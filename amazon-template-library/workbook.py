"""Read OOXML and patch only explicitly mapped worksheet cells; no third-party dependencies."""
import io, re, zipfile, posixpath, xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

MAX_FILE = 24 * 1024 * 1024
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}


def archive(data):
    if len(data) > MAX_FILE:
        raise ValueError('文件超过24MB限制')
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        infos = z.infolist()
        if len(infos) > 5000 or len({i.filename for i in infos}) != len(infos) or sum(i.file_size for i in infos) > 120 * 1024 * 1024:
            raise ValueError('压缩文件过大或含重复条目')
        if any(i.flag_bits & 1 for i in infos):
            raise ValueError('请先解除Excel文件密码保护')
        if 'xl/workbook.xml' not in z.namelist():
            raise ValueError('仅支持有效的.xlsx或.xlsm工作簿')
        return z
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError('无法读取Excel，请使用.xlsx或.xlsm文件') from exc


def xml(z, name):
    raw = z.read(name)
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('不支持含外部实体的XML')
    try:
        return ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ValueError('工作簿XML格式损坏') from exc


def sheets(z):
    rel = {r.attrib['Id']: r.attrib['Target'] for r in xml(z, 'xl/_rels/workbook.xml.rels') if r.attrib.get('TargetMode') != 'External'}
    result = []
    for s in xml(z, 'xl/workbook.xml').findall('s:sheets/s:sheet', NS):
        target = rel.get(s.attrib.get('{%s}id' % NS['r']), '')
        p = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
        if p in z.namelist() and p.startswith('xl/worksheets/'):
            result.append({'name': s.attrib['name'], 'path': p, 'hidden': s.attrib.get('state', 'visible') != 'visible'})
    if not result:
        raise ValueError('找不到可读取的工作表')
    return result


def colnum(text):
    out = 0
    for c in text.upper():
        out = out * 26 + ord(c) - 64
    return out


def colname(n):
    text = ''
    while n:
        n, r = divmod(n - 1, 26)
        text = chr(65 + r) + text
    return text


def read_cells(z, sheet):
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        strings = [''.join(t.text or '' for t in si.findall('.//s:t', NS)) for si in xml(z, 'xl/sharedStrings.xml').findall('s:si', NS)]
    cells = {}
    for c in xml(z, sheet['path']).findall('s:sheetData/s:row/s:c', NS):
        ref = c.attrib.get('r', '')
        if not re.fullmatch('[A-Z]{1,3}[1-9][0-9]*', ref):
            continue
        v = c.find('s:v', NS)
        value = v.text if v is not None and v.text is not None else ''
        if c.attrib.get('t') == 's':
            try:
                value = strings[int(value)]
            except (ValueError, IndexError):
                raise ValueError('工作簿共享字符串索引损坏')
        elif c.attrib.get('t') == 'inlineStr':
            value = ''.join(t.text or '' for t in c.findall('.//s:t', NS))
        elif c.attrib.get('t') == 'b':
            value = 'TRUE' if value == '1' else 'FALSE'
        formula = c.find('s:f', NS) is not None
        cells[ref] = {'value': value, 'formula': formula, 'style': c.attrib.get('s', '')}
    return cells


def inspect(data):
    with archive(data) as z:
        result = []
        for s in sheets(z):
            cells = read_cells(z, s)
            preview = []
            for row in range(1, 13):
                values = [{'column': re.sub(r'\d', '', ref), 'value': c['value'][:180]} for ref, c in cells.items() if re.search(r'\d+$', ref).group() == str(row) and c['value']]
                if values:
                    preview.append({'row': row, 'cells': values[:24]})
            result.append({'name': s['name'], 'hidden': s['hidden'], 'preview': preview})
        return {'sheets': result, 'macros': 'xl/vbaProject.bin' in z.namelist()}


def get_fields(data, name, row):
    if not isinstance(row, int) or not 1 <= row <= 100:
        raise ValueError('字段行号必须在1～100之间')
    with archive(data) as z:
        sheet = next((s for s in sheets(z) if s['name'] == name), None)
        if not sheet:
            raise ValueError('找不到指定工作表')
        fields = [{'column': re.sub(r'\d', '', ref), 'label': c['value']} for ref, c in read_cells(z, sheet).items() if re.search(r'\d+$', ref).group() == str(row) and c['value']]
        fields.sort(key=lambda f: colnum(f['column']))
        if not fields:
            raise ValueError('这一行没有字段，请根据预览调整字段行号')
        return fields


def fill(template, source, layout, source_layout, mapping, required):
    """Draft only: map explicit source columns, never infer facts or write formulas."""
    target_fields = get_fields(template, layout['sheet'], layout['header'])
    source_fields = get_fields(source, source_layout['sheet'], source_layout['header'])
    targets = {f['column'] for f in target_fields}
    sources = {f['column'] for f in source_fields}
    if not mapping or len(mapping) > 500 or any(k not in targets or v not in sources for k, v in mapping.items()):
        raise ValueError('请至少映射一个有效字段，映射列须存在于选定字段行')
    if not set(required).issubset(targets):
        raise ValueError('必填字段不在当前模板中')
    for item in (layout, source_layout):
        if not isinstance(item['start'], int) or not item['header'] < item['start'] <= 1000:
            raise ValueError('数据起始行必须大于字段行，且不超过1000')
    with archive(template) as tz, archive(source) as sz:
        ts = next(s for s in sheets(tz) if s['name'] == layout['sheet'])
        ss = next(s for s in sheets(sz) if s['name'] == source_layout['sheet'])
        tc, sc = read_cells(tz, ts), read_cells(sz, ss)
        if any(int(re.search(r'\d+$', ref).group()) >= layout['start'] and (c['value'] or c['formula']) for ref, c in tc.items()):
            raise ValueError('模板数据区含样例、公式或旧商品，请上传干净模板，或确认数据起始行。为防混入旧商品，本次未生成')
        rows = sorted({int(re.search(r'\d+$', ref).group()) for ref, c in sc.items() if c['value'] or c['formula']})
        rows = [r for r in rows if r >= source_layout['start'] and any(sc.get(f'{col}{r}', {}).get('value') or sc.get(f'{col}{r}', {}).get('formula') for col in sources)]
        if not rows:
            raise ValueError('商品表的数据区没有内容')
        if len(rows) > 3000:
            raise ValueError('单次最多3000行商品，请拆分资料表')
        updates, issues = {}, []
        labels = {f['column']: f['label'] for f in target_fields}
        sku_col = next((f['column'] for f in target_fields if re.search(r'(^|[.\[])item_sku|^sku$|seller_sku|卖家sku', f['label'], re.I)), None)
        sku_seen = set()
        for offset, source_row in enumerate(rows):
            dest_row = layout['start'] + offset
            for dest, src in mapping.items():
                c = sc.get(f'{src}{source_row}', {'value': '', 'formula': False})
                if c['formula']:
                    issues.append([source_row, dest_row, labels[dest], '来源是公式：未复制公式或缓存结果，请将该值转成明确值后重试'])
                    continue
                value = c['value']
                if value:
                    if len(value) > 32767:
                        raise ValueError('单元格文字超过Excel限制')
                    updates[f'{dest}{dest_row}'] = value
            for field in required:
                if not updates.get(f'{field}{dest_row}'):
                    issues.append([source_row, dest_row, labels[field], '用户指定的必填字段缺失'])
            sku = updates.get(f'{sku_col}{dest_row}', '') if sku_col else ''
            if sku and sku in sku_seen:
                issues.append([source_row, dest_row, 'SKU', '重复SKU，请人工确认；未合并商品'])
            if sku:
                sku_seen.add(sku)
        raw = tz.read(ts['path']).decode('utf-8-sig')
        # Preserve all other XML bytes, macros, hidden sheets and untouched ZIP entries.
        match = re.search(r'<(?P<p>(?:\w+:)?)sheetData\b[^>]*(?:/>|>[\s\S]*?</(?P=p)sheetData>)', raw)
        if not match:
            raise ValueError('无法定位模板数据区')
        prefix = match.group('p')
        section = match.group()
        existing_rows = {int(m.group(1)): m.group() for m in re.finditer(r'<'+prefix+r'row\b[^>]*\br=["\'](\d+)["\'][^>]*(?:/>|>[\s\S]*?</'+prefix+r'row>)', section)}
        for dest_row in range(layout['start'], layout['start'] + len(rows)):
            rowtext = existing_rows.get(dest_row, f'<{prefix}row r="{dest_row}"></{prefix}row>')
            if rowtext.endswith('/>'):
                rowtext = rowtext[:-2] + f'></{prefix}row>'
            cells = {re.search(r'\br=["\']([A-Z]+\d+)["\']', m.group()).group(1): m.group() for m in re.finditer(r'<'+prefix+r'c\b[^>]*\br=["\'][A-Z]+\d+["\'][^>]*(?:/>|>[\s\S]*?</'+prefix+r'c>)', rowtext)}
            for col in mapping:
                ref = f'{col}{dest_row}'
                if ref not in updates:
                    continue
                style = tc.get(ref, tc.get(f'{col}{layout["start"]}', {})).get('style', '')
                attr = f' s="{style}"' if style.isdigit() else ''
                cells[ref] = f'<{prefix}c r="{ref}"{attr} t="inlineStr"><{prefix}is><{prefix}t xml:space="preserve">{escape(updates[ref])}</{prefix}t></{prefix}is></{prefix}c>'
            inner = ''.join(cells[k] for k in sorted(cells, key=lambda ref: colnum(re.sub(r'\d', '', ref))))
            rowtext = re.sub(r'(<'+prefix+r'row\b[^>]*>)[\s\S]*(</'+prefix+r'row>)', lambda m: m[1]+inner+m[2], rowtext)
            existing_rows[dest_row] = rowtext
        opening = re.match(r'<'+prefix+r'sheetData\b[^>]*>', section).group() if not section.endswith('/>') else section[:-2]+'>'
        newsection = opening + ''.join(existing_rows[r] for r in sorted(existing_rows)) + f'</{prefix}sheetData>'
        raw = raw[:match.start()] + newsection + raw[match.end():]
        maxrow = max([layout['start']+len(rows)-1]+[int(re.search(r'\d+$', ref).group()) for ref in tc])
        maxcol = max(colnum(re.sub(r'\d', '', ref)) for ref in [*tc, *updates])
        raw = re.sub(r'(<(?:\w+:)?dimension\b[^>]*\bref=)["\'][^"\']*["\']', lambda m: m[1]+'"A1:'+colname(maxcol)+str(maxrow)+'"', raw, count=1)
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as out:
            for info in tz.infolist():
                out.writestr(info, raw.encode('utf-8') if info.filename == ts['path'] else tz.read(info.filename))
    result = output.getvalue()
    with archive(result) as check:
        actual = read_cells(check, ts)
        if any(actual.get(ref, {}).get('value') != value for ref, value in updates.items()):
            raise ValueError('生成后回读核验失败，文件未交付')
    return result, issues, {'rows': len(rows), 'cells': len(updates), 'issues': len(issues), 'draft': True}

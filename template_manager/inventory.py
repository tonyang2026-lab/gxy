"""Read inventory without modifying it and propose template coverage with evidence."""
import csv
from difflib import SequenceMatcher
import io
import posixpath
import re
import unicodedata
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile
from .library import GLOBAL_SHOP, validate_table_type
from .product_types import FAMILIES, norm, canonical_category, declared_types, type_labels, CategoryResolver

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
MAX_ROWS = 10000
MAX_CELLS = 250000
ALIASES = {
    'sku': ['sku', 'seller sku', 'seller_sku', 'item_sku', '商家sku', '商品sku', '卖家sku', '库存sku', '货号', '商品编码', '产品编码', '商品编号', '产品编号', '物料编码'],
    'title': ['title', 'product name', 'item_name', 'product_name', '商品名称', '产品名称', '品名', '商品名', '产品名', '名称', '商品标题', '标题', 'name'],
    'category': ['category', 'product category', 'product type', 'product_type', 'feed_product_type', 'item_type_keyword', '类目', '商品类目', '产品类目', '产品类别', '商品类别', '类别', '分类', '商品分类', '产品类型'],
}

def xml(data):
    if re.search(br'<!\s*(DOCTYPE|ENTITY)', data, re.I):
        raise ValueError('不支持带 DTD/实体定义的工作簿 XML')
    return ET.fromstring(data)


def col_index(ref):
    m = re.match(r'([A-Z]+)', ref or '')
    if not m:
        raise ValueError('工作簿单元格坐标无效')
    result = 0
    for c in m[1]:
        result = result * 26 + ord(c) - 64
    if result > 512:
        raise ValueError('库存表最多支持 512 列')
    return result - 1


def read_tables(data, filename):
    suffix = Path(filename).suffix.lower()
    if suffix=='.xls' and data[:4]==b'PK\x03\x04':
        suffix='.xlsx'  # Some exports use .xls for an OOXML ZIP container.
    if suffix == '.csv':
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = data.decode('gb18030')
        try:
            dialect = csv.Sniffer().sniff(text[:10000], delimiters=',;\t')
        except csv.Error:
            dialect = csv.excel
        rows = []
        cells = 0
        for num, row in enumerate(csv.reader(io.StringIO(text), dialect), 1):
            if not any(v.strip() for v in row):
                continue
            cells += len(row)
            if len(rows) >= MAX_ROWS + 30 or len(row) > 512 or cells > MAX_CELLS:
                raise ValueError('库存表过大，请拆分为每份最多 10000 个商品、512 列')
            rows.append((num, [v.strip() for v in row]))
        return [{'name': 'CSV', 'rows': rows, 'warnings': []}]
    if suffix not in ('.xlsx', '.xlsm'):
        raise ValueError('库存表支持 .xlsx、.xlsm、.csv；真正的旧版 .xls 请用 Excel/WPS 另存为 .xlsx 并保留图片，不能只改文件扩展名')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if len(z.infolist()) > 5000 or sum(i.file_size for i in z.infolist()) > 256 * 1024 * 1024 or any(i.file_size > 32 * 1024 * 1024 for i in z.infolist()):
            raise ValueError('工作簿展开体积过大，请拆分文件')
        if z.testzip():
            raise ValueError('工作簿已损坏')
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            shared = [''.join(t.text or '' for t in n.findall('.//s:t', NS)) for n in xml(z.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        zero_formats = {}
        if 'xl/styles.xml' in z.namelist():
            styles = xml(z.read('xl/styles.xml'))
            formats = {n.get('numFmtId'): n.get('formatCode', '') for n in styles.findall('s:numFmts/s:numFmt', NS)}
            for i, style in enumerate(styles.findall('s:cellXfs/s:xf', NS)):
                fmt = formats.get(style.get('numFmtId'), '')
                if re.fullmatch('0{2,30}', fmt):
                    zero_formats[str(i)] = len(fmt)
        rels = {n.get('Id'): n for n in xml(z.read('xl/_rels/workbook.xml.rels'))}
        sheets = xml(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS)
        if len(sheets) > 50:
            raise ValueError('最多支持 50 个工作表')
        tables = []
        cell_count = 0
        for sheet in sheets:
            if sheet.get('state', 'visible') != 'visible':
                continue
            rel = rels.get(sheet.get(R))
            if rel is None or rel.get('TargetMode') == 'External':
                continue
            target = rel.get('Target', '')
            name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
            if not name.startswith('xl/') or '..' in name.split('/'):
                raise ValueError('工作表路径无效')
            rows, warnings = [], []
            for row in xml(z.read(name)).findall('s:sheetData/s:row', NS):
                values = {}
                for cell in row.findall('s:c', NS):
                    cell_count += 1
                    if cell_count > MAX_CELLS:
                        raise ValueError('库存表单元格过多，请拆分文件')
                    index = col_index(cell.get('r'))
                    kind = cell.get('t')
                    val = cell.findtext('s:v', '', NS)
                    if kind == 's':
                        try:
                            val = shared[int(val)]
                        except (ValueError, IndexError):
                            raise ValueError('共享文本索引无效')
                    elif kind == 'inlineStr':
                        val = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                    elif kind == 'e':
                        val = ''
                    elif cell.get('s') in zero_formats and val.isdigit():
                        val = val.zfill(zero_formats[cell.get('s')])
                    if cell.find('s:f', NS) is not None:
                        warnings.append('公式仅读取 Excel 已缓存的结果，不重新计算；请核对后使用')
                    if len(val) > 4000:
                        raise ValueError('单元格文本过长，请清理库存表')
                    values[index] = val.strip()
                if values and any(values.values()):
                    if len(rows) >= MAX_ROWS + 30:
                        raise ValueError('商品行过多，请按每份最多 10000 行拆分')
                    dense = [values.get(i, '') for i in range(max(values) + 1)]
                    rows.append((int(row.get('r', len(rows) + 1)), dense))
            tables.append({'name': sheet.get('name', ''), 'rows': rows, 'warnings': sorted(set(warnings))})
        return tables


def mapping_for(headers):
    result = {}
    for field, aliases in ALIASES.items():
        matches = [i for i, h in enumerate(headers) if norm(h) in {norm(a) for a in aliases}]
        result[field] = matches[0] if len(matches) == 1 else None
    return result


def header_info(table, header_row=None):
    rows = table['rows']
    if not rows:
        raise ValueError('所选工作表没有数据')
    if header_row is None:
        position = max(range(min(30, len(rows))), key=lambda i: sum(v is not None for v in mapping_for(rows[i][1]).values()))
    else:
        position = next((i for i, row in enumerate(rows) if row[0] == int(header_row)), None)
        if position is None:
            raise ValueError('指定表头行不存在或为空')
    headers = rows[position][1]
    return position, headers, mapping_for(headers)


def header_warnings(headers,mapping):
    selected=[headers[i] for field,i in mapping.items() if field in ('title','category') and type(i) is int and 0<=i<len(headers)]
    if any(re.fullmatch(r'\d+(?:\.\d+)?',str(value).strip()) for value in selected) or sum(bool(re.fullmatch(r'\d+(?:\.\d+)?',str(value).strip())) for value in headers)>=2:
        return ['当前表头含“1”“2”等数字，可能选到了商品数据行。请展开列设置，把表头行改为实际包含 SKU、品名、类别等列名的那一行，再核对映射。']
    return []


def inspect(data, filename, sheet=None, header_row=None):
    tables = read_tables(data, filename)
    nonempty = [t for t in tables if t['rows']]
    if not nonempty:
        raise ValueError('文件没有可读取的数据')
    selected = next((t for t in nonempty if t['name'] == sheet), None) if sheet else max(nonempty, key=lambda t: sum(v is not None for v in header_info(t)[2].values()))
    if selected is None:
        raise ValueError('工作表不存在或为空')
    pos, headers, mapping = header_info(selected, header_row)
    return {'sheet': selected['name'], 'sheets': [{'name': t['name'], 'rows': len(t['rows'])} for t in nonempty], 'header_row': selected['rows'][pos][0], 'headers': headers, 'mapping': mapping, 'preview': [r[1] for r in selected['rows'][pos + 1:pos + 4]], 'warnings': selected['warnings']+header_warnings(headers,mapping)}


def hits(text, resolver=None):
    folded = unicodedata.normalize('NFKC', text).casefold()
    found = []
    for label, words in FAMILIES:
        matched = [w for w in words if (re.search(r'(?<![a-z])' + re.escape(w) + r'(?![a-z])', folded) if w.isascii() else w in folded)]
        if matched:
            found.append((label, matched[0]))
    # A conjunction of independent attributes can identify luggage without its name.
    # A lock or an ABS/PC material alone is deliberately insufficient.
    if not any(label == '行李箱' for label, _ in found):
        handle = bool(re.search(r'拉杆|trolley\s*handle|telescopic\s*handle', folded))
        tsa = bool(re.search(r'\btsa\b', folded))
        material = bool(re.search(r'abs\s*[+/&＋]\s*pc|pc\s*[+/&＋]\s*abs|聚碳酸酯', folded))
        dimensions = len(set(re.findall(r'(?<!\d)(20|24|28)(?!\d)', folded))) >= 2
        accessory = bool(re.search(r'替换|配件|箱套|replacement|luggage\s*cover', folded))
        if handle and sum((tsa, material, dimensions)) >= 2 and not accessory:
            clues = ['拉杆结构'] + (['TSA 锁'] if tsa else []) + (['ABS+PC 材质'] if material else []) + (['20/24/28 英寸系列尺寸'] if dimensions else [])
            found.append(('行李箱', '组合属性：' + ' + '.join(clues)))
    if resolver:
        found += resolver.hits(text)
        found = list({label: (label, word) for label, word in found}.values())
    return found


def template_candidates(category, inferred, same_site, shop=GLOBAL_SHOP, resolver=None):
    """Use every declared type; semantic matches stay suggestions until confirmed."""
    canonical = resolver.canonical if resolver else canonical_category
    result = []
    wanted = {label for label, _ in inferred}
    if category and canonical(category):
        wanted.add(canonical(category))
    for t in same_site:
        matches = []
        for code in declared_types(t):
            family = canonical(code)
            if family and family in wanted:
                matches.append((4, t, '模板声明商品类型：'+code+' → '+family, code))
        family = canonical(t['category'])
        if family and family in wanted:
            matches.append((3, t, '模板登记类目别名：'+t['category']+' → '+family, None))
        elif category and len(norm(category)) >= 4 and len(norm(t['category'])) >= 4:
            score = SequenceMatcher(None, norm(category), norm(t['category'])).ratio()
            if score >= 0.86:
                matches.append((1, t, '登记类目文字近似（需核对）：'+t['category'], None))
        if matches:
            result.append(max(matches, key=lambda entry: entry[0]))
    return sorted(result, key=lambda entry: (entry[0], entry[1].get('shop', GLOBAL_SHOP) == shop, entry[1]['created_at']), reverse=True)


def descriptive_context(headers, values, title):
    fields = {'description', 'productdescription', 'specification', 'specifications', 'material', 'size', 'features', '产品描述', '商品描述', '描述', '规格', '产品规格', '规格参数', '参数', '材质', '尺寸', '特点', '卖点'}
    parts = [title] if title else []
    used = []
    for i, header in enumerate(headers):
        if norm(header) in fields and i < len(values) and values[i] and values[i] not in parts:
            parts.append(values[i]); used.append(header)
    return '\n'.join(parts), used


def summarize(report, resolver=None):
    canonical = resolver.canonical if resolver else canonical_category
    records = report['items']
    groups = {}
    for record in records:
        category = record['suggested_category'] or '无法识别类目'
        record['category_key'] = canonical(category) or category
        key = (record['status'], record['suggested_category'] or '无法识别类目', (record.get('template') or {}).get('id'))
        group = groups.setdefault(key, {'status': key[0], 'category': key[1], 'count': 0, 'template': record.get('template'), 'rows': []})
        group['count'] += 1
        group['rows'].append(record['row'])
    report['summary'] = {'total': len(records), **{state: sum(r['status'] == state for r in records) for state in ('available', 'missing', 'review')}}
    report['groups'] = list(groups.values())
    return report


def analyze(data, filename, marketplace, templates, sheet=None, header_row=None, mapping=None, category_overrides=None, shop=GLOBAL_SHOP, tables=None, table_type="upload", template_overrides=None, alias_rules=None):
    from .aliases import revision
    alias_rules = alias_rules or []
    resolver = CategoryResolver(alias_rules)
    table_type = validate_table_type(table_type)
    if not re.fullmatch('[A-Z]{2}', marketplace or ''):
        raise ValueError('请明确选择目标站点，不能从商品语言推测站点')
    if not isinstance(shop, str) or not shop.strip() or len(shop) > 120:
        raise ValueError('请明确选择店铺，店铺名称最多 120 字')
    shop = shop.strip()
    tables = read_tables(data, filename) if tables is None else tables
    table = next((t for t in tables if t['name'] == sheet), None)
    if table is None:
        raise ValueError('请先读取表头并明确选择工作表')
    pos, headers, detected = header_info(table, header_row)
    mapping = detected if mapping is None else mapping
    cols = {}
    for field in ('sku', 'title', 'category'):
        value = mapping.get(field)
        if value is not None and (type(value) is not int or value < 0 or value >= len(headers)):
            raise ValueError('列映射无效，请重新读取表头')
        cols[field] = value
    assigned = [v for v in cols.values() if v is not None]
    if len(assigned) != len(set(assigned)):
        raise ValueError('SKU、品名和类目不能选择同一列')
    if cols['title'] is None and cols['category'] is None:
        raise ValueError('至少指定品名列或类目列，只有库存数量无法判断模板')
    records = []
    groups = {}
    category_overrides = category_overrides or {}
    if not isinstance(category_overrides, dict) or len(category_overrides) > MAX_ROWS:
        raise ValueError('类目确认数据无效')
    valid_rows = {str(r[0]) for r in table['rows'][pos + 1:]}
    for row, label in category_overrides.items():
        if row not in valid_rows or not isinstance(label, str) or not label.strip() or len(label) > 120:
            raise ValueError('确认的行号或类目无效，请重新读取库存表')
    same_site = [t for t in templates if t.get('table_type', 'upload') == table_type and t['marketplace'] == marketplace and t.get('shop', GLOBAL_SHOP) in (shop, GLOBAL_SHOP) and not t.get('account_scope_unknown')]
    template_overrides = template_overrides or {}
    if not isinstance(template_overrides, dict) or len(template_overrides) > MAX_ROWS:
        raise ValueError('模板确认数据无效')
    scoped_templates = {t['id']: t for t in same_site}
    for row, override in template_overrides.items():
        if row not in valid_rows or row not in category_overrides or not isinstance(override, dict):
            raise ValueError('模板确认须关联本次已确认的商品行')
        ident, product_type = override.get('template_id'), override.get('product_type')
        if not isinstance(ident, str) or ident not in scoped_templates or not isinstance(product_type, str) or product_type not in declared_types(scoped_templates[ident]):
            raise ValueError('确认模板或商品类型不在本店铺、站点和表格类型的声明范围内')
    by_category = {}
    for t in same_site:
        for label in dict.fromkeys([norm(t['category'])]+[norm(code) for code in declared_types(t)]):
            by_category.setdefault(label, []).append(t)
    related_cache = {}
    for row_number, values in table['rows'][pos + 1:]:
        def get(field):
            idx = cols[field]
            return values[idx] if idx is not None and idx < len(values) else ''
        sku, title, original_category = get('sku'), get('title'), get('category')
        if not any((sku, title, original_category)):
            continue
        confirmed = category_overrides.get(str(row_number), '').strip()
        rule = None if confirmed else resolver.exact_alias(original_category or title)
        category = confirmed or (rule['category'] if rule else original_category)
        if len(records) >= MAX_ROWS:
            raise ValueError('最多分析 10000 个商品，请拆分文件')
        context, context_columns = descriptive_context(headers, values, title)
        inferred = hits(context, resolver)
        exact = by_category.get(norm(category), []) if category else []
        manual_template = template_overrides.get(str(row_number))
        if manual_template:
            exact = [scoped_templates[manual_template['template_id']]]
        label = category or (inferred[0][0] if len(inferred) == 1 else '')
        candidates = exact
        status = 'available' if exact else ('missing' if category else 'review')
        evidence = f'库存表第 {row_number} 行类目“{category}”与模板库登记类目一致' if exact else (f'库存表第 {row_number} 行明确填写类目“{category}”，目标站点无同名登记模板' if category else '库存表没有明确类目，需要人工确认')
        if confirmed:
            evidence = f'用户已将第 {row_number} 行类目确认为“{confirmed}”；' + ('目标站点有同登记类目模板' if exact else '目标站点没有同登记类目模板')
        related = []
        if not exact:
            # An explicit but different category may be a synonym, typo or contradictory.
            key = (category, tuple(label for label, _ in inferred) if not category else ())
            if key not in related_cache:
                related_cache[key] = template_candidates(category, inferred if not category else [], same_site, shop, resolver)
            related = related_cache[key]
            candidates = [entry[1] for entry in related]
            if category and related:
                status = 'review'
                evidence += '；发现声明类型、别名或近似类目模板，需确认是否为同一适用类目'
            if (confirmed or rule) and related and related[0][0] >= 3:
                candidates = [entry[1] for entry in related if entry[0] >= 3]
                status = 'available'
                evidence += '；已确认的归类命中明确类型关联'
        if rule:
            evidence += '；团队别名规则：'+rule['alias']+' → '+rule['category']
        if not category:
            if inferred:
                evidence += '；文字/属性依据：' + '、'.join(f'{word} → {family}' for family, word in inferred)
                if context_columns:
                    evidence += '；参考描述列：' + '、'.join(context_columns)
            if len(inferred) > 1:
                label = ' / '.join(f for f, _ in inferred)
        if related:
            evidence += '；' + related[0][2]
        if exact:
            candidates = sorted(candidates, key=lambda t: (t.get('shop', GLOBAL_SHOP) == shop, t['created_at']), reverse=True)
        # Keep separate category variants and older versions visible; latest is a suggestion only.
        suggested = candidates[0] if candidates and (exact or len(inferred) == 1 or (category and related)) else None
        suggestion = {'id': suggested['id'], 'filename': suggested.get('download_name', suggested['original_name']), 'category': suggested['category'], 'version': suggested['version'], 'shop': suggested.get('shop', GLOBAL_SHOP)} if suggested else None
        matched_type = next((code for code in declared_types(suggested) if norm(code) == norm(category)), None) if suggested else None
        if manual_template:
            matched_type = manual_template['product_type']
            evidence += '；用户已确认该模板及其声明商品类型'
        if suggested and not matched_type:
            matched_type = next((entry[3] for entry in related if entry[1]['id'] == suggested['id']), None)
        if suggested and matched_type:
            evidence += '；匹配模板声明商品类型 '+matched_type
        if suggested and (exact or rule) and declared_types(suggested) and not manual_template:
            family = resolver.canonical(category)
            compatible = matched_type or (family and any(resolver.canonical(code) == family for code in declared_types(suggested)))
            if not compatible:
                status = 'review'
                evidence += '；登记类目虽命中，但未能对应模板声明商品类型，请核对适用范围'
        if suggestion:
            suggestion.update(product_types_count=len(declared_types(suggested)), matched_product_type=matched_type)
        evidence += f'；仅检查店铺“{shop}”及通用模板，不借用其他店铺专用模板'
        record = {'row': row_number, 'sku': sku, 'title': title, 'original_category': original_category, 'category': category, 'confirmed': bool(confirmed), 'alias_match': {'alias': rule['alias'], 'category': rule['category']} if rule else None, 'suggested_category': label, 'status': status, 'evidence': evidence, 'template': suggestion, 'candidates': [{'id': t['id'], 'filename': t['original_name'], 'category': t['category'], 'version': t['version']} for t in candidates[:20]], 'action': '核对模板适用范围后下载使用' if status == 'available' else ('补充该站点和类目的亚马逊原始模板，或核对库内类目命名是否不同' if status == 'missing' else '先确认亚马逊类目，再判断需要补充的模板')}
        records.append(record)
        key = (status, label or '无法识别类目')
        group = groups.setdefault(key, {'status': status, 'category': key[1], 'count': 0, 'template': suggestion, 'rows': []})
        group['count'] += 1
        group['rows'].append(row_number)
    if not records:
        raise ValueError('表头之后没有可分析的商品行，请检查列映射和表头行号')
    used_ids = {r['template']['id'] for r in records if r['template']}
    template_supports = {t['id']: {'product_types': declared_types(t), 'product_type_labels': type_labels(t, resolver)} for t in same_site if t['id'] in used_ids}
    coverage_warnings = [t['original_name']+'：'+warning for t in same_site for warning in (t.get('metadata') or {}).get('product_type_warnings', [])]
    return summarize({'alias_revision': revision(alias_rules), 'template_supports': template_supports, 'table_type': table_type, 'filename': filename, 'marketplace': marketplace, 'shop': shop, 'sheet': sheet, 'header_row': table['rows'][pos][0], 'items': records, 'warnings': table['warnings'] + header_warnings(headers,cols) + coverage_warnings + ['结果只检查模板覆盖，不检查商品资料。类目匹配依据库内登记信息，不代表亚马逊官方类目审核；同名模板仍需核对适用范围。', '缺少模板指无同店铺/通用、同站点同登记类目，可能存在不同命名；品名/属性推断只供确认，不自动判定缺失。', '本地规则不读取图片；开启 AI 图片分析后才读取支持格式的内嵌图片。', '库存文件仅在本次请求内分析，不存入共享模板库。']}, resolver)

"""Generate same-marketplace copies, changing only Template!A1 contributorId."""
import hashlib
import io
import json
from pathlib import Path
import posixpath
import re
import tempfile
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote_plus, quote
from xml.sax.saxutils import escape
import zipfile

from . import library, metadata

PREFIX = r'(?:[A-Za-z_][\w.-]*:)?'


def replace_identity(data, suffix, seller_id):
    from .roster import fingerprint
    target_fp = fingerprint(seller_id)
    library.workbook(data, suffix)
    before = metadata.inspect(data)
    if not before.get('account_fingerprint') or not before.get('marketplace'):
        raise ValueError('源模板缺少可识别的主站点或 contributorId，未修改文件')
    with zipfile.ZipFile(io.BytesIO(data)) as src:
        if any(n.startswith('_xmlsignatures/') for n in src.namelist()):
            raise ValueError('源文件含文档数字签名，修改将使签名失效；本功能不处理此文件')
        workbook = metadata.parse_xml(src.read('xl/workbook.xml'))
        sheet = next(s for s in workbook.findall('s:sheets/s:sheet', metadata.N) if s.get('name', '').casefold() in ('template', '模板'))
        rel = next(r for r in metadata.parse_xml(src.read('xl/_rels/workbook.xml.rels')) if r.get('Id') == sheet.get(metadata.R))
        path = rel.get('Target', '')
        path = posixpath.normpath(path.lstrip('/') if path.startswith('/') else posixpath.join('xl', path))
        sheet_bytes = src.read(path)
        cell_pattern = re.compile(rb'<' + PREFIX.encode() + rb'c\b(?=[^>]*\br=["\']A1["\'])[^>]*>.*?</' + PREFIX.encode() + rb'c\s*>', re.S)
        matches = list(cell_pattern.finditer(sheet_bytes))
        if len(matches) != 1:
            raise ValueError('无法唯一定位 Template!A1，未修改文件')
        match = matches[0]
        cell_bytes = match.group()
        cell = metadata.parse_xml(src.read(path)).find("s:sheetData/s:row/s:c[@r='A1']", metadata.N)
        if cell is None or cell.find('s:f', metadata.N) is not None:
            raise ValueError('Template!A1 不是可直接修改的元数据单元格')
        shared = None
        if cell.get('t') == 's':
            shared = src.read('xl/sharedStrings.xml')
            strings = metadata.parse_xml(shared).findall('s:si', metadata.N)
            index = int(cell.findtext('s:v', '', metadata.N))
            settings = ''.join(t.text or '' for t in strings[index].findall('.//s:t', metadata.N))
        elif cell.get('t') == 'inlineStr':
            settings = ''.join(t.text or '' for t in cell.findall('.//s:t', metadata.N))
        else:
            settings = cell.findtext('s:v', '', metadata.N)
        if not settings.startswith('settings='):
            raise ValueError('元数据格式不受支持')
        parts = settings[len('settings='):].split('&')
        indexes = [i for i, p in enumerate(parts) if unquote_plus(p.split('=', 1)[0]) == 'contributorId']
        if len(indexes) != 1:
            raise ValueError('contributorId 不唯一，未修改文件')
        i = indexes[0]
        old = unquote_plus(parts[i].split('=', 1)[1])
        new = 'amzn1.cr.o.'+seller_id
        raw_old = parts[i].split('=', 1)[1]
        new_value = quote(new, safe='') if '%' in raw_old else new
        parts[i] = parts[i].split('=', 1)[0]+'='+new_value
        changed_settings = 'settings='+'&'.join(parts)
        replacements = {}
        if old == new:
            return data, {'changed': False, 'location': 'Template!A1 → contributorId', 'changed_parts': [], 'verified': True}
        if shared is not None:
            # Append a separate string: other cells sharing the source entry stay intact.
            fragment = ('<si xmlns="'+metadata.N['s']+'"><t xml:space="preserve">'+escape(changed_settings)+'</t></si>').encode()
            close = re.search(rb'</'+PREFIX.encode()+rb'sst\s*>\s*$', shared)
            if close is None:
                raise ValueError('共享字符串表结尾格式不受支持')
            new_shared = shared[:close.start()]+fragment+shared[close.start():]
            opening = re.search(rb'<'+PREFIX.encode()+rb'sst\b[^>]*>', new_shared)
            if opening is None:
                raise ValueError('共享字符串表结构不受支持')
            tag = re.sub(rb'\buniqueCount=["\']\d+["\']', b'uniqueCount="'+str(len(strings)+1).encode()+b'"', opening.group())
            if b'uniqueCount=' not in tag:
                tag=tag[:-1]+b' uniqueCount="'+str(len(strings)+1).encode()+b'">'
            new_shared = new_shared[:opening.start()]+tag+new_shared[opening.end():]
            v_pattern = re.compile(rb'(<'+PREFIX.encode()+rb'v\b[^>]*>).*?(</'+PREFIX.encode()+rb'v\s*>)', re.S)
            new_cell, count = v_pattern.subn(lambda m: m[1]+str(len(strings)).encode()+m[2], cell_bytes)
            if count != 1:
                raise ValueError('共享字符串引用不唯一')
            replacements['xl/sharedStrings.xml'] = new_shared
        elif cell.get('t') == 'inlineStr':
            pattern = re.compile(rb'<'+PREFIX.encode()+rb'is\b[^>]*>.*?</'+PREFIX.encode()+rb'is\s*>', re.S)
            fragment = ('<is xmlns="'+metadata.N['s']+'"><t xml:space="preserve">'+escape(changed_settings)+'</t></is>').encode()
            new_cell, count = pattern.subn(lambda _: fragment, cell_bytes)
            if count != 1:
                raise ValueError('内联字符串不唯一')
        else:
            pattern = re.compile(rb'(<'+PREFIX.encode()+rb'v\b[^>]*>).*?(</'+PREFIX.encode()+rb'v\s*>)', re.S)
            new_cell, count = pattern.subn(lambda m: m[1]+escape(changed_settings).encode()+m[2], cell_bytes)
            if count != 1:
                raise ValueError('元数据文本引用不唯一')
        replacements[path] = sheet_bytes[:match.start()]+new_cell+sheet_bytes[match.end():]
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as dest:
            dest.comment = src.comment
            for info in src.infolist():
                raw = replacements.get(info.filename)
                dest.writestr(info, src.read(info.filename) if raw is None else raw)
    result = out.getvalue()
    library.workbook(result, suffix)
    after = metadata.inspect(result)
    if after.get('account_fingerprint') != target_fp or any(before.get(k) != after.get(k) for k in ('marketplace', 'product_types', 'data_row', 'attribute_row', 'field_count', 'has_prefilled_data')):
        raise ValueError('生成后的来源或模板结构校验失败，未交付副本')
    with zipfile.ZipFile(io.BytesIO(data)) as a, zipfile.ZipFile(io.BytesIO(result)) as b:
        if a.namelist() != b.namelist() or any(a.read(n) != b.read(n) for n in a.namelist() if n not in replacements):
            raise ValueError('出现计划之外的工作簿部件变化，未交付副本')
    return result, {'changed': True, 'location': 'Template!A1 → contributorId', 'changed_parts': sorted(replacements), 'verified': True}


def safe_name(value):
    value = re.sub(r'[^\w.-]+', '_', value).strip(' ._')[:60] or 'template'
    return value


def generate(root, data, filename, shops, category, version, save_to_library=True):
    if not isinstance(shops, list) or not 1 <= len(shops) <= 50 or not all(isinstance(s, str) for s in shops) or len(set(shops)) != len(shops):
        raise ValueError('请选择 1–50 家不同的目标店铺')
    if not isinstance(category, str) or not category.strip() or len(category) > 120 or not isinstance(version, str) or not version.strip() or len(version) > 120:
        raise ValueError('类目和版本须为 1–120 字')
    suffix = Path(filename).suffix.lower()
    library.workbook(data, suffix)
    info = metadata.inspect(data)
    marketplace = info.get('marketplace')
    if not marketplace or not info.get('account_fingerprint'):
        raise ValueError('请使用包含主站点和账户标识的亚马逊原始模板')
    db = library.connect(Path(root))
    try:
        directory = {r['shop']: dict(r) for r in db.execute('SELECT * FROM shop_registry WHERE marketplace=?', (marketplace,))}
        existing = {(r['shop'],r['marketplace'],r['category'],r['version']): r['sha256'] for r in db.execute('SELECT * FROM templates')}
    finally:
        db.close()
    plans = []
    total = 0
    for shop in shops:
        target = directory.get(shop)
        if not target or not target['seller_id']:
            raise ValueError('“'+shop+'”缺少源模板站点 '+marketplace+' 的完整卖家记号，请重新导入店铺对照表')
        output, audit = replace_identity(data, suffix, target['seller_id'])
        total += len(output)
        if total > 100 * 1024 * 1024:
            raise ValueError('生成文件合计超过 100 MB，请减少目标店铺；尚未入库')
        sha = library.digest(output)
        if save_to_library and existing.get((shop,marketplace,category.strip(),version.strip()),sha) != sha:
            raise ValueError('“'+shop+'”已有同站点、类目、版本的不同文件，请更换批量版本标签；尚未入库')
        name = f'{safe_name(shop)}_{hashlib.sha256(shop.encode()).hexdigest()[:8]}_{marketplace}_{safe_name(category)}_{safe_name(version)}{suffix}'
        plans.append({'shop':shop, 'output_name':name, 'data':output, 'audit':audit, 'sha256':sha, 'account_hint':target['account_hint']})
    report = {'source':filename, 'source_sha256':library.digest(data), 'marketplace':marketplace, 'category':category.strip(), 'version':version.strip(), 'generated':len(plans), 'saved':0, 'reused':0, 'failed':0, 'items':[], 'notes':['仅替换主 Template!A1 contributorId；保留原模板的站点、字段、商品数据、宏及其他元数据，包括来源偏好设置。', '只生成同主站点副本，不把 AE 模板转换成 SA 模板。', '本地结构与目标标识检查不代表亚马逊接受；各店铺处理结果需以亚马逊报告为准。']}
    if info.get('has_prefilled_data'):
        report['notes'].append('源模板已有预填数据，副本原样保留；使用前请核对商品内容。')
    archive = io.BytesIO()
    with tempfile.TemporaryDirectory() as temporary, zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for plan in plans:
            item = {k:v for k,v in plan.items() if k!='data'}
            item['library_status'] = 'not_requested'
            if save_to_library:
                local = Path(temporary)/plan['output_name'];local.write_bytes(plan['data'])
                try:
                    saved = library.run(SimpleNamespace(command='add',library=str(root),source=str(local),marketplace=marketplace,category=category.strip(),version=version.strip(),shop=plan['shop']))
                    item['template_id'] = saved['id']
                    item['library_status'] = 'reused' if saved.get('reused') else 'saved'
                    report[item['library_status']] += 1
                except Exception:
                    item['library_status'] = 'failed'
                    report['failed'] += 1
                    item['error'] = '入库失败；文件已在下载包中保留，请检查磁盘或稍后重试'
            z.writestr(plan['output_name'],plan['data']);report['items'].append(item)
        z.writestr('生成与入库报告.json',json.dumps(report,ensure_ascii=False,indent=2))
    return archive.getvalue(), report

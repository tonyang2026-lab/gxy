"""Read Amazon's template source identity without exposing raw contributor IDs."""
import base64
import hashlib
import io
import json
import re
from urllib.parse import parse_qs
import xml.etree.ElementTree as ET
import zipfile

N = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
MARKETS = {'A2VIGQ35RCS4UG': 'AE', 'A17E79C6D8DWNP': 'SA', 'ATVPDKIKX0DER': 'US', 'A1F83G8C2ARO7P': 'UK', 'A1PA6795UKMFR9': 'DE', 'A13V1IB3VIYZZH': 'FR', 'A1VC38T7YXB528': 'JP', 'A2EUQ1WTGCTBG2': 'CA', 'A39IBJ37TRP1C6': 'AU'}


def parse_xml(raw):
    if re.search(br'<!\s*(DOCTYPE|ENTITY)', raw, re.I):
        raise ValueError('模板 XML 不支持 DTD/实体定义')
    return ET.fromstring(raw)


def inspect(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if 'xl/_rels/workbook.xml.rels' not in z.namelist():
            return {}
        workbook = parse_xml(z.read('xl/workbook.xml'))
        sheet = next((s for s in workbook.findall('s:sheets/s:sheet', N) if s.get('name', '').casefold() in ('template', '模板')), None)
        if sheet is None:
            return {}
        rel = next((r for r in parse_xml(z.read('xl/_rels/workbook.xml.rels')) if r.get('Id') == sheet.get(R) and r.get('TargetMode') != 'External'), None)
        if rel is None:
            return {}
        import posixpath
        target = rel.get('Target', '')
        target = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
        if not target.startswith('xl/') or '..' in target.split('/'):
            raise ValueError('模板工作表路径无效')
        sheet_xml = parse_xml(z.read(target))
        shared = None
        def value(cell):
            nonlocal shared
            if cell.get('t') == 's':
                if shared is None:
                    shared = [''.join(t.text or '' for t in n.findall('.//s:t', N)) for n in parse_xml(z.read('xl/sharedStrings.xml')).findall('s:si', N)]
                return shared[int(cell.findtext('s:v', '', N))]
            if cell.get('t') == 'inlineStr':
                return ''.join(t.text or '' for t in cell.findall('.//s:t', N))
            return cell.findtext('s:v', '', N)
        settings = next((value(c) for c in sheet_xml.findall('s:sheetData/s:row/s:c', N) if c.get('r') == 'A1'), '')
        if not settings.startswith('settings='):
            return {}
        raw = {k: v[0] for k, v in parse_qs(settings[len('settings='):]).items()}
        contributor = raw.get('contributorId', '')
        valid = bool(re.fullmatch(r'amzn1\.cr\.o\.[A-Za-z0-9_-]{1,100}', contributor))
        result = {'account_fingerprint': hashlib.sha256(('amazon-contributor:'+contributor).encode()).hexdigest() if valid else '', 'account_hint': '…'+contributor[-5:] if valid else '', 'marketplace': MARKETS.get(raw.get('primaryMarketplaceId', '').split('.')[-1], ''), 'generated_at': raw.get('timestamp', ''), 'product_types': [], 'data_row': None, 'attribute_row': None, 'field_count': 0, 'has_prefilled_data': False}
        try:
            types = base64.b64decode(raw.get('ptds', ''), validate=True).decode()
            parsed = json.loads(types) if types.startswith('[') else [types]
            result['product_types'] = [p for p in parsed if isinstance(p, str) and re.fullmatch(r'[A-Z0-9_]{1,100}', p)][:30]
        except (ValueError, UnicodeDecodeError, TypeError):
            pass
        for field, key in [('data_row', 'dataRow'), ('attribute_row', 'attributeRow')]:
            if raw.get(key, '').isdigit() and 0 < int(raw[key]) < 10000:
                result[field] = int(raw[key])
        for row in sheet_xml.findall('s:sheetData/s:row', N):
            number = int(row.get('r', '0'))
            if number == result['attribute_row']:
                result['field_count'] = sum(bool(value(c)) for c in row.findall('s:c', N))
            if result['data_row'] and number >= result['data_row'] and any(value(c) or c.find('s:f', N) is not None for c in row.findall('s:c', N)):
                result['has_prefilled_data'] = True
        return result

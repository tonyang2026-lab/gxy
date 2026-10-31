"""Import a private seller directory for source recognition and batch conversion."""
import csv
import hashlib
import io
import re
from pathlib import Path

from . import library


def clean(value):
    return re.sub(r'<br\s*/?>', '', str(value), flags=re.I).strip().strip('`').strip()


def fingerprint(seller):
    if not re.fullmatch(r'A[A-Z0-9]{5,30}', seller):
        raise ValueError('卖家记号应为以 A 开头的大写字母和数字，请检查复制内容')
    return hashlib.sha256(('amazon-contributor:amzn1.cr.o.'+seller).encode()).hexdigest()


def wrapped_rows(lines):
    """Repair copied rendered tables only when complete ID pairs are unambiguous."""
    header = None
    start = 0
    for count in range(1, min(3, len(lines))+1):
        candidate = ' '.join(clean(s) for s in lines[:count])
        match = re.fullmatch(r'(店铺(?:名称)?|shop)\s+(卖家记号阿联酋|阿联酋卖家记号|AE|seller_id_ae)\s+(卖家记号沙特|沙特卖家记号|SA|seller_id_sa)', candidate, re.I)
        if match:
            header=list(match.groups());start=count;break
    if header is None:
        raise ValueError('无法识别粘贴格式，请使用下方逐行编辑表格，或从 Excel 复制三列')
    rows=[header];pending=[]
    seller=r'A[A-Z0-9]{5,30}'
    for line in lines[start:]:
        pending.append(clean(line))
        combined=' '.join(pending)
        match=re.fullmatch(r'(.+?)\s+('+seller+r')\s+('+seller+r')',combined)
        if not match:
            continue
        shop=match[1].strip()
        if re.search(r'(?<![\w-])'+seller+r'(?![\w-])',shop):
            raise ValueError('有一行记号缺失或换行含义不明确，请在逐行表格中核对，未保存任何记录')
        rows.append([shop,match[2],match[3]]);pending=[]
    if pending:
        raise ValueError('末尾店铺行缺少两个完整记号，请改用逐行表格补全，未保存任何记录')
    return rows


def parse(text):
    if not isinstance(text, str) or not text.strip() or len(text) > 100000:
        raise ValueError('请粘贴店铺对照表（最多 10 万字符）')
    lines = [line for line in text.splitlines() if line.strip()]
    if '|' in lines[0]:
        rows = [[clean(v) for v in line.strip().strip('|').split('|')] for line in lines]
        rows = [r for r in rows if not all(re.fullmatch(r'[-:\s]+', c) for c in r)]
    else:
        try:
            dialect = csv.Sniffer().sniff(text[:5000], delimiters='\t,;')
        except csv.Error:
            dialect = csv.excel_tab
        rows = [[clean(v) for v in row] for row in csv.reader(io.StringIO(text), dialect) if any(v.strip() for v in row)]
        if not rows or len(rows[0])!=3 or any(len(r)!=len(rows[0]) for r in rows[1:]):
            if not any(c in lines[0] for c in ',;|'):
                rows=wrapped_rows(lines)
    if len(rows) < 2:
        raise ValueError('对照表必须包含表头和至少一行店铺')
    header = rows[0]
    def column(names):
        found = [i for i, value in enumerate(header) if value.replace(' ', '').casefold() in {n.casefold() for n in names}]
        if len(found) != 1:
            raise ValueError('未找到唯一表头：'+names[0]+'；请保留“店铺、卖家记号阿联酋、卖家记号沙特”三列表头')
        return found[0]
    shop_col = column(['店铺', '店铺名称', 'shop'])
    markets = {'AE': column(['卖家记号阿联酋', '阿联酋卖家记号', 'AE', 'seller_id_ae']), 'SA': column(['卖家记号沙特', '沙特卖家记号', 'SA', 'seller_id_sa'])}
    result = {}
    by_account = {}
    for number, row in enumerate(rows[1:], 2):
        if len(row) != len(header):
            raise ValueError(f'第 {number} 行列数与表头不同，未导入任何记录')
        shop = row[shop_col]
        if not shop or len(shop) > 120 or shop == library.GLOBAL_SHOP:
            raise ValueError(f'第 {number} 行店铺名称无效')
        for market, index in markets.items():
            seller = row[index]
            if seller in ('', '-', '—'):
                continue
            fp = fingerprint(seller)
            if (shop, market) in result and result[(shop, market)]['fingerprint'] != fp:
                raise ValueError('同一店铺站点存在不同卖家记号，未导入任何记录')
            if fp in by_account and by_account[fp] != shop:
                raise ValueError('同一卖家记号对应不同店铺名称，请先统一名称，未导入任何记录')
            by_account[fp] = shop
            result[(shop, market)] = {'shop': shop, 'marketplace': market, 'fingerprint': fp, 'account_hint': '…'+seller[-5:], 'seller_id': seller}
    if not result or len(result) > 1000:
        raise ValueError('对照表需包含 1–1000 条店铺站点记录')
    return list(result.values())


def import_rows(root, rows):
    if not isinstance(rows,list) or not 1<=len(rows)<=500:
        raise ValueError('请填写 1–500 行店铺')
    out=io.StringIO();writer=csv.writer(out);writer.writerow(['店铺','AE','SA'])
    for number,row in enumerate(rows,1):
        if not isinstance(row,dict) or any(not isinstance(row.get(k,''),str) for k in ('shop','ae','sa')):
            raise ValueError(f'第 {number} 行内容格式无效')
        values=[row.get(k,'').strip() for k in ('shop','ae','sa')]
        if not any(values):continue
        if not values[0] or not any(values[1:]):
            raise ValueError(f'第 {number} 行需要店铺名称和至少一个地区的卖家记号')
        for label,value in zip(['阿联酋','沙特'],values[1:]):
            if value and not re.fullmatch(r'A[A-Z0-9]{5,30}',value):
                raise ValueError(f'第 {number} 行{label}记号格式有误，应为以 A 开头的大写字母和数字')
        writer.writerow(values)
    return import_text(root,out.getvalue())


def editable_directory(root):
    db=library.connect(Path(root))
    try:
        groups={}
        for row in db.execute('SELECT * FROM shop_registry ORDER BY shop,marketplace'):
            item=groups.setdefault(row['shop'],{'shop':row['shop'],'ae':'','sa':''})
            item[row['marketplace'].lower()]=row['seller_id']
        return list(groups.values())
    finally:
        db.close()


def apply(db, records, bindings=()):
    for record in records:
        shop, market, fp, hint = (record.get(k) for k in ('shop', 'marketplace', 'fingerprint', 'account_hint'))
        if not isinstance(shop, str) or not shop.strip() or len(shop) > 120 or shop == library.GLOBAL_SHOP or market not in ('AE', 'SA') or not isinstance(fp, str) or not re.fullmatch('[a-f0-9]{64}', fp) or not isinstance(hint, str) or len(hint) > 10:
            raise ValueError('店铺对照记录格式无效')
        seller = record.get('seller_id', '')
        if not isinstance(seller, str) or (seller and fingerprint(seller) != fp):
            raise ValueError('卖家记号与已登记摘要不一致')
        old = db.execute('SELECT shop FROM shop_bindings WHERE fingerprint=?', (fp,)).fetchone()
        if old and old['shop'] != shop:
            raise ValueError(f'来源 {hint} 已绑定“{old["shop"]}”，与“{shop}”不同；请先用设置店铺更正归属')
        old = db.execute('SELECT fingerprint FROM shop_registry WHERE shop=? AND marketplace=?', (shop, market)).fetchone()
        if old and old['fingerprint'] != fp:
            raise ValueError(f'“{shop}”的 {market} 记号与已有登记冲突，未覆盖原记录')
        db.execute('INSERT OR IGNORE INTO shop_bindings VALUES (?,?,?)', (fp, shop, hint))
        db.execute('INSERT INTO shop_registry (shop,marketplace,fingerprint,account_hint,seller_id) VALUES (?,?,?,?,?) ON CONFLICT(shop,marketplace) DO UPDATE SET seller_id=CASE WHEN excluded.seller_id != \'\' THEN excluded.seller_id ELSE shop_registry.seller_id END', (shop, market, fp, hint, seller))
    for binding in bindings:
        # Store manually learned bindings even when no marketplace directory exists.
        fp, shop, hint = (binding.get(k) for k in ('fingerprint', 'shop', 'account_hint'))
        if not isinstance(fp, str) or not re.fullmatch('[a-f0-9]{64}', fp) or not isinstance(shop, str) or not shop.strip() or len(shop) > 120 or shop == library.GLOBAL_SHOP or not isinstance(hint, str) or len(hint) > 10:
            raise ValueError('账户来源绑定格式无效')
        old = db.execute('SELECT shop FROM shop_bindings WHERE fingerprint=?', (fp,)).fetchone()
        if old and old['shop'] != shop:
            raise ValueError('备份店铺来源存在冲突')
        db.execute('INSERT OR IGNORE INTO shop_bindings VALUES (?,?,?)', (fp, shop, hint))


def import_text(root, text):
    records = parse(text)
    db = library.connect(Path(root))
    try:
        db.execute('BEGIN IMMEDIATE')
        apply(db, records)
        db.commit()
    finally:
        db.close()
    return {'shops': len({r['shop'] for r in records}), 'site_records': len(records), 'account_sources': len({r['fingerprint'] for r in records}), 'stored_raw_seller_ids': True}


def targets(root, marketplace):
    db = library.connect(Path(root))
    try:
        return [{'shop': r['shop'], 'marketplace': r['marketplace'], 'account_hint': r['account_hint'], 'can_generate': bool(r['seller_id'])} for r in db.execute('SELECT * FROM shop_registry WHERE marketplace=? ORDER BY shop', (marketplace,))]
    finally:
        db.close()


def directory(root):
    db = library.connect(Path(root))
    try:
        names = {r[0] for r in db.execute('SELECT shop FROM shop_bindings UNION SELECT shop FROM templates UNION SELECT shop FROM shop_registry')}
        return sorted(names | {library.GLOBAL_SHOP})
    finally:
        db.close()

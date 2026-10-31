#!/usr/bin/env python3
"""Byte-preserving, versioned Amazon template library; Python standard library only."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import uuid
import zipfile
from . import metadata

GLOBAL_SHOP = '通用模板'
FIELDS = ('id', 'marketplace', 'category', 'version', 'original_name', 'sha256', 'file', 'created_at', 'shop')


def schema(name):
    return f'CREATE TABLE {name} (id TEXT PRIMARY KEY, marketplace TEXT, category TEXT, version TEXT, original_name TEXT, sha256 TEXT, file TEXT, created_at TEXT, shop TEXT NOT NULL, UNIQUE(shop,marketplace,category,version))'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def workbook(data, suffix):
    import io
    if suffix.lower() not in ('.xlsx', '.xlsm'):
        raise ValueError('只支持 .xlsx 或 .xlsm')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if len(z.infolist()) > 5000 or sum(i.file_size for i in z.infolist()) > 256 * 1024 * 1024:
            raise ValueError('工作簿解压体积过大')
        if not {'[Content_Types].xml', 'xl/workbook.xml'}.issubset(z.namelist()):
            raise ValueError('不是有效的 OOXML 工作簿')
        if z.testzip() is not None:
            raise ValueError('工作簿 ZIP 校验失败')


def connect(root):
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'index.sqlite3')
    db.row_factory = sqlite3.Row
    existing = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='templates'").fetchone()
    if not existing:
        db.execute(schema('templates'))
    elif 'shop' not in {r[1] for r in db.execute('PRAGMA table_info(templates)')}:
        try:
            db.execute('BEGIN IMMEDIATE')
            db.execute(schema('templates_migrated'))
            db.execute('INSERT INTO templates_migrated SELECT id,marketplace,category,version,original_name,sha256,file,created_at,? FROM templates', (GLOBAL_SHOP,))
            db.execute('DROP TABLE templates')
            db.execute('ALTER TABLE templates_migrated RENAME TO templates')
            db.commit()
        except Exception:
            db.rollback(); db.close(); raise
    db.execute('CREATE TABLE IF NOT EXISTS template_metadata (id TEXT PRIMARY KEY, info TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS shop_bindings (fingerprint TEXT PRIMARY KEY, shop TEXT NOT NULL, account_hint TEXT)')
    return db


def account_check(db, info, shop):
    fingerprint = info.get('account_fingerprint')
    if not fingerprint:
        return
    if shop == GLOBAL_SHOP:
        raise ValueError('此模板含账户来源标识，请指定具体店铺，不能作为跨店铺通用模板')
    bound = db.execute('SELECT shop FROM shop_bindings WHERE fingerprint=?', (fingerprint,)).fetchone()
    if bound and bound['shop'] != shop:
        raise ValueError(f"账户来源 {info.get('account_hint')} 已绑定店铺“{bound['shop']}”，不能存入“{shop}”；请核对归属")
    db.execute('INSERT OR IGNORE INTO shop_bindings VALUES (?,?,?)', (fingerprint, shop, info.get('account_hint', '')))


def decorate(root, db, row):
    result = dict(row)
    found = db.execute('SELECT info FROM template_metadata WHERE id=?', (row['id'],)).fetchone()
    if found:
        info = json.loads(found['info'])
    else:
        info = metadata.inspect(verified(root, row))
        db.execute('INSERT INTO template_metadata VALUES (?,?)', (row['id'], json.dumps(info)))
    result['metadata'] = info
    result['account_scope_unknown'] = bool(info.get('account_fingerprint')) and row['shop'] == GLOBAL_SHOP
    return result


def inspect_template(root, data, suffix):
    workbook(data, suffix)
    info = metadata.inspect(data)
    db = connect(Path(root))
    try:
        bound = db.execute('SELECT shop FROM shop_bindings WHERE fingerprint=?', (info.get('account_fingerprint', ''),)).fetchone()
        return {'metadata': info, 'recognized_shop': bound['shop'] if bound else None}
    finally:
        db.close()


def verified(root, row):
    name = row['file']
    if Path(name).name != name or name in ('', '.', '..'):
        raise ValueError('非法文件路径')
    data = (root / 'files' / name).read_bytes()
    if digest(data) != row['sha256']:
        raise ValueError('原件哈希不符：' + row['id'])
    workbook(data, Path(name).suffix)
    return data


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as f:
        f.write(data)


def move_shop(root, ident, shop):
    if not isinstance(shop, str) or not shop.strip() or len(shop.strip()) > 120:
        raise ValueError('店铺名称须为 1–120 字')
    db = connect(Path(root))
    try:
        db.execute('BEGIN IMMEDIATE')
        found = db.execute('SELECT * FROM templates WHERE id=?', (ident,)).fetchone()
        if found is None:
            raise ValueError('模板不存在')
        info = metadata.inspect(verified(Path(root), found))
        fingerprint = info.get('account_fingerprint')
        ids = [ident]
        if fingerprint:
            if shop.strip() == GLOBAL_SHOP:
                raise ValueError('含账户来源标识的模板不能设为通用模板')
            # Move all templates from this account atomically, never split one identity.
            all_rows = db.execute('SELECT * FROM templates').fetchall()
            for row in all_rows:
                decorated = decorate(Path(root), db, row)
                if decorated['metadata'].get('account_fingerprint') == fingerprint and row['id'] not in ids:
                    ids.append(row['id'])
        try:
            for row_id in ids:
                db.execute('UPDATE templates SET shop=? WHERE id=?', (shop.strip(), row_id))
        except sqlite3.IntegrityError:
            raise ValueError('目标店铺已有同站点、类目和版本，未覆盖任何模板') from None
        if fingerprint:
            db.execute('INSERT OR REPLACE INTO shop_bindings VALUES (?,?,?)', (fingerprint, shop.strip(), info.get('account_hint', '')))
        row = dict(db.execute('SELECT * FROM templates WHERE id=?', (ident,)).fetchone())
        row['moved_count'] = len(ids)
        db.commit()
        return row
    finally:
        db.close()


def run(a):
    root = Path(a.library).expanduser().resolve()
    if a.command == 'restore':
        if root.exists():
            raise ValueError('恢复目录必须不存在，避免覆盖现有库')
        root.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root.parent) as tmp:
            stage = Path(tmp) / 'library'
            stage.mkdir()
            with zipfile.ZipFile(a.source) as z:
                if len(z.infolist()) > 10000 or sum(i.file_size for i in z.infolist()) > 512 * 1024 * 1024:
                    raise ValueError('备份解压体积过大')
                manifest = json.loads(z.read('manifest.json'))
                if manifest.get('schema_version') not in (1, 2, 3):
                    raise ValueError('不支持的备份版本')
                db = connect(stage)
                try:
                    for row in manifest['templates']:
                        row = dict(row)
                        row.setdefault('shop', GLOBAL_SHOP)
                        if not isinstance(row['shop'], str) or not row['shop'].strip() or len(row['shop']) > 120:
                            raise ValueError('备份店铺名称无效')
                        name = row['file']
                        if Path(name).name != name or name in ('', '.', '..'):
                            raise ValueError('非法备份路径')
                        data = z.read('files/' + name)
                        if digest(data) != row['sha256']:
                            raise ValueError('备份哈希校验失败')
                        workbook(data, Path(name).suffix)
                        info = metadata.inspect(data)
                        if row['shop'] != GLOBAL_SHOP:
                            account_check(db, info, row['shop'])
                        write_new(stage / 'files' / name, data)
                        db.execute('INSERT INTO templates VALUES (?,?,?,?,?,?,?,?,?)', tuple(row[k] for k in FIELDS))
                        db.execute('INSERT INTO template_metadata VALUES (?,?)', (row['id'], json.dumps(info)))
                    db.commit()
                finally:
                    db.close()
            stage.rename(root)
        return {'restored': str(root), 'count': len(manifest['templates'])}
    db = connect(root)
    try:
        if a.command == 'add':
            source = Path(a.source)
            data = source.read_bytes()
            workbook(data, source.suffix)
            info = metadata.inspect(data)
            market = a.marketplace.strip().upper()
            category, version = a.category.strip(), a.version.strip()
            shop = getattr(a, 'shop', GLOBAL_SHOP).strip()
            if not shop or len(shop) > 120:
                raise ValueError('店铺名称须为 1–120 字')
            if not all((market, category, version)):
                raise ValueError('站点、类目和版本不能为空')
            db.execute('BEGIN IMMEDIATE')
            if info.get('marketplace') and info['marketplace'] != market:
                raise ValueError('模板内部主站点为 '+info['marketplace']+'，与所选站点不同')
            account_check(db, info, shop)
            old = db.execute('SELECT * FROM templates WHERE shop=? AND marketplace=? AND category=? AND version=?', (shop, market, category, version)).fetchone()
            if old:
                if old['sha256'] != digest(data):
                    raise ValueError('版本已存在且内容不同；请使用新的版本标签')
                verified(root, old)
                db.commit()
                return {'reused': True, **dict(old)}
            ident = uuid.uuid4().hex
            name = ident + source.suffix.lower()
            row = (ident, market, category, version, source.name, digest(data), name, datetime.datetime.now(datetime.timezone.utc).isoformat(), shop)
            write_new(root / 'files' / name, data)
            try:
                db.execute('INSERT INTO templates VALUES (?,?,?,?,?,?,?,?,?)', row)
                stored = db.execute('SELECT * FROM templates WHERE id=?', (ident,)).fetchone()
                db.execute('INSERT INTO template_metadata VALUES (?,?)', (ident, json.dumps(info)))
                verified(root, stored)
                db.commit()
            except Exception:
                db.rollback()
                (root / 'files' / name).unlink(missing_ok=True)
                raise
            return dict(stored)
        if a.command == 'list':
            rows = db.execute('SELECT * FROM templates ORDER BY created_at DESC').fetchall()
            decorated = [decorate(root, db, r) for r in rows if (not a.marketplace or r['marketplace'] == a.marketplace.strip().upper()) and (not a.category or r['category'] == a.category) and (not getattr(a, 'shop', None) or r['shop'] == a.shop)]
            db.commit()
            return decorated
        if a.command == 'checkout':
            row = db.execute('SELECT * FROM templates WHERE id=?', (a.id,)).fetchone()
            if row is None:
                raise ValueError('模板 ID 不存在')
            output = Path(a.output).resolve()
            if output.is_relative_to(root):
                raise ValueError('工作副本必须位于模板库外')
            if output.suffix.lower() != Path(row['file']).suffix:
                raise ValueError('副本扩展名必须与原件一致')
            write_new(output, verified(root, row))
            return {'output': str(output), 'sha256': row['sha256'], 'id': a.id}
        if a.command == 'backup':
            db.execute('BEGIN')
            rows = [dict(r) for r in db.execute('SELECT * FROM templates ORDER BY created_at')]
            output = Path(a.output).resolve()
            if output.is_relative_to(root):
                raise ValueError('备份必须位于模板库外')
            output.parent.mkdir(parents=True, exist_ok=True)
            try:
                f = output.open('xb')
            except FileExistsError:
                raise ValueError('备份输出已存在')
            try:
                with f, zipfile.ZipFile(f, 'w', zipfile.ZIP_DEFLATED) as z:
                    z.writestr('manifest.json', json.dumps({'schema_version': 3, 'templates': rows}, ensure_ascii=False))
                    for row in rows:
                        z.writestr('files/' + row['file'], verified(root, row))
            except Exception:
                output.unlink(missing_ok=True)
                raise
            return {'backup': str(output), 'count': len(rows), 'sha256': digest(output.read_bytes())}
    finally:
        db.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--library', default=os.environ.get('AMZ_TEMPLATE_LIBRARY', '/workspace/amazon-template-library'))
    sub = p.add_subparsers(dest='command', required=True)
    add = sub.add_parser('add')
    add.add_argument('source')
    for field in ('marketplace', 'category', 'version'):
        add.add_argument('--' + field, required=True)
    add.add_argument('--shop', default=GLOBAL_SHOP)
    ls = sub.add_parser('list')
    ls.add_argument('--marketplace')
    ls.add_argument('--category')
    ls.add_argument('--shop')
    co = sub.add_parser('checkout')
    co.add_argument('id')
    co.add_argument('output')
    sub.add_parser('backup').add_argument('output')
    sub.add_parser('restore').add_argument('source')
    try:
        print(json.dumps(run(p.parse_args()), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, sqlite3.Error, zipfile.BadZipFile) as e:
        p.exit(1, '错误：' + str(e) + '\n')


if __name__ == '__main__':
    main()

import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
import zipfile

from template_manager import library, inventory
from test_inventory import make_book, template


class ShopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root/'template.xlsx'
        self.source.write_bytes(make_book({'Template': [['sku', 'title']]}))
        self.lib = self.root/'library'

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, shop):
        return library.run(SimpleNamespace(command='add', library=str(self.lib), source=str(self.source), marketplace='AE', category='行李箱', version='v1', shop=shop))

    def test_same_category_version_can_belong_to_two_shops(self):
        a, b = self.add('A店'), self.add('B店')
        self.assertNotEqual(a['id'], b['id'])
        rows = library.run(SimpleNamespace(command='list', library=str(self.lib), marketplace=None, category=None, shop='A店'))
        self.assertEqual([r['id'] for r in rows], [a['id']])

    def test_legacy_schema_migration_preserves_rows_and_hash(self):
        self.lib.mkdir()
        db = sqlite3.connect(self.lib/'index.sqlite3')
        db.execute('CREATE TABLE templates (id TEXT PRIMARY KEY, marketplace TEXT, category TEXT, version TEXT, original_name TEXT, sha256 TEXT, file TEXT, created_at TEXT, UNIQUE(marketplace,category,version))')
        db.execute('INSERT INTO templates VALUES (?,?,?,?,?,?,?,?)', ('old-id', 'AE', '行李箱', 'v1', 'original.xlsx', library.digest(self.source.read_bytes()), 'old.xlsx', '2026-10-31'))
        db.commit();db.close()
        (self.lib/'files').mkdir();(self.lib/'files/old.xlsx').write_bytes(self.source.read_bytes())
        rows = library.run(SimpleNamespace(command='list', library=str(self.lib), marketplace=None, category=None))
        self.assertEqual(rows[0]['shop'], library.GLOBAL_SHOP)
        self.assertEqual(rows[0]['id'], 'old-id')
        self.assertEqual(library.verified(self.lib, rows[0]), self.source.read_bytes())
        self.add('A店')

    def test_shop_scope_and_generic_fallback(self):
        a = {**template(category='行李箱'), 'id': 'A-only', 'shop': 'A店'}
        general = {**template(category='行李箱', created='2026-12-01'), 'id': 'shared', 'shop': library.GLOBAL_SHOP}
        data = 'SKU,类目\nDEMO-LUG-001,行李箱\n'.encode()
        r = inventory.analyze(data, 'stock.csv', 'AE', [a], sheet='CSV', shop='B店')
        self.assertEqual(r['summary']['missing'], 1)
        r = inventory.analyze(data, 'stock.csv', 'AE', [a, general], sheet='CSV', shop='A店')
        self.assertEqual(r['items'][0]['template']['id'], 'A-only')
        r = inventory.analyze(data, 'stock.csv', 'AE', [a, general], sheet='CSV', shop='B店')
        self.assertEqual(r['items'][0]['template']['id'], 'shared')

    def test_move_shop_conflict_never_overwrites(self):
        a, b = self.add('A店'), self.add('B店')
        with self.assertRaisesRegex(ValueError, '未覆盖'):
            library.move_shop(self.lib, a['id'], 'B店')
        row = library.move_shop(self.lib, a['id'], 'C店')
        self.assertEqual(row['shop'], 'C店')
        self.assertEqual(library.verified(self.lib, row), self.source.read_bytes())

    def test_new_backup_retains_shop_and_old_backup_restores_generic(self):
        a = self.add('A店')
        backup = self.root/'new.zip'
        library.run(SimpleNamespace(command='backup', library=str(self.lib), output=str(backup)))
        target = self.root/'restored'
        library.run(SimpleNamespace(command='restore', library=str(target), source=str(backup)))
        restored = library.run(SimpleNamespace(command='list', library=str(target), marketplace=None, category=None))
        self.assertEqual(restored[0]['shop'], 'A店')
        legacy = self.root/'old.zip'
        old = {k: v for k, v in a.items() if k != 'shop'}
        with zipfile.ZipFile(legacy, 'w') as z:
            z.writestr('manifest.json', json.dumps({'schema_version': 1, 'templates': [old]}))
            z.writestr('files/'+old['file'], self.source.read_bytes())
        target = self.root/'old-restored'
        library.run(SimpleNamespace(command='restore', library=str(target), source=str(legacy)))
        restored = library.run(SimpleNamespace(command='list', library=str(target), marketplace=None, category=None))
        self.assertEqual(restored[0]['shop'], library.GLOBAL_SHOP)


if __name__ == '__main__':
    unittest.main()

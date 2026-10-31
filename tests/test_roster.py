from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from template_manager import roster, library
from test_metadata import account_book


TABLE = '| 店铺 | 卖家记号阿联酋 | 卖家记号沙特 |\n| --- | --- | --- |\n| 测试甲<br> | ATEST001 | ATEST002 |\n| 测试乙 | ATEST003 | ATEST003 |\n'


class RosterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)/'library'

    def tearDown(self):
        self.tmp.cleanup()

    def test_markdown_and_different_market_ids(self):
        result = roster.import_text(self.root, TABLE)
        self.assertEqual(result['shops'], 2)
        self.assertEqual(result['site_records'], 4)
        self.assertEqual(result['account_sources'], 3)
        self.assertEqual(roster.directory(self.root), ['测试乙', '测试甲', '通用模板'])
        recognized = library.inspect_template(self.root, account_book(account='ATEST001'), '.xlsm')
        self.assertEqual(recognized['recognized_shop'], '测试甲')

    def test_excel_clipboard_and_csv(self):
        for text in ['店铺\t卖家记号阿联酋\t卖家记号沙特\n测试甲\tATEST001\tATEST002', '店铺,AE,SA\n测试甲,ATEST001,ATEST002']:
            self.assertEqual(len(roster.parse(text)), 2)

    def test_unknown_account_remains_unknown(self):
        roster.import_text(self.root, TABLE)
        self.assertIsNone(library.inspect_template(self.root, account_book(account='ATEST999'), '.xlsm')['recognized_shop'])

    def test_invalid_or_conflicting_table_no_partial_import(self):
        roster.import_text(self.root, TABLE)
        with self.assertRaisesRegex(ValueError, '已绑定'):
            roster.import_text(self.root, '店铺,AE,SA\n新店,ATEST004,ATEST004\n错误店,ATEST001,ATEST001')
        self.assertNotIn('新店', roster.directory(self.root))
        with self.assertRaisesRegex(ValueError, '对应不同店铺'):
            roster.parse('店铺,AE,SA\n甲店,ATEST001,ATEST001\n乙店,ATEST001,ATEST002')

    def test_registry_primary_marketplace_must_match(self):
        roster.import_text(self.root, TABLE)
        file = Path(self.tmp.name)/'template.xlsm'
        file.write_bytes(account_book(account='ATEST002'))  # This ID registered for SA, template declares AE.
        with self.assertRaisesRegex(ValueError, '该站点'):
            library.run(SimpleNamespace(command='add', library=str(self.root), source=str(file), marketplace='AE', category='行李箱', version='v1', shop='测试甲'))

    def test_directory_only_backup_restores_without_template_uploads(self):
        roster.import_text(self.root, TABLE)
        backup = Path(self.tmp.name)/'backup.zip'
        library.run(SimpleNamespace(command='backup', library=str(self.root), output=str(backup)))
        restored = Path(self.tmp.name)/'restored'
        library.run(SimpleNamespace(command='restore', library=str(restored), source=str(backup)))
        self.assertEqual(roster.directory(restored), roster.directory(self.root))
        self.assertEqual(library.inspect_template(restored, account_book(account='ATEST003'), '.xlsm')['recognized_shop'], '测试乙')
        db = (restored/'index.sqlite3').read_bytes()
        self.assertIn(b'ATEST003', db)  # Private raw IDs are required to generate other shops' copies.
        self.assertTrue(all(t['can_generate'] for t in roster.targets(restored,'AE')))


if __name__ == '__main__':
    unittest.main()

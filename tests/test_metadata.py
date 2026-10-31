import base64
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
from urllib.parse import urlencode
import unittest
import zipfile

from template_manager import metadata, library
from test_inventory import make_book


def account_book(account='TEST_ACCOUNT_A', timestamp='2026-10-31T06:00:00Z'):
    settings = 'settings='+urlencode({'contributorId': 'amzn1.cr.o.'+account, 'primaryMarketplaceId': 'amzn1.mp.o.A2VIGQ35RCS4UG', 'ptds': base64.b64encode(b'SUITCASE').decode(), 'attributeRow': '3', 'dataRow': '5', 'timestamp': timestamp})
    return make_book({'Template': [[settings], ['labels'], ['sku', 'product_type'], [], ['DEMO', 'SUITCASE']]})


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root/'renamed.xlsm'
        self.source.write_bytes(account_book())
        self.lib = self.root/'library'

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, shop, version='v1'):
        return library.run(SimpleNamespace(command='add', library=str(self.lib), source=str(self.source), marketplace='AE', category='行李箱', version=version, shop=shop))

    def test_metadata_reads_identity_scope_and_layout(self):
        info = metadata.inspect(self.source.read_bytes())
        self.assertEqual(info['marketplace'], 'AE')
        self.assertEqual(info['product_types'], ['SUITCASE'])
        self.assertEqual(info['field_count'], 2)
        self.assertEqual(info['data_row'], 5)
        self.assertTrue(info['has_prefilled_data'])
        self.assertNotIn('amzn1.cr.o.TEST_ACCOUNT_A', str(info))

    def test_identity_stable_across_timestamps_but_not_accounts(self):
        a = metadata.inspect(account_book())['account_fingerprint']
        b = metadata.inspect(account_book(timestamp='2026-11-01T06:00:00Z'))['account_fingerprint']
        c = metadata.inspect(account_book(account='TEST_ACCOUNT_B'))['account_fingerprint']
        self.assertEqual(a, b);self.assertNotEqual(a, c)

    def test_binding_recognizes_later_templates_and_rejects_wrong_shop(self):
        self.assertIsNone(library.inspect_template(self.lib, self.source.read_bytes(), '.xlsm')['recognized_shop'])
        self.add('测试店A')
        self.assertEqual(library.inspect_template(self.lib, account_book(timestamp='later'), '.xlsm')['recognized_shop'], '测试店A')
        with self.assertRaisesRegex(ValueError, '已绑定'):
            self.add('测试店B')
        with self.assertRaisesRegex(ValueError, '不能作为'):
            self.add(library.GLOBAL_SHOP)

    def test_atomic_account_reassignment_moves_all_versions(self):
        first=self.add('测试店A');second=self.add('测试店A', 'v2')
        moved=library.move_shop(self.lib, first['id'], '更正店铺')
        self.assertEqual(moved['moved_count'], 2)
        rows=library.run(SimpleNamespace(command='list', library=str(self.lib), marketplace=None, category=None))
        self.assertEqual({r['shop'] for r in rows}, {'更正店铺'})
        self.assertEqual(library.inspect_template(self.lib, self.source.read_bytes(), '.xlsm')['recognized_shop'], '更正店铺')

    def test_backup_restores_binding_from_original_metadata(self):
        self.add('测试店A');backup=self.root/'backup.zip'
        library.run(SimpleNamespace(command='backup',library=str(self.lib),output=str(backup)))
        restored=self.root/'restored'
        library.run(SimpleNamespace(command='restore',library=str(restored),source=str(backup)))
        self.assertEqual(library.inspect_template(restored,self.source.read_bytes(),'.xlsm')['recognized_shop'],'测试店A')


if __name__ == '__main__':
    unittest.main()

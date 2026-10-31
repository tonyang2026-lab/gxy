import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from xml.sax.saxutils import escape
import zipfile

from template_manager import batch, library, metadata, roster
from test_metadata import account_book
from test_roster import TABLE


def shared_book():
    source = account_book(account='ATEST001')
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(source)) as src, zipfile.ZipFile(out,'w') as dest:
        for part in src.infolist():
            raw = src.read(part.filename)
            if part.filename=='xl/worksheets/sheet1.xml':
                sheet=metadata.parse_xml(raw)
                setting=''.join(t.text or '' for t in sheet.find("s:sheetData/s:row/s:c[@r='A1']",metadata.N).findall('.//s:t',metadata.N))
                start=raw.index(b'<c r="A1"');end=raw.index(b'</c>',start)+4
                raw=raw[:start]+b'<c r="A1" t="s"><v>0</v></c>'+raw[end:]
                raw=raw.replace(b'</sheetData>',b'<row r="9"><c r="A9" t="s"><v>0</v></c></row></sheetData>')
            dest.writestr(part,raw)
        dest.writestr('xl/sharedStrings.xml','<sst xmlns="'+metadata.N['s']+'" count="2" uniqueCount="1"><si><t>'+escape(setting)+'</t></si></sst>')
        dest.writestr('xl/vbaProject.bin',b'fixture-macro-bytes')
        dest.writestr('xl/media/example.png',b'fixture-image-bytes')
    return out.getvalue()


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'library';roster.import_text(self.root,TABLE)

    def tearDown(self):
        self.tmp.cleanup()

    def test_inline_replacement_and_same_account_no_change(self):
        source=account_book(account='ATEST001');output,audit=batch.replace_identity(source,'.xlsm','ATEST003')
        self.assertEqual(metadata.inspect(output)['account_fingerprint'],roster.fingerprint('ATEST003'))
        self.assertEqual(audit['changed_parts'],['xl/worksheets/sheet1.xml'])
        same,audit=batch.replace_identity(source,'.xlsm','ATEST001');self.assertEqual(same,source);self.assertFalse(audit['changed'])

    def test_shared_metadata_preserves_other_references_and_macros(self):
        source=shared_book();output,audit=batch.replace_identity(source,'.xlsm','ATEST003')
        self.assertEqual(metadata.inspect(output)['account_fingerprint'],roster.fingerprint('ATEST003'))
        with zipfile.ZipFile(io.BytesIO(source)) as a,zipfile.ZipFile(io.BytesIO(output)) as b:
            for name in a.namelist():
                if name not in audit['changed_parts']:self.assertEqual(a.read(name),b.read(name))
            self.assertEqual(b.read('xl/vbaProject.bin'),b'fixture-macro-bytes')
            sheet=metadata.parse_xml(b.read('xl/worksheets/sheet1.xml'))
            self.assertEqual(sheet.findtext("s:sheetData/s:row/s:c[@r='A9']/s:v",namespaces=metadata.N),'0')
            original=metadata.parse_xml(b.read('xl/sharedStrings.xml')).findall('s:si',metadata.N)[0]
            self.assertIn('ATEST001',''.join(original.itertext()))

    def test_generate_and_store_without_individual_uploads(self):
        source=account_book(account='ATEST001')
        archive,report=batch.generate(self.root,source,'source.xlsm',['测试甲','测试乙'],'行李箱','batch-v1')
        self.assertEqual((report['generated'],report['saved'],report['failed']),(2,2,0))
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertEqual(len(z.namelist()),3)
            self.assertEqual(json.loads(z.read('生成与入库报告.json'))['marketplace'],'AE')
        rows=library.run(SimpleNamespace(command='list',library=str(self.root),marketplace=None,category=None))
        by_shop={r['shop']:r for r in rows}
        for shop,seller in [('测试甲','ATEST001'),('测试乙','ATEST003')]:
            self.assertEqual(metadata.inspect(library.verified(self.root,by_shop[shop]))['account_fingerprint'],roster.fingerprint(seller))
        _,again=batch.generate(self.root,source,'source.xlsm',['测试甲','测试乙'],'行李箱','batch-v1')
        self.assertEqual(again['reused'],2)

    def test_only_same_primary_region_target_allowed(self):
        roster.import_text(self.root,'店铺,AE,SA\n仅沙特,,ATEST005')
        with self.assertRaisesRegex(ValueError,'站点 AE'):
            batch.generate(self.root,account_book(account='ATEST001'),'source.xlsm',['仅沙特'],'行李箱','v1')
        self.assertNotIn('仅沙特',[t['shop'] for t in roster.targets(self.root,'AE')])

    def test_missing_raw_ids_requires_reimport_not_hash_reversal(self):
        db=library.connect(self.root);db.execute("UPDATE shop_registry SET seller_id='' WHERE shop='测试乙'");db.commit();db.close()
        with self.assertRaisesRegex(ValueError,'重新导入'):
            batch.generate(self.root,account_book(account='ATEST001'),'source.xlsm',['测试乙'],'行李箱','v1')

    def test_sa_source_uses_sa_seller_ids(self):
        out=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(account_book(account='ATEST002'))) as src,zipfile.ZipFile(out,'w') as dest:
            for info in src.infolist():
                raw=src.read(info.filename)
                if info.filename=='xl/worksheets/sheet1.xml':raw=raw.replace(b'A2VIGQ35RCS4UG',b'A17E79C6D8DWNP')
                dest.writestr(info,raw)
        source=out.getvalue()
        _,report=batch.generate(self.root,source,'source-sa.xlsm',['测试甲'],'行李箱','sa-v1')
        self.assertEqual(report['marketplace'],'SA')
        rows=library.run(SimpleNamespace(command='list',library=str(self.root),marketplace='SA',category=None))
        self.assertEqual(metadata.inspect(library.verified(self.root,rows[0]))['account_fingerprint'],roster.fingerprint('ATEST002'))

    def test_version_conflict_preflight_does_not_partially_store(self):
        source=account_book(account='ATEST001')
        batch.generate(self.root,source,'a.xlsm',['测试乙'],'行李箱','v1')
        with self.assertRaisesRegex(ValueError,'尚未入库'):
            batch.generate(self.root,account_book(account='ATEST001',timestamp='new-source'),'b.xlsm',['测试甲','测试乙'],'行李箱','v1')
        rows=library.run(SimpleNamespace(command='list',library=str(self.root),marketplace=None,category=None))
        self.assertEqual(len(rows),1)


if __name__=='__main__':unittest.main()

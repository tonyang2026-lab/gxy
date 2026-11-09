import base64
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import unquote
import zipfile

from app import create_server
from template_manager import batch, library, roster
from test_metadata import account_book
from test_roster import TABLE

BASE='2026-11-09-批量'


class AutomaticVersionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'library';roster.import_text(self.root,TABLE)
        self.clock=patch.object(batch,'version_base',return_value=BASE);self.clock.start()

    def tearDown(self):self.clock.stop();self.temp.cleanup()

    def generate(self,source=None,shops=None,category='行李箱',version=None,**kwargs):
        return batch.generate(self.root,source or account_book(account='ATEST001'),'source.xlsm',shops or ['测试甲','测试乙'],category,version,auto_version=True,**kwargs)

    def rows(self):return library.run(SimpleNamespace(command='list',library=str(self.root),marketplace=None,category=None))

    def test_changed_source_same_day_and_repeated_clicks_create_distinct_versions(self):
        _,first=self.generate(create_archive=False);original={t['id']:library.verified(self.root,t) for t in self.rows()}
        source=account_book(account='ATEST001',timestamp='new-content')
        archive,second=self.generate(source);_,third=self.generate(source,create_archive=False)
        self.assertEqual([r['version'] for r in (first,second,third)],[BASE,BASE+'-02',BASE+'-03'])
        self.assertEqual([r['saved'] for r in (first,second,third)],[2,2,2]);self.assertEqual(len(self.rows()),6)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:self.assertEqual(json.loads(z.read('生成与入库报告.json'))['version'],second['version'])
        for row in self.rows():
            if row['id'] in original:self.assertEqual(library.verified(self.root,row),original[row['id']])

    def test_highest_selected_shop_sequence_and_independent_scopes(self):
        source=account_book(account='ATEST001')
        batch.generate(self.root,source,'a.xlsm',['测试乙'],'行李箱',BASE+'-08',create_archive=False)
        _,result=self.generate(create_archive=False);self.assertEqual(result['version'],BASE+'-09')
        _,other_category=self.generate(category='其他类目',create_archive=False);self.assertEqual(other_category['version'],BASE)
        _,other_type=self.generate(table_type='price_update',create_archive=False);self.assertEqual(other_type['version'],BASE)
        # An unrelated shop's higher sequence must not affect this selection.
        batch.generate(self.root,source,'a.xlsm',['测试乙'],'行李箱',BASE+'-20',create_archive=False)
        _,one=self.generate(shops=['测试甲'],create_archive=False);self.assertEqual(one['version'],BASE+'-10')
        # Change market within the ZIP, retaining the valid workbook container.
        output=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(source)) as src,zipfile.ZipFile(output,'w') as dest:
            for part in src.infolist():dest.writestr(part,src.read(part.filename).replace(b'A2VIGQ35RCS4UG',b'A17E79C6D8DWNP'))
        _,sa=self.generate(output.getvalue(),shops=['测试甲'],create_archive=False);self.assertEqual(sa['version'],BASE)

    def test_manual_versions_and_partial_retry_keep_existing_reuse_behavior(self):
        source=account_book(account='ATEST001');real_run=library.run
        def save(args):
            if args.command=='add' and args.shop=='测试乙':raise OSError('disk failure')
            return real_run(args)
        with patch.object(library,'run',side_effect=save):_,first=self.generate(create_archive=False)
        self.assertEqual((first['saved'],first['failed']),(1,1))
        _,retry=batch.generate(self.root,source,'a.xlsm',['测试甲','测试乙'],'行李箱',first['version'],create_archive=False)
        self.assertEqual((retry['saved'],retry['reused'],retry['failed']),(1,1,0));self.assertEqual(len(self.rows()),2)
        _,custom=batch.generate(self.root,source,'a.xlsm',['测试甲'],'行李箱','活动专用',create_archive=False)
        self.assertEqual(custom['version'],'活动专用')
        with self.assertRaisesRegex(ValueError,'尚未入库'):batch.generate(self.root,account_book(account='ATEST001',timestamp='changed'),'b.xlsm',['测试甲'],'行李箱','活动专用',create_archive=False)

    def test_new_day_and_download_only_and_invalid_flag(self):
        self.generate(create_archive=False)
        with patch.object(batch,'version_base',return_value='2026-11-10-批量'):
            _,new_day=self.generate(create_archive=False);self.assertEqual(new_day['version'],'2026-11-10-批量')
        before=len(self.rows());archive,report=self.generate(save_to_library=False)
        self.assertTrue(archive);self.assertEqual(report['saved'],0);self.assertEqual(len(self.rows()),before)
        with self.assertRaisesRegex(ValueError,'自动版本'):batch.generate(self.root,account_book(account='ATEST001'),'a.xlsm',['测试甲'],'行李箱',BASE,auto_version='true')
        self.assertEqual(len(self.rows()),before)


class AutomaticVersionAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)/'library';roster.import_text(cls.root,TABLE);cls.server=create_server(cls.root,0)
        cls.server.auth.create('owner','batch-test-password','admin');threading.Thread(target=cls.server.serve_forever,daemon=True).start()

    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.temp.cleanup()

    def request(self,path,body,cookie=None):
        c=HTTPConnection('127.0.0.1',self.server.server_port,timeout=20);headers={'Content-Type':'application/json','X-Template-Request':'1'}
        if cookie:headers['Cookie']=cookie
        c.request('POST',path,json.dumps(body),headers);r=c.getresponse();result=(r.status,r.read(),dict(r.getheaders()));c.close();return result

    def test_concurrent_generation_and_zip_header_report_agree(self):
        status,_,headers=self.request('/api/login',{'username':'owner','password':'batch-test-password'});self.assertEqual(status,200)
        cookie=headers['Set-Cookie'].split(';')[0]
        body={'filename':'a.xlsm','data':base64.b64encode(account_book(account='ATEST001')).decode(),'shops':['测试甲'],'category':'并发测试','auto_version':True,'download_zip':False}
        with patch.object(batch,'version_base',return_value=BASE),ThreadPoolExecutor(max_workers=3) as pool:
            results=list(pool.map(lambda _:self.request('/api/template/batch',body,cookie),range(3)))
            self.assertEqual([r[0] for r in results],[200,200,200])
            self.assertEqual({json.loads(r[1])['version'] for r in results},{BASE,BASE+'-02',BASE+'-03'})
            status,raw,headers=self.request('/api/template/batch',{**body,'download_zip':True},cookie)
        self.assertEqual(status,200)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:report=json.loads(z.read('生成与入库报告.json'))
        self.assertEqual(unquote(headers['X-Batch-Version']),BASE+'-04');self.assertEqual(report['version'],BASE+'-04')

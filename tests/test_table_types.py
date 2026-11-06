import base64
from http.client import HTTPConnection
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from app import create_server
from template_manager import library, inventory, ai, batch, roster
from test_inventory import make_book, template
from test_metadata import account_book
from test_roster import TABLE


class TableTypeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base/'library'
        self.source = self.base/'source.xlsm'
        self.raw = make_book({'Template': [['sku', 'price'], ['SKU1', '10']]})
        self.source.write_bytes(self.raw)

    def tearDown(self):
        self.temp.cleanup()

    def add(self, table_type='upload', version='v1', shop='测试店'):
        return library.run(SimpleNamespace(command='add', library=str(self.root), source=str(self.source),
                                          shop=shop, marketplace='AE', category='PRODUCT', version=version, table_type=table_type))

    def rows(self, table_type=None):
        return library.run(SimpleNamespace(command='list', library=str(self.root), marketplace=None, category=None, table_type=table_type))

    def test_types_coexist_but_conflicting_content_in_same_type_is_rejected(self):
        upload = self.add()
        changed = make_book({'Template': [['sku', 'price'], ['SKU1', '20']]})
        self.source.write_bytes(changed)
        price = self.add('price_update')
        self.assertNotEqual(upload['id'], price['id'])
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(self.rows('price_update')[0]['id'], price['id'])
        self.assertTrue(self.add('price_update')['reused'])
        with self.assertRaisesRegex(ValueError, '内容不同'):
            self.add()
        self.assertEqual(library.verified(self.root, upload), self.raw)
        self.assertEqual(library.verified(self.root, price), changed)
        library.delete_template(self.root, upload['id'])
        self.assertEqual(library.verified(self.root, price), changed)
        with self.assertRaisesRegex(ValueError, '表格类型'):
            self.add('other')

    def test_shop_schema_migration_keeps_id_bytes_and_removes_old_unique_limit(self):
        self.root.mkdir();(self.root/'files').mkdir()
        (self.root/'files/old.xlsm').write_bytes(self.raw)
        with sqlite3.connect(self.root/'index.sqlite3') as db:
            db.execute('CREATE TABLE templates (id TEXT PRIMARY KEY,marketplace TEXT,category TEXT,version TEXT,original_name TEXT,sha256 TEXT,file TEXT,created_at TEXT,shop TEXT NOT NULL,UNIQUE(shop,marketplace,category,version))')
            db.execute('INSERT INTO templates VALUES (?,?,?,?,?,?,?,?,?)', ('old','AE','PRODUCT','v1','original.xlsm',library.digest(self.raw),'old.xlsm','2026-11-01','测试店'))
        old = self.rows()[0]
        self.assertEqual((old['id'], old['table_type']), ('old', 'upload'))
        self.assertEqual(library.verified(self.root, old), self.raw)
        self.add('price_update')
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual({r['table_type'] for r in self.rows()}, {'upload','price_update'})
        self.assertEqual(library.verified(self.root, old), self.raw)

    def test_reclassification_is_metadata_only_and_conflict_rolls_back(self):
        upload, price = self.add(), self.add('price_update')
        with self.assertRaisesRegex(ValueError, '未覆盖'):
            library.change_table_type(self.root, upload['id'], 'price_update')
        self.assertEqual({r['id']:r['table_type'] for r in self.rows()}, {upload['id']:'upload',price['id']:'price_update'})
        extra = self.add(version='v2')
        changed = library.change_table_type(self.root, extra['id'], 'price_update')
        self.assertEqual((changed['id'], changed['file'], changed['sha256']), (extra['id'], extra['file'], extra['sha256']))
        self.assertEqual(library.verified(self.root, changed), self.raw)
        with self.assertRaisesRegex(ValueError, '表格类型'):
            library.change_table_type(self.root, extra['id'], None)

    def test_backup_roundtrip_and_schema5_without_type(self):
        self.add();self.add('price_update')
        archive = self.base/'backup.zip'
        library.run(SimpleNamespace(command='backup',library=str(self.root),output=str(archive)))
        restored = self.base/'restored'
        library.run(SimpleNamespace(command='restore',library=str(restored),source=str(archive)))
        rows = library.run(SimpleNamespace(command='list',library=str(restored),marketplace=None,category=None))
        self.assertEqual({r['table_type'] for r in rows}, {'upload','price_update'})
        for r in rows:self.assertEqual(library.verified(restored,r), self.raw)
        old_archive = self.base/'old.zip'
        with zipfile.ZipFile(archive) as z, zipfile.ZipFile(old_archive,'w') as old:
            manifest = json.loads(z.read('manifest.json'))
            manifest['schema_version'] = 5
            manifest['templates'] = [r for r in manifest['templates'] if r['table_type']=='upload']
            for row in manifest['templates']:
                row.pop('table_type')
                old.writestr('files/'+row['file'],z.read('files/'+row['file']))
            old.writestr('manifest.json',json.dumps(manifest))
        old_root = self.base/'old-restored'
        library.run(SimpleNamespace(command='restore',library=str(old_root),source=str(old_archive)))
        rows = library.run(SimpleNamespace(command='list',library=str(old_root),marketplace=None,category=None))
        self.assertEqual(rows[0]['table_type'], 'upload')
        self.assertEqual(library.verified(old_root,rows[0]), self.raw)

    def test_moving_shop_allows_other_type_at_same_version(self):
        upload = self.add(shop='甲店')
        self.add('price_update',shop='乙店')
        moved = library.move_shop(self.root,upload['id'],'乙店')
        self.assertEqual(moved['shop'],'乙店')
        self.assertEqual(len(self.rows()),2)

    def test_inventory_and_ai_match_only_requested_type(self):
        upload = dict(template(category='行李箱',version='upload'),table_type='upload')
        price = dict(template(category='行李箱',version='price'),table_type='price_update')
        data = 'SKU,类目\n1,行李箱\n'.encode()
        for kind, expected in [('upload',upload),('price_update',price)]:
            report = inventory.analyze(data,'stock.csv','AE',[upload,price],sheet='CSV',table_type=kind)
            self.assertEqual(report['items'][0]['template']['id'],expected['id'])
            self.assertEqual(report['table_type'],kind)
        report = inventory.analyze(data,'stock.csv','AE',[price],sheet='CSV')
        self.assertIsNone(report['items'][0]['template'])
        settings = ai.Settings(self.base/'ai.json');settings.configure('qwen','qwen3-vl-plus','fake-test-key')
        data = b'SKU,title\n1,unknown-type-test\n'
        seen = []
        def remote(settings, products, catalog, images):
            seen.extend(t['id'] for t in catalog)
            return {p['row']:{'row':p['row'],'category':'行李箱','confidence':'medium','evidence':'模拟','template_id':catalog[0]['id']} for p in products}
        with patch.object(ai,'classify',side_effect=remote):
            report = inventory.analyze(data,'stock.csv','AE',[upload,price],sheet='CSV',table_type='price_update')
            ai.enrich(report,inventory.read_tables(data,'stock.csv'),[upload,price],data,'stock.csv',settings)
        self.assertEqual(seen,[price['id']])
        self.assertEqual(report['items'][0]['template']['id'],price['id'])

    def test_ai_cache_is_separate_even_when_both_type_catalogs_are_empty(self):
        settings = ai.Settings(self.base/'ai.json');settings.configure('qwen','qwen3-vl-plus','fake-test-key')
        data = b'SKU,title\n1,unknown-type-cache\n';cache = ai.ResultCache()
        def remote(settings,products,catalog,images):
            return {p['row']:{'row':p['row'],'category':'测试建议','confidence':'low','evidence':'模拟','template_id':None} for p in products}
        with patch.object(ai,'classify',side_effect=remote) as call:
            for kind in ['upload','price_update','upload']:
                report = inventory.analyze(data,'stock.csv','AE',[],sheet='CSV',table_type=kind)
                ai.enrich(report,inventory.read_tables(data,'stock.csv'),[],data,'stock.csv',settings,cache=cache,cache_scope='owner')
            self.assertEqual(call.call_count,2)
            self.assertEqual(report['ai_summary']['cached'],1)

    def test_batch_type_is_stored_and_versions_are_independent(self):
        roster.import_text(self.root,TABLE)
        source = account_book(account='ATEST001')
        _, upload = batch.generate(self.root,source,'a.xlsm',['测试甲'],'PRODUCT','v1',create_archive=False)
        changed = account_book(account='ATEST001',timestamp='changed')
        archive, price = batch.generate(self.root,changed,'b.xlsm',['测试甲'],'PRODUCT','v1',table_type='price_update')
        self.assertEqual((upload['saved'],price['saved']),(1,1))
        self.assertEqual(price['table_type'],'price_update')
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            report=json.loads(z.read('生成与入库报告.json'))
            self.assertEqual(report['table_type_label'],'改价表格')
            self.assertEqual(report['items'][0]['output_name'],'改价表格_测试甲_AE.xlsm')
        with self.assertRaisesRegex(ValueError,'同表格类型'):
            batch.generate(self.root,changed,'b.xlsm',['测试甲'],'PRODUCT','v1')
        self.assertEqual(len(self.rows()),2)


class TableTypeAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.server=create_server(Path(cls.temp.name)/'library',0)
        for name,role in [('owner','admin'),('reader','viewer')]:cls.server.auth.create(name,'test-password-long',role)
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.temp.cleanup()

    def request(self,method,path,data=None,cookie=None):
        client=HTTPConnection('127.0.0.1',self.server.server_port,timeout=10)
        headers={'Content-Type':'application/json','X-Template-Request':'1'}
        if cookie:headers['Cookie']=cookie
        client.request(method,path,json.dumps(data) if data is not None else None,headers)
        response=client.getresponse();result=(response.status,response.read(),response.getheader('Set-Cookie'));client.close();return result

    def test_upload_filter_type_edit_and_viewer_permissions(self):
        cookies={}
        for name in ('owner','reader'):
            status,_,cookie=self.request('POST','/api/login',{'username':name,'password':'test-password-long'})
            self.assertEqual(status,200);cookies[name]=cookie.split(';')[0]
        raw=make_book({'Template':[['sku'],['fixture']]})
        payload={'filename':'source.xlsm','data':base64.b64encode(raw).decode(),'shop':'测试店','marketplace':'AE','category':'PRODUCT','version':'v1'}
        rows=[]
        for kind in ('upload','price_update'):
            status,data,_=self.request('POST','/api/upload',dict(payload,table_type=kind),cookies['owner'])
            self.assertEqual(status,200,data);rows.append(json.loads(data))
        self.assertEqual(self.request('POST','/api/template/type',{'id':rows[0]['id'],'table_type':'price_update'},cookies['reader'])[0],403)
        self.assertEqual(self.request('POST','/api/template/type',{'id':rows[0]['id'],'table_type':'price_update'},cookies['owner'])[0],400)
        status,data,_=self.request('GET','/api/templates?table_type=price_update',cookie=cookies['reader'])
        self.assertEqual(status,200);self.assertEqual([r['id'] for r in json.loads(data)],[rows[1]['id']])
        self.assertEqual(self.request('GET','/api/templates?table_type=invalid',cookie=cookies['reader'])[0],400)
        for row in rows:self.assertEqual(self.request('GET','/api/download/'+row['id'],cookie=cookies['reader'])[1],raw)
        status,_,_=self.request('POST','/api/upload',dict(payload,table_type='invalid'),cookies['owner'])
        self.assertEqual(status,400)

import base64
import csv
import io
import json
from http.client import HTTPConnection
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from app import create_server
from template_manager import aliases, ai, inventory, library
from template_manager.product_types import CategoryResolver
from test_inventory import make_book, template
from test_multi_product_types import multi_book, multi_template
from test_ai import response


class AliasTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.root=self.base/'library'

    def tearDown(self):self.temp.cleanup()

    def add(self,text,category=''):
        rows=aliases.parse_text(text,category);preview=aliases.preview(self.root,rows)
        return aliases.apply(self.root,rows,'tester',preview['revision'])

    def rules(self):return aliases.directory(self.root)['items']

    def test_group_and_two_column_inputs_flatten_reuse_and_persist(self):
        self.assertEqual(self.add('皮箱、旅行硬箱\n皮箱','行李箱')['saved'],2)
        self.assertEqual(self.add('叫法\t对应类别\n美容镜;梳妆镜\t化妆镜\n皮箱\t拉杆箱')['saved'],2)
        self.assertEqual(len(self.rules()),4)
        self.assertEqual(self.add('叫法,对应类别\n"美容镜、梳妆镜",化妆镜')['saved'],0)
        self.assertEqual(aliases.directory(self.root)['revision'],aliases.revision(self.rules()))
        self.assertEqual(aliases.preview(self.root,aliases.parse_text('PHONE_CASE\t手机壳'))['counts']['builtin'],1)
        self.add('保护胶壳\t软壳\n软壳\t手机保护套')
        self.assertEqual({r['category'] for r in self.rules() if r['alias'] in ('保护胶壳','软壳')},{'手机壳'})

    def test_conflicts_are_atomic_and_cycles_and_builtins_are_blocked(self):
        self.add('皮箱','行李箱');before=self.rules()
        for text in ('皮箱\t背包\n美容镜\t化妆镜','美容镜\t化妆镜\n美容镜\t收纳盒','拉杆箱\t背包','甲种物品\t乙种物品\n乙种物品\t甲种物品'):
            rows=aliases.parse_text(text);preview=aliases.preview(self.root,rows)
            self.assertFalse(preview['can_save']);self.assertGreater(preview['counts']['conflict'],0)
            with self.assertRaises(ValueError):aliases.apply(self.root,rows,'tester')
            self.assertEqual(self.rules(),before)
        # Punctuation/case normalization cannot bypass an existing alias.
        self.add('beauty-mirror','化妆镜')
        self.assertEqual(aliases.preview(self.root,aliases.parse_text('BEAUTY MIRROR\t收纳盒'))['counts']['conflict'],1)

    def test_explicit_edit_delete_and_stale_revisions(self):
        self.add('美容镜、便携美容镜','化妆镜');version=aliases.directory(self.root)['revision']
        aliases.update(self.root,'美容镜','美容镜','收纳盒','editor',version)
        self.assertEqual(next(r['category'] for r in self.rules() if r['alias']=='美容镜'),'收纳盒')
        with self.assertRaisesRegex(ValueError,'其他成员'):aliases.delete(self.root,['美容镜'],version)
        with self.assertRaises(ValueError):aliases.delete(self.root,['美容镜','不存在'])
        self.assertEqual(len(self.rules()),2)
        aliases.delete(self.root,['美容镜','便携美容镜'],aliases.directory(self.root)['revision']);self.assertEqual(self.rules(),[])

    def test_import_workbook_select_sheet_and_csv_export(self):
        book=make_book({'说明':[['说明文字']], '叫法表':[['叫法','对应类别'],['美容镜、梳妆镜','化妆镜']]})
        self.assertEqual(aliases.parse_file(book,'aliases.xlsx')[1]['sheet'],'叫法表')
        rows,info=aliases.parse_file(book,'aliases.xlsx','叫法表')
        self.assertEqual(info['sheets'],['说明','叫法表']);self.assertEqual(len(rows),2)
        aliases.apply(self.root,rows,'test')
        exported=aliases.export_csv(self.root)
        parsed,_=aliases.parse_file(exported,'aliases.csv');self.assertEqual(len(parsed),2)
        self.assertEqual(aliases.preview(self.root,parsed)['counts']['exists'],2)
        self.add('=测试叫法','化妆镜')
        self.assertIn("'=测试叫法",exported.decode('utf-8-sig')+aliases.export_csv(self.root).decode('utf-8-sig'))

    def test_invalid_and_limits(self):
        for rows in ([],[None],[{'alias':'','category':'行李箱'}],[{'alias':'x','category':'\x00'}]):
            with self.assertRaises(ValueError):aliases.apply(self.root,rows,'tester')
        with self.assertRaises(ValueError):aliases.parse_text('x\n'*5001,'行李箱')
        with self.assertRaises(ValueError):aliases.parse_text('x,y,z\na,b,c')
        with self.assertRaises(ValueError):aliases.parse_file(b'old binary','aliases.xls')

    def test_backup_roundtrip_and_legacy_empty(self):
        self.add('美容镜、梳妆镜','化妆镜');archive=self.base/'backup.zip'
        library.run(SimpleNamespace(command='backup',library=str(self.root),output=str(archive)))
        restored=self.base/'restored'
        library.run(SimpleNamespace(command='restore',library=str(restored),source=str(archive)))
        self.assertEqual([(r['alias'],r['category']) for r in aliases.directory(restored)['items']],[(r['alias'],r['category']) for r in self.rules()])
        legacy=self.base/'legacy.zip'
        with zipfile.ZipFile(legacy,'w') as z:z.writestr('manifest.json',json.dumps({'schema_version':6,'templates':[]}))
        library.run(SimpleNamespace(command='restore',library=str(self.base/'old'),source=str(legacy)))
        self.assertEqual(aliases.directory(self.base/'old')['items'],[])
        with zipfile.ZipFile(self.base/'broken.zip','w') as z:z.writestr('manifest.json',json.dumps({'schema_version':7,'templates':[],'product_aliases':[{'alias':'拉杆箱','category':'背包'}]}))
        with self.assertRaises(ValueError):library.run(SimpleNamespace(command='restore',library=str(self.base/'broken'),source=str(self.base/'broken.zip')))
        self.assertFalse((self.base/'broken').exists())

    def test_complete_alias_vs_substring_ambiguity_and_scope(self):
        self.add('美容镜、梳妆镜','化妆镜');self.add('旅行硬箱','行李箱')
        rules=self.rules();mirrors=[{**template(category='化妆镜'),'shop':'甲店'}]
        data='SKU,品名,类别\nA,美容镜,\nB,商品,梳妆镜\nC,带灯美容镜,\nD,美容镜和背包组合,\nE,美容镜,背包\n'.encode()
        report=inventory.analyze(data,'a.csv','AE',mirrors,sheet='CSV',shop='甲店',alias_rules=rules)
        self.assertEqual([r['status'] for r in report['items']],['available','available','review','review','missing'])
        self.assertEqual([r['suggested_category'] for r in report['items'][:3]],['化妆镜']*3)
        self.assertIn('团队别名规则',report['items'][0]['evidence']);self.assertIn('背包',report['items'][3]['suggested_category'])
        target=inventory.analyze('SKU,品名\nA,化妆镜\nB,可折叠化妆镜'.encode(),'a.csv','AE',mirrors,sheet='CSV',shop='甲店',alias_rules=rules)
        self.assertEqual([r['status'] for r in target['items']],['available','review']);self.assertEqual(target['items'][1]['suggested_category'],'化妆镜')
        for kwargs in ({'shop':'乙店'},{'marketplace':'SA'},{'table_type':'price_update'}):
            args={'shop':'甲店','marketplace':'AE',**kwargs}
            scoped=inventory.analyze(data,'a.csv',templates=mirrors,sheet='CSV',alias_rules=rules,**args)
            self.assertEqual(scoped['summary']['available'],0);self.assertTrue(all(r['template'] is None for r in scoped['items']))
        # A request with no aliases never sees the preceding request's rules.
        self.assertEqual(inventory.analyze(data,'a.csv','AE',mirrors,sheet='CSV',shop='甲店')['items'][0]['status'],'review')

    def test_declared_type_coverage_cannot_be_bypassed(self):
        self.add('美容镜','化妆镜');rules=self.rules();data='SKU,品名\nA,美容镜'.encode()
        t=multi_template(codes=['SPECIAL_MIRROR','PHONE_CASE'],category='化妆镜')
        report=inventory.analyze(data,'a.csv','AE',[t],sheet='CSV',alias_rules=rules)
        self.assertEqual(report['items'][0]['status'],'review')
        self.add('SPECIAL_MIRROR','化妆镜');rules=self.rules()
        report=inventory.analyze(data,'a.csv','AE',[t],sheet='CSV',alias_rules=rules)
        self.assertEqual(report['items'][0]['status'],'available')
        # Match a non-primary type in a multi-type template.
        report=inventory.analyze(data,'a.csv','AE',[{**t,'category':'多类目模板'}],sheet='CSV',alias_rules=rules)
        self.assertEqual(report['items'][0]['template']['matched_product_type'],'SPECIAL_MIRROR')
        self.assertEqual(report['template_supports'][t['id']]['product_type_labels']['SPECIAL_MIRROR'],'化妆镜')

    def test_dynamic_labels_dont_modify_original_bytes(self):
        source=self.base/'original.xlsm';source.write_bytes(multi_book(['SPECIAL_MIRROR']))
        added=library.run(SimpleNamespace(command='add',library=str(self.root),source=str(source),shop='甲店',marketplace='AE',category='多类目模板',version='v1',table_type='upload'))
        self.add('SPECIAL_MIRROR','化妆镜')
        rows=library.run(SimpleNamespace(command='list',library=str(self.root),marketplace=None,category=None))
        self.assertEqual(rows[0]['metadata']['product_type_labels']['SPECIAL_MIRROR'],'化妆镜')
        self.assertEqual(library.verified(self.root,added),source.read_bytes())

    def test_ai_cache_invalidated_by_alias_revision(self):
        data='SKU,品名\nA,带灯美容镜'.encode();templates=[template(category='化妆镜')];cache=ai.ResultCache()
        settings=ai.Settings(self.base/'ai.json');settings.configure('qwen','qwen3-vl-plus','fake-test-key')
        answers=[{'row':2,'category':'化妆镜','confidence':'high','evidence':'测试','template_id':templates[0]['id']}]
        def analyze():
            report=inventory.analyze(data,'a.csv','AE',templates,sheet='CSV',alias_rules=self.rules())
            return ai.enrich(report,inventory.read_tables(data,'a.csv'),templates,data,'a.csv',settings,cache=cache,cache_scope='member',alias_rules=self.rules())
        with patch('urllib.request.urlopen',side_effect=lambda *a,**k:response(answers)) as mock:
            analyze();cached=analyze();self.assertEqual(mock.call_count,1);self.assertEqual(cached['ai_summary']['cached'],1)
            self.add('美容镜','化妆镜');analyze();self.assertEqual(mock.call_count,2)


class AliasAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)/'library';cls.server=create_server(cls.root,0)
        for name,role in [('owner','admin'),('writer','editor'),('reader','viewer')]:cls.server.auth.create(name,'alias-test-password',role)
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()

    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.temp.cleanup()

    def req(self,method,path,data=None,cookie=None):
        c=HTTPConnection('127.0.0.1',self.server.server_port,timeout=10);headers={'Content-Type':'application/json','X-Template-Request':'1'}
        if cookie:headers['Cookie']=cookie
        c.request(method,path,json.dumps(data).encode() if data is not None else None,headers);r=c.getresponse();result=(r.status,r.read(),r.getheader('Set-Cookie'));c.close();return result

    def login(self,name):return self.req('POST','/api/login',{'username':name,'password':'alias-test-password'})[2].split(';')[0]

    def test_shared_alias_workflow_roles_conflicts_and_restore_export(self):
        self.assertEqual(self.req('GET','/api/aliases')[0],401)
        owner,writer,reader=map(self.login,('owner','writer','reader'))
        for route in ('preview','save','update','delete','inspect'):
            self.assertEqual(self.req('POST','/api/aliases/'+route,{},reader)[0],403)
        code,raw,_=self.req('POST','/api/aliases/preview',{'text':'美容镜、梳妆镜','category':'化妆镜'},writer)
        self.assertEqual(code,200);preview=json.loads(raw);self.assertTrue(preview['can_save'])
        code,raw,_=self.req('POST','/api/aliases/save',{'rows':preview['items'],'revision':preview['revision']},writer)
        self.assertEqual(code,200);self.assertEqual(json.loads(raw)['saved'],2)
        self.assertEqual(len(json.loads(self.req('GET','/api/aliases',cookie=reader)[1])['items']),2)
        self.assertEqual(self.req('GET','/api/aliases/export',cookie=reader)[0],200)
        self.assertIn('美容镜',self.req('GET','/api/aliases/export',cookie=reader)[1].decode('utf-8-sig'))
        code,raw,_=self.req('POST','/api/aliases/inspect',{'filename':'aliases.csv','data':base64.b64encode('叫法,对应类别\n旅行硬箱,行李箱'.encode()).decode()},owner)
        self.assertEqual(code,200);self.assertEqual(json.loads(raw)['counts']['new'],1)
        code,_,_=self.req('POST','/api/aliases/save',{'rows':[{'alias':'美容镜','category':'背包'}]},owner);self.assertEqual(code,400)
        code,_,_=self.req('POST','/api/aliases/save',{'rows':[{'alias':'旅行硬箱','category':'行李箱'}],'revision':preview['revision']},owner);self.assertEqual(code,400)
        # Inventory endpoint uses saved rules for every role, without a client-supplied dictionary.
        payload={'filename':'stock.csv','data':base64.b64encode('SKU,品名\nA,美容镜'.encode()).decode(),'sheet':'CSV','marketplace':'AE'}
        code,raw,_=self.req('POST','/api/inventory/analyze',payload,reader)
        self.assertEqual(code,200);self.assertEqual(json.loads(raw)['items'][0]['suggested_category'],'化妆镜')
        code,raw,_=self.req('POST','/api/aliases/update',{'key':'美容镜','alias':'美容镜','category':'收纳盒'},writer);self.assertEqual(code,200)
        code,raw,_=self.req('POST','/api/aliases/delete',{'keys':['美容镜','梳妆镜']},writer);self.assertEqual(code,200);self.assertEqual(json.loads(raw)['deleted'],2)

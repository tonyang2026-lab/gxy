import base64
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from urllib.parse import urlencode
import unittest
from unittest.mock import patch
import zipfile

from template_manager import metadata, library, inventory, ai, batch, roster
from test_inventory import make_book, template
from test_ai import response


def multi_book(types, account='ATEST001', market='AE'):
    types_data = types if isinstance(types,str) else json.dumps(types)
    settings = 'settings='+urlencode({'contributorId':'amzn1.cr.o.'+account,'primaryMarketplaceId':'amzn1.mp.o.'+{'AE':'A2VIGQ35RCS4UG','SA':'A17E79C6D8DWNP'}[market],
                                    'ptds':base64.b64encode(types_data.encode()).decode(),'attributeRow':'3','dataRow':'5'})
    return make_book({'Template':[[settings],['labels'],['sku','product_type'],[],['DEMO','PHONE_CASE']]})


def multi_template(codes=('PHONE_CASE','PHONE_STAND'), **values):
    return {**template(category='多商品类型模板'), 'metadata':{'product_types':list(codes)}, **values}


class MultiProductTypeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.root=self.base/'library'
        self.settings=ai.Settings(self.base/'ai.json');self.settings.configure('qwen','qwen3-vl-plus','fake-test-key')

    def tearDown(self):self.temp.cleanup()

    def test_parse_multi_types_labels_duplicates_and_bounds(self):
        info=metadata.inspect(multi_book(['PHONE_CASE','PHONE_STAND','PHONE_CASE',5,'bad type']))
        self.assertEqual(info['product_types'],['PHONE_CASE','PHONE_STAND'])
        self.assertEqual(info['product_type_labels']['PHONE_STAND'],'手机支架')
        self.assertTrue(info['product_type_warnings'])
        codes=['TYPE_'+str(i) for i in range(301)]
        info=metadata.inspect(multi_book(codes));self.assertEqual(len(info['product_types']),300);self.assertTrue(info['product_type_warnings'])
        info=metadata.inspect(multi_book(' ["PHONE_CASE", "PHONE_STAND"] '))
        self.assertEqual(info['product_types'],['PHONE_CASE','PHONE_STAND'])

    def test_two_explicit_types_use_one_template_without_changing_categories(self):
        t=multi_template()
        report=inventory.analyze('SKU,类目\nA,PHONE_CASE\nB,PHONE_STAND\n'.encode(),'a.csv','AE',[t],sheet='CSV')
        self.assertEqual(report['summary']['available'],2)
        self.assertEqual({i['template']['id'] for i in report['items']},{t['id']})
        self.assertEqual([i['suggested_category'] for i in report['items']],['PHONE_CASE','PHONE_STAND'])
        self.assertEqual([i['template']['matched_product_type'] for i in report['items']],['PHONE_CASE','PHONE_STAND'])

    def test_local_alias_confirmation_preserves_product_category(self):
        data='SKU,品名\nA,手机壳\nB,手机支架\n'.encode();t=multi_template()
        first=inventory.analyze(data,'a.csv','AE',[t],sheet='CSV')
        self.assertEqual(first['summary']['review'],2)
        self.assertEqual(first['items'][1]['template']['matched_product_type'],'PHONE_STAND')
        confirmed=inventory.analyze(data,'a.csv','AE',[t],sheet='CSV',category_overrides={'2':'手机壳','3':'手机支架'})
        self.assertEqual(confirmed['summary']['available'],2)
        self.assertEqual([i['category'] for i in confirmed['items']],['手机壳','手机支架'])

    def test_registered_label_conflicting_with_declaration_is_review_not_available(self):
        t=multi_template(codes=['PHONE_STAND'],category='手机壳')
        report=inventory.analyze('SKU,类目\nA,手机壳\n'.encode(),'a.csv','AE',[t],sheet='CSV')
        self.assertEqual(report['summary']['review'],1)
        self.assertIn('未能对应',report['items'][0]['evidence'])

    def test_no_wildcard_and_scope_restrictions(self):
        data='SKU,类目\nA,PHONE_STAND\n'.encode()
        foreign=[multi_template(shop='乙店'),multi_template(marketplace='SA'),multi_template(table_type='price_update')]
        report=inventory.analyze(data,'a.csv','AE',foreign,sheet='CSV',shop='甲店')
        self.assertIsNone(report['items'][0]['template'])
        generic=multi_template(codes=['PRODUCT'],category='PRODUCT')
        report=inventory.analyze(data,'a.csv','AE',[generic],sheet='CSV')
        self.assertIsNone(report['items'][0]['template'])

    def test_legacy_cached_metadata_refreshed_from_unchanged_original(self):
        raw=multi_book(['TYPE_'+str(i) for i in range(45)]);source=self.base/'old.xlsm';source.write_bytes(raw)
        row=library.run(SimpleNamespace(command='add',library=str(self.root),source=str(source),shop='甲店',marketplace='AE',category='多商品类型模板',version='v1'))
        db=library.connect(self.root);db.execute('UPDATE template_metadata SET info=? WHERE id=?',(json.dumps({'product_types':['TYPE_0']}),row['id']));db.commit();db.close()
        rows=library.run(SimpleNamespace(command='list',library=str(self.root),marketplace=None,category=None))
        self.assertEqual(len(rows[0]['metadata']['product_types']),45)
        self.assertEqual(library.verified(self.root,rows[0]),raw)
        with patch.object(metadata,'inspect',side_effect=AssertionError('cache should be current')):
            library.run(SimpleNamespace(command='list',library=str(self.root),marketplace=None,category=None))

    def test_ai_catalog_keeps_different_coverage_versions(self):
        old=multi_template(id='old',version='v1',created_at='2026-10-01')
        newer=multi_template(codes=['PHONE_CASE'],id='new',version='v2',created_at='2026-11-01')
        data=b'SKU,title\nA,unknown object\n';seen=[]
        def remote(settings,products,catalog,images):
            seen.extend(catalog)
            return {p['row']:{'row':p['row'],'category':'手机支架','confidence':'medium','evidence':'模拟','template_id':'old','matched_product_type':'PHONE_STAND'} for p in products}
        report=inventory.analyze(data,'a.csv','AE',[old,newer],sheet='CSV')
        with patch.object(ai,'classify',side_effect=remote):ai.enrich(report,inventory.read_tables(data,'a.csv'),[old,newer],data,'a.csv',self.settings)
        self.assertEqual({t['id'] for t in seen},{'old','new'})
        self.assertEqual(next(t for t in seen if t['id']=='old')['product_types'],['PHONE_CASE','PHONE_STAND'])
        self.assertEqual(report['items'][0]['template']['matched_product_type'],'PHONE_STAND')
        self.assertEqual(report['items'][0]['status'],'review')

    def test_ai_rejects_missing_or_unsupported_type_and_accepts_declared_type(self):
        catalog=[{'id':'multi','category':'多类型','product_types':['PHONE_CASE','PHONE_STAND']}]
        item={'row':2,'category':'手机支架','confidence':'high','evidence':'模拟','template_id':'multi'}
        for code in [None,'HEADPHONES']:
            with patch('urllib.request.urlopen',return_value=response([{**item,'matched_product_type':code}])):
                with self.assertRaisesRegex(ValueError,'声明范围'):ai.classify(self.settings,[{'row':2}],catalog,{})
        with patch('urllib.request.urlopen',return_value=response([{**item,'matched_product_type':'PHONE_STAND'}])):
            self.assertEqual(ai.classify(self.settings,[{'row':2}],catalog,{})[2]['matched_product_type'],'PHONE_STAND')

    def test_explicit_template_confirmation_for_unknown_code_is_scoped(self):
        t=multi_template(codes=['SPECIAL_DEVICE'],shop='甲店',id='special')
        data='SKU,品名\nA,特殊设备\n'.encode()
        kwargs={'sheet':'CSV','shop':'甲店','category_overrides':{'2':'特殊设备'},'template_overrides':{'2':{'template_id':'special','product_type':'SPECIAL_DEVICE'}}}
        result=inventory.analyze(data,'a.csv','AE',[t],**kwargs)
        self.assertEqual(result['summary']['available'],1);self.assertEqual(result['items'][0]['category'],'特殊设备')
        with self.assertRaisesRegex(ValueError,'声明范围'):inventory.analyze(data,'a.csv','AE',[{**t,'shop':'乙店'}],**kwargs)
        bad={**kwargs,'template_overrides':{'2':{'template_id':'special','product_type':'BAD'}}}
        with self.assertRaisesRegex(ValueError,'声明范围'):inventory.analyze(data,'a.csv','AE',[t],**bad)

    def test_short_download_names_and_collision_counters_preserve_bytes(self):
        raw=multi_book(['PHONE_CASE','PHONE_STAND']);source=self.base/'long-version-category-name.xlsm';source.write_bytes(raw)
        ids=[]
        for version in ['v1','v2']:
            row=library.run(SimpleNamespace(command='add',library=str(self.root),source=str(source),shop='甲店',marketplace='AE',category='多商品类型模板',version=version));ids.append(row['id'])
        single,name=library.download_templates(self.root,ids[:1]);self.assertEqual(name,'上传表格_甲店_AE.xlsm');self.assertEqual(single,raw)
        data,_=library.download_templates(self.root,ids)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            self.assertEqual(z.namelist(),['上传表格_甲店_AE.xlsm','上传表格_甲店_AE_2.xlsm'])
            for n in z.namelist():self.assertEqual(z.read(n),raw)

    def test_declarations_are_indexed_once_and_repeated_categories_reuse_search(self):
        t=multi_template()
        data=('SKU,品名\n'+''.join(str(i)+',手机支架\n' for i in range(500))).encode()
        with patch.object(inventory,'template_candidates',wraps=inventory.template_candidates) as search:
            report=inventory.analyze(data,'stock.csv','AE',[t],sheet='CSV')
        self.assertEqual(search.call_count,1)
        self.assertEqual(list(report['template_supports']),[t['id']])
        self.assertEqual(report['template_supports'][t['id']]['product_types'],['PHONE_CASE','PHONE_STAND'])
        self.assertTrue(all('product_types' not in row['template'] for row in report['items']))

    def test_batch_short_names_are_unique_after_windows_name_sanitizing(self):
        roster.import_text(self.root,'店铺,AE,SA\nA/B,ATEST001,\nA?B,ATEST003,\n')
        raw=multi_book(['PHONE_CASE','PHONE_STAND'])
        data,report=batch.generate(self.root,raw,'source.xlsm',['A/B','A?B'],'多类型','v1')
        names=[i['output_name'] for i in report['items']]
        self.assertEqual(names,['上传表格_A_B_AE.xlsm','上传表格_A_B_AE_2.xlsm'])
        with zipfile.ZipFile(io.BytesIO(data)) as z:self.assertEqual(len(z.namelist()),3)

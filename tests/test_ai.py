import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

from template_manager import ai, inventory
from test_inventory import make_book, template


def image_book():
    original = make_book({'库存': [['SKU', '品名'], ['DEMO-LUG-001', '三件套 TSA-Compatible Lock 宽拉杆 材质 ABS+PC 尺寸20/24/28']]})
    result = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(original)) as src, zipfile.ZipFile(result, 'w') as dest:
        for info in src.infolist():
            value = src.read(info.filename)
            if info.filename == 'xl/worksheets/sheet1.xml':
                value = value.replace(b'</worksheet>', b'<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="drawing1"/></worksheet>')
            dest.writestr(info, value)
        dest.writestr('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="drawing1" Target="../drawings/drawing1.xml"/></Relationships>')
        dest.writestr('xl/drawings/drawing1.xml', '<x:wsDr xmlns:x="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:twoCellAnchor><x:from><x:col>2</x:col><x:row>1</x:row></x:from><x:pic><a:blip r:embed="image1"/></x:pic></x:twoCellAnchor></x:wsDr>')
        dest.writestr('xl/drawings/_rels/drawing1.xml.rels', '<Relationships><Relationship Id="image1" Target="../media/image1.png"/></Relationships>')
        dest.writestr('xl/media/image1.png', base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='))
    return result.getvalue()


def response(items):
    return io.BytesIO(json.dumps({'choices': [{'message': {'content': json.dumps({'items': items})}}]}).encode())


class AITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = ai.Settings(Path(self.tmp.name)/'ai-config.json')
        self.settings.configure('qwen', 'qwen-vl-plus', 'unit-test-not-a-real-key')

    def tearDown(self):
        self.tmp.cleanup()

    def test_key_never_saved_or_returned(self):
        self.assertTrue(self.settings.public()['configured'])
        self.assertNotIn('unit-test-not-a-real-key', json.dumps(self.settings.public()))
        self.assertNotIn('unit-test-not-a-real-key', self.settings.path.read_text())
        with patch.dict('os.environ', {}, clear=True):
            self.assertFalse(ai.Settings(self.settings.path).public()['configured'])

    def test_qwen3_default_does_not_overwrite_saved_model(self):
        fresh=ai.Settings(Path(self.tmp.name)/'new-config.json')
        self.assertEqual(fresh.model,'qwen3-vl-plus')
        existing=ai.Settings(self.settings.path)
        self.assertEqual(existing.model,'qwen-vl-plus')

    def test_native_picture_row_mapping(self):
        pictures, warnings = ai.images_for_rows(image_book(), 'stock.xlsx', '库存', {2})
        self.assertEqual(list(pictures), [2])
        self.assertEqual(pictures[2]['mime'], 'image/png')
        self.assertEqual(warnings, [])
        self.assertEqual(ai.images_for_rows(image_book(), 'stock.xlsx', '库存', {3})[0], {})

    def test_wps_dispimg_picture_row_mapping(self):
        out = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(make_book({'库存': [['SKU', '品名'], ['DEMO-LUG-001', '三件套']]}))) as src, zipfile.ZipFile(out, 'w') as z:
            for info in src.infolist():
                data = src.read(info.filename)
                if info.filename == 'xl/worksheets/sheet1.xml':
                    data = data.replace(b'</sheetData>', b'<row r="3"><c r="C3"><f>_xlfn.DISPIMG("ID_PICTURE",1)</f><v/></c></row></sheetData>')
                z.writestr(info, data)
            z.writestr('xl/cellimages.xml', '<cellImages xmlns:x="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cellImage><x:pic><x:nvPicPr><x:cNvPr name="ID_PICTURE"/></x:nvPicPr><x:blipFill><a:blip r:embed="rId1"/></x:blipFill></x:pic></cellImage></cellImages>')
            z.writestr('xl/_rels/cellimages.xml.rels', '<Relationships><Relationship Id="rId1" Target="media/test.png"/></Relationships>')
            z.writestr('xl/media/test.png', b'\x89PNG\r\n\x1a\nfixture')
        pictures, _ = ai.images_for_rows(out.getvalue(), 'stock.xlsx', '库存', {3})
        self.assertEqual(pictures[3]['mime'], 'image/png')

    def test_vision_request_and_validated_result(self):
        row = {'row': 2, 'sku': 'DEMO-LUG-001', 'name': 'TSA Lock'}
        image = {2: {'mime': 'image/png', 'data': 'dGVzdA=='}}
        answer = {'row': 2, 'category': '行李箱', 'confidence': 'high', 'evidence': '拉杆和多尺寸箱体', 'template_id': 'AE行李箱v1'}
        with patch('urllib.request.urlopen', return_value=response([answer])) as call:
            result = ai.classify(self.settings, [row], [template(category='行李箱')], image)
        self.assertEqual(result[2]['category'], '行李箱')
        request = call.call_args.args[0]
        self.assertTrue(request.full_url.startswith('https://dashscope.aliyuncs.com/'))
        body = json.loads(request.data)
        self.assertEqual(body['messages'][1]['content'][-1]['type'], 'image_url')

    def test_hallucinated_or_cross_site_template_rejected(self):
        answer = {'row': 2, 'category': '行李箱', 'confidence': 'high', 'evidence': '', 'template_id': 'SA行李箱v1'}
        with patch('urllib.request.urlopen', return_value=response([answer])):
            with self.assertRaisesRegex(ValueError, '之外'):
                ai.classify(self.settings, [{'row': 2}], [template(category='行李箱')], {})

    def test_missing_or_duplicate_model_rows_rejected(self):
        with patch('urllib.request.urlopen', return_value=response([])):
            with self.assertRaisesRegex(ValueError, '漏回'):
                ai.classify(self.settings, [{'row': 2}], [], {})
        item = {'row': 2, 'category': '行李箱', 'confidence': 'high', 'evidence': '', 'template_id': None}
        with patch('urllib.request.urlopen', return_value=response([item, item])):
            with self.assertRaisesRegex(ValueError, '重复'):
                ai.classify(self.settings, [{'row': 2}], [], {})

    def test_request_failure_keeps_local_result(self):
        data = b'SKU,title\n1,unknown\n2,unknown\n'
        report = inventory.analyze(data, 'a.csv', 'AE', [], sheet='CSV')
        with patch('urllib.request.urlopen', side_effect=urllib.error.URLError('offline')) as call:
            result = ai.enrich(report, inventory.read_tables(data, 'a.csv'), [], data, 'a.csv', self.settings)
        self.assertEqual(result['ai_summary']['completed'], 0)
        self.assertEqual(result['summary']['review'], 2)
        self.assertEqual(call.call_count, 1)

    def test_ai_limits_and_manual_confirmation_not_rebilled(self):
        data = 'SKU,品名\n1,物品A\n2,物品B\n'.encode()
        report = inventory.analyze(data, 'a.csv', 'AE', [], sheet='CSV', category_overrides={'2': '行李箱'})
        item = {'row': 3, 'category': '背包', 'confidence': 'medium', 'evidence': '外形建议', 'template_id': None}
        with patch('urllib.request.urlopen', return_value=response([item])):
            result = ai.enrich(report, inventory.read_tables(data, 'a.csv'), [], data, 'a.csv', self.settings, limit=1)
        self.assertEqual(result['ai_summary']['completed'], 1)
        self.assertTrue(result['items'][0]['confirmed'])
        self.assertEqual(result['items'][1]['suggested_category'], '背包')
        self.assertEqual(result['items'][1]['status'], 'review')

    def test_text_provider_cannot_silently_drop_requested_images(self):
        self.settings.configure('deepseek', 'deepseek-chat', 'unit-test-not-a-real-key')
        data = b'SKU,title\n1,unknown\n'
        report = inventory.analyze(data, 'a.csv', 'AE', [], sheet='CSV')
        with self.assertRaisesRegex(ValueError, '不支持图片'):
            ai.enrich(report, inventory.read_tables(data, 'a.csv'), [], data, 'a.csv', self.settings, include_images=True)

    def test_500_limit_processes_100_batches_and_keeps_overflow_local(self):
        data=('SKU,title\n'+''.join(f'{i},unknown{i}\n' for i in range(501))).encode()
        report=inventory.analyze(data,'a.csv','AE',[],sheet='CSV')
        def mock_classify(settings,products,templates,images):
            return {p['row']:{'row':p['row'],'category':'测试类目','confidence':'medium','evidence':'模拟分类','template_id':None} for p in products}
        with patch.object(ai,'classify',side_effect=mock_classify) as call:
            result=ai.enrich(report,inventory.read_tables(data,'a.csv'),[],data,'a.csv',self.settings,limit=500)
        self.assertEqual(call.call_count,100)
        self.assertEqual(result['ai_summary']['completed'],500)
        self.assertNotIn('ai',result['items'][-1])
        with self.assertRaisesRegex(ValueError,'1–500'):
            ai.enrich(report,inventory.read_tables(data,'a.csv'),[],data,'a.csv',self.settings,limit=501)

    @staticmethod
    def mock_classification(settings, products, templates, images):
        return {p['row']: {'row': p['row'], 'category': '测试类目', 'confidence': 'medium',
                          'evidence': '模拟分类', 'template_id': None} for p in products}

    def test_identical_evidence_deduplicates_but_parameters_and_images_do_not(self):
        data = 'SKU,品名,参数\n1,独特商品,尺寸10\n2,独特商品,尺寸10\n3,独特商品,尺寸20\n4,独特商品,尺寸20\n'.encode()
        report = inventory.analyze(data, 'a.csv', 'AE', [], sheet='CSV')
        images = {4: {'mime': 'image/png', 'data': 'different'}}
        with patch.object(ai, 'classify', side_effect=self.mock_classification) as call, patch.object(ai, 'images_for_rows', return_value=(images, [])):
            result = ai.enrich(report, inventory.read_tables(data, 'a.csv'), [], data, 'a.csv', self.settings, include_images=True)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(len(call.call_args.args[1]), 3)
        self.assertEqual(result['ai_summary']['completed'], 4)
        self.assertEqual(result['ai_summary']['deduplicated'], 1)
        self.assertEqual(result['ai_summary']['images_sent'], 1)
        self.assertEqual(result['items'][1]['ai']['source'], 'duplicate')
        self.assertTrue(all(r['status'] == 'review' for r in result['items']))

    def test_generic_unknown_titles_do_not_merge_different_skus(self):
        data = b'SKU,title\nA,unknown\nB,unknown\n'
        with patch.object(ai, 'classify', side_effect=self.mock_classification) as call:
            result = ai.enrich(inventory.analyze(data, 'a.csv', 'AE', [], sheet='CSV'), inventory.read_tables(data, 'a.csv'), [], data, 'a.csv', self.settings)
        self.assertEqual(len(call.call_args.args[1]), 2)
        self.assertEqual(result['ai_summary']['deduplicated'], 0)

    def test_parallelism_is_bounded_and_first_batch_is_serial(self):
        import threading
        data = ('SKU,title\n'+''.join(f'{i},unknown{i}\n' for i in range(30))).encode()
        gate = threading.Barrier(3, timeout=5)
        lock = threading.Lock()
        metrics = {'active': 0, 'peak': 0, 'started': 0}
        def remote(settings, products, templates, images):
            with lock:
                metrics['active'] += 1
                metrics['started'] += 1
                number = metrics['started']
                metrics['peak'] = max(metrics['peak'], metrics['active'])
            try:
                if number in (2, 3, 4):
                    gate.wait()
                if number == 1:
                    self.assertEqual(metrics['active'], 1)
                return self.mock_classification(settings, products, templates, images)
            finally:
                with lock:
                    metrics['active'] -= 1
        states = []
        with patch.object(ai, 'classify', side_effect=remote):
            result = ai.enrich(inventory.analyze(data, 'a.csv', 'AE', [], sheet='CSV'), inventory.read_tables(data, 'a.csv'), [], data, 'a.csv', self.settings, progress=states.append)
        self.assertEqual(metrics['peak'], 3)
        self.assertEqual(result['ai_summary']['calls'], 6)
        self.assertEqual(result['ai_summary']['completed'], 30)
        self.assertEqual(states[-1]['completed'], 30)
        self.assertEqual([r['row'] for r in result['items']], list(range(2, 32)))

    def test_failure_after_first_batch_stops_new_work(self):
        data = ('SKU,title\n'+''.join(f'{i},unknown{i}\n' for i in range(50))).encode()
        def remote(settings, products, templates, images):
            if products[0]['row'] != 2:
                raise ValueError('模拟 HTTP 429')
            return self.mock_classification(settings, products, templates, images)
        with patch.object(ai, 'classify', side_effect=remote) as call:
            result = ai.enrich(inventory.analyze(data, 'a.csv', 'AE', [], sheet='CSV'), inventory.read_tables(data, 'a.csv'), [], data, 'a.csv', self.settings, limit=50)
        self.assertEqual(call.call_count, 4)
        self.assertEqual(result['ai_summary']['completed'], 5)
        self.assertNotIn('ai', result['items'][-1])
        self.assertEqual(result['warnings'].count('模拟 HTTP 429'), 1)

    def test_cache_is_scoped_to_member_model_credentials_catalog_and_target(self):
        cache = ai.ResultCache()
        data = 'SKU,品名\n1,独特商品\n2,独特商品\n'.encode()
        def run(scope='reader', catalog=None, shop='通用模板'):
            catalog = catalog or []
            return ai.enrich(inventory.analyze(data, 'a.csv', 'AE', catalog, sheet='CSV', shop=shop), inventory.read_tables(data, 'a.csv'), catalog, data, 'a.csv', self.settings, cache=cache, cache_scope=scope)
        with patch.object(ai, 'classify', side_effect=self.mock_classification) as call:
            self.assertEqual(run()['ai_summary']['cached'], 0)
            self.assertEqual(run()['ai_summary']['cached'], 2)
            self.assertEqual(call.call_count, 1)
            run('other-reader')
            self.settings.configure('qwen', 'qwen3-vl-plus', 'another-unit-test-key')
            run()
            run(catalog=[template()])
            run(shop='另一个店铺')
            self.assertEqual(call.call_count, 5)
        self.assertNotIn('another-unit-test-key', repr(cache.entries))
        self.assertNotIn('独特商品', repr(cache.entries))

    def test_cache_expiry_and_capacity(self):
        cache = ai.ResultCache(capacity=2, ttl=10)
        with patch.object(ai.time, 'monotonic', return_value=1):
            cache.put('a', {'category': 'A'})
            cache.put('b', {'category': 'B'})
            cached = cache.get('a');cached['category'] = 'changed'
            self.assertEqual(cache.get('a')['category'], 'A')
            cache.put('c', {'category': 'C'})
            self.assertIsNone(cache.get('b'))
        with patch.object(ai.time, 'monotonic', return_value=12):
            self.assertIsNone(cache.get('a'))

    def test_only_newest_catalog_version_sent_and_public_scope_preserved(self):
        data = b'SKU,title\n1,unknown\n'
        old, new = template(version='old', created='2025'), template(version='new', created='2026')
        foreign = dict(template(category='家具'), shop='其他店铺')
        with patch.object(ai, 'classify', side_effect=self.mock_classification) as call:
            ai.enrich(inventory.analyze(data, 'a.csv', 'AE', [old, new, foreign], sheet='CSV', shop='本店'), inventory.read_tables(data, 'a.csv'), [old, new, foreign], data, 'a.csv', self.settings)
        self.assertEqual([t['id'] for t in call.call_args.args[2]], [new['id']])

    def test_http_error_exposes_safe_provider_code_not_key(self):
        error=urllib.error.HTTPError('https://dashscope.aliyuncs.com',404,'not found',{},io.BytesIO(json.dumps({'error':{'code':'ModelNotFound','message':'Unknown model; unit-test-not-a-real-key'}}).encode()))
        with patch('urllib.request.urlopen',side_effect=error):
            with self.assertRaises(ValueError) as caught:ai.classify(self.settings,[{'row':1}],[],{})
        message=str(caught.exception)
        self.assertIn('ModelNotFound',message);self.assertIn('HTTP 404',message)
        self.assertNotIn('unit-test-not-a-real-key',message)

    def test_region_endpoint_and_old_default_preserved(self):
        self.settings.configure('qwen','qwen-vl-plus','unit-test-not-a-real-key',region='intl')
        with patch('urllib.request.urlopen',return_value=response([{'row':1,'category':'测试','confidence':'low','evidence':'模拟','template_id':None}])) as remote:
            ai.classify(self.settings,[{'row':1}],[],{})
        self.assertIn('dashscope-intl.aliyuncs.com',remote.call_args.args[0].full_url)
        self.assertEqual(ai.Settings(self.settings.path).public()['region'],'intl')

    def test_probe_calls_once_and_returns_no_key(self):
        with patch('urllib.request.urlopen',return_value=response([{'row':1,'category':'测试','confidence':'low','evidence':'模拟','template_id':None}])) as remote:
            result=ai.probe(self.settings)
        self.assertTrue(result['ok']);self.assertEqual(remote.call_count,1)
        self.assertNotIn('unit-test-not-a-real-key',json.dumps(result))


if __name__ == '__main__':
    unittest.main()

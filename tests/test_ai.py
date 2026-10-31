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


if __name__ == '__main__':
    unittest.main()

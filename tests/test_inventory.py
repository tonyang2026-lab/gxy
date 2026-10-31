import io
import unittest
from xml.sax.saxutils import escape
import zipfile

from template_manager import inventory


def make_book(sheets, zero_sku=False):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('xl/workbook.xml', '<workbook xmlns="'+inventory.NS['s']+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+''.join(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>' for i, name in enumerate(sheets, 1))+'</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(f'<Relationship Id="rId{i}" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets)+1))+'</Relationships>')
        if zero_sku:
            z.writestr('xl/styles.xml', '<styleSheet xmlns="'+inventory.NS['s']+'"><numFmts><numFmt numFmtId="164" formatCode="00000"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>')
        for i, rows in enumerate(sheets.values(), 1):
            xml = '<worksheet xmlns="'+inventory.NS['s']+'"><sheetData>'
            for r, row in enumerate(rows, 1):
                xml += f'<row r="{r}">'
                for c, value in enumerate(row):
                    ref = chr(65+c)+str(r)
                    if zero_sku and r > 1 and c == 0:
                        xml += f'<c r="{ref}" s="1"><v>{value}</v></c>'
                    else:
                        xml += f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'
                xml += '</row>'
            xml += '</sheetData></worksheet>'
            z.writestr(f'xl/worksheets/sheet{i}.xml', xml)
    return out.getvalue()


def template(market='AE', category='手机壳', version='v1', created='2026-10-30'):
    return {'id': market+category+version, 'marketplace': market, 'category': category, 'version': version, 'original_name': category+'.xlsm', 'created_at': created}


class InventoryTests(unittest.TestCase):
    def report(self, text, templates=(), **kwargs):
        return inventory.analyze(text.encode('utf-8-sig'), '库存.csv', 'AE', list(templates), sheet='CSV', **kwargs)

    def test_three_outcomes_and_site_isolation(self):
        r = self.report('SKU,品名,类目\n001,保护壳,手机壳\n002,毛巾,毛巾\n003,未知商品,\n', [template(), template('SA', '毛巾')])
        self.assertEqual(r['summary'], {'total': 3, 'available': 1, 'missing': 1, 'review': 1})
        self.assertEqual(r['items'][0]['sku'], '001')
        self.assertIn('第 3 行', r['items'][1]['evidence'])
        self.assertIsNone(r['items'][1]['template'])

    def test_keyword_only_never_claims_confirmed(self):
        r = self.report('SKU,品名\n1,USB charging cable\n2,手机壳\n', [template()])
        self.assertEqual(r['summary']['review'], 2)
        self.assertEqual(r['items'][0]['suggested_category'], '数据线')
        self.assertIsNone(r['items'][0]['template'])
        self.assertIsNotNone(r['items'][1]['template'])

    def test_multiple_types_stay_ambiguous(self):
        r = self.report('SKU,品名\n1,手机壳和手机支架套装\n', [template(), template(category='手机支架')])
        self.assertEqual(r['items'][0]['status'], 'review')
        self.assertIsNone(r['items'][0]['template'])

    def test_latest_registered_version_and_old_candidates(self):
        r = self.report('SKU,类目\nA,手机壳\n', [template(), template(version='v2', created='2026-10-31')])
        self.assertEqual(r['items'][0]['template']['version'], 'v2')
        self.assertEqual(len(r['items'][0]['candidates']), 2)

    def test_header_after_notes_and_multi_sheet(self):
        data = make_book({'说明': [['说明', '不是商品数据']], '库存': [['2026 库存'], ['SKU', '商品名称', '类别'], ['0012', '手机壳', '手机壳']]})
        info = inventory.inspect(data, 'test.xlsx')
        self.assertEqual((info['sheet'], info['header_row']), ('库存', 2))
        self.assertEqual(len(info['sheets']), 2)
        r = inventory.analyze(data, 'test.xlsx', 'AE', [template()], sheet='库存', header_row=2, mapping=info['mapping'])
        self.assertEqual(r['items'][0]['row'], 3)
        self.assertEqual(r['items'][0]['sku'], '0012')

    def test_excel_numeric_sku_zero_format(self):
        data = make_book({'库存': [['SKU', '类目'], ['12', '手机壳']]}, zero_sku=True)
        r = inventory.analyze(data, 'test.xlsm', 'AE', [template()], sheet='库存')
        self.assertEqual(r['items'][0]['sku'], '00012')

    def test_custom_mapping_and_duplicate_headers(self):
        data = '内部编号,描述,部门\n001,手机壳,手机壳\n'
        r = self.report(data, [template()], mapping={'sku': 0, 'title': 1, 'category': 2})
        self.assertEqual(r['summary']['available'], 1)
        self.assertIsNone(inventory.mapping_for(['SKU', 'SKU', '品名'])['sku'])

    def test_missing_columns_not_faked(self):
        with self.assertRaisesRegex(ValueError, '至少指定品名列或类目列'):
            self.report('SKU,库存数量\n1,99\n')
        with self.assertRaisesRegex(ValueError, '同一列'):
            self.report('SKU,品名\n1,x\n', mapping={'sku': 0, 'title': 0, 'category': None})

    def test_unsupported_and_wrong_sheet(self):
        with self.assertRaisesRegex(ValueError, '旧版'):
            inventory.inspect(b'xls', 'old.xls')
        with self.assertRaisesRegex(ValueError, '工作表'):
            inventory.analyze(b'SKU,title\n1,a', 'a.csv', 'AE', [], sheet='other')

    def test_gb18030_and_semicolon_csv(self):
        data = 'SKU;品名;类目\n01;毛巾;毛巾\n'.encode('gb18030')
        info = inventory.inspect(data, '库存.csv')
        self.assertEqual(info['headers'], ['SKU', '品名', '类目'])

    def test_unknown_is_not_a_missing_template(self):
        r = self.report('SKU,品名\n001,特殊商品XYZ\n')
        self.assertEqual(r['summary']['missing'], 0)
        self.assertEqual(r['items'][0]['status'], 'review')

    def test_no_external_xml_entities(self):
        with self.assertRaisesRegex(ValueError, 'DTD'):
            inventory.xml(b'<!DOCTYPE a [<!ENTITY x "test">]><a>&x;</a>')

    def test_manual_category_confirmation_preserves_original(self):
        r = self.report('SKU,品名\n001,手机壳\n002,电热水壶\n', [template()], category_overrides={'2': '手机壳', '3': '电热水壶'})
        self.assertEqual(r['summary']['available'], 1)
        self.assertEqual(r['summary']['missing'], 1)
        self.assertEqual(r['items'][0]['original_category'], '')
        self.assertTrue(r['items'][0]['confirmed'])
        self.assertIn('用户已', r['items'][0]['evidence'])
        with self.assertRaisesRegex(ValueError, '行号'):
            self.report('SKU,品名\n1,x\n', category_overrides={'999': '手机壳'})

    def test_users_luggage_example_without_exact_product_name(self):
        title = '三件套 TSA-Compatible Lock 宽拉杆 材质: ABS+PC 尺寸: 20/24/28'
        r = self.report('SKU,品名\nDEMO-LUG-001,'+title+'\n', [template(category='Luggage')])
        self.assertEqual(r['items'][0]['suggested_category'], '行李箱')
        self.assertEqual(r['items'][0]['template']['category'], 'Luggage')
        self.assertIn('组合属性', r['items'][0]['evidence'])
        self.assertEqual(r['items'][0]['status'], 'review')

    def test_lock_or_material_alone_not_luggage(self):
        for title in ['TSA-Compatible Lock', 'ABS+PC 三件套 20/24/28', '拉杆替换配件 TSA ABS+PC 20/24/28']:
            self.assertNotIn('行李箱', [label for label, _ in inventory.hits(title)])

    def test_attributes_in_separate_columns(self):
        r = self.report('SKU,品名,材质,尺寸,描述\n1,三件套,ABS+PC,20/24/28,TSA 宽拉杆\n')
        self.assertEqual(r['items'][0]['suggested_category'], '行李箱')

    def test_synonym_category_candidate_not_false_missing(self):
        r = self.report('SKU,品名,类目\n1,手机保护套,手机保护套\n', [template(category='phone cases')])
        self.assertEqual(r['items'][0]['status'], 'review')
        self.assertEqual(r['items'][0]['template']['category'], 'phone cases')

    def test_category_key_merges_chinese_english_luggage_labels(self):
        r=self.report('SKU,品名,类目\n1,行李箱,行李箱\n2,suitcase,SUITCASE\n3,旅行箱,luggage\n',[template(category='SUITCASE')])
        self.assertEqual({item['category_key'] for item in r['items']},{'行李箱'})


if __name__ == '__main__':
    unittest.main()

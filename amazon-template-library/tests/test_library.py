import sys, io, json, tempfile, unittest, zipfile, hashlib, threading
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app, workbook
from xml.sax.saxutils import escape


def book(rows, macros=False, prefix=''):
    ns=workbook.NS['s'];p=prefix
    contents=''
    for r, row in enumerate(rows,1):
        cells=''
        for col,value in enumerate(row,1):
            if value is None:continue
            ref=workbook.colname(col)+str(r)
            if isinstance(value,tuple):cells+=f'<{p}c r="{ref}"><{p}f>{escape(value[0])}</{p}f><{p}v>999</{p}v></{p}c>'
            else:cells+=f'<{p}c r="{ref}" t="inlineStr"><{p}is><{p}t>{escape(str(value))}</{p}t></{p}is></{p}c>'
        contents+=f'<{p}row r="{r}">{cells}</{p}row>'
    decl=f'xmlns:{p[:-1]}="{ns}"' if p else f'xmlns="{ns}"'
    sheet=f'<?xml version="1.0" encoding="UTF-8"?><{p}worksheet {decl} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"><{p}dimension ref="A1:C{len(rows)}"/><{p}sheetData>{contents}</{p}sheetData><{p}dataValidations count="1"><{p}dataValidation type="list" sqref="C4:C100"><{p}formula1>"Black,White"</{p}formula1></{p}dataValidation></{p}dataValidations></{p}worksheet>'
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml',f'<workbook xmlns="{ns}" xmlns:r="{workbook.NS["r"]}"><sheets><sheet name="Template" sheetId="1" r:id="rId1"/><sheet name="Data Definitions" sheetId="2" r:id="rId2" state="hidden"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml',sheet)
        z.writestr('xl/worksheets/sheet2.xml',f'<worksheet xmlns="{ns}"><sheetData/></worksheet>')
        if macros:z.writestr('xl/vbaProject.bin',b'fixture-macro-preservation')
    return data.getvalue()


TEMPLATE=lambda prefix='':book([['DEMO — NOT AN OFFICIAL AMAZON TEMPLATE'],['SKU','Title','Color'],['item_sku','item_name','color_name']],True,prefix)
SOURCE=lambda:book([['SKU','商品名称','颜色'],['000123','Desk lamp','Black'],['A-002','Lamp two','White']])
LAYOUT={'sheet':'Template','header':3,'start':4}
SOURCE_LAYOUT={'sheet':'Template','header':1,'start':2}


class WorkbookTests(unittest.TestCase):
    def test_preserves_all_other_parts_macros_and_values_with_prefixes(self):
        for prefix in ('','x:'):
            original=TEMPLATE(prefix)
            result,issues,stats=workbook.fill(original,SOURCE(),LAYOUT,SOURCE_LAYOUT,{'A':'A','B':'B','C':'C'},['A'])
            self.assertEqual(stats,{'rows':2,'cells':6,'issues':0,'draft':True});self.assertFalse(issues)
            with zipfile.ZipFile(io.BytesIO(original)) as before,zipfile.ZipFile(io.BytesIO(result)) as after:
                self.assertEqual(before.namelist(),after.namelist())
                for name in before.namelist():
                    if name!='xl/worksheets/sheet1.xml':self.assertEqual(before.read(name),after.read(name))
                xml=after.read('xl/worksheets/sheet1.xml');self.assertIn(b'mc:Ignorable="x14ac"',xml);self.assertIn(b'xmlns:x14ac=',xml)
                root=workbook.ET.fromstring(xml)
                self.assertEqual(root.find("s:sheetData/s:row[@r='4']/s:c[@r='A4']/s:is/s:t",workbook.NS).text,'000123')
                self.assertIsNotNone(root.find('s:dataValidations',workbook.NS))
            self.assertEqual(hashlib.sha256(original).hexdigest(),hashlib.sha256(TEMPLATE(prefix)).hexdigest())
    def test_no_invented_required_values_and_formula_sources_are_skipped(self):
        source=book([['SKU','品牌'],['A-1',('SUM(1,2)',)]])
        out,issues,stats=workbook.fill(TEMPLATE(),source,LAYOUT,SOURCE_LAYOUT,{'A':'A','B':'B'},['B','C'])
        self.assertEqual(len(issues),3);self.assertEqual(stats['cells'],1)
        with workbook.archive(out) as z:self.assertNotIn('B4',workbook.read_cells(z,workbook.sheets(z)[0]))
    def test_rejects_existing_data_invalid_mapping_and_bad_upload(self):
        dirty=book([['a'],['b'],['sku'],['old-sku']])
        with self.assertRaisesRegex(ValueError,'旧商品'):workbook.fill(dirty,SOURCE(),LAYOUT,SOURCE_LAYOUT,{'A':'A'},[])
        with self.assertRaises(ValueError):workbook.fill(TEMPLATE(),SOURCE(),LAYOUT,SOURCE_LAYOUT,{'Z':'A'},[])
        with self.assertRaises(ValueError):workbook.inspect(b'not an excel file')
    def test_formula_like_text_is_not_executed_and_duplicates_reported(self):
        source=book([['SKU','名称'],['001','=HYPERLINK("bad")'],['001','text']])
        out,issues,_=workbook.fill(TEMPLATE(),source,LAYOUT,SOURCE_LAYOUT,{'A':'A','B':'B'},[])
        self.assertEqual(len(issues),1)
        with workbook.archive(out) as z:
            c=workbook.read_cells(z,workbook.sheets(z)[0])['B4'];self.assertFalse(c['formula']);self.assertTrue(c['value'].startswith('='))


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.old=app.DATA;app.DATA=Path(self.temp.name);app.init()
    def tearDown(self):app.DATA=self.old;self.temp.cleanup()
    def add(self,version='v1'):return app.add_template({'name':'AE Lighting','site':'AE','category':'LIGHT_FIXTURE','version':version},'original.xlsm',TEMPLATE())
    def test_restart_keeps_original_and_versions(self):
        first=self.add();second=self.add('v2');app.init()
        self.assertEqual(len(app.records()),2);self.assertEqual(first['active'],1);self.assertEqual(second['active'],0)
        self.assertEqual(app.read_template(first),TEMPLATE())
    def test_backup_restore_and_repeated_restore_do_not_duplicate(self):
        first=self.add();self.add('v2');data=app.backup()
        self.assertEqual(app.restore(data),0)
        with app.db() as c:c.execute('DELETE FROM templates')
        self.assertEqual(app.restore(data),2);self.assertEqual(app.restore(data),0)
        self.assertEqual(len(app.records()),2);self.assertEqual(sum(r['active'] for r in app.records()),1)
    def test_tampered_backup_and_original_are_rejected(self):
        r=self.add();app.template_file(r).write_bytes(b'broken')
        with self.assertRaisesRegex(ValueError,'校验失败'):app.read_template(r)
        with self.assertRaises(ValueError):app.restore(b'not zip')
    def test_http_requires_token_and_downloads_exact_original(self):
        r=self.add();server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base=f'http://127.0.0.1:{server.server_port}'
        try:
            with self.assertRaises(HTTPError) as denied:urlopen(base+'/api/templates')
            self.assertEqual(denied.exception.code,401)
            with urlopen(Request(base+'/api/templates',headers={'Authorization':'Bearer '+app.TOKEN})) as response:self.assertEqual(len(json.load(response)['templates']),1)
            with urlopen(Request(base+'/api/template/'+r['id']+'/download',headers={'Authorization':'Bearer '+app.TOKEN})) as response:self.assertEqual(response.read(),TEMPLATE())
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()

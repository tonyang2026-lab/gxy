import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import zipfile
from template_manager import library
from test_inventory import make_book


class DownloadTests(unittest.TestCase):
    def test_single_excel_multi_zip_and_missing_id(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'library';source=Path(d)/'template.xlsm';raw=make_book({'Template':[['sku','title']]});source.write_bytes(raw)
            ids=[]
            for category in ['行李箱','手机壳']:
                row=library.run(SimpleNamespace(command='add',library=str(root),source=str(source),shop='测试店',marketplace='AE',category=category,version='v1'));ids.append(row['id'])
            data,name=library.download_templates(root,ids[:1]);self.assertEqual(data,raw);self.assertEqual(name,'template.xlsm')
            data,name=library.download_templates(root,ids);self.assertTrue(name.endswith('.zip'))
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                self.assertEqual(len(set(z.namelist())),2)
                for file in z.namelist():self.assertEqual(z.read(file),raw)
            with self.assertRaisesRegex(ValueError,'已经|已被删除'):library.download_templates(root,[ids[0],'missing'])
            with self.assertRaisesRegex(ValueError,'不同表格'):library.download_templates(root,[ids[0],ids[0]])

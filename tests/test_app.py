import base64
from http.client import HTTPConnection
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

from app import create_server
from template_manager import library


class SharedLibraryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = create_server(Path(cls.tmp.name) / 'library', 0)
        for name, role in [('owner', 'admin'), ('writer', 'editor'), ('reader', 'viewer')]:
            cls.server.auth.create(name, 'a-secure-test-password', role)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.tmp.cleanup()

    def req(self, method, path, data=None, cookie=None, extra=None):
        c = HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        headers = {'Content-Type': 'application/json', 'X-Template-Request': '1'}
        if cookie: headers['Cookie'] = cookie
        headers.update(extra or {})
        c.request(method, path, json.dumps(data) if data is not None else None, headers)
        r = c.getresponse(); result = (r.status, r.read(), r.getheader('Set-Cookie')); c.close()
        return result

    def login(self, name):
        status, _, cookie = self.req('POST', '/api/login', {'username': name, 'password': 'a-secure-test-password'})
        self.assertEqual(status, 200)
        return cookie.split(';')[0]

    def test_shared_workflow(self):
        self.assertEqual(self.req('GET', '/api/templates')[0], 401)
        owner, writer, reader = [self.login(n) for n in ('owner', 'writer', 'reader')]
        fixture = io.BytesIO()
        with zipfile.ZipFile(fixture, 'w') as z:
            z.writestr('[Content_Types].xml', '<Types/>')
            z.writestr('xl/workbook.xml', '<workbook/>')
            z.writestr('xl/vbaProject.bin', b'macro-fixture')
        data = fixture.getvalue()
        upload = {'filename': 'original.xlsm', 'data': base64.b64encode(data).decode(), 'marketplace': 'AE', 'category': '家居', 'version': 'v1'}
        self.assertEqual(self.req('POST', '/api/upload', upload, reader)[0], 403)
        status, result, _ = self.req('POST', '/api/upload', upload, writer)
        self.assertEqual(status, 200, result)
        ident = json.loads(result)['id']
        self.assertEqual(len(json.loads(self.req('GET', '/api/templates', cookie=reader)[1])), 1)
        self.assertEqual(self.req('GET', '/api/download/' + ident, cookie=reader)[1], data)
        self.assertTrue(json.loads(self.req('POST', '/api/upload', upload, writer)[1])['reused'])
        user = {'username': 'new-reader', 'password': 'another-secure-password', 'role': 'viewer'}
        self.assertEqual(self.req('POST', '/api/users', user, writer)[0], 403)
        self.assertEqual(self.req('POST', '/api/users', user, owner)[0], 200)
        self.assertEqual(self.req('POST', '/api/upload', upload, writer, {'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.req('GET', '/api/templates', cookie=reader, extra={'Host': 'evil.example'})[0], 403)
        status, backup, _ = self.req('GET', '/api/backup', cookie=owner)
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(backup)) as z:
            self.assertEqual(len(json.loads(z.read('manifest.json'))['templates']), 1)
        backup_path = Path(self.tmp.name) / 'portable.zip'
        backup_path.write_bytes(backup)
        restored = Path(self.tmp.name) / 'restored-library'
        library.run(SimpleNamespace(command='restore', library=str(restored), source=str(backup_path)))
        records = library.run(SimpleNamespace(command='list', library=str(restored), marketplace=None, category=None))
        self.assertEqual(library.verified(restored, records[0]), data)
        # A second process/server reading the same saved data sees the persisted library.
        persisted = library.run(SimpleNamespace(command='list', library=str(Path(self.tmp.name) / 'library'), marketplace=None, category=None))
        self.assertEqual(persisted[0]['id'], ident)
        restore = {'filename': 'backup.zip', 'data': base64.b64encode(backup).decode()}
        self.assertEqual(self.req('POST', '/api/restore', restore, owner)[0], 400)
        self.assertEqual(self.req('POST', '/api/logout', {}, reader)[0], 200)
        self.assertEqual(self.req('GET', '/api/templates', cookie=reader)[0], 401)

    def test_wrong_password(self):
        self.assertEqual(self.req('POST', '/api/login', {'username': 'owner', 'password': 'wrong'})[0], 400)

    def test_delete_endpoint_enforces_roles_and_download_disappears(self):
        from test_inventory import make_book
        owner,reader,writer=self.login('owner'),self.login('reader'),self.login('writer')
        data=make_book({'Template':[['sku','title']]})
        payload={'filename':'delete-test.xlsx','data':base64.b64encode(data).decode(),'shop':'删除测试店','marketplace':'AE','category':'删除测试类目','version':'v1'}
        status,raw,_=self.req('POST','/api/upload',payload,owner);self.assertEqual(status,200)
        ident=json.loads(raw)['id']
        self.assertEqual(self.req('POST','/api/template/delete',{'id':ident})[0],401)
        self.assertEqual(self.req('POST','/api/template/delete',{'id':ident},reader)[0],403)
        self.assertEqual(self.req('GET','/api/download/'+ident,cookie=reader)[0],200)
        self.assertEqual(self.req('POST','/api/templates/download',{'ids':[ident]})[0],401)
        status,download,_=self.req('POST','/api/templates/download',{'ids':[ident]},reader)
        self.assertEqual(status,200);self.assertEqual(download,data)
        self.assertEqual(self.req('POST','/api/templates/delete',{'ids':[ident]},reader)[0],403)
        self.assertEqual(self.req('POST','/api/template/delete',{'id':ident},writer)[0],200)
        self.assertEqual(self.req('GET','/api/download/'+ident,cookie=owner)[0],404)

    def test_inventory_readonly_analysis(self):
        payload = {'filename': '库存.csv', 'data': base64.b64encode('SKU,品名,类目\n001,不明商品,新类目\n'.encode()).decode()}
        self.assertEqual(self.req('POST', '/api/inventory/inspect', payload)[0], 401)
        reader = self.login('reader')
        status, raw, _ = self.req('POST', '/api/inventory/inspect', payload, reader)
        self.assertEqual(status, 200, raw)
        info = json.loads(raw)
        payload.update(marketplace='AE', sheet=info['sheet'], header_row=info['header_row'], mapping=info['mapping'])
        status, raw, _ = self.req('POST', '/api/inventory/analyze', payload, reader)
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)['summary']['missing'], 1)

    def test_inventory_progress_remains_readable_during_ai_and_cache_can_be_disabled(self):
        from template_manager import ai
        reader, writer = self.login('reader'), self.login('writer')
        self.server.ai.configure('qwen', 'qwen3-vl-plus', 'unit-test-not-a-real-key')
        payload = {'filename': 'stock.csv', 'data': base64.b64encode('SKU,品名\nA,进度专用商品\nB,进度专用商品\n'.encode()).decode(), 'marketplace': 'AE', 'sheet': 'CSV', 'job_id': 'live-progress', 'use_ai': True, 'ai_consent': True}
        entered, release = threading.Event(), threading.Event()
        def remote(settings, products, templates, images):
            entered.set()
            if not release.wait(5):
                raise ValueError('测试等待超时')
            return {p['row']: {'row': p['row'], 'category': '测试建议', 'confidence': 'low', 'evidence': '模拟进度', 'template_id': None} for p in products}
        responses = []
        with patch.object(ai, 'classify', side_effect=remote) as call:
            worker = threading.Thread(target=lambda: responses.append(self.req('POST', '/api/inventory/analyze', payload, reader)))
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                own = json.loads(self.req('GET', '/api/inventory/progress?job_id=live-progress', cookie=reader)[1])
                other = json.loads(self.req('GET', '/api/inventory/progress?job_id=live-progress', cookie=writer)[1])
                self.assertEqual(own['stage'], 'ai')
                self.assertEqual(own['total'], 2)
                self.assertEqual(other, {'stage': 'upload'})
                self.assertTrue(worker.is_alive())
            finally:
                release.set();worker.join(5)
            self.assertEqual(responses[0][0], 200, responses)
            payload['job_id'] = 'live-progress-cached'
            status, raw, _ = self.req('POST', '/api/inventory/analyze', payload, reader)
            self.assertEqual(status, 200, raw)
            self.assertEqual(json.loads(raw)['ai_summary']['cached'], 2)
            self.assertEqual(call.call_count, 1)
            payload.update(job_id='live-progress-fresh', use_ai_cache=False)
            status, raw, _ = self.req('POST', '/api/inventory/analyze', payload, reader)
            self.assertEqual(status, 200, raw)
            self.assertEqual(json.loads(raw)['ai_summary']['cached'], 0)
            self.assertEqual(call.call_count, 2)

    def test_inventory_parsed_once_and_progress_is_member_scoped(self):
        from template_manager import inventory
        reader, writer = self.login('reader'), self.login('writer')
        payload = {'filename': 'stock.csv', 'data': base64.b64encode(b'SKU,title\nA,unknown-progress\n').decode(), 'marketplace': 'AE', 'sheet': 'CSV', 'job_id': 'progress-unit-test'}
        self.assertEqual(self.req('GET', '/api/inventory/progress?job_id=progress-unit-test')[0], 401)
        with patch.object(inventory, 'read_tables', wraps=inventory.read_tables) as read:
            status, raw, _ = self.req('POST', '/api/inventory/analyze', payload, reader)
        self.assertEqual(status, 200, raw)
        self.assertEqual(read.call_count, 1)
        own = json.loads(self.req('GET', '/api/inventory/progress?job_id=progress-unit-test', cookie=reader)[1])
        other = json.loads(self.req('GET', '/api/inventory/progress?job_id=progress-unit-test', cookie=writer)[1])
        self.assertEqual(own['stage'], 'done')
        self.assertEqual(other, {'stage': 'upload'})
        self.assertNotIn('unknown-progress', json.dumps(own))
        self.assertEqual(self.req('POST', '/api/inventory/analyze', payload, reader)[0], 400)

    def test_static_ui(self):
        for path in ('/', '/style.css', '/app.js'):
            self.assertEqual(self.req('GET', path)[0], 200)

    def test_roster_import_admin_only(self):
        from test_roster import TABLE
        reader, owner = self.login('reader'), self.login('owner')
        self.assertEqual(self.req('POST', '/api/shops/import', {'text': TABLE}, reader)[0], 403)
        status, raw, _ = self.req('POST', '/api/shops/import', {'text': TABLE}, owner)
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)['shops'], 2)
        status, raw, _ = self.req('GET', '/api/shops', cookie=reader)
        self.assertEqual(status, 200)
        self.assertIn('测试甲', json.loads(raw))
        self.assertNotIn(b'ATEST001', raw)

    def test_batch_same_region_download_and_permissions(self):
        from test_roster import TABLE
        from test_metadata import account_book
        owner, reader = self.login('owner'), self.login('reader')
        self.assertEqual(self.req('POST','/api/shops/import',{'text':TABLE},owner)[0],200)
        source = account_book(account='ATEST001')
        payload = {'filename':'source.xlsm','data':base64.b64encode(source).decode(),'shops':['测试甲','测试乙'],'category':'行李箱','version':'api-batch','save_to_library':False}
        self.assertEqual(self.req('POST','/api/template/batch',payload,reader)[0],403)
        status,raw,_ = self.req('POST','/api/template/batch',payload,owner)
        self.assertEqual(status,200)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            report=json.loads(z.read('生成与入库报告.json'))
            self.assertEqual(report['generated'],2)
            self.assertEqual(report['marketplace'],'AE')
            self.assertEqual(report['saved'],0)

    def test_batch_save_only_json_permissions_and_later_download(self):
        from test_roster import TABLE
        from test_metadata import account_book
        owner,writer,reader=[self.login(name) for name in ('owner','writer','reader')]
        self.assertEqual(self.req('POST','/api/shops/import',{'text':TABLE},owner)[0],200)
        source=account_book(account='ATEST001')
        payload={'filename':'source.xlsm','data':base64.b64encode(source).decode(),'shops':['测试甲','测试乙'],'category':'仅入库接口测试','version':'api-save-only','save_to_library':True,'download_zip':False}
        self.assertEqual(self.req('POST','/api/template/batch',payload,reader)[0],403)
        self.assertEqual(self.req('POST','/api/template/batch',dict(payload,save_to_library=False),writer)[0],400)
        ids=[]
        try:
            status,raw,_=self.req('POST','/api/template/batch',payload,writer)
            self.assertEqual(status,200,raw);report=json.loads(raw)
            self.assertEqual((report['generated'],report['saved'],report['failed']),(2,2,0))
            self.assertFalse(report['download_requested'])
            self.assertNotIn(b'ATEST003',raw)
            ids=[item['template_id'] for item in report['items']]
            for ident in ids:self.assertEqual(self.req('GET','/api/download/'+ident,cookie=reader)[0],200)
            status,raw,_=self.req('POST','/api/templates/download',{'ids':ids},reader)
            self.assertEqual(status,200)
            with zipfile.ZipFile(io.BytesIO(raw)) as z:self.assertEqual(len(z.namelist()),2)
            status,raw,_=self.req('POST','/api/template/batch',payload,writer)
            self.assertEqual(status,200,raw)
            self.assertEqual(json.loads(raw)['reused'],2)
        finally:
            if ids:self.req('POST','/api/templates/delete',{'ids':ids},writer)

    def test_ai_config_permissions_consent_and_result(self):
        owner, reader = self.login('owner'), self.login('reader')
        config = {'provider': 'qwen', 'model': 'qwen-vl-plus', 'api_key': 'unit-test-not-a-real-key'}
        self.assertEqual(self.req('POST', '/api/ai/settings', config, reader)[0], 403)
        status, raw, _ = self.req('POST', '/api/ai/settings', config, owner)
        self.assertEqual(status, 200, raw)
        self.assertNotIn(b'unit-test-not-a-real-key', raw)
        payload = {'filename': 'stock.csv', 'data': base64.b64encode(b'SKU,title\nA,unknown\n').decode(), 'marketplace': 'AE', 'sheet': 'CSV', 'use_ai': True}
        with patch('urllib.request.urlopen') as remote:
            self.assertEqual(self.req('POST', '/api/inventory/analyze', payload, owner)[0], 400)
            remote.assert_not_called()
        payload['ai_consent'] = True
        answer = {'row': 2, 'category': '行李箱', 'confidence': 'high', 'evidence': '实物候选判断', 'template_id': None}
        remote_response = io.BytesIO(json.dumps({'choices': [{'message': {'content': json.dumps({'items': [answer]})}}]}).encode())
        with patch('urllib.request.urlopen', return_value=remote_response):
            status, raw, _ = self.req('POST', '/api/inventory/analyze', payload, owner)
        self.assertEqual(status, 200, raw)
        result = json.loads(raw)
        self.assertEqual(result['ai_summary']['completed'], 1)
        self.assertEqual(result['items'][0]['suggested_category'], '行李箱')
        self.assertEqual(result['items'][0]['status'], 'review')


if __name__ == '__main__':
    unittest.main()

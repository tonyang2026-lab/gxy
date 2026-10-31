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

    def test_static_ui(self):
        for path in ('/', '/style.css', '/app.js'):
            self.assertEqual(self.req('GET', path)[0], 200)


if __name__ == '__main__':
    unittest.main()

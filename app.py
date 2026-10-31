#!/usr/bin/env python3
"""Local Amazon template manager. Python 3.9+, no external dependencies."""
import argparse
import base64
import binascii
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import getpass
from http.cookies import SimpleCookie
from pathlib import Path
import shutil
import tempfile
import threading
from types import SimpleNamespace
from urllib.parse import parse_qs, quote, urlparse

from template_manager import library
from template_manager.auth import Auth
from template_manager import inventory
from template_manager import ai

WEB = Path(__file__).parent / 'web'
LOCK = threading.Lock()
MAX_BODY = 46 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, data_dir, **kwargs):
        self.root = Path(data_dir)
        super().__init__(*args, **kwargs)

    def log_message(self, fmt, *args):
        # Do not log uploaded filenames or metadata.
        pass

    def send(self, data, status=200, mime='application/json; charset=utf-8', filename=None, cookie=None):
        if isinstance(data, (dict, list)):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
        if filename:
            self.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + quote(filename, safe=''))
        self.end_headers()
        self.wfile.write(data)

    def trusted(self):
        host = self.headers.get('Host', '')
        allowed = self.server.allowed_hosts
        if host not in allowed:
            self.send({'error': '访问域名未配置'}, 403)
            return False
        origin = self.headers.get('Origin')
        if origin and origin != self.server.scheme + '://' + host:
            self.send({'error': '拒绝跨站请求'}, 403)
            return False
        return True

    def token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            return cookie['session'].value if 'session' in cookie else ''
        except Exception:
            return ''

    def identity(self, roles=None):
        user = self.server.auth.user(self.token())
        if not user:
            self.send({'error': '请先登录'}, 401)
            return None
        if roles and user['role'] not in roles:
            self.send({'error': '当前账号没有此操作权限'}, 403)
            return None
        return user

    def call(self, command, **kwargs):
        return library.run(SimpleNamespace(library=str(self.root), command=command, **kwargs))

    def do_GET(self):
        if not self.trusted():
            return
        path = urlparse(self.path)
        try:
            with LOCK:
                if path.path == '/api/me':
                    user = self.identity()
                    if user:
                        self.send(user)
                    return
                if path.path.startswith('/api/') and not self.identity():
                    return
                if path.path == '/api/templates':
                    q = parse_qs(path.query)
                    self.send(self.call('list', marketplace=q.get('marketplace', [None])[0], category=q.get('category', [None])[0], shop=q.get('shop', [None])[0]))
                elif path.path == '/api/ai/settings':
                    self.send(self.server.ai.public())
                elif path.path == '/api/backup':
                    with tempfile.TemporaryDirectory() as d:
                        dest = Path(d) / 'backup.zip'
                        self.call('backup', output=str(dest))
                        self.send(dest.read_bytes(), mime='application/zip', filename='amazon-template-backup.zip')
                elif path.path.startswith('/api/download/'):
                    ident = path.path.rsplit('/', 1)[-1]
                    rows = self.call('list', marketplace=None, category=None)
                    row = next((r for r in rows if r['id'] == ident), None)
                    if row is None:
                        self.send({'error': '模板不存在'}, 404)
                        return
                    data = library.verified(self.root, row)
                    self.send(data, mime='application/octet-stream', filename=row['original_name'])
                elif path.path in ('/', '/app.js', '/style.css'):
                    name = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}[path.path]
                    mime = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8'}[name]
                    self.send((WEB / name).read_bytes(), mime=mime)
                else:
                    self.send({'error': '页面不存在'}, 404)
        except Exception as e:
            self.send({'error': str(e)}, 400)

    def do_POST(self):
        if not self.trusted():
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send({'error': '请求必须为 JSON'}, 415)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BODY:
                self.send({'error': '文件过大或请求为空（文件上限 32 MB）'}, 413)
                return
            body = json.loads(self.rfile.read(size))
            if self.headers.get('X-Template-Request') != '1':
                self.send({'error': '缺少请求校验标记'}, 403)
                return
            if self.path == '/api/login':
                username, password = body.get('username', ''), body.get('password', '')
                if not isinstance(username, str) or not isinstance(password, str) or len(username) > 80 or len(password) > 256:
                    raise ValueError('登录信息格式错误')
                with LOCK:
                    token = self.server.auth.login(username, password, self.client_address[0])
                suffix = '; Secure' if self.server.scheme == 'https' else ''
                self.send({'ok': True}, cookie=f'session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' + suffix)
                return
            roles = ('admin',) if self.path in ('/api/users', '/api/restore', '/api/ai/settings') else ('admin', 'editor')
            if self.path in ('/api/logout', '/api/inventory/inspect', '/api/inventory/analyze'):
                roles = None
            if not self.identity(roles):
                return
            if self.path == '/api/logout':
                self.server.auth.logout(self.token())
                self.send({'ok': True}, cookie='session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
                return
            if self.path == '/api/users':
                self.server.auth.create(body['username'], body['password'], body['role'])
                self.send({'ok': True})
                return
            if self.path == '/api/ai/settings':
                if self.server.scheme != 'https' and self.client_address[0] not in ('127.0.0.1', '::1'):
                    self.send({'error': 'HTTP 模式下仅允许在服务器本机配置 API 密钥，请用 127.0.0.1 打开软件'}, 403)
                    return
                self.server.ai.configure(body.get('provider'), body.get('model'), body.get('api_key', ''))
                self.send(self.server.ai.public())
                return
            if self.path == '/api/template-shop':
                with LOCK:
                    self.send(library.move_shop(self.root, body.get('id'), body.get('shop')))
                return
            data = base64.b64decode(body['data'], validate=True)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError('文件不能超过 32 MB')
            name = body.get('filename', '')
            if not isinstance(name, str) or not name or '/' in name or '\\' in name or len(name) > 200:
                raise ValueError('文件名无效')
            if self.path == '/api/inventory/inspect':
                self.send(inventory.inspect(data, name, body.get('sheet'), body.get('header_row')))
                return
            if self.path == '/api/template/inspect':
                with LOCK:
                    self.send(library.inspect_template(self.root, data, Path(name).suffix))
                return
            if self.path == '/api/inventory/analyze':
                with LOCK:
                    templates = self.call('list', marketplace=None, category=None)
                report = inventory.analyze(data, name, body.get('marketplace', ''), templates, body.get('sheet'), body.get('header_row'), body.get('mapping'), body.get('category_overrides'), body.get('shop', library.GLOBAL_SHOP))
                if body.get('use_ai') is True:
                    if body.get('ai_consent') is not True:
                        raise ValueError('请先同意将本次分析涉及的商品资料发送到所选 AI 服务商')
                    if not self.server.ai_job_lock.acquire(blocking=False):
                        self.send({'error': '其他成员正在进行 AI 分析，请稍后重试，避免重复产生费用'}, 409)
                        return
                    try:
                        report = ai.enrich(report, inventory.read_tables(data, name), templates, data, name, self.server.ai, body.get('include_images') is True, body.get('ai_limit', 30))
                    finally:
                        self.server.ai_job_lock.release()
                self.send(report)
                return
            with LOCK, tempfile.TemporaryDirectory() as d:
                source = Path(d) / name
                source.write_bytes(data)
                if self.path == '/api/upload':
                    meta = {k: str(body.get(k, '')).strip() for k in ('marketplace', 'category', 'version')}
                    meta['shop'] = str(body.get('shop', library.GLOBAL_SHOP)).strip()
                    if any(len(v) > 120 for v in meta.values()):
                        raise ValueError('站点、类目或版本过长')
                    self.send(self.call('add', source=str(source), **meta))
                elif self.path == '/api/restore':
                    rows = self.call('list', marketplace=None, category=None)
                    if rows:
                        raise ValueError('仅支持恢复到空模板库，请先使用完整备份妥善保留现有库')
                    stage = Path(d) / 'restored'
                    library.run(SimpleNamespace(command='restore', library=str(stage), source=str(source)))
                    # Preserve an empty existing directory until replacement has succeeded.
                    self.root.parent.mkdir(parents=True, exist_ok=True)
                    replacement = self.root.parent / ('.restore-' + stage.name + '-' + library.uuid.uuid4().hex)
                    shutil.copytree(stage, replacement)
                    old = self.root.with_name(self.root.name + '-empty-' + library.uuid.uuid4().hex)
                    self.root.rename(old)
                    try:
                        replacement.rename(self.root)
                    except Exception:
                        old.rename(self.root)
                        raise
                    shutil.rmtree(old)
                    restored = self.call('list', marketplace=None, category=None)
                    self.send({'count': len(restored)})
                else:
                    self.send({'error': '接口不存在'}, 404)
        except Exception as e:
            self.send({'error': str(e)}, 400)


def create_server(data_dir, port=8765, host='127.0.0.1', allowed_hosts=None, scheme='http'):
    data_dir = Path(data_dir)
    server = ThreadingHTTPServer((host, port), partial(Handler, data_dir=data_dir))
    server.auth = Auth(data_dir.parent / 'accounts.sqlite3')
    server.ai = ai.Settings(data_dir.parent / 'ai-config.json')
    server.ai_job_lock = threading.Lock()
    server.allowed_hosts = set(allowed_hosts or [f'127.0.0.1:{server.server_port}', f'localhost:{server.server_port}'])
    server.scheme = scheme
    return server


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--allowed-host', action='append', help='允许的 Host，含非默认端口；可重复指定')
    p.add_argument('--https', action='store_true', help='仅在 HTTPS 反向代理后使用')
    p.add_argument('--create-user', help='创建用户并退出；交互输入密码')
    p.add_argument('--role', choices=['admin', 'editor', 'viewer'], default='admin')
    p.add_argument('--data-dir', default=str(Path(__file__).parent / '.data' / 'library'))
    a = p.parse_args()
    if a.create_user:
        password = getpass.getpass('密码（至少 12 字符）：')
        if password != getpass.getpass('再次输入密码：'):
            p.error('两次密码不同')
        Auth(Path(a.data_dir).resolve().parent / 'accounts.sqlite3').create(a.create_user, password, a.role)
        print('用户已创建：' + a.create_user)
        raise SystemExit(0)
    if a.host != '127.0.0.1' and not a.allowed_host:
        p.error('对外监听必须通过 --allowed-host 显式指定访问地址')
    server = create_server(Path(a.data_dir).resolve(), a.port, a.host, a.allowed_host, 'https' if a.https else 'http')
    print(f'亚马逊模板管理已启动：http://127.0.0.1:{server.server_port}', flush=True)
    print(f'模板保存位置：{Path(a.data_dir).resolve()}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

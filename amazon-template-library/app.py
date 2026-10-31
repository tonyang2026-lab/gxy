import csv, hashlib, io, json, os, secrets, sqlite3, sys, threading, uuid, webbrowser, zipfile
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, quote
import workbook

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = Path(os.environ.get('LOCALAPPDATA', str(ROOT))) / 'YuanbenAmazonTemplates' if os.name == 'nt' else ROOT / 'data'
DATA = Path(os.environ.get('AMAZON_LIBRARY_DATA', str(DEFAULT_DATA))).resolve()
TOKEN = secrets.token_urlsafe(32)
MAX_REQUEST = 26 * 1024 * 1024


def init():
    (DATA / 'files').mkdir(parents=True, exist_ok=True)
    (DATA / 'outputs').mkdir(exist_ok=True)
    with db() as c:
        c.executescript('''CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, site TEXT NOT NULL, category TEXT NOT NULL,
        version TEXT NOT NULL, filename TEXT NOT NULL, ext TEXT NOT NULL, sha256 TEXT NOT NULL,
        created TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        layout TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, template_id TEXT, created TEXT, stats TEXT, ext TEXT);''')


def db():
    c = sqlite3.connect(DATA / 'library.sqlite3', timeout=15)
    c.row_factory = sqlite3.Row
    return c


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def records():
    with db() as c:
        return [dict(r) for r in c.execute('SELECT * FROM templates ORDER BY created DESC, rowid DESC')]


def record(id):
    with db() as c:
        r = c.execute('SELECT * FROM templates WHERE id=?', (id,)).fetchone()
    if r is None:
        raise ValueError('模板不存在')
    return dict(r)


def template_file(r):
    return DATA / 'files' / (r['id'] + r['ext'])


def read_template(r):
    data = template_file(r).read_bytes()
    if hashlib.sha256(data).hexdigest() != r['sha256']:
        raise ValueError('原始模板校验失败，请从备份恢复，不要继续填表')
    return data


def text(value, name, size=100):
    if not isinstance(value, str) or not value.strip() or len(value) > size or any(ord(ch)<32 for ch in value):
        raise ValueError(name+'不能为空、过长或含控制字符')
    return value.strip()


def add_template(fields, filename, data):
    name = text(fields.get('name'), '模板名称')
    site = text(fields.get('site'), '站点', 30)
    category = text(fields.get('category'), '类目')
    version = text(fields.get('version'), '版本', 60)
    ext = Path(filename).suffix.lower()
    if ext not in ('.xlsx', '.xlsm'):
        raise ValueError('仅支持.xlsx和.xlsm，不支持.xls或CSV模板')
    details = workbook.inspect(data)
    if details['macros'] and ext != '.xlsm':
        raise ValueError('含宏工作簿请使用原始.xlsm扩展名')
    id = uuid.uuid4().hex
    sha = hashlib.sha256(data).hexdigest()
    destination = DATA / 'files' / (id+ext)
    destination.write_bytes(data)
    try:
        with db() as c:
            active = not c.execute('SELECT 1 FROM templates WHERE site=? AND category=? AND active=1 AND archived=0', (site,category)).fetchone()
            c.execute('INSERT INTO templates(id,name,site,category,version,filename,ext,sha256,created,active) VALUES(?,?,?,?,?,?,?,?,?,?)', (id,name,site,category,version,Path(filename.replace('\\','/')).name,ext,sha,timestamp(),int(active)))
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return record(id)


def backup():
    manifest = records()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps({'format':1,'templates':manifest}, ensure_ascii=False))
        for r in manifest:
            z.writestr('templates/'+r['id']+r['ext'], read_template(r))
    return buffer.getvalue()


def restore(data):
    if len(data)>workbook.MAX_FILE:
        raise ValueError('备份恢复单次上限24MB，大模板库请直接复制data文件夹备份')
    try:
        z=zipfile.ZipFile(io.BytesIO(data))
        infos=z.infolist()
        if len(infos)>1000 or len(set(i.filename for i in infos))!=len(infos) or sum(i.file_size for i in infos)>120*1024*1024:
            raise ValueError('备份内容过大或有重复条目')
        manifest=json.loads(z.read('manifest.json'))
        if manifest.get('format')!=1 or not isinstance(manifest.get('templates'),list):
            raise ValueError('不是本工具导出的模板备份')
        staged=[]
        # Validate everything before mutating the library. Never extract archive paths.
        for old in manifest['templates']:
            if not isinstance(old,dict) or not __import__('re').fullmatch('[a-f0-9]{32}',old.get('id','')) or old.get('ext') not in ('.xlsx','.xlsm'):
                raise ValueError('备份索引无效')
            raw=z.read('templates/'+old['id']+old['ext'])
            if hashlib.sha256(raw).hexdigest()!=old.get('sha256'):
                raise ValueError('备份校验失败')
            workbook.inspect(raw)
            for field in ('name','site','category','version','filename'):
                text(old.get(field),field,255)
            staged.append((old,raw))
        added=[]
        try:
            with db() as c:
                for old,raw in staged:
                    if c.execute('SELECT 1 FROM templates WHERE sha256=? AND site=? AND category=? AND version=?',(old['sha256'],old['site'],old['category'],old['version'])).fetchone():
                        continue
                    id=uuid.uuid4().hex; dest=DATA/'files'/(id+old['ext']);dest.write_bytes(raw);added.append(dest)
                    # Restored templates do not silently replace an existing default.
                    active=not c.execute('SELECT 1 FROM templates WHERE site=? AND category=? AND active=1 AND archived=0',(old['site'],old['category'])).fetchone() and not old.get('archived')
                    c.execute('INSERT INTO templates VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(id,old['name'],old['site'],old['category'],old['version'],old['filename'],old['ext'],old['sha256'],timestamp(),int(active),int(bool(old.get('archived'))),json.dumps(old.get('layout','{}')) if not isinstance(old.get('layout','{}'),str) else old.get('layout','{}')))
        except Exception:
            for p in added:p.unlink(missing_ok=True)
            raise
        return len(added)
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, TypeError) as exc:
        raise ValueError('备份损坏或格式不正确') from exc
    finally:
        if 'z' in locals():z.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # No uploaded data or access tokens in logs.

    def send(self, status, data, mime='application/json; charset=utf-8', filename=None):
        if not isinstance(data,bytes):data=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type',mime)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        if filename:self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(filename))
        self.end_headers();self.wfile.write(data)

    def body(self):
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:raise ValueError('请求长度无效')
        if length<0 or length>MAX_REQUEST:raise ValueError('上传请求过大，单文件上限24MB')
        raw=self.rfile.read(length)
        if len(raw)!=length:raise ValueError('文件未传完整，请重试')
        return raw

    def upload(self):
        ctype=self.headers.get('Content-Type','')
        if not ctype.startswith('multipart/form-data'):raise ValueError('请使用文件上传表单')
        message=BytesParser(policy=default).parsebytes(('Content-Type: '+ctype+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+self.body())
        fields={};files={}
        for part in message.iter_parts():
            name=part.get_param('name',header='content-disposition');filename=part.get_filename();raw=part.get_payload(decode=True) or b''
            if filename is not None:files[name]=(filename,raw)
            elif name:fields[name]=raw.decode('utf-8')
        return fields,files

    def payload(self):
        try:return json.loads(self.body())
        except json.JSONDecodeError as exc:raise ValueError('请求数据无效') from exc

    def auth(self):
        return secrets.compare_digest(self.headers.get('Authorization',''), 'Bearer '+TOKEN)

    def do_GET(self):self.dispatch('GET')
    def do_POST(self):self.dispatch('POST')

    def dispatch(self, method):
        try:
            path=urlsplit(self.path).path
            if method=='GET' and path in ('/','/app.js','/style.css'):
                name={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[path]
                mime={'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','style.css':'text/css; charset=utf-8'}[name]
                return self.send(200,(ROOT/'static'/name).read_bytes(),mime)
            if not self.auth():return self.send(401,{'error':'请使用启动窗口中带token的完整地址打开；刷新后会保留本次登录'})
            if method=='GET' and path=='/api/templates':return self.send(200,{'templates':records(),'storage':str(DATA)})
            if method=='POST' and path=='/api/templates':
                fields,files=self.upload()
                if 'file' not in files:raise ValueError('请选择模板文件')
                return self.send(201,add_template(fields,*files['file']))
            if method=='POST' and path=='/api/inspect':
                _,files=self.upload()
                if 'file' not in files:raise ValueError('请选择商品资料文件')
                return self.send(200,workbook.inspect(files['file'][1]))
            if method=='POST' and path=='/api/fields':
                fields,files=self.upload();spec=json.loads(fields['spec'])
                data=read_template(record(spec['template'])) if spec.get('template') else files['file'][1]
                return self.send(200,{'fields':workbook.get_fields(data,spec['sheet'],spec['header'])})
            if method=='GET' and path=='/api/backup':return self.send(200,backup(),'application/zip','模板库备份.zip')
            if method=='POST' and path=='/api/restore':
                _,files=self.upload()
                if 'file' not in files:raise ValueError('请选择备份文件')
                return self.send(200,{'added':restore(files['file'][1])})
            if path.startswith('/api/template/'):
                parts=path.split('/');r=record(parts[3]);action=parts[4] if len(parts)>4 else ''
                if method=='GET' and action=='download':return self.send(200,read_template(r),'application/octet-stream',r['filename'])
                if method=='GET' and action=='inspect':return self.send(200,workbook.inspect(read_template(r)))
                if method=='POST' and action=='default':
                    if r['archived']:raise ValueError('请先恢复归档模板')
                    with db() as c:
                        c.execute('UPDATE templates SET active=0 WHERE site=? AND category=?',(r['site'],r['category']))
                        c.execute('UPDATE templates SET active=1 WHERE id=?',(r['id'],))
                    return self.send(200,{'ok':True})
                if method=='POST' and action=='archive':
                    with db() as c:c.execute('UPDATE templates SET archived=?,active=0 WHERE id=?',(int(not r['archived']),r['id']))
                    return self.send(200,{'ok':True})
                if method=='POST' and action=='layout':
                    spec=self.payload();workbook.get_fields(read_template(r),spec['sheet'],spec['header'])
                    if not isinstance(spec['start'],int) or not spec['header']<spec['start']<=1000:raise ValueError('数据起始行必须大于字段行且不超过1000')
                    with db() as c:c.execute('UPDATE templates SET layout=? WHERE id=?',(json.dumps(spec),r['id']))
                    return self.send(200,{'ok':True})
            if method=='POST' and path=='/api/fill':
                fields,files=self.upload();spec=json.loads(fields['spec']);r=record(spec['template'])
                if r['archived']:raise ValueError('归档模板不能用于新任务，请先恢复')
                output,issues,stats=workbook.fill(read_template(r),files['file'][1],spec['layout'],spec['source'],spec['mapping'],spec.get('required',[]))
                id=uuid.uuid4().hex;outpath=DATA/'outputs'/(id+r['ext']);outpath.write_bytes(output)
                csvbuf=io.StringIO();writer=csv.writer(csvbuf);writer.writerow(['来源行','模板行','字段','待确认问题']);writer.writerows([[str(v) if not str(v).startswith(('=','+','-','@')) else "'"+str(v) for v in row] for row in issues])
                (DATA/'outputs'/(id+'.csv')).write_bytes(b'\xef\xbb\xbf'+csvbuf.getvalue().encode())
                with db() as c:c.execute('INSERT INTO outputs VALUES(?,?,?,?,?)',(id,r['id'],timestamp(),json.dumps(stats),r['ext']))
                return self.send(200,{'id':id,'stats':stats,'ext':r['ext']})
            if method=='GET' and path.startswith('/api/output/'):
                parts=path.split('/');id=parts[3];kind=parts[4]
                with db() as c:r=c.execute('SELECT * FROM outputs WHERE id=?',(id,)).fetchone()
                if not r:raise ValueError('生成记录不存在')
                ext='.csv' if kind=='issues' else r['ext']
                return self.send(200,(DATA/'outputs'/(id+ext)).read_bytes(),'application/octet-stream',('问题清单' if kind=='issues' else 'Amazon_填表草稿')+ext)
            return self.send(404,{'error':'找不到页面或接口'})
        except (ValueError,KeyError,TypeError,StopIteration) as exc:
            return self.send(400,{'error':str(exc) if str(exc) else '请求内容不完整'})
        except Exception as exc:
            print('操作失败：',type(exc).__name__,flush=True)
            return self.send(500,{'error':'操作失败，请确认存储目录可写、文件未损坏，并查看启动窗口'})


def main():
    init();port=int(os.environ.get('AMAZON_LIBRARY_PORT','8765'))
    try:server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    except OSError:
        print('端口被占用，请先关闭旧的模板库窗口，或设置AMAZON_LIBRARY_PORT换端口');return
    server.timeout=1
    url=f'http://127.0.0.1:{port}/#token={TOKEN}'
    print('亚马逊模板库已启动。窗口保持打开，Ctrl+C退出。',flush=True)
    print('永久存储目录：'+str(DATA),flush=True)
    print('本机访问地址（含口令，请勿分享）：'+url,flush=True)
    if os.environ.get('NO_BROWSER')!='1':threading.Timer(.6,lambda:webbrowser.open(url)).start()
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()

if __name__=='__main__':main()

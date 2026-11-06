"""Persistent shared product aliases; explicit bulk preview and atomic updates."""
import csv
import datetime
import hashlib
import io
import json
import re
import unicodedata

from . import library
from .product_types import FAMILIES, canonical_category, norm

MAX_ALIASES = 5000
MAX_TEXT = 2 * 1024 * 1024
ALIAS_HEADERS = {'别名','叫法','商品叫法','商品名称','品名','原叫法','alias','aliases','name'}
CATEGORY_HEADERS = {'对应类别','标准类别','目标类别','类别','商品类别','category','targetcategory'}


def snapshot_db(db):
    return [dict(row) for row in db.execute('SELECT * FROM product_aliases ORDER BY alias_key')]


def revision(rows):
    values=sorted((r['alias_key'],r['alias'],r['category']) for r in rows)
    return hashlib.sha256(json.dumps(values,ensure_ascii=False).encode()).hexdigest()


def directory(root):
    db=library.connect(root)
    try:
        rows=snapshot_db(db)
        return {'items':rows,'revision':revision(rows),'builtin':[{'category':category,'aliases':list(dict.fromkeys([category]+words))} for category,words in FAMILIES]}
    finally:db.close()


def clean(value):
    if not isinstance(value,str):raise ValueError('叫法和类别须为文字')
    value=unicodedata.normalize('NFKC',value).strip()
    if not value or len(value)>120 or not norm(value) or any(ord(c)<32 for c in value):
        raise ValueError('叫法和类别须为 1–120 字的有效文字')
    return value


def split_names(value):
    return [part.strip() for part in re.split(r'[\r\n,，、;；|]+',str(value)) if part.strip()]


def parse_table(rows):
    """Find recognized headers, otherwise require exactly two columns."""
    rows=[(number,list(values)) for number,values in rows if any(str(v).strip() for v in values)]
    if not rows:raise ValueError('没有可读取的别名数据')
    columns=None;start=0
    for index,(_,values) in enumerate(rows[:20]):
        keys=[norm(v) for v in values]
        a=[i for i,k in enumerate(keys) if k in ALIAS_HEADERS]
        c=[i for i,k in enumerate(keys) if k in CATEGORY_HEADERS]
        if len(a)==1 and len(c)==1 and a[0]!=c[0]:columns=(a[0],c[0]);start=index+1;break
    if columns is None:
        if any(len(values)!=2 for _,values in rows):raise ValueError('请提供“叫法、对应类别”两列，或使用明确的表头')
        columns=(0,1)
    result=[]
    for number,values in rows[start:]:
        alias=values[columns[0]] if columns[0]<len(values) else ''
        category=values[columns[1]] if columns[1]<len(values) else ''
        for name in split_names(alias) or ['']:
            result.append({'row':number,'alias':name,'category':category})
            if len(result)>MAX_ALIASES:raise ValueError('一次最多导入 5000 个叫法，请拆分处理')
    if not result:raise ValueError('表头后没有别名数据')
    return result


def parse_text(text,category=''):
    if not isinstance(text,str) or len(text.encode())>MAX_TEXT:raise ValueError('批量内容须为不超过 2 MB 的文字')
    if category:
        values=split_names(text)
        if not values:raise ValueError('请填写要归类的多个叫法')
        if len(values)>MAX_ALIASES:raise ValueError('一次最多导入 5000 个叫法')
        return [{'row':i,'alias':value,'category':category} for i,value in enumerate(values,1)]
    delimiter='\t' if '\t' in text else ','
    try:rows=list(csv.reader(io.StringIO(text.lstrip('\ufeff')),delimiter=delimiter))
    except csv.Error:raise ValueError('两列文字无法解析，请核对 CSV 引号或从 Excel 重新复制') from None
    return parse_table(list(enumerate(rows,1)))


def parse_file(data,filename,sheet=None):
    from .inventory import read_tables
    tables=read_tables(data,filename)
    if not tables:raise ValueError('文件没有可读取的工作表')
    candidates=[t for t in tables if t['name']==sheet] if sheet else tables
    if not candidates:raise ValueError('所选工作表不存在')
    failure=None
    for table in candidates:
        try:rows=parse_table(table['rows'])
        except ValueError as error:
            failure=error;continue
        return rows,{'sheets':[t['name'] for t in tables],'sheet':table['name'],'warnings':table['warnings']}
    raise failure


def preview_rows(existing,rows):
    if not isinstance(rows,list) or not 1<=len(rows)<=MAX_ALIASES:raise ValueError('一次须提供 1–5000 个叫法')
    old={r['alias_key']:r for r in existing};items=[];targets={}
    for index,row in enumerate(rows,1):
        item={'row':row.get('row',index) if isinstance(row,dict) else index,'alias':'','category':'','status':'invalid','message':''}
        try:
            if not isinstance(row,dict):raise ValueError('每条数据须包含叫法和对应类别')
            alias,category=clean(row.get('alias')),clean(row.get('category'))
            category=canonical_category(category) or category
            key=norm(alias);item.update(alias=alias,category=category,alias_key=key,status='new')
            targets.setdefault(key,set()).add(norm(category))
        except ValueError as e:item['message']=str(e)
        items.append(item)
    graph={key:row['category'] for key,row in old.items()}
    for item in items:
        if item['status']=='invalid':continue
        key=item['alias_key']
        if len(targets[key])>1:item.update(status='conflict',message='同一叫法在本批对应多个类别');continue
        graph[key]=item['category']
    def final(label):
        seen=set()
        for _ in range(100):
            builtin=canonical_category(label)
            if builtin:return builtin
            key=norm(label)
            if key not in graph or norm(graph[key])==key:return label
            if key in seen:raise ValueError('叫法归类形成循环，请直接填写最终标准类别')
            seen.add(key);label=graph[key]
        raise ValueError('类别关联链过长，请直接填写最终标准类别')
    standard_keys={norm(r['category']) for r in existing}
    encountered=set()
    for item in items:
        if item['status']!='new':continue
        key=item['alias_key']
        try:
            target=final(item['category']);item['category']=target
            builtin=canonical_category(item['alias'])
            if builtin and norm(builtin)!=norm(target):raise ValueError('与内置归类“'+builtin+'”冲突')
            if key in old and norm(old[key]['category'])!=norm(target):raise ValueError('已有规则对应“'+old[key]['category']+'”，请在列表中明确修改')
            if key in standard_keys and key!=norm(target):raise ValueError('该叫法正被用作标准类别，请先调整相关规则')
            if key in encountered:item.update(status='duplicate',message='本批重复，保存时合并')
            elif key in old:item.update(status='exists',message='已保存相同归类')
            elif builtin:item.update(status='builtin',message='内置规则已支持')
            elif key==norm(target):item.update(status='exists',message='叫法与类别相同，无需额外规则')
            encountered.add(key)
        except ValueError as e:item.update(status='conflict',message=str(e))
    counts={status:sum(i['status']==status for i in items) for status in ('new','exists','builtin','duplicate','conflict','invalid')}
    if len(existing)+counts['new']>MAX_ALIASES:raise ValueError('别名库最多保存 5000 条，请先整理已有规则')
    return {'items':items,'counts':counts,'revision':revision(existing),'total':len(items),'can_save':bool(counts['new']) and not counts['conflict'] and not counts['invalid']}


def preview(root,rows):
    db=library.connect(root)
    try:return preview_rows(snapshot_db(db),rows)
    finally:db.close()


def check_revision(rows,expected):
    if expected is not None and expected!=revision(rows):raise ValueError('别名库已被其他成员修改，请刷新并重新检查后保存')


def apply(root,rows,username,expected=None):
    db=library.connect(root)
    try:
        db.execute('BEGIN IMMEDIATE');current=snapshot_db(db);check_revision(current,expected)
        result=preview_rows(current,rows)
        if result['counts']['conflict'] or result['counts']['invalid']:raise ValueError('存在冲突或无效叫法，本批未保存；请修正后重新检查')
        stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
        for item in result['items']:
            if item['status']=='new':db.execute('INSERT INTO product_aliases VALUES (?,?,?,?,?)',(item['alias_key'],item['alias'],item['category'],username,stamp))
        db.commit();return {'saved':result['counts']['new'],'reused':result['total']-result['counts']['new'],'revision':revision(snapshot_db(db))}
    except Exception:db.rollback();raise
    finally:db.close()


def update(root,key,alias,category,username,expected=None):
    db=library.connect(root)
    try:
        db.execute('BEGIN IMMEDIATE');current=snapshot_db(db);check_revision(current,expected)
        old=next((r for r in current if r['alias_key']==key),None)
        if old is None:raise ValueError('规则不存在或已删除，请刷新')
        remaining=[r for r in current if r['alias_key']!=key]
        result=preview_rows(remaining,[{'alias':alias,'category':category}]);item=result['items'][0]
        if item['status']!='new':raise ValueError(item['message'] or '修改后与已有规则重复')
        if any(norm(r['category'])==key for r in remaining) and item['alias_key']!=norm(item['category']):raise ValueError('该叫法正被用作其他规则的标准类别，请先调整相关规则')
        db.execute('DELETE FROM product_aliases WHERE alias_key=?',(key,))
        db.execute('INSERT INTO product_aliases VALUES (?,?,?,?,?)',(item['alias_key'],item['alias'],item['category'],username,datetime.datetime.now(datetime.timezone.utc).isoformat()))
        db.commit();return {'updated':True}
    except Exception:db.rollback();raise
    finally:db.close()


def delete(root,keys,expected=None):
    if not isinstance(keys,list) or not 1<=len(keys)<=MAX_ALIASES or any(not isinstance(k,str) for k in keys) or len(set(keys))!=len(keys):raise ValueError('请选择有效且不重复的自定义规则')
    db=library.connect(root)
    try:
        db.execute('BEGIN IMMEDIATE');current=snapshot_db(db);check_revision(current,expected)
        if not set(keys)<={r['alias_key'] for r in current}:raise ValueError('部分规则不存在，请刷新后重新选择')
        db.executemany('DELETE FROM product_aliases WHERE alias_key=?',[(key,) for key in keys]);db.commit();return {'deleted':len(keys)}
    except Exception:db.rollback();raise
    finally:db.close()


def restore(db,rows):
    if not isinstance(rows,list):raise ValueError('备份中的别名库格式无效')
    if not rows:return
    result=preview_rows([],rows)
    if result['counts']['conflict'] or result['counts']['invalid']:raise ValueError('备份中的别名归类存在冲突或无效数据')
    for item in result['items']:
        if item['status']=='new':db.execute('INSERT INTO product_aliases VALUES (?,?,?,?,?)',(item['alias_key'],item['alias'],item['category'],'备份恢复',datetime.datetime.now(datetime.timezone.utc).isoformat()))


def export_csv(root):
    data=directory(root);output=io.StringIO();writer=csv.writer(output);writer.writerow(['叫法','对应类别'])
    for row in data['items']:
        writer.writerow(["'"+v if re.match(r'^\s*[=+\-@]',v) else v for v in (row['alias'],row['category'])])
    return ('\ufeff'+output.getvalue()).encode()

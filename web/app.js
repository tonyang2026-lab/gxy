const $ = id => document.getElementById(id);
let templates = [];
let busy = false;
let timer;
function notify(text, error=false) {
  clearTimeout(timer); $('status').textContent=text; $('status').className=error?'error':'';
  $('status').style.display='block'; timer=setTimeout(()=>$('status').style.display='none',8000);
}
async function request(url, options={}) {
  const res=await fetch(url,options);
  const data=await res.json();
  if(res.status===401) { $('workspace').hidden=true; $('login-screen').hidden=false; }
  if(!res.ok) throw new Error(data.error || '操作失败');
  return data;
}
function cell(row,text,cls) {
  const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;row.append(td);return td;
}
function render() {
  const query=$('search').value.trim().toLowerCase(), market=$('filter-market').value;
  const rows=templates.filter(t=>(!market||t.marketplace===market)&&[t.original_name,t.category,t.version,t.id].some(v=>v.toLowerCase().includes(query)));
  $('rows').replaceChildren();$('count').textContent=rows.length;$('empty').hidden=rows.length>0;
  $('empty').querySelector('h3').textContent=templates.length?'没有找到匹配的模板':'模板库还空着';
  $('empty').querySelector('p').textContent=templates.length?'试试其他关键词或站点。':'导入第一份原始模板，以后无需反复查找。';
  for(const t of rows) {
    const tr=document.createElement('tr'),name=cell(tr,'');
    const title=document.createElement('div');title.className='filename';title.textContent=t.original_name;title.title=t.original_name;
    const hash=document.createElement('small');hash.className='hash';hash.textContent='SHA-256 '+t.sha256.slice(0,14)+'…';hash.title=t.sha256;
    name.append(title,hash);
    const meta=cell(tr,'');const badge=document.createElement('span');badge.className='badge';badge.textContent=t.marketplace;meta.append(badge,document.createTextNode(t.category));
    cell(tr,t.version);cell(tr,new Date(t.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
    const action=cell(tr,'');const link=document.createElement('a');link.href='/api/download/'+encodeURIComponent(t.id);link.textContent='↓ 下载原件';action.append(link);$('rows').append(tr);
  }
}
async function load() {
  templates=await request('/api/templates');
  $('total').textContent=templates.length;$('markets').textContent=new Set(templates.map(t=>t.marketplace)).size;$('categories').textContent=new Set(templates.map(t=>t.category)).size;
  const selected=$('filter-market').value;$('filter-market').replaceChildren(new Option('全部站点',''));
  [...new Set(templates.map(t=>t.marketplace))].sort().forEach(m=>$('filter-market').add(new Option(m,m)));
  $('filter-market').value=selected;render();
}
async function encoded(file) {
  if(file.size>32*1024*1024)throw new Error('文件不能超过 32 MB');
  return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(new Error('文件读取失败'));r.readAsDataURL(file);});
}
async function sendFile(url,file,meta={}) {
  return request(url,{method:'POST',headers:{'Content-Type':'application/json','X-Template-Request':'1'},body:JSON.stringify({filename:file.name,data:await encoded(file),...meta})});
}
$('file').addEventListener('change',()=>$('file-name').textContent=$('file').files[0]?.name||'点击选择亚马逊原始模板');
$('version').value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('upload').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;const button=event.submitter;button.disabled=true;button.textContent='正在保存…';
  try {
    const result=await sendFile('/api/upload',$('file').files[0],{marketplace:$('marketplace').value,category:$('category').value,version:$('version').value});
    await load();notify(result.reused?'此模板已保存，已复用现有版本。':'保存成功，原件已校验。建议下载完整备份。');
    $('file').value='';$('file-name').textContent='点击选择亚马逊原始模板';
  } catch(e){notify(e.message,true);}finally{busy=false;button.disabled=false;button.textContent='＋ 保存模板';}
});
$('restore').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  if(busy){notify('请等待当前操作完成',true);event.target.value='';return;}
  if(templates.length){notify('恢复仅支持空模板库，现有模板不会被覆盖。',true);event.target.value='';return;}
  busy=true;
  try{const result=await sendFile('/api/restore',file);await load();notify('恢复成功，共 '+result.count+' 份模板。');}catch(e){notify(e.message,true);}finally{busy=false;event.target.value='';}
});
$('search').addEventListener('input',render);$('filter-market').addEventListener('change',render);
$('refresh').addEventListener('click',()=>load().catch(e=>notify(e.message,true)));
async function enter() {
  const me=await request('/api/me');
  resetInventory();$('inventory-file').value='';
  $('account').textContent=me.username+' · '+({admin:'管理员',editor:'编辑者',viewer:'只读'}[me.role]);
  $('login-screen').hidden=true;$('workspace').hidden=false;
  $('import').hidden=me.role==='viewer';$('admin-panel').hidden=me.role!=='admin';
  document.querySelector('.restore-label').hidden=me.role!=='admin';
  await load();
}
async function postJSON(url,body) {return request(url,{method:'POST',headers:{'Content-Type':'application/json','X-Template-Request':'1'},body:JSON.stringify(body)});}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const b=e.submitter;b.disabled=true;$('login-error').textContent='';
  try{await postJSON('/api/login',{username:$('username').value,password:$('password').value});$('password').value='';await enter();}catch(err){$('login-error').textContent=err.message;}finally{b.disabled=false;}
});
$('logout').addEventListener('click',async()=>{try{await postJSON('/api/logout',{});templates=[];render();$('workspace').hidden=true;$('login-screen').hidden=false;}catch(e){notify(e.message,true);}});
$('user-form').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await postJSON('/api/users',{username:$('new-user').value,password:$('new-password').value,role:$('new-role').value});$('user-form').reset();notify('团队成员已创建');}catch(err){notify(err.message,true);}finally{b.disabled=false;}});
enter().catch(e=>{if(e.message!=='请先登录')$('login-error').textContent=e.message;});

// Inventory analysis remains local to the logged-in browser session.
let inventoryReport=null;
let inventoryOverrides={};
let inspectedFile=null;
let inspectedSheet=null;
const statusLabels={available:'已有登记模板',missing:'需要补充模板',review:'类目待确认'};
for(const option of $('marketplace').options) $('inventory-market').add(new Option(option.text,option.value));
function resetInventory(clearMapping=true) {
  inventoryReport=null;$('inventory-result').hidden=true;
  if(clearMapping){inventoryOverrides={};inspectedFile=null;inspectedSheet=null;$('inventory-mapping').hidden=true;}
}
$('inventory-file').addEventListener('change',()=>resetInventory());
$('inventory-market').addEventListener('change',()=>{inventoryOverrides={};resetInventory(false);});
for(const id of ['inventory-sku','inventory-title','inventory-category']) $(id).addEventListener('change',()=>{inventoryOverrides={};resetInventory(false);});
$('inventory-header').addEventListener('input',()=>{inventoryOverrides={};resetInventory(false);});
async function inspectInventory(reuseSelection=false) {
  const file=$('inventory-file').files[0];
  if(!file){notify('请先选择库存表',true);return;}
  if(busy){notify('请等待当前操作完成',true);return;}
  busy=true;
  try {
    const options=reuseSelection?{sheet:$('inventory-sheet').value,header_row:Number($('inventory-header').value)}:{};
    const info=await sendFile('/api/inventory/inspect',file,options);
    if($('inventory-file').files[0]!==file)return;
    resetInventory();inspectedFile=file;inspectedSheet=info.sheet;
    $('inventory-sheet').replaceChildren(...info.sheets.map(s=>new Option(s.name+' · '+s.rows+' 个非空行',s.name)));
    $('inventory-sheet').value=info.sheet;$('inventory-header').value=info.header_row;
    for(const field of ['sku','title','category']){
      const select=$('inventory-'+field);select.replaceChildren(new Option('未提供 / 不使用',''));
      info.headers.forEach((h,i)=>select.add(new Option('第 '+(i+1)+' 列 · '+(h||'空表头'),String(i))));
      select.value=info.mapping[field]===null?'':String(info.mapping[field]);
    }
    $('inventory-mapping').hidden=false;
    $('inventory-preview').textContent='请核对列映射。样例：'+info.preview.map(row=>row.slice(0,8).join(' | ')).join('；')+(info.warnings.length?'；'+info.warnings.join('；'):'');
    notify('表头已读取，请核对工作表、表头行和列映射');
  }catch(e){notify(e.message,true);}finally{busy=false;}
}
$('inspect-inventory').addEventListener('click',()=>inspectInventory());
$('reread-inventory').addEventListener('click',()=>inspectInventory(true));
$('inventory-sheet').addEventListener('change',async()=>{
  if(busy){$('inventory-sheet').value=inspectedSheet||'';notify('请等待当前操作完成',true);return;}
  const file=$('inventory-file').files[0];if(!file)return;
  busy=true;resetInventory(false);
  try {
    const info=await sendFile('/api/inventory/inspect',file,{sheet:$('inventory-sheet').value});
    inventoryOverrides={};inspectedSheet=info.sheet;$('inventory-header').value=info.header_row;
    for(const field of ['sku','title','category']){
      const select=$('inventory-'+field);select.replaceChildren(new Option('未提供 / 不使用',''));
      info.headers.forEach((h,i)=>select.add(new Option('第 '+(i+1)+' 列 · '+(h||'空表头'),String(i))));
      select.value=info.mapping[field]===null?'':String(info.mapping[field]);
    }
    $('inventory-preview').textContent='样例：'+info.preview.map(row=>row.slice(0,8).join(' | ')).join('；');
  }catch(e){resetInventory();notify(e.message,true);}finally{busy=false;}
});
function templateLink(target,template){
  const a=document.createElement('a');a.href='/api/download/'+encodeURIComponent(template.id);a.textContent='下载 '+template.filename+' · '+template.version;target.append(a);
}
function renderInventory(report) {
  inventoryReport=report;const summary=report.summary;
  $('inventory-summary').textContent=summary.total+' 行商品 · 缺少模板 '+summary.missing+' 行 · 待确认 '+summary.review+' 行';
  $('inventory-context').textContent=report.filename+' / '+report.sheet+' · 表头第 '+report.header_row+' 行 · 目标站点 '+report.marketplace+' · 已有同登记类目模板 '+summary.available+' 行';
  $('inventory-warnings').replaceChildren(...report.warnings.map(w=>{const p=document.createElement('p');p.textContent=w;return p;}));
  $('inventory-groups').replaceChildren(...report.groups.map(g=>{
    const box=document.createElement('div');box.className='analysis-group '+g.status;
    const title=document.createElement('b');title.textContent=g.category+' · '+g.count+' 行';
    const detail=document.createElement('p');detail.textContent=statusLabels[g.status];box.append(title,detail);
    if(g.template)templateLink(box,g.template);
    if(g.category!=='无法识别类目'&&!g.category.includes(' / ')){
      const input=document.createElement('input');input.className='confirm-category';input.value=g.category;input.maxLength=120;input.setAttribute('aria-label','确认本组类目');
      const button=document.createElement('button');button.className='text-button';button.type='button';button.textContent='确认 / 修正本组类目并重查';
      button.addEventListener('click',()=>{const category=input.value.trim();if(!category){notify('请输入确认后的类目',true);return;}if(busy)return;for(const row of g.rows)inventoryOverrides[String(row)]=category;$('inventory-form').requestSubmit($('inventory-form').querySelector('button[type="submit"]'));});box.append(input,button);
    }
    return box;
  }));
  $('inventory-rows').replaceChildren();
  for(const item of report.items.slice(0,200)){
    const row=document.createElement('tr');cell(row,'第 '+item.row+' 行 / '+(item.sku||'无 SKU'));
    cell(row,item.title||'无品名','inventory-text');const categoryCell=cell(row,item.category||((item.suggested_category||'未知')+'（推断）'),'inventory-text');
    if(item.status==='review'){
      const input=document.createElement('input');input.className='confirm-category';input.placeholder='填写确认后的类目';input.maxLength=120;input.value=item.suggested_category&&!item.suggested_category.includes(' / ')?item.suggested_category:'';input.setAttribute('aria-label','第 '+item.row+' 行确认类目');
      const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent='确认此行并重查';button.addEventListener('click',()=>{if(busy)return;const category=input.value.trim();if(!category){notify('请填写确认后的类目',true);return;}inventoryOverrides[String(item.row)]=category;$('inventory-form').requestSubmit($('inventory-form').querySelector('button[type="submit"]'));});categoryCell.append(input,button);
    }
    const result=cell(row,statusLabels[item.status]);result.className='inventory-text status-'+item.status;
    if(item.template){result.append(document.createElement('br'));templateLink(result,item.template);}
    cell(row,item.evidence+'。'+item.action,'inventory-text');$('inventory-rows').append(row);
  }
  $('inventory-limit').textContent=report.items.length>200?'页面显示前 200 行，导出 CSV 包含全部 '+report.items.length+' 行。':'显示全部 '+report.items.length+' 行。入库时间较新的版本仅作为候选，不代表亚马逊官方最新模板。';
  $('inventory-result').hidden=false;
}
$('inventory-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const file=$('inventory-file').files[0];
  if(file!==inspectedFile){notify('文件已变化，请重新读取表头',true);return;}
  const button=event.submitter;button.disabled=true;busy=true;
  try{
    const mapping={};for(const field of ['sku','title','category']){const value=$('inventory-'+field).value;mapping[field]=value===''?null:Number(value);}
    const report=await sendFile('/api/inventory/analyze',file,{marketplace:$('inventory-market').value,sheet:$('inventory-sheet').value,header_row:Number($('inventory-header').value),mapping,category_overrides:inventoryOverrides});
    if($('inventory-file').files[0]===file){renderInventory(report);notify('分析完成：请查看需要补充的模板及待确认类目');}
  }catch(e){notify(e.message,true);}finally{busy=false;button.disabled=false;}
});
$('export-inventory').addEventListener('click',()=>{
  if(!inventoryReport)return;
  const report=inventoryReport;
  const rows=[['站点','工作表','原表行','SKU','品名','原类目','确认后的类目','建议类目（需确认）','结果','候选模板','模板版本','依据','下一步']];
  for(const r of report.items)rows.push([report.marketplace,report.sheet,r.row,r.sku,r.title,r.original_category,r.confirmed?r.category:'',r.suggested_category,statusLabels[r.status],r.template?.filename||'',r.template?.version||'',r.evidence,r.action]);
  const csv=rows.map(row=>row.map(value=>{let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='模板补充清单-'+report.marketplace+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('logout').addEventListener('click',()=>{$('inventory-file').value='';resetInventory();});

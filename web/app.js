const $ = id => document.getElementById(id);
let templates = [];
let currentRole='viewer';
let inspectingTemplate=false;
let busy = false;
let timer;
const PAGES={
  library:{id:'library',title:'模板库',description:'查找和下载团队保存的模板，按店铺、地区与类目筛选。',roles:['admin','editor','viewer']},
  import:{id:'import',title:'上传模板',description:'保存原始模板，自动读取来源，只需确认店铺名称。',roles:['admin','editor']},
  batch:{id:'batch-panel',title:'同地区批量生成',description:'上传一次，为同地区店铺生成独立模板并分别入库。',roles:['admin','editor']},
  inventory:{id:'inventory',title:'库存识别',description:'上传商品库存表，查看可用模板与需要补充的类目。',roles:['admin','editor','viewer']},
  shops:{id:'shop-roster-panel',title:'店铺管理',description:'管理店铺及各地区的卖家记号。',roles:['admin']},
  ai:{id:'ai-settings-panel',title:'AI 设置',description:'独立配置 AI 服务商、模型与 API 密钥。',roles:['admin']},
  members:{id:'admin-panel',title:'成员管理',description:'添加团队成员，分配管理员、编辑者和只读权限。',roles:['admin']},
  backup:{id:'backup-panel',title:'备份恢复',description:'备份模板和店铺目录，或将备份恢复到空模板库。',roles:['admin','editor','viewer']}
};
function showPage(raw=location.hash.slice(1)){
  const alias=Object.keys(PAGES).find(key=>PAGES[key].id===raw);
  const requested=Object.prototype.hasOwnProperty.call(PAGES,raw)?raw:alias||'library';
  const key=PAGES[requested].roles.includes(currentRole)?requested:'library';
  for(const [name,page] of Object.entries(PAGES))$(page.id).hidden=name!==key;
  for(const link of document.querySelectorAll('nav [data-route]')){
    const allowed=PAGES[link.dataset.route].roles.includes(currentRole);link.hidden=!allowed;
    link.classList.toggle('active',link.dataset.route===key);
    if(link.dataset.route===key)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  }
  $('library-stats').hidden=key!=='library';
  document.querySelector('.heading h1').textContent=PAGES[key].title;
  document.querySelector('.heading p').textContent=PAGES[key].description;
  $('breadcrumb').textContent='工作空间 / '+PAGES[key].title;
  $('workspace').dataset.page=key;document.title=PAGES[key].title+' · 模板仓';
  if(raw!==key)history.replaceState(null,'','#'+key);
}
window.addEventListener('hashchange',()=>{if(!$('workspace').hidden){showPage();window.scrollTo({top:0,behavior:'instant'});}});
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
  const query=$('search').value.trim().toLowerCase(), market=$('filter-market').value,shop=$('filter-shop').value;
  const rows=templates.filter(t=>(!market||t.marketplace===market)&&(!shop||(t.shop||'通用模板')===shop)&&[t.original_name,t.category,t.version,t.id,t.shop||'通用模板'].some(v=>v.toLowerCase().includes(query)));
  $('rows').replaceChildren();$('count').textContent=rows.length;$('empty').hidden=rows.length>0;
  $('empty').querySelector('h3').textContent=templates.length?'没有找到匹配的模板':'模板库还空着';
  $('empty').querySelector('p').textContent=templates.length?'试试其他关键词或站点。':'导入第一份原始模板，以后无需反复查找。';
  for(const t of rows) {
    const tr=document.createElement('tr'),name=cell(tr,'');
    const title=document.createElement('div');title.className='filename';title.textContent=t.original_name;title.title=t.original_name;
    const hash=document.createElement('small');hash.className='hash';hash.textContent='SHA-256 '+t.sha256.slice(0,14)+'…';hash.title=t.sha256;
    name.append(title,hash);
    const meta=cell(tr,'');const store=document.createElement('small');store.className='hash';store.textContent=(t.shop||'通用模板')+(t.metadata?.account_hint?' · 账户 '+t.metadata.account_hint:'')+(t.account_scope_unknown?' · 需绑定店铺':'');meta.append(store);const badge=document.createElement('span');badge.className='badge';badge.textContent=t.marketplace;meta.append(badge,document.createTextNode(t.category));
    cell(tr,t.version);cell(tr,new Date(t.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
    const action=cell(tr,'');const link=document.createElement('a');link.href='/api/download/'+encodeURIComponent(t.id);link.textContent='↓ 下载原件';action.append(link);if(currentRole!=='viewer'){const move=document.createElement('button');move.className='text-button';move.textContent='设置店铺';move.addEventListener('click',async()=>{const shop=prompt('输入归属店铺；含账户标识的同来源模板会一起调整。无账户来源的模板才可设为“通用模板”',t.shop||'通用模板');if(shop===null)return;try{await postJSON('/api/template-shop',{id:t.id,shop});inventoryAICache={};resetInventory(false);await load();notify('已更新店铺归属');}catch(e){notify(e.message,true);}});action.append(move);}$('rows').append(tr);
  }
}
async function load() {
  const [stored,registeredShops]=await Promise.all([request('/api/templates'),request('/api/shops')]);templates=stored;
  $('total').textContent=templates.length;$('markets').textContent=new Set(templates.map(t=>t.marketplace)).size;$('categories').textContent=new Set(templates.map(t=>t.category)).size;
  const selected=$('filter-market').value;$('filter-market').replaceChildren(new Option('全部站点',''));
  [...new Set(templates.map(t=>t.marketplace))].sort().forEach(m=>$('filter-market').add(new Option(m,m)));
  $('filter-market').value=selected;const selectedShop=$('filter-shop').value;const shops=[...new Set(['通用模板',...registeredShops,...templates.map(t=>t.shop||'通用模板')])].sort();$('filter-shop').replaceChildren(new Option('全部店铺',''),...shops.map(shop=>new Option(shop,shop)));$('filter-shop').value=selectedShop;$('shop-options').replaceChildren(...shops.map(shop=>new Option(shop,shop)));render();
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
  event.preventDefault();if(busy)return;if(inspectingTemplate){notify('正在读取模板来源，请稍后保存',true);return;}busy=true;const button=event.submitter;button.disabled=true;button.textContent='正在保存…';
  try {
    const result=await sendFile('/api/upload',$('file').files[0],{shop:$('template-shop').value,marketplace:$('marketplace').value,category:$('category').value,version:$('version').value});
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
$('search').addEventListener('input',render);$('filter-market').addEventListener('change',render);$('filter-shop').addEventListener('change',render);
$('refresh').addEventListener('click',()=>load().catch(e=>notify(e.message,true)));
async function enter() {
  const me=await request('/api/me');currentRole=me.role;
  resetInventory();$('inventory-file').value='';
  $('account').textContent=me.username+' · '+({admin:'管理员',editor:'编辑者',viewer:'只读'}[me.role]);
  $('login-screen').hidden=true;$('workspace').hidden=false;
  showPage();await loadAISettings();if(me.role==='admin')await loadShopEditor();
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
let inventoryAICache={};
let inventoryLocalRecheck=false;
let inventoryOverrides={};
let inspectedFile=null;
let inspectedSheet=null;
const statusLabels={available:'已有登记模板',missing:'需要补充模板',review:'类目待确认'};
for(const option of $('marketplace').options) $('inventory-market').add(new Option(option.text,option.value));
function resetInventory(clearMapping=true) {
  inventoryReport=null;$('inventory-result').hidden=true;
  if(clearMapping){inventoryAICache={};inventoryOverrides={};inspectedFile=null;inspectedSheet=null;$('inventory-mapping').hidden=true;}
}
$('inventory-file').addEventListener('change',()=>{resetInventory();$('inventory-ai-consent').checked=false;});
$('inventory-market').addEventListener('change',()=>{inventoryAICache={};inventoryOverrides={};resetInventory(false);});
for(const id of ['inventory-sku','inventory-title','inventory-category']) $(id).addEventListener('change',()=>{inventoryAICache={};inventoryOverrides={};resetInventory(false);});
$('inventory-header').addEventListener('input',()=>{inventoryAICache={};inventoryOverrides={};resetInventory(false);});
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
    inventoryAICache={};inventoryOverrides={};inspectedSheet=info.sheet;$('inventory-header').value=info.header_row;
    for(const field of ['sku','title','category']){
      const select=$('inventory-'+field);select.replaceChildren(new Option('未提供 / 不使用',''));
      info.headers.forEach((h,i)=>select.add(new Option('第 '+(i+1)+' 列 · '+(h||'空表头'),String(i))));
      select.value=info.mapping[field]===null?'':String(info.mapping[field]);
    }
    $('inventory-preview').textContent='样例：'+info.preview.map(row=>row.slice(0,8).join(' | ')).join('；');
  }catch(e){resetInventory();notify(e.message,true);}finally{busy=false;}
});
function templateLink(target,template){
  const a=document.createElement('a');a.href='/api/download/'+encodeURIComponent(template.id);a.textContent='下载 '+template.filename+' · '+template.version+' · '+(template.shop||'通用模板');target.append(a);
}
function renderInventory(report) {
  inventoryReport=report;const summary=report.summary;
  $('inventory-summary').textContent=summary.total+' 行商品 · 缺少模板 '+summary.missing+' 行 · 待确认 '+summary.review+' 行';
  $('inventory-context').textContent='店铺：'+report.shop+' · '+report.filename+' / '+report.sheet+' · 表头第 '+report.header_row+' 行 · 目标站点 '+report.marketplace+' · 已有同登记类目模板 '+summary.available+' 行';
  $('inventory-warnings').replaceChildren(...report.warnings.map(w=>{const p=document.createElement('p');p.textContent=w;return p;}));
  $('inventory-groups').replaceChildren(...report.groups.map(g=>{
    const box=document.createElement('div');box.className='analysis-group '+g.status;
    const title=document.createElement('b');title.textContent=g.category+' · '+g.count+' 行';
    const detail=document.createElement('p');detail.textContent=statusLabels[g.status];box.append(title,detail);
    if(g.template)templateLink(box,g.template);
    if(g.category!=='无法识别类目'&&!g.category.includes(' / ')){
      const input=document.createElement('input');input.className='confirm-category';input.value=g.template?.category||g.category;input.maxLength=120;input.setAttribute('aria-label','确认本组类目');
      const button=document.createElement('button');button.className='text-button';button.type='button';button.textContent='确认 / 修正本组类目并重查';
      button.addEventListener('click',()=>{const category=input.value.trim();if(!category){notify('请输入确认后的类目',true);return;}if(busy)return;for(const row of g.rows)inventoryOverrides[String(row)]=category;inventoryLocalRecheck=true;$('inventory-form').requestSubmit($('inventory-form').querySelector('button[type="submit"]'));});box.append(input,button);
    }
    return box;
  }));
  $('inventory-rows').replaceChildren();
  for(const item of report.items.slice(0,200)){
    const row=document.createElement('tr');cell(row,'第 '+item.row+' 行 / '+(item.sku||'无 SKU'));
    cell(row,item.title||'无品名','inventory-text');const categoryCell=cell(row,item.category||((item.suggested_category||'未知')+'（推断）'),'inventory-text');
    if(item.status==='review'){
      const input=document.createElement('input');input.className='confirm-category';input.placeholder='填写确认后的类目';input.maxLength=120;input.value=item.template?.category||(item.suggested_category&&!item.suggested_category.includes(' / ')?item.suggested_category:'');input.setAttribute('aria-label','第 '+item.row+' 行确认类目');
      const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent='确认此行并重查';button.addEventListener('click',()=>{if(busy)return;const category=input.value.trim();if(!category){notify('请填写确认后的类目',true);return;}inventoryOverrides[String(item.row)]=category;inventoryLocalRecheck=true;$('inventory-form').requestSubmit($('inventory-form').querySelector('button[type="submit"]'));});categoryCell.append(input,button);
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
  const useAI=$('inventory-use-ai').checked&&!inventoryLocalRecheck;const localRecheck=inventoryLocalRecheck;inventoryLocalRecheck=false;
  const button=event.submitter;const controls=[...$('inventory-form').querySelectorAll('input,select,button')];const disabledBefore=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);busy=true;const before=button.textContent;button.textContent=useAI?'AI 正在分析，请勿重复提交…':'正在分析…';
  try{
    if(useAI&&!$('inventory-ai-consent').checked)throw new Error('请先同意将所选商品资料发送到 AI 服务商');
    const mapping={};for(const field of ['sku','title','category']){const value=$('inventory-'+field).value;mapping[field]=value===''?null:Number(value);}
    const report=await sendFile('/api/inventory/analyze',file,{shop:$('inventory-shop').value,marketplace:$('inventory-market').value,sheet:$('inventory-sheet').value,header_row:Number($('inventory-header').value),mapping,category_overrides:inventoryOverrides,use_ai:useAI,include_images:$('inventory-images').checked,ai_consent:$('inventory-ai-consent').checked,ai_limit:Number($('inventory-ai-limit').value)});
    if(localRecheck)reuseAISuggestions(report);
    for(const item of report.items)if(item.ai)inventoryAICache[item.row]=structuredClone(item);
    if($('inventory-file').files[0]===file){renderInventory(report);notify('分析完成：请查看需要补充的模板及待确认类目');}
  }catch(e){notify(e.message,true);}finally{busy=false;controls.forEach((control,i)=>control.disabled=disabledBefore[i]);button.textContent=before;}
});
$('export-inventory').addEventListener('click',()=>{
  if(!inventoryReport)return;
  const report=inventoryReport;
  const rows=[['店铺','站点','工作表','原表行','SKU','品名','原类目','确认后的类目','建议类目（需确认）','结果','候选模板','模板版本','依据','下一步']];
  for(const r of report.items)rows.push([report.shop,report.marketplace,report.sheet,r.row,r.sku,r.title,r.original_category,r.confirmed?r.category:'',r.suggested_category,statusLabels[r.status],r.template?.filename||'',r.template?.version||'',r.evidence,r.action]);
  const csv=rows.map(row=>row.map(value=>{let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='模板补充清单-'+report.marketplace+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('logout').addEventListener('click',()=>{$('inventory-file').value='';$('ai-key').value='';$('inventory-ai-consent').checked=false;resetInventory();});

async function loadAISettings(){
  const info=await request('/api/ai/settings');window.currentAI=info;
  $('ai-provider').value=info.provider;$('ai-model').value=info.model;
  $('ai-state').textContent=info.configured?'已配置 · '+info.providers[info.provider].name:'尚未配置 API 密钥';
  $('ai-ready-label').textContent='（'+info.providers[info.provider].name+' / '+info.model+' · '+(info.configured?'已配置':'待配置')+'）';
  $('inventory-images').disabled=!info.vision;if(!info.vision)$('inventory-images').checked=false;
}
$('ai-provider').addEventListener('change',()=>{const models={qwen:'qwen-vl-plus',openai:'gpt-4.1-mini',deepseek:'deepseek-chat'};$('ai-model').value=models[$('ai-provider').value];$('ai-key').value='';});
$('ai-settings-form').addEventListener('submit',async e=>{
  e.preventDefault();const b=e.submitter;b.disabled=true;
  try{await postJSON('/api/ai/settings',{provider:$('ai-provider').value,model:$('ai-model').value,api_key:$('ai-key').value.trim()});$('ai-key').value='';await loadAISettings();notify('AI 配置已更新；请在库存分析中按需开启');}catch(err){notify(err.message,true);}finally{b.disabled=false;}
});

function reuseAISuggestions(report){
  let reused=0;
  for(const item of report.items){const prior=inventoryAICache[item.row];if(!item.confirmed&&prior&&prior.title===item.title&&prior.original_category===item.original_category){Object.assign(item,structuredClone(prior));reused++;}}
  if(!reused)return;
  const groups=new Map();
  for(const item of report.items){const key=JSON.stringify([item.status,item.suggested_category,item.template?.id]);if(!groups.has(key))groups.set(key,{status:item.status,category:item.suggested_category||'无法识别类目',count:0,template:item.template,rows:[]});const group=groups.get(key);group.count++;group.rows.push(item.row);}
  report.groups=[...groups.values()];for(const status of ['available','missing','review'])report.summary[status]=report.items.filter(item=>item.status===status).length;
  report.warnings.push('本次人工确认重查未再次调用 AI；沿用同一库存表尚未确认的 '+reused+' 行 AI 建议。');
}

$('inventory-shop').addEventListener('input',()=>{inventoryAICache={};inventoryOverrides={};resetInventory(false);$('inventory-ai-consent').checked=false;});

$('file').addEventListener('change',async()=>{
  const file=$('file').files[0];if(!file)return;inspectingTemplate=true;$('template-source-info').textContent='正在读取模板内部来源…';
  try{
    const result=await sendFile('/api/template/inspect',file);if($('file').files[0]!==file)return;
    const m=result.metadata;const parts=[];
    if(m.account_fingerprint){
      parts.push('账户来源 '+m.account_hint);$('template-shop').value=result.recognized_shop||'';
      parts.push(result.recognized_shop?'已识别归属：'+result.recognized_shop:'首次见到此账户，请填写真实店铺名称后保存；后续同来源模板将提示归属');
    }else parts.push('未找到可用账户来源标识，请手动确认店铺归属');
    if(m.marketplace){$('marketplace').value=m.marketplace;parts.push('主站点 '+m.marketplace);}
    if(m.product_types?.length===1){$('category').value=m.product_types[0]==='SUITCASE'?'行李箱':m.product_types[0];parts.push('商品类型 '+m.product_types[0]);}
    if(m.field_count)parts.push(m.field_count+' 个字段，数据从第 '+m.data_row+' 行开始');
    if(m.has_prefilled_data)parts.push('注意：已有预填内容，原件未清除，使用前须核对');
    $('template-source-info').textContent=parts.join('；');
  }catch(e){if($('file').files[0]===file)$('template-source-info').textContent='来源读取失败：'+e.message+'；请勿猜测店铺归属';}
  finally{if($('file').files[0]===file)inspectingTemplate=false;}
});

$('logout').addEventListener('click',()=>{$('shop-roster-text').value='';$('shop-roster-status').textContent='';});

let batchFile=null,batchSource=null,batchReading=false;
$('batch-version').value=$('version').value+'-批量';
function selectBatchTargets(){
  if(!batchSource)return;for(const checkbox of $('batch-targets').querySelectorAll('input'))checkbox.checked=!checkbox.disabled;
}
async function readBatchSource(){
  const file=$('batch-file').files[0];batchFile=null;batchSource=null;$('batch-targets').replaceChildren();if(!file)return;
  batchReading=true;$('batch-source').textContent='正在读取源模板和同地区店铺…';
  try{
    const source=await sendFile('/api/template/inspect',file);const m=source.metadata;
    if(!m.marketplace||!m.account_fingerprint)throw new Error('源模板缺少可识别的主站点或卖家记号');
    const targets=await request('/api/shops/targets?marketplace='+encodeURIComponent(m.marketplace));
    if($('batch-file').files[0]!==file)return;batchFile=file;batchSource=source;
    if(m.product_types?.length===1)$('batch-category').value=m.product_types[0]==='SUITCASE'?'行李箱':m.product_types[0];
    $('batch-source').textContent='源店铺：'+(source.recognized_shop||'未登记来源')+' · 主站点：'+m.marketplace+' · '+m.field_count+' 个字段，仅生成 '+m.marketplace+' 地区副本'+(m.has_prefilled_data?'；已有预填数据会保留':'');
    for(const target of targets){const label=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=target.shop;checkbox.disabled=!target.can_generate;label.append(checkbox,document.createTextNode(target.shop+' · '+target.account_hint+(target.can_generate?'':'（需重新导入完整记号）')));$('batch-targets').append(label);}
    if(!targets.length)$('batch-targets').textContent='该地区暂无店铺对照记录，请先让管理员导入对照表。';
    selectBatchTargets();
  }catch(e){$('batch-source').textContent=e.message;notify(e.message,true);}finally{batchReading=false;}
}
$('batch-file').addEventListener('change',readBatchSource);$('batch-select-all').addEventListener('click',selectBatchTargets);
$('batch-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy||batchReading){notify('请等待当前操作完成',true);return;}
  const file=$('batch-file').files[0];if(file!==batchFile||!batchSource){notify('请先读取有效源模板',true);return;}
  const shops=[...$('batch-targets').querySelectorAll('input:checked')].map(c=>c.value);if(!shops.length){notify('请选择至少一家同地区目标店铺',true);return;}
  busy=true;const b=e.submitter;const controls=[...$('batch-form').querySelectorAll('input,button')];const states=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);const old=b.textContent;b.textContent='正在生成和校验…';
  try{
    const payload={filename:file.name,data:await encoded(file),shops,category:$('batch-category').value,version:$('batch-version').value,save_to_library:$('batch-save').checked};
    const response=await fetch('/api/template/batch',{method:'POST',headers:{'Content-Type':'application/json','X-Template-Request':'1'},body:JSON.stringify(payload)});
    if(!response.ok){const error=await response.json();throw new Error(error.error||'生成失败');}
    const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='同地区多店铺模板-'+batchSource.metadata.marketplace+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    const generated=Number(response.headers.get('X-Generated-Count')),saved=Number(response.headers.get('X-Saved-Count')),reused=Number(response.headers.get('X-Reused-Count')),failed=Number(response.headers.get('X-Failed-Count'));
    $('batch-status').textContent='已生成 '+generated+' 份 '+batchSource.metadata.marketplace+' 副本；新入库 '+saved+'，复用已有 '+reused+'，入库失败 '+failed+'。每店修改与入库结果见 ZIP 内报告。请以亚马逊实际处理报告确认上传结果。';
    await load();notify('批量生成完成，下载包内附修改报告');
  }catch(err){notify(err.message,true);}finally{busy=false;controls.forEach((c,i)=>c.disabled=states[i]);b.textContent=old;}
});
$('logout').addEventListener('click',()=>{$('batch-file').value='';batchFile=null;batchSource=null;$('batch-targets').replaceChildren();$('batch-status').textContent='';});

function drawShopEditor(rows){
  $('shop-grid-body').replaceChildren();
  for(const row of rows.length?rows:[{shop:'',ae:'',sa:''}])addShopRow(row);
}
function addShopRow(value={shop:'',ae:'',sa:''}){
  const tr=document.createElement('tr');
  for(const key of ['shop','ae','sa']){const td=document.createElement('td');const input=document.createElement('input');input.value=value[key]||'';input.dataset.field=key;input.maxLength=key==='shop'?120:31;input.placeholder=key==='shop'?'店铺名称':'没有此地区可留空';input.setAttribute('aria-label',key==='shop'?'店铺名称':key==='ae'?'阿联酋卖家记号':'沙特卖家记号');td.append(input);tr.append(td);}
  const td=document.createElement('td');const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent='移除此行';button.title='仅移出当前待保存表格，不删除已登记店铺';button.onclick=()=>tr.remove();td.append(button);tr.append(td);$('shop-grid-body').append(tr);
}
async function loadShopEditor(){drawShopEditor(await request('/api/shops/roster'));}
$('shop-add-row').addEventListener('click',()=>addShopRow());
$('shop-toggle-paste').addEventListener('click',()=>{$('shop-paste-area').hidden=!$('shop-paste-area').hidden;if(!$('shop-paste-area').hidden)$('shop-roster-text').focus();});
$('shop-preview').addEventListener('click',async()=>{
  const button=$('shop-preview');button.disabled=true;
  try{const rows=await postJSON('/api/shops/preview',{text:$('shop-roster-text').value});drawShopEditor(rows);$('shop-roster-text').value='';$('shop-paste-area').hidden=true;$('shop-roster-status').textContent='已识别 '+rows.length+' 家店铺，请核对后点击保存。';}catch(e){$('shop-roster-status').textContent=e.message;notify(e.message,true);}finally{button.disabled=false;}
});
$('shop-roster-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;const b=e.submitter;b.disabled=true;
  try{
    const rows=[...$('shop-grid-body').rows].map(tr=>Object.fromEntries([...tr.querySelectorAll('input')].map(input=>[input.dataset.field,input.value])));
    const result=await postJSON('/api/shops/import',{rows});$('shop-roster-status').textContent='已保存 '+result.shops+' 家店铺、'+result.site_records+' 条地区记录。以后无需重复填写。';
    inventoryAICache={};resetInventory(false);await load();await loadShopEditor();notify('店铺已保存');
  }catch(e){$('shop-roster-status').textContent=e.message;notify(e.message,true);}finally{b.disabled=false;}
});

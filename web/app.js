const $ = id => document.getElementById(id);
const UI_REVISION='多类型匹配版 1105.1';
const TABLE_TYPES={upload:'上传表格',price_update:'改价表格'};
ensureInventoryShopPicker();
let templates = [];
let inventoryShopNames=[];
const selectedTemplates=new Set();
let libraryDownloading=false;
let visibleTemplates=[];
let currentRole='viewer';
let inspectingTemplate=false;
let busy = false;
let timer;
const PAGES={
  library:{id:'library',title:'模板库',description:'查找和下载团队保存的模板，按店铺、地区与类目筛选。',roles:['admin','editor','viewer']},
  import:{id:'import',title:'上传模板',description:'保存原始模板，自动读取来源，只需确认店铺名称。',roles:['admin','editor']},
  batch:{id:'batch-panel',title:'同地区批量生成',description:'为同地区店铺生成模板，可选择保存入库或下载 ZIP。',roles:['admin','editor']},
  inventory:{id:'inventory',title:'库存识别',description:'识别商品类型，直接获取对应类别表格。',roles:['admin','editor','viewer']},
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
function productTypeInfo(template){if(template.metadata)return template.metadata;if(Array.isArray(template.product_types))return template;return inventoryReport?.template_supports?.[template.id]||templates.find(t=>t.id===template.id)?.metadata||{};}
function declaredProductTypes(template){return productTypeInfo(template).product_types||[];}
function productTypeLabels(template){return productTypeInfo(template).product_type_labels||{};}
function templateCategories(template){const codes=declaredProductTypes(template),labels=productTypeLabels(template);return [...new Set([template.category,...codes,...codes.map(code=>labels[code]||code)])].filter(Boolean);}
function formatProductTypes(template){const labels=productTypeLabels(template);return declaredProductTypes(template).map(code=>labels[code]&&labels[code]!==code?labels[code]+'（'+code+'）':code).join('、');}
function renderQuickMarkets(){for(const button of document.querySelectorAll('[data-quick-market]')){const active=button.dataset.quickMarket===$('filter-market').value;button.classList.toggle('active-market',active);button.setAttribute('aria-pressed',String(active));}}
function render() {
  const query=$('search').value.trim().toLowerCase(), market=$('filter-market').value,shop=$('filter-shop').value,categoryFilter=$('filter-category').value,versionFilter=$('filter-version').value,typeFilter=$('filter-table-type').value;
  const rows=templates.filter(t=>(!typeFilter||(t.table_type||'upload')===typeFilter)&&(!market||t.marketplace===market)&&(!shop||(t.shop||'通用模板')===shop)&&(!categoryFilter||templateCategories(t).includes(categoryFilter))&&(!versionFilter||t.version===versionFilter)&&[t.original_name,t.download_name||t.original_name,t.category,t.version,t.id,t.shop||'通用模板',TABLE_TYPES[t.table_type||'upload'],...templateCategories(t)].some(v=>v.toLowerCase().includes(query)));
  renderQuickMarkets();$('filter-result-summary').textContent='找到 '+rows.length+' 条模板 / 全部 '+templates.length+' 条';visibleTemplates=rows;$('template-bulk-actions').hidden=false;$('delete-selected').hidden=currentRole==='viewer';document.querySelector('.template-select-column').hidden=false;
  $('rows').replaceChildren();$('count').textContent=rows.length;$('empty').hidden=rows.length>0;
  $('empty').querySelector('h3').textContent=templates.length?'没有找到匹配的模板':'模板库还空着';
  $('empty').querySelector('p').textContent=templates.length?'调整关键词、店铺、地区、类别或版本后重试。':'导入第一份原始模板，以后无需反复查找。';
  for(const t of rows) {
    const tr=document.createElement('tr');{const td=cell(tr,'');td.className='template-select-cell';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=selectedTemplates.has(t.id);checkbox.disabled=libraryDownloading;checkbox.setAttribute('aria-label','选择模板 '+t.original_name);checkbox.addEventListener('change',()=>{if(checkbox.checked)selectedTemplates.add(t.id);else selectedTemplates.delete(t.id);updateTemplateSelection();});td.append(checkbox);}const name=cell(tr,'');
    const title=document.createElement('div');title.className='filename';title.textContent=t.download_name||t.original_name;title.title=(t.download_name?'下载名：'+t.download_name+'\n原文件名：':'')+t.original_name;
    const hash=document.createElement('small');hash.className='hash';hash.textContent='SHA-256 '+t.sha256.slice(0,14)+'…';hash.title=t.sha256;
    name.append(title,hash);
    const meta=cell(tr,'');const store=document.createElement('small');store.className='hash';store.textContent=(t.shop||'通用模板')+(t.metadata?.account_hint?' · 账户 '+t.metadata.account_hint:'')+(t.account_scope_unknown?' · 需绑定店铺':'');meta.append(store);const badge=document.createElement('span');badge.className='badge';badge.textContent=t.marketplace;meta.append(badge,document.createTextNode(t.category));
    if(declaredProductTypes(t).length){const details=document.createElement('details');details.className='supported-product-types';const summary=document.createElement('summary');summary.textContent='支持 '+declaredProductTypes(t).length+' 种商品类型';const list=document.createElement('p');list.textContent=formatProductTypes(t);details.append(summary,list);meta.append(details);}
    for(const warning of t.metadata?.product_type_warnings||[]){const line=document.createElement('small');line.className='product-type-warning';line.textContent=warning;meta.append(line);}
    const typeCell=cell(tr,'');
    if(currentRole==='viewer'){typeCell.textContent=TABLE_TYPES[t.table_type||'upload'];}
    else{
      const select=document.createElement('select');select.className='table-type-select';select.title='调整登记类型，Excel 内容保持原样';select.setAttribute('aria-label','表格类型 '+t.original_name);for(const [value,label] of Object.entries(TABLE_TYPES))select.add(new Option(label,value));select.value=t.table_type||'upload';
      select.addEventListener('change',async()=>{if(busy){select.value=t.table_type||'upload';notify('请等待当前操作完成',true);return;}const value=select.value;busy=true;select.disabled=true;try{await postJSON('/api/template/type',{id:t.id,table_type:value});inventoryAICache={};resetInventory(false);await load();notify('已改为'+TABLE_TYPES[value]);}catch(e){select.value=t.table_type||'upload';notify(e.message,true);}finally{busy=false;select.disabled=false;updateInventoryActions();}});typeCell.append(select);
    }
    cell(tr,t.version);cell(tr,new Date(t.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
    const action=cell(tr,'');const link=document.createElement('a');link.href='/api/download/'+encodeURIComponent(t.id);link.textContent='↓ 下载原件';action.append(link);if(currentRole!=='viewer'){const move=document.createElement('button');move.className='text-button';move.textContent='设置店铺';move.addEventListener('click',async()=>{const shop=prompt('输入归属店铺；含账户标识的同来源模板会一起调整。无账户来源的模板才可设为“通用模板”',t.shop||'通用模板');if(shop===null)return;try{await postJSON('/api/template-shop',{id:t.id,shop});inventoryAICache={};resetInventory(false);await load();notify('已更新店铺归属');}catch(e){notify(e.message,true);}});action.append(move);const remove=document.createElement('button');remove.className='text-button delete-template';remove.textContent='删除';remove.setAttribute('aria-label','删除模板 '+t.original_name);remove.addEventListener('click',async()=>{
      if(busy){notify('请等待当前操作完成',true);return;}
      if(!confirm('确认删除以下模板？\n\n文件：'+t.original_name+'\n店铺：'+(t.shop||'通用模板')+'\n站点 / 类目：'+t.marketplace+' / '+t.category+'\n表格类型：'+TABLE_TYPES[t.table_type||'upload']+'\n版本：'+t.version+'\n\n确认后移除该文件和库内记录。已有备份可用于恢复。'))return;
      busy=true;remove.disabled=true;
      try{const result=await postJSON('/api/template/delete',{id:t.id});inventoryAICache={};resetInventory(false);await load();notify(result.cleanup_pending?'已从模板库移除；磁盘文件清理尚未完成':'模板已删除');}
      catch(e){notify(e.message,true);}finally{busy=false;remove.disabled=false;}
    });action.append(remove);}$('rows').append(tr);
  }
  updateTemplateSelection();
}
async function load() {
  selectedTemplates.clear();
  const [stored,registeredShops]=await Promise.all([request('/api/templates'),request('/api/shops')]);templates=stored;
  $('total').textContent=templates.length;$('markets').textContent=new Set(templates.map(t=>t.marketplace)).size;$('categories').textContent=new Set(templates.map(t=>t.category)).size;
  const selected=$('filter-market').value;$('filter-market').replaceChildren(new Option('全部站点',''));
  [...new Set(['AE','SA',...templates.map(t=>t.marketplace)])].sort().forEach(m=>$('filter-market').add(new Option(m,m)));
  $('filter-market').value=selected;const selectedShop=$('filter-shop').value;const shops=[...new Set(['通用模板',...registeredShops,...templates.map(t=>t.shop||'通用模板')])].sort();$('filter-shop').replaceChildren(new Option('全部店铺',''),...shops.map(shop=>new Option(shop,shop)));$('filter-shop').value=selectedShop;$('shop-options').replaceChildren(...shops.map(shop=>new Option(shop,shop)));inventoryShopNames=shops;updateInventoryShopOptions();for(const [id,field,label] of [['filter-category','category','全部类别'],['filter-version','version','全部版本']]){const value=$(id).value;$(id).replaceChildren(new Option(label,''),...[...new Set(field==='category'?templates.flatMap(templateCategories):templates.map(t=>t[field]))].sort().map(item=>new Option(item,item)));$(id).value=value;}render();
}
async function encoded(file,maxMB=32) {
  if(file.size>maxMB*1024*1024)throw new Error('当前文件 '+(file.size/1024/1024).toFixed(1)+' MB，超过此操作 '+maxMB+' MB 上限');
  return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(new Error('文件读取失败'));r.readAsDataURL(file);});
}
async function sendFile(url,file,meta={}) {
  const inventory=url.startsWith('/api/inventory/');
  if(inventory&&/\.xls$/i.test(file.name)){const header=new Uint8Array(await file.slice(0,4).arrayBuffer());if(!(header[0]===0x50&&header[1]===0x4b&&header[2]===3&&header[3]===4))throw new Error('旧版 .xls 请先用 Excel/WPS 另存为 .xlsx 并保留图片，不能只改扩展名');}
  return request(url,{method:'POST',headers:{'Content-Type':'application/json','X-Template-Request':'1'},body:JSON.stringify({filename:file.name,data:await encoded(file,inventory?100:32),...meta})});
}
$('file').addEventListener('change',()=>$('file-name').textContent=$('file').files[0]?.name||'点击选择亚马逊原始模板');
$('version').value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('upload').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;if(inspectingTemplate){notify('正在读取模板来源，请稍后保存',true);return;}busy=true;const button=event.submitter;button.disabled=true;button.textContent='正在保存…';
  try {
    const result=await sendFile('/api/upload',$('file').files[0],{table_type:$('template-table-type').value,shop:$('template-shop').value,marketplace:$('marketplace').value,category:$('category').value,version:$('version').value});
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
const filterTemplates=()=>{selectedTemplates.clear();render();};$('search').addEventListener('input',filterTemplates);$('filter-table-type').addEventListener('change',filterTemplates);$('filter-market').addEventListener('change',filterTemplates);$('filter-shop').addEventListener('change',filterTemplates);$('filter-category').addEventListener('change',filterTemplates);$('filter-version').addEventListener('change',filterTemplates);$('clear-template-filters').addEventListener('click',()=>{for(const id of ['search','filter-table-type','filter-market','filter-shop','filter-category','filter-version'])$(id).value='';filterTemplates();});
for(const button of document.querySelectorAll('[data-quick-market]'))button.addEventListener('click',()=>{$('filter-market').value=button.dataset.quickMarket;filterTemplates();});
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
const inventorySelected=new Set();
let inventoryDownloading=false;
let inventoryAICache={};
let inventoryLocalRecheck=false;
let inventoryOverrides={};
let inventoryTemplateOverrides={};
let inspectedFile=null;
let inspectedSheet=null;
let inventoryFileRevision=0,inventoryInspectRunning=false,inventoryInspectQueued=false;
const statusLabels={available:'已有登记模板',missing:'需要补充模板',review:'类目待确认'};
for(const option of $('marketplace').options) $('inventory-market').add(new Option(option.text,option.value));
function updateInventoryActions(){
  for(const id of ['inventory-new-file','inventory-next-file-button','inspect-inventory','reread-inventory'])if($(id))$(id).disabled=busy||inventoryDownloading;
  const submit=$('inventory-form').querySelector('button[type="submit"]');if(submit)submit.disabled=busy||inventoryDownloading||!inspectedFile;
}
function updateInventoryFileInfo(){
  const file=$('inventory-file').files[0];$('inventory-file-info').textContent=file?file.name+' · '+(file.size/1024/1024).toFixed(1)+' MB'+(/\.xls$/i.test(file.name)?' · 旧版格式请另存为 .xlsx':''):'选择文件后自动读取表头';
}
function resetInventory(clearMapping=true) {
  inventoryReport=null;inventorySelected.clear();inventoryLocalRecheck=false;if($('inventory-progress'))$('inventory-progress').hidden=true;$('inventory-download-bar').hidden=true;$('inventory-result').hidden=true;$('inventory-inputs').open=true;$('inventory-inputs').querySelector('summary').textContent='上传库存与识别设置';
  for(const id of ['inventory-groups','inventory-warnings','inventory-summary','inventory-context'])$(id).replaceChildren();
  if(clearMapping){
    inventoryAICache={};inventoryOverrides={};inventoryTemplateOverrides={};inspectedFile=null;inspectedSheet=null;$('inventory-mapping').hidden=true;
    $('inventory-sheet').replaceChildren();$('inventory-header').value='1';$('inventory-preview').textContent='';
    for(const field of ['sku','title','category'])$('inventory-'+field).replaceChildren(new Option('未提供 / 不使用',''));
    $('column-settings').open=false;
  }
  setInventoryStep(clearMapping?1:($('inventory-mapping').hidden?1:2));updateInventoryActions();
}
function chooseNextInventory(){
  if(busy||inventoryDownloading){notify('请等待当前操作完成',true);return;}
  // Use a separate picker so Cancel preserves the current file and result.
  $('inventory-next-file').value='';$('inventory-next-file').click();
}
for(const id of ['inventory-new-file','inventory-next-file-button'])$(id).addEventListener('click',chooseNextInventory);
$('inventory-next-file').addEventListener('change',()=>{
  const file=$('inventory-next-file').files[0];if(!file)return;
  if(busy||inventoryDownloading){notify('请等待当前操作完成',true);return;}
  const transfer=new DataTransfer();transfer.items.add(file);$('inventory-file').files=transfer.files;$('inventory-file').dispatchEvent(new Event('change',{bubbles:true}));
  $('inventory-inputs').scrollIntoView({block:'start',behavior:'smooth'});
});
$('inventory-file').addEventListener('change',()=>{
  inventoryFileRevision++;resetInventory();updateInventoryFileInfo();$('inventory-ai-consent').checked=false;
  if($('inventory-file').files.length)inspectInventory();
});
$('inventory-table-type').addEventListener('change',()=>{updateInventoryShopOptions();inventoryAICache={};inventoryOverrides={};inventoryTemplateOverrides={};resetInventory(false);$('inventory-ai-consent').checked=false;});
$('inventory-market').addEventListener('change',()=>{updateInventoryShopOptions();inventoryAICache={};inventoryOverrides={};inventoryTemplateOverrides={};resetInventory(false);});
for(const id of ['inventory-sku','inventory-title','inventory-category']) $(id).addEventListener('change',()=>{inventoryAICache={};inventoryOverrides={};inventoryTemplateOverrides={};resetInventory(false);});
$('inventory-header').addEventListener('input',()=>{inventoryAICache={};inventoryOverrides={};inventoryTemplateOverrides={};resetInventory(false);});
async function inspectInventory(reuseSelection=false) {
  const file=$('inventory-file').files[0];
  if(!file){notify('请先选择库存表',true);return;}
  if(busy){if(inventoryInspectRunning&&!reuseSelection){inventoryInspectQueued=true;return;}notify('请等待当前操作完成',true);return;}
  busy=true;inventoryInspectRunning=true;inventoryInspectQueued=false;updateInventoryActions();
  const revision=inventoryFileRevision;const button=$('inspect-inventory');button.textContent='正在读取表头…';
  try {
    const options=reuseSelection?{sheet:$('inventory-sheet').value,header_row:Number($('inventory-header').value)}:{};
    const info=await sendFile('/api/inventory/inspect',file,options);
    if($('inventory-file').files[0]!==file||revision!==inventoryFileRevision)return;
    resetInventory();inspectedFile=file;inspectedSheet=info.sheet;
    $('inventory-sheet').replaceChildren(...info.sheets.map(s=>new Option(s.name+' · '+s.rows+' 个非空行',s.name)));
    $('inventory-sheet').value=info.sheet;$('inventory-header').value=info.header_row;
    for(const field of ['sku','title','category']){
      const select=$('inventory-'+field);select.replaceChildren(new Option('未提供 / 不使用',''));
      info.headers.forEach((h,i)=>select.add(new Option('第 '+(i+1)+' 列 · '+(h||'空表头'),String(i))));
      select.value=info.mapping[field]===null?'':String(info.mapping[field]);
    }
    $('inventory-mapping').hidden=false;setInventoryStep(2);$('column-settings').open=(info.mapping.title===null&&info.mapping.category===null)||info.warnings.some(w=>w.includes('当前表头'));
    $('inventory-preview').textContent='表头已识别，请核对工作表、表头行号及列映射'+(info.warnings.length?'；'+info.warnings.join('；'):'');
    notify('表头已读取，请核对工作表、表头行和列映射');
  }catch(e){if(revision===inventoryFileRevision&&$('inventory-file').files[0]===file)notify(e.message,true);}
  finally{busy=false;inventoryInspectRunning=false;button.textContent=inspectedFile?'重新读取库存表':'读取库存表';updateInventoryActions();if(inventoryInspectQueued&&$('inventory-file').files.length)inspectInventory();else inventoryInspectQueued=false;}
}
$('inspect-inventory').addEventListener('click',()=>inspectInventory());
$('reread-inventory').addEventListener('click',()=>inspectInventory(true));
$('inventory-sheet').addEventListener('change',async()=>{
  if(busy){$('inventory-sheet').value=inspectedSheet||'';notify('请等待当前操作完成',true);return;}
  const file=$('inventory-file').files[0];if(!file)return;
  busy=true;inventoryInspectRunning=true;inventoryInspectQueued=false;resetInventory(false);updateInventoryActions();
  const revision=inventoryFileRevision;
  try {
    const info=await sendFile('/api/inventory/inspect',file,{sheet:$('inventory-sheet').value});
    if($('inventory-file').files[0]!==file||revision!==inventoryFileRevision)return;
    inventoryAICache={};inventoryOverrides={};inventoryTemplateOverrides={};inspectedSheet=info.sheet;$('inventory-header').value=info.header_row;
    for(const field of ['sku','title','category']){
      const select=$('inventory-'+field);select.replaceChildren(new Option('未提供 / 不使用',''));
      info.headers.forEach((h,i)=>select.add(new Option('第 '+(i+1)+' 列 · '+(h||'空表头'),String(i))));
      select.value=info.mapping[field]===null?'':String(info.mapping[field]);
    }
    $('inventory-preview').textContent='表头已识别，请核对列映射后开始匹配类别模板。';
  }catch(e){if(revision===inventoryFileRevision){resetInventory();notify(e.message,true);}}finally{busy=false;inventoryInspectRunning=false;updateInventoryActions();if(inventoryInspectQueued&&$('inventory-file').files.length)inspectInventory();else inventoryInspectQueued=false;}
});
function templateLink(target,template){
  const a=document.createElement('a');a.href='/api/download/'+encodeURIComponent(template.id);a.textContent='下载 '+template.filename+' · '+template.version+' · '+(template.shop||'通用模板');target.append(a);
}
function categoryResults(report){
  const groups=new Map();
  for(const item of report.items){
    const category=item.category_key||item.suggested_category||'无法识别类目';
    if(!groups.has(category))groups.set(category,{category,rows:[],statuses:new Set(),candidates:new Map()});
    const group=groups.get(category);group.rows.push(item.row);group.statuses.add(item.status);
    if(item.template)group.candidates.set(item.template.id,item.template);
  }
  return [...groups.values()].map(group=>{
    const candidates=[...group.candidates.values()].sort((a,b)=>{
      const own=Number(b.shop===report.shop)-Number(a.shop===report.shop);if(own)return own;
      const date=id=>templates.find(t=>t.id===id)?.created_at||'';return date(b.id).localeCompare(date(a.id));
    });
    return {...group,template:candidates[0]||null,status:group.statuses.has('review')?'review':group.statuses.has('available')?'available':'missing'};
  });
}
function renderInventory(report) {
  inventoryReport=report;const groups=categoryResults(report);
  inventorySelected.clear();for(const group of groups)if(group.template)inventorySelected.add(group.template.id);
  updateInventoryDownload(groups);
  $('inventory-summary').textContent='识别到 '+groups.filter(g=>g.category!=='无法识别类目').length+' 类商品 · '+inventoryDownloadIds().length+' 份不同表格';
  $('inventory-context').textContent='库存：'+report.filename+' · '+TABLE_TYPES[report.table_type||'upload']+' · 目标店铺：'+report.shop+' · 地区：'+report.marketplace+'。每类一行；相同文件只下载一次。';
  $('inventory-warnings').replaceChildren(...report.warnings.map(w=>{const p=document.createElement('p');p.textContent=w;return p;}));
  $('inventory-groups').replaceChildren(...groups.map(group=>{
    const box=document.createElement('article');box.className='analysis-group category-template '+group.status;
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='inventory-file-select';checkbox.disabled=!group.template;checkbox.checked=!!group.template;checkbox.setAttribute('aria-label','选择 '+group.category+' 对应表格');
    if(group.template){checkbox.dataset.templateId=group.template.id;checkbox.addEventListener('change',()=>{if(checkbox.checked)inventorySelected.add(group.template.id);else inventorySelected.delete(group.template.id);updateInventoryDownload(groups);});}
    const body=document.createElement('div');body.className='category-body';const heading=document.createElement('div');heading.className='category-heading';
    const title=document.createElement('h3');title.textContent=group.category==='无法识别类目'?'待识别的商品类别':group.category;
    const badge=document.createElement('span');badge.className='category-state '+group.status;badge.textContent=group.template?(group.status==='review'?'候选 · 待确认':'可下载'):(group.status==='review'?'待识别':'需补充');heading.append(title,badge);body.append(heading);
    const actions=document.createElement('div');actions.className='category-actions';
    if(group.template){
      const file=document.createElement('p');file.className='template-version';file.textContent=group.template.filename+' · '+group.template.version+' · '+(group.template.shop||'通用模板');if(declaredProductTypes(group.template).length>1)file.textContent+=' · 支持 '+declaredProductTypes(group.template).length+' 类';file.title=file.textContent+(declaredProductTypes(group.template).length?'\n支持：'+formatProductTypes(group.template):'');body.append(file);
      const link=document.createElement('a');link.href='/api/download/'+encodeURIComponent(group.template.id);link.className='button secondary';link.textContent=group.status==='review'?'下载候选':'下载表格';actions.append(link);
    }else{
      const detail=document.createElement('p');detail.className='hint';detail.textContent=group.status==='review'?'当前店铺未匹配到模板，请确认类别或启用 AI 图文识别。':'当前店铺和地区暂无对应模板。';body.append(detail);
      if(group.status==='missing'&&currentRole!=='viewer'){const link=document.createElement('a');link.href='#import';link.className='text-button';link.textContent='补充模板';actions.append(link);}
      else {const label=document.createElement('span');label.className='hint';label.textContent='暂无文件';actions.append(label);}
    }
    if(group.status==='review'&&group.category!=='无法识别类目'&&!group.category.includes(' / ')){
      const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='确认或修正类别';
      const input=document.createElement('input');input.className='confirm-category';input.value=group.category;input.maxLength=120;input.setAttribute('aria-label','确认类别 '+group.category);
      const button=document.createElement('button');button.className='text-button';button.type='button';button.textContent='确认类别并重新匹配';
      button.addEventListener('click',()=>{if(busy)return;const category=input.value.trim();if(!category){notify('请输入确认后的类别',true);return;}for(const row of group.rows){inventoryOverrides[String(row)]=category;delete inventoryTemplateOverrides[String(row)];if(group.template?.matched_product_type&&declaredProductTypes(group.template).includes(group.template.matched_product_type))inventoryTemplateOverrides[String(row)]={template_id:group.template.id,product_type:group.template.matched_product_type};}inventoryLocalRecheck=true;$('inventory-form').requestSubmit($('inventory-form').querySelector('button[type="submit"]'));});
      details.append(summary,input,button);body.append(details);
    }
    box.append(checkbox,body,actions);return box;
  }));
  $('inventory-result').hidden=false;setInventoryStep(3);$('inventory-inputs').open=false;$('inventory-inputs').querySelector('summary').textContent='更换库存表 / 调整识别设置';
}
$('inventory-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const file=$('inventory-file').files[0];
  if(file!==inspectedFile){notify('文件已变化，请重新读取表头',true);return;}
  const useAI=$('inventory-use-ai').checked&&!inventoryLocalRecheck;const localRecheck=inventoryLocalRecheck;inventoryLocalRecheck=false;
  const button=event.submitter;const controls=[...$('inventory-form').querySelectorAll('input,select,button')];const disabledBefore=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);busy=true;const before=button.textContent;button.textContent=useAI?'AI 正在分析…':'正在分析…';
  const jobId='inv-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);const stopProgress=startInventoryProgress(jobId);const revision=inventoryFileRevision;updateInventoryActions();
  try{
    if(useAI&&!$('inventory-ai-consent').checked)throw new Error('请先同意将所选商品资料发送到 AI 服务商');
    const mapping={};for(const field of ['sku','title','category']){const value=$('inventory-'+field).value;mapping[field]=value===''?null:Number(value);}
    const report=await sendFile('/api/inventory/analyze',file,{table_type:$('inventory-table-type').value,job_id:jobId,use_ai_cache:$('inventory-ai-cache')?.checked!==false,shop:$('inventory-shop').value,marketplace:$('inventory-market').value,sheet:$('inventory-sheet').value,header_row:Number($('inventory-header').value),mapping,category_overrides:inventoryOverrides,template_overrides:inventoryTemplateOverrides,use_ai:useAI,include_images:$('inventory-images').checked,ai_consent:$('inventory-ai-consent').checked,ai_limit:Number($('inventory-ai-limit').value)});
    if($('inventory-file').files[0]!==file||revision!==inventoryFileRevision)return;
    if(localRecheck)reuseAISuggestions(report);
    for(const item of report.items)if(item.ai)inventoryAICache[item.row]=structuredClone(item);
    if($('inventory-file').files[0]===file){stopProgress(report);renderInventory(report);notify('识别完成，可一键下载全部或勾选表格下载');}
  }catch(e){stopProgress(null,e.message);notify(e.message,true);}finally{stopProgress();busy=false;controls.forEach((control,i)=>control.disabled=disabledBefore[i]);button.textContent=before;updateInventoryActions();}
});
$('export-inventory').addEventListener('click',()=>{
  if(!inventoryReport)return;
  const report=inventoryReport;
  const rows=[['店铺','站点','表格类型','商品类别','匹配状态','对应模板','模板版本']];
  for(const group of categoryResults(report))rows.push([report.shop,report.marketplace,TABLE_TYPES[report.table_type||'upload'],group.category,statusLabels[group.status],group.template?.filename||'',group.template?.version||'']);
  const csv=rows.map(row=>row.map(value=>{let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='模板补充清单-'+report.marketplace+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('logout').addEventListener('click',()=>{inventoryFileRevision++;inventoryInspectQueued=false;$('inventory-next-file').value='';$('inventory-file').value='';updateInventoryFileInfo();$('ai-key').value='';$('inventory-ai-consent').checked=false;resetInventory();});

async function loadAISettings(){
  const info=await request('/api/ai/settings');window.currentAI=info;
  $('ai-provider').value=info.provider;$('ai-model').value=info.model;$('ai-region').value=info.region||'cn';$('ai-region-label').hidden=info.provider!=='qwen';
  $('ai-state').textContent=info.configured?'已配置 · '+info.providers[info.provider].name:'尚未配置 API 密钥';
  $('ai-ready-label').textContent='（'+info.providers[info.provider].name+' / '+info.model+' · '+(info.configured?'已配置':'待配置')+'）';
  if($('ai-model-help'))$('ai-model-help').textContent='推荐模型：'+info.providers[info.provider].model+'。已有保存配置不会自动替换，修改后请保存并测试。';
  $('inventory-images').disabled=!info.vision;if(!info.vision)$('inventory-images').checked=false;
}
$('ai-provider').addEventListener('change',()=>{const models={qwen:'qwen3-vl-plus',openai:'gpt-4.1-mini',deepseek:'deepseek-chat'};$('ai-model').value=models[$('ai-provider').value];$('ai-key').value='';$('ai-region-label').hidden=$('ai-provider').value!=='qwen';});
$('ai-settings-form').addEventListener('submit',async e=>{
  e.preventDefault();const b=e.submitter;b.disabled=true;
  try{await postJSON('/api/ai/settings',{provider:$('ai-provider').value,model:$('ai-model').value,api_key:$('ai-key').value.trim(),region:$('ai-region').value});$('ai-key').value='';await loadAISettings();notify('AI 配置已更新；请在库存分析中按需开启');}catch(err){notify(err.message,true);}finally{b.disabled=false;}
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

$('inventory-shop').addEventListener('input',()=>{inventoryAICache={};inventoryOverrides={};inventoryTemplateOverrides={};resetInventory(false);$('inventory-ai-consent').checked=false;});

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
    if(m.product_types?.length===1)$('category').value=productTypeLabels(m)[m.product_types[0]]||m.product_types[0];
    if(m.product_types?.length>1)$('category').value='多商品类型模板';
    if(m.product_types?.length)parts.push('声明支持 '+m.product_types.length+' 类：'+formatProductTypes(m));
    parts.push(...(m.product_type_warnings||[]));
    if(m.field_count)parts.push(m.field_count+' 个字段，数据从第 '+m.data_row+' 行开始');
    if(m.has_prefilled_data)parts.push('注意：已有预填内容，原件未清除，使用前须核对');
    $('template-source-info').textContent=parts.join('；');
  }catch(e){if($('file').files[0]===file)$('template-source-info').textContent='来源读取失败：'+e.message+'；请勿猜测店铺归属';}
  finally{if($('file').files[0]===file)inspectingTemplate=false;}
});

$('logout').addEventListener('click',()=>{$('shop-roster-text').value='';$('shop-roster-status').textContent='';});

let batchFile=null,batchSource=null,batchReading=false,batchReadSequence=0,batchLastResult=null,batchDownloading=false;
$('batch-version').value=$('version').value+'-批量';
const batchModeLabels={library:'生成并保存到模板库',both:'生成、保存并下载 ZIP',download:'生成并下载 ZIP'};
function batchMode(){return document.querySelector('input[name="batch-output"]:checked')?.value||'library';}
function updateBatchControls(){
  const available=[...$('batch-targets').querySelectorAll('input:not(:disabled)')],selected=available.filter(c=>c.checked);
  $('batch-selection-count').textContent=batchSource?'已选 '+selected.length+' / '+available.length+' 家店铺':'尚未读取店铺';
  $('batch-select-all').disabled=busy||batchReading||!available.length;$('batch-clear-all').disabled=busy||batchReading||!selected.length;
  $('batch-submit').disabled=busy||batchReading||!batchSource||!selected.length;
  if(!busy)$('batch-submit').textContent=batchModeLabels[batchMode()];
  $('batch-mode-note').textContent={library:'完成后可在模板库查找，也可手动下载本批模板。',both:'生成后保存到模板库，并自动下载一份 ZIP。',download:'生成后只下载 ZIP，模板库中不会增加记录。'}[batchMode()];
}
function clearBatchResult(){batchLastResult=null;$('batch-result').hidden=true;$('batch-result-rows').replaceChildren();}
function selectBatchTargets(selected=true){
  if(!batchSource)return;for(const checkbox of $('batch-targets').querySelectorAll('input'))checkbox.checked=selected&&!checkbox.disabled;updateBatchControls();
}
async function readBatchSource(){
  const sequence=++batchReadSequence,file=$('batch-file').files[0];batchFile=null;batchSource=null;clearBatchResult();$('batch-targets').replaceChildren();
  if(!file){batchReading=false;$('batch-source').textContent='选择文件后自动读取地区与来源店铺。';updateBatchControls();return;}
  batchReading=true;$('batch-source').textContent='正在读取源模板和同地区店铺…';updateBatchControls();
  try{
    const source=await sendFile('/api/template/inspect',file);const m=source.metadata;
    if(sequence!==batchReadSequence)return;
    if(!m.marketplace||!m.account_fingerprint)throw new Error('源模板缺少可识别的主站点或卖家记号');
    const targets=await request('/api/shops/targets?marketplace='+encodeURIComponent(m.marketplace));
    if(sequence!==batchReadSequence)return;batchFile=file;batchSource=source;
    if(m.product_types?.length===1)$('batch-category').value=productTypeLabels(m)[m.product_types[0]]||m.product_types[0];
    if(m.product_types?.length>1)$('batch-category').value='多商品类型模板';
    $('batch-source').textContent='源店铺：'+(source.recognized_shop||'未登记来源')+' · 地区：'+m.marketplace+' · '+m.field_count+' 个字段'+(m.product_types?.length?' · 声明支持 '+m.product_types.length+' 类：'+formatProductTypes(m):'')+(m.has_prefilled_data?' · 已有商品内容会保留':'')+(m.product_type_warnings?.length?' · '+m.product_type_warnings.join('；'):'');
    for(const target of targets){const label=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=target.shop;checkbox.disabled=!target.can_generate;const name=document.createElement('span');name.textContent=target.shop+' · '+target.account_hint+(target.can_generate?'':'（需补全卖家记号）');name.title=name.textContent;label.append(checkbox,name);$('batch-targets').append(label);}
    if(!targets.length)$('batch-targets').textContent='该地区暂无店铺记录，请先在店铺管理中登记。';
    selectBatchTargets();
  }catch(e){if(sequence===batchReadSequence){$('batch-source').textContent=e.message;notify(e.message,true);}}
  finally{if(sequence===batchReadSequence){batchReading=false;updateBatchControls();}}
}
$('batch-file').addEventListener('change',readBatchSource);$('batch-select-all').addEventListener('click',()=>selectBatchTargets());$('batch-clear-all').addEventListener('click',()=>selectBatchTargets(false));$('batch-targets').addEventListener('change',updateBatchControls);
for(const radio of document.querySelectorAll('input[name="batch-output"]'))radio.addEventListener('change',updateBatchControls);
function saveDownloadBlob(blob,filename){
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderBatchResult(result){
  batchLastResult=result;const report=result.report,ids=[...new Set((report.items||[]).filter(item=>item.template_id&&['saved','reused'].includes(item.library_status)).map(item=>item.template_id))];result.ids=ids;
  $('batch-result-context').textContent=report.marketplace+' · '+TABLE_TYPES[report.table_type||'upload']+' · '+report.category+' · 版本：'+report.version;
  $('batch-result').hidden=false;$('batch-result').classList.toggle('has-errors',report.failed>0);$('batch-result-title').textContent=report.failed?'部分入库失败，请核对':'生成完成';
  $('batch-result-counts').replaceChildren(...[['已生成',report.generated],['新入库',report.saved],['复用已有',report.reused],['入库失败',report.failed]].map(([label,value])=>{const box=document.createElement('div'),number=document.createElement('strong'),name=document.createElement('span');number.textContent=value;name.textContent=label;box.append(number,name);return box;}));
  $('batch-status').textContent=report.failed?'有 '+report.failed+' 份未成功入库。'+(result.blob?'副本已保留在 ZIP 中，请查看包内报告。':'请查看逐店结果；检查磁盘后可用相同源文件和版本重试，成功项会复用。'):result.blob?(report.save_requested?'已按店铺保存，并开始下载 ZIP。':'ZIP 已开始下载，本次未保存到模板库。'):'已保存到共享模板库，可直接查看或按需下载，不会自动弹出下载窗口。';
  $('batch-open-library').hidden=!report.saved&&!report.reused;
  $('batch-download-result').hidden=!result.blob&&!ids.length;$('batch-download-result').textContent=result.blob?'再次下载 ZIP':'下载本批已入库模板';
  $('batch-download-report').hidden=!report.items;
  $('batch-result-details').hidden=!report.items;$('batch-result-details').open=!!report.failed&&!!report.items;$('batch-result-rows').replaceChildren();
  const labels={saved:'已入库',reused:'复用已有',failed:'入库失败',not_requested:'仅下载'};
  for(const item of report.items||[]){const row=document.createElement('tr');cell(row,item.shop);cell(row,labels[item.library_status]||item.library_status);const file=cell(row,item.output_name);file.className='batch-result-file';file.title=item.output_name;cell(row,item.error||'');$('batch-result-rows').append(row);}
}
$('batch-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy||batchReading){notify('请等待当前操作完成',true);return;}
  const file=$('batch-file').files[0];if(file!==batchFile||!batchSource){notify('请先读取有效源模板',true);return;}
  const shops=[...$('batch-targets').querySelectorAll('input:checked')].map(c=>c.value);if(!shops.length){notify('请选择至少一家同地区目标店铺',true);return;}
  const mode=batchMode(),marketplace=batchSource.metadata.marketplace;
  busy=true;const controls=[...$('batch-form').querySelectorAll('input,select,button')];const states=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);$('batch-submit').textContent='正在生成和校验…';
  try{
    const payload={table_type:$('batch-table-type').value,filename:file.name,data:await encoded(file),shops,category:$('batch-category').value,version:$('batch-version').value,save_to_library:mode!=='download',download_zip:mode!=='library'};
    const response=await fetch('/api/template/batch',{method:'POST',headers:{'Content-Type':'application/json','X-Template-Request':'1'},body:JSON.stringify(payload)});
    if(!response.ok){const error=await response.json();throw new Error(error.error||'生成失败');}
    let result;
    if(mode==='library'){
      if(!(response.headers.get('Content-Type')||'').includes('application/json'))throw new Error('服务器仍是旧版本，请完整覆盖新版程序并重启后重试');
      result={report:await response.json(),blob:null};
    }else{
      const blob=await response.blob(),report={marketplace,table_type:payload.table_type,category:payload.category.trim(),version:payload.version.trim(),save_requested:payload.save_to_library};
      for(const [field,header] of [['generated','Generated'],['saved','Saved'],['reused','Reused'],['failed','Failed']])report[field]=Number(response.headers.get('X-'+header+'-Count'));
      const disposition=(response.headers.get('Content-Disposition')||'').match(/filename\*=UTF-8''([^;]+)/i);result={report,blob,filename:disposition?decodeURIComponent(disposition[1]):TABLE_TYPES[payload.table_type]+'_多店铺_'+marketplace+'.zip'};saveDownloadBlob(blob,result.filename);
    }
    renderBatchResult(result);
    if(payload.save_to_library){try{await load();}catch(error){notify('生成已完成；模板库列表刷新失败，请稍后刷新查看',true);return;}}
    notify(result.report.failed?'部分入库失败，请查看本次结果':mode==='library'?'已保存到模板库，需要时再下载':'批量生成完成，ZIP 内附生成报告',result.report.failed>0);
  }catch(err){notify(err.message,true);}finally{busy=false;controls.forEach((c,i)=>c.disabled=states[i]);updateBatchControls();}
});
$('batch-download-result').addEventListener('click',async()=>{
  if(!batchLastResult||batchDownloading)return;if(busy){notify('请等待当前操作完成',true);return;}
  const result=batchLastResult;if(result.blob){saveDownloadBlob(result.blob,result.filename);return;}
  batchDownloading=true;$('batch-download-result').disabled=true;
  try{
    const response=await fetch('/api/templates/download',{method:'POST',headers:{'Content-Type':'application/json','X-Template-Request':'1'},body:JSON.stringify({ids:result.ids})});
    if(!response.ok){const error=await response.json();throw new Error(error.error||'下载失败');}
    const match=(response.headers.get('Content-Disposition')||'').match(/filename\*=UTF-8''([^;]+)/i);saveDownloadBlob(await response.blob(),match?decodeURIComponent(match[1]):'本批模板.zip');
  }catch(error){notify(error.message,true);}finally{batchDownloading=false;$('batch-download-result').disabled=false;}
});
$('batch-download-report').addEventListener('click',()=>{if(batchLastResult?.report.items)saveDownloadBlob(new Blob([JSON.stringify(batchLastResult.report,null,2)],{type:'application/json;charset=utf-8'}),'生成与入库报告.json');});
$('batch-open-library').addEventListener('click',()=>{if(!batchLastResult)return;const report=batchLastResult.report;$('search').value='';$('filter-shop').value='';for(const [id,value] of [['filter-table-type',report.table_type||'upload'],['filter-market',report.marketplace],['filter-category',report.category],['filter-version',report.version]])$(id).value=value;render();});
$('logout').addEventListener('click',()=>{$('batch-file').value='';batchReadSequence++;batchFile=null;batchSource=null;batchReading=false;$('batch-targets').replaceChildren();clearBatchResult();updateBatchControls();});
updateBatchControls();

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

function setInventoryStep(step){for(const item of document.querySelectorAll('.inventory-flow li')){const value=Number(item.dataset.step);item.classList.toggle('current',value===step);item.classList.toggle('complete',value<step);if(value===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');}}
$('inventory-use-ai').addEventListener('change',()=>{$('ai-advanced').open=$('inventory-use-ai').checked;});

function selectedTemplateIds(){return [...new Set(visibleTemplates.filter(t=>selectedTemplates.has(t.id)).map(t=>t.id))];}
function updateTemplateSelection(){
  const count=selectedTemplateIds().length,all=visibleTemplates.length>0&&count===visibleTemplates.length;
  $('template-selection-count').textContent=count?'已选择 '+count+' 份表格':'未选择表格';
  $('download-selected-templates').disabled=!count||libraryDownloading;$('download-selected-templates').textContent=libraryDownloading?'正在准备下载…':'↓ 下载所选'+(count?'（'+count+' 份）':'');
  $('delete-selected').disabled=!count||busy||libraryDownloading;$('delete-selected').textContent='删除所选'+(count?'（'+count+'）':'');
  $('select-all-template-files').disabled=!visibleTemplates.length||libraryDownloading||all;$('clear-template-selection').disabled=!count||libraryDownloading;
  const box=$('select-all-templates');box.checked=all;box.indeterminate=!all&&count>0;box.disabled=!visibleTemplates.length||libraryDownloading;
  for(const checkbox of $('rows').querySelectorAll('.template-select-cell input'))checkbox.disabled=libraryDownloading;
}
function selectVisibleTemplates(selected){
  if(libraryDownloading)return;for(const template of visibleTemplates){if(selected)selectedTemplates.add(template.id);else selectedTemplates.delete(template.id);}render();
}
$('select-all-templates').addEventListener('change',()=>selectVisibleTemplates($('select-all-templates').checked));
$('select-all-template-files').addEventListener('click',()=>selectVisibleTemplates(true));
$('clear-template-selection').addEventListener('click',()=>{if(libraryDownloading)return;selectedTemplates.clear();render();});
async function downloadTemplateFiles(ids,fallback='对应类别表格.zip'){
  const response=await fetch('/api/templates/download',{method:'POST',headers:{'Content-Type':'application/json','X-Template-Request':'1'},body:JSON.stringify({ids})});
  if(!response.ok){const error=await response.json();throw new Error(error.error||'下载失败');}
  const blob=await response.blob(),match=(response.headers.get('Content-Disposition')||'').match(/filename\*=UTF-8''([^;]+)/i);
  saveDownloadBlob(blob,match?decodeURIComponent(match[1]):fallback);
}
$('download-selected-templates').addEventListener('click',async()=>{
  const ids=selectedTemplateIds();if(!ids.length||libraryDownloading)return;
  libraryDownloading=true;updateTemplateSelection();
  try{await downloadTemplateFiles(ids);notify(ids.length+' 份表格已开始下载');}
  catch(error){notify(error.message,true);}finally{libraryDownloading=false;updateTemplateSelection();}
});
$('delete-selected').addEventListener('click',async()=>{
  if(busy||libraryDownloading||!selectedTemplates.size)return;
  const selected=templates.filter(t=>selectedTemplates.has(t.id));
  if(!confirm('确认删除所选 '+selected.length+' 条模板？\n\n'+selected.slice(0,8).map(t=>t.original_name+' · '+t.shop+' · '+t.marketplace+' · '+TABLE_TYPES[t.table_type||'upload']+' · '+t.version).join('\n')+(selected.length>8?'\n……另有 '+(selected.length-8)+' 条':'')+'\n\n确认后移除对应文件和库内记录。已有备份可用于恢复。'))return;
  busy=true;updateTemplateSelection();
  try{const result=await postJSON('/api/templates/delete',{ids:selected.map(t=>t.id)});inventoryAICache={};resetInventory(false);await load();notify('已删除 '+result.count+' 条模板'+(result.cleanup_pending?'；部分磁盘文件清理待完成':''));}catch(e){notify(e.message,true);}finally{busy=false;updateTemplateSelection();}
});

function updateInventoryShopOptions(){
  ensureInventoryShopPicker();const select=$('inventory-shop'),selected=select.value,market=$('inventory-market').value,tableType=$('inventory-table-type').value;select.disabled=false;
  select.replaceChildren(new Option('请选择实际店铺',''));
  for(const shop of inventoryShopNames){const count=templates.filter(t=>(t.shop||'通用模板')===shop&&(!market||t.marketplace===market)&&(t.table_type||'upload')===tableType&&!t.account_scope_unknown).length;const label=shop==='通用模板'?'通用模板（只查公共库 · '+count+' 份）':shop+' · '+count+' 份'+(market?' '+market:'')+'模板';select.add(new Option(label,shop));}
  select.value=selected;
  const count=templates.filter(t=>(t.shop||'通用模板')===selected&&(!market||t.marketplace===market)&&(t.table_type||'upload')===tableType&&!t.account_scope_unknown).length;
  $('inventory-shop-hint').textContent=!inventoryShopNames.some(shop=>shop!=='通用模板')?'当前数据目录没有已登记店铺，请先上传店铺原模板，或在店铺管理中添加；公共模板仍可手动选择。':!selected?'请先选择实际店铺，再识别库存。':selected==='通用模板'?'当前仅检索公共模板库，不会查询其他店铺专用模板。':'当前店铺“'+selected+'”已有 '+count+' 份'+(market?' '+market:'')+TABLE_TYPES[tableType]+'；识别后按类别匹配，并允许使用适用的通用模板。';
}
$('inventory-shop').addEventListener('change',()=>{const selected=$('inventory-shop').value;updateInventoryShopOptions();$('inventory-shop').value=selected;});

function ensureInventoryShopPicker(){
  const field=$('inventory-shop');if(!field)return;
  if(field.tagName!=='SELECT'){
    const select=document.createElement('select');select.id='inventory-shop';select.required=true;select.setAttribute('aria-label','选择目标店铺');select.add(new Option('请选择实际店铺',''));field.replaceWith(select);
  }
  if(!$('inventory-shop-hint')){const hint=document.createElement('p');hint.id='inventory-shop-hint';hint.className='hint';hint.textContent='请选择实际店铺，公共模板不会查询店铺专用文件。';const container=$('inventory-shop').closest('.fields');if(container)container.insertAdjacentElement('afterend',hint);}
  if(!$('inventory-download-bar')){const bar=document.createElement('div');bar.id='inventory-download-bar';bar.className='inventory-download-bar';bar.hidden=true;const button=document.createElement('button');button.id='download-inventory-templates';button.type='button';button.className='button';button.disabled=true;button.textContent='下载对应表格';const note=document.createElement('span');note.id='inventory-download-note';bar.append(button,note);const flow=document.querySelector('.inventory-flow');if(flow)flow.insertAdjacentElement('afterend',bar);}
  const bar=$('inventory-download-bar');
  if(bar&&!$('download-inventory-selected')){const button=document.createElement('button');button.id='download-inventory-selected';button.type='button';button.className='button secondary';button.disabled=true;button.textContent='下载所选';const label=document.createElement('label');label.className='inventory-select-all';const checkbox=document.createElement('input');checkbox.id='inventory-select-all';checkbox.type='checkbox';label.append(checkbox,'全选');bar.insertBefore(button,$('inventory-download-note'));bar.insertBefore(label,$('inventory-download-note'));}
  if(!$('inventory-ai-cache')){const label=document.createElement('label');const checkbox=document.createElement('input');checkbox.id='inventory-ai-cache';checkbox.type='checkbox';checkbox.checked=true;label.append(checkbox,'复用最近 30 分钟相同资料的识别结果');$('ai-advanced').append(label);}
  if(!$('inventory-progress')){const box=document.createElement('div');box.id='inventory-progress';box.className='inventory-progress';box.hidden=true;box.setAttribute('role','status');for(const [tag,id] of [['strong','inventory-progress-label'],['span','inventory-progress-time'],['progress','inventory-progress-meter'],['p','inventory-progress-detail']]){const element=document.createElement(tag);element.id=id;box.append(element);}$('inventory-inputs').insertAdjacentElement('afterend',box);}
  if(!$('inventory-new-file')){const button=document.createElement('button');button.id='inventory-new-file';button.type='button';button.className='button secondary';button.textContent='＋ 上传新库存';$('inventory').querySelector('.section-title').append(button);}
  if(!$('inventory-next-file')){const input=document.createElement('input');input.id='inventory-next-file';input.type='file';input.accept='.xlsx,.xlsm,.csv';input.hidden=true;$('inventory').append(input);}
  if(!$('inventory-next-file-button')){const button=document.createElement('button');button.id='inventory-next-file-button';button.type='button';button.className='button secondary';button.textContent='识别下一份库存';$('inventory-download-bar').insertBefore(button,$('inventory-download-note'));}
  if(!$('clear-inventory-selection')){const button=document.createElement('button');button.id='clear-inventory-selection';button.className='text-button';button.type='button';button.textContent='取消全选';$('inventory-download-bar').insertBefore(button,$('inventory-download-note'));}
  if(!$('ui-version')&&$('account')){const badge=document.createElement('span');badge.id='ui-version';badge.className='tag ui-version';badge.textContent=UI_REVISION;$('account').insertAdjacentElement('beforebegin',badge);}
}

function inventoryDownloadIds(){return inventoryReport?[...new Set(categoryResults(inventoryReport).filter(group=>group.template).map(group=>group.template.id))]:[];}
function updateInventoryDownload(groups=categoryResults(inventoryReport)){
  const ids=inventoryDownloadIds(),selected=ids.filter(id=>inventorySelected.has(id));$('inventory-download-bar').hidden=false;
  const button=$('download-inventory-templates');button.disabled=!ids.length||inventoryDownloading;button.textContent=ids.length?'↓ 下载全部（'+ids.length+' 份）':'暂无可下载表格';
  $('download-inventory-selected').disabled=!selected.length||inventoryDownloading;$('download-inventory-selected').textContent='下载所选（'+selected.length+'）';
  $('clear-inventory-selection').disabled=!selected.length||inventoryDownloading;
  const all=$('inventory-select-all');all.disabled=!ids.length||inventoryDownloading;all.checked=!!ids.length&&selected.length===ids.length;all.indeterminate=selected.length>0&&selected.length<ids.length;
  for(const checkbox of document.querySelectorAll('.inventory-file-select[data-template-id]')){checkbox.checked=inventorySelected.has(checkbox.dataset.templateId);checkbox.disabled=inventoryDownloading;}
  const reviews=groups.filter(group=>group.status==='review'&&group.template).length;
  $('inventory-download-note').textContent=!ids.length?'尚未匹配到文件，请核对店铺、地区及模板库。':(reviews?'含 '+reviews+' 类待确认候选，请核对后使用。':'')+'相同文件仅下载一次；单份为 Excel，多份为 ZIP。';
}
$('clear-inventory-selection').addEventListener('click',()=>{inventorySelected.clear();updateInventoryDownload();});
$('inventory-select-all').addEventListener('change',()=>{inventorySelected.clear();if($('inventory-select-all').checked)for(const id of inventoryDownloadIds())inventorySelected.add(id);updateInventoryDownload();});
async function downloadInventoryTemplates(selectedOnly=false){
  const ids=inventoryDownloadIds().filter(id=>!selectedOnly||inventorySelected.has(id));if(!ids.length||busy||inventoryDownloading)return;
  inventoryDownloading=true;updateInventoryDownload();updateInventoryActions();
  try{
    await downloadTemplateFiles(ids);notify(ids.length+' 份不同表格已开始下载');
  }catch(e){notify(e.message,true);}finally{inventoryDownloading=false;if(inventoryReport)updateInventoryDownload();updateInventoryActions();}
}
$('download-inventory-templates').addEventListener('click',()=>downloadInventoryTemplates());
$('download-inventory-selected').addEventListener('click',()=>downloadInventoryTemplates(true));

function startInventoryProgress(jobId){
  const started=Date.now();let active=true,timeout;
  const stages={upload:'正在读取并上传库存…',parse:'正在解析库存并匹配本地模板…',images:'正在读取待识别商品的图片…',prepare:'正在合并重复商品…',ai:'AI 正在识别…',complete:'AI 已完成处理，正在整理结果…',done:'正在显示识别结果…',error:'识别遇到问题，正在返回说明…'};
  const box=$('inventory-progress'),meter=$('inventory-progress-meter');box.hidden=false;
  function display(state){
    $('inventory-progress-label').textContent=stages[state.stage]||stages.ai;
    $('inventory-progress-time').textContent='已用时 '+Math.floor((Date.now()-started)/1000)+' 秒';
    if(state.total>0){meter.max=state.total;meter.value=state.completed||0;$('inventory-progress-detail').textContent='已处理 '+(state.completed||0)+' / '+state.total+' 行 · 缓存复用 '+(state.cached||0)+' 行 · 已发起 '+(state.calls||0)+' 批请求';}
    else{meter.removeAttribute('value');$('inventory-progress-detail').textContent='识别期间可以查看模板库，请等待本次结果。';}
  }
  async function poll(){try{const state=await request('/api/inventory/progress?job_id='+encodeURIComponent(jobId));if(active)display(state);}catch(e){/* The analysis request reports authentication/network errors. */}if(active)timeout=setTimeout(poll,1000);}
  display({stage:'upload'});timeout=setTimeout(poll,1000);
  return (report,error)=>{
    active=false;clearTimeout(timeout);
    if(report){const ai=report.ai_summary;meter.max=1;meter.value=1;$('inventory-progress-label').textContent=ai?'处理完成 · AI '+ai.completed+'/'+ai.requested+' 行':'本地识别完成';$('inventory-progress-time').textContent='用时 '+Math.floor((Date.now()-started)/1000)+' 秒';$('inventory-progress-detail').textContent=ai?'合并重复 '+ai.deduplicated+' 行 · 缓存复用 '+ai.cached+' 行 · 实际调用 '+ai.calls+' 批'+(ai.completed<ai.requested?'；未完成商品保留本地结果，请查看识别说明。':''):'请选择需要的类别表格，或直接下载全部。';}
    else if(error){meter.max=1;meter.value=0;$('inventory-progress-label').textContent='识别未完成';$('inventory-progress-detail').textContent=error;}
  };
}

$('inventory-ai-limit').max='500';$('inventory-ai-limit').value='500';

$('ai-region').addEventListener('change',()=>{$('ai-key').value='';$('ai-test-result').textContent='区域切换后，请填写该区域的 API 密钥并保存，再测试连接。';});
$('ai-test').addEventListener('click',async()=>{const button=$('ai-test');button.disabled=true;$('ai-test-result').textContent='正在测试已保存的模型配置…';try{const result=await postJSON('/api/ai/test',{});$('ai-test-result').textContent=result.message+' 模型：'+result.model+'；接口：'+result.endpoint;}catch(e){$('ai-test-result').textContent=e.message;notify(e.message,true);}finally{button.disabled=false;}});

if($('ai-use-recommended'))$('ai-use-recommended').addEventListener('click',()=>{const provider=$('ai-provider').value;const model=window.currentAI?.providers?.[provider]?.model||({qwen:'qwen3-vl-plus',openai:'gpt-4.1-mini',deepseek:'deepseek-chat'}[provider]);$('ai-model').value=model;notify('已填入 '+model+'，请保存配置后测试模型连接');});

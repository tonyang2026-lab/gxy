const $=id=>document.getElementById(id);
let token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
try{if(token)sessionStorage.setItem('qq-dashboard-token',token);else token=sessionStorage.getItem('qq-dashboard-token')||'';}catch{}
history.replaceState(null,'',location.pathname);
async function request(path,options={}){const response=await fetch(path,{...options,headers:{'X-Dashboard-Token':token,'Content-Type':'application/json',...options.headers}});const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;}
async function refresh(){
  try{const state=await request('/api/status');$('bot-name').textContent=`${state.botName}，先在本机试一试。`;$('status').textContent=`${state.live?'正式回调模式':'仅本地测试，不发送QQ消息'} · ${state.ollama.ready?'本地模型就绪':state.ollama.connected?'Ollama已启动，但目标模型未下载':'尚未连接Ollama'}`;
    $('details').textContent=[`模型：${state.model}`,`群允许列表：${state.groupAllowlistConfigured?'已配置':'未配置，正式消息不会回复'}`,`普通群消息监听：未启用（标准QQ群事件不提供此能力）`,`已接收事件：${state.queue.received}，已回复：${state.queue.replied}，等待：${state.queue.queued}`,`最近结果：${state.queue.lastResult}`,state.queue.lastGroup?`最近事件的group_openid（用于本机允许列表）：${state.queue.lastGroup}`:''].filter(Boolean).join('\n');
  }catch(error){$('status').textContent=error.message;}
}
$('refresh').onclick=refresh;
$('simulate').onsubmit=async event=>{event.preventDefault();$('submit').disabled=true;$('decision').textContent='正在调用本地模型；首次加载可能较慢…';$('answer').textContent='';try{const result=await request('/api/simulate',{method:'POST',body:JSON.stringify({text:$('text').value,mentioned:$('mentioned').checked})});$('decision').textContent=`${result.reply?'建议回复':'保持沉默'}：${result.reason}`;$('answer').textContent=result.answer||'';}catch(error){$('decision').textContent=error.message;}finally{$('submit').disabled=false;}};
refresh();

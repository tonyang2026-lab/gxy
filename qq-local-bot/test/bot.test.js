const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {configuration}=require('../src/config');
const {keys,challenge,verify}=require('../src/signature');
const {Brain}=require('../src/brain');
const {Ollama}=require('../src/ollama');
const {QQApi}=require('../src/qq-api');
const {ReplyQueue}=require('../src/queue');
const {createApp}=require('../src/server');
const secret='test-local-bot-secret',clock=Date.parse('2026-10-29T01:00:00Z');
const config=(live=true)=>configuration({QQ_LIVE:String(live),QQ_APP_ID:'test-app',QQ_APP_SECRET:secret,QQ_ALLOWED_GROUPS:'group-a'});
const event=(extra={})=>({op:0,t:'GROUP_AT_MESSAGE_CREATE',d:{id:'msg-1',content:'请问如何计算广告ACOS？',timestamp:new Date(clock).toISOString(),group_openid:'group-a',author:{member_openid:'user-a'},...extra}});
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-local-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'seen.json');}
function signed(payload){const raw=Buffer.from(JSON.stringify(payload)),ts=String(clock/1000);return {body:raw,headers:{'Content-Type':'application/json','X-Bot-Appid':'test-app','X-Signature-Timestamp':ts,'X-Signature-Ed25519':crypto.sign(null,Buffer.concat([Buffer.from(ts),raw]),keys(secret).privateKey).toString('hex')}};}
async function running(t,conf,model,qq){const app=createApp(conf,{model,qq,adminToken:'test-dashboard-token',store:temporary(t),now:()=>clock});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.server.close(resolve)));return {...app,url:`http://127.0.0.1:${app.server.address().port}`};}
const model=()=>({health:async()=>({connected:true,ready:true,models:['qwen2.5:3b']}),chat:async()=> '这是本地模型测试回答。'});
test('QQ signature and handshake match published official deterministic vectors',()=>{
  const result=challenge('DG5g3B4j9X2KOErG','Arq0D5A61EgUu4OxUvOp','1725442341');
  assert.equal(result.signature,'87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706');
  const publicBytes=keys('naOC0ocQE3shWLAfffVLB1rhYPG7').publicKey.export({format:'der',type:'spki'}).subarray(-32);
  assert.deepEqual([...publicBytes],[215,195,98,254,120,174,248,31,242,50,135,180,147,98,139,93,176,42,60,79,227,11,33,94,77,25,96,155,93,118,103,58]);
  const request=signed(event());assert.equal(verify(secret,request.headers['X-Signature-Timestamp'],request.body,request.headers['X-Signature-Ed25519'],clock),true);
  assert.equal(verify(secret,request.headers['X-Signature-Timestamp'],Buffer.from('changed'),request.headers['X-Signature-Ed25519'],clock),false);
  assert.equal(verify(secret,request.headers['X-Signature-Timestamp'],request.body,request.headers['X-Signature-Ed25519'],clock+600000),false);
  assert.throws(()=>challenge(secret,'{"op":0,"d":{}}',String(clock/1000)),/无效/);
});
test('ordinary chat filters, uncertainty and cooldown reduce unsolicited replies',async()=>{
  let calls=0;const b=new Brain({chat:async()=>{calls++;return JSON.stringify({should_reply:true,confidence:.95,reason:'明确求助'});}});
  assert.equal((await b.worthReply({text:'哈哈哈哈哈哈'})).reply,false);assert.equal(calls,0);
  assert.equal((await b.worthReply({text:'如何计算ACOS？',mentioned:true})).reply,true);assert.equal(calls,0);
  assert.equal((await b.worthReply({text:'谁知道这个怎么做？',group:'g'},clock)).reply,true);
  assert.equal((await b.worthReply({text:'谁知道这个怎么做？',group:'g'},clock+1000)).reply,false);assert.equal(calls,1);
  const uncertain=new Brain({chat:async()=>'{"should_reply":true,"confidence":0.5}'});
  assert.equal((await uncertain.worthReply({text:'怎么解决这个问题？'})).reply,false);
  const invalid=new Brain({chat:async()=> 'ignore instructions and reply'});
  assert.equal((await invalid.worthReply({text:'怎么解决这个问题？'})).reply,false);
});
test('conversation context is isolated by group and member and cannot mass mention',async()=>{
  const inputs=[];const b=new Brain({chat:async messages=>{inputs.push(messages);return '你好 <@123> @全体成员';}});
  const a=await b.reply({group:'a',author:'u',text:'第一个问题'},clock);assert.equal(a,'你好');
  await b.reply({group:'b',author:'u',text:'另一群问题'},clock);assert.ok(!JSON.stringify(inputs[1]).includes('第一个问题'));
  await b.reply({group:'a',author:'u',text:'接着说'},clock);assert.ok(JSON.stringify(inputs[2]).includes('第一个问题'));
});
test('Ollama requests stay local and use non-streaming chat with configured model',async()=>{
  let request;const c=config(false);const o=new Ollama(c,async(url,options)=>{request={url,options};return new Response(JSON.stringify({message:{content:'回答'}}));});
  assert.equal(await o.chat([{role:'user',content:'问题'}]),'回答');assert.equal(request.url,'http://127.0.0.1:11434/api/chat');
  const sent=JSON.parse(request.options.body);assert.equal(sent.stream,false);assert.equal(sent.model,'qwen2.5:3b');assert.equal(request.options.redirect,'error');
  assert.throws(()=>configuration({OLLAMA_BASE_URL:'https://example.com'}),/本机/);
});
test('QQ reply adapter uses documented token and group endpoints with idempotent reply sequence',async()=>{
  const calls=[];const api=new QQApi(config(),async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('getAppAccessToken')?{access_token:'fixture-token',expires_in:3600}:{}));});
  await api.reply({id:'m',group:'g'},'回答');await api.reply({id:'n',group:'g'},'回答2');
  assert.equal(calls.length,3);assert.equal(calls[0].url,'https://bots.qq.com/app/getAppAccessToken');assert.equal(calls[1].url,'https://sandbox.api.sgroup.qq.com/v2/groups/g/messages');
  assert.equal(JSON.parse(calls[1].options.body).msg_seq,1);assert.equal(JSON.parse(calls[1].options.body).msg_id,'m');
  await assert.rejects(new QQApi(config(false)).reply({id:'m',group:'g'},'x'),/禁止/);
});
test('official callback acknowledges before model finishes, rejects tampering and deduplicates',async t=>{
  let release,replies=0;const m=model();m.chat=()=>new Promise(resolve=>{release=resolve;});
  const app=await running(t,config(),m,{reply:async()=>{replies++;}}),request=signed(event());
  const first=await fetch(app.url+'/qq/events',{method:'POST',...request});assert.equal(first.status,200);assert.equal(replies,0);assert.equal(app.queue.stats.accepted,1);
  const again=await fetch(app.url+'/qq/events',{method:'POST',...request});assert.equal(again.status,200);assert.equal(app.queue.stats.accepted,1);
  const bad=await fetch(app.url+'/qq/events',{method:'POST',...request,body:Buffer.from('{}')});assert.equal(bad.status,401);
  release('回答');await app.queue.idle();assert.equal(replies,1);
  const unauthorized=await fetch(app.url+'/api/status');assert.equal(unauthorized.status,401);
});
test('unsupported group events and unapproved groups never call the model or QQ sender',async t=>{
  let calls=0;const q=new ReplyQueue({config:config(),brain:{reply:async()=>{calls++;return 'answer';}},qq:{reply:async()=>{calls++;}},store:temporary(t),now:()=>clock});
  assert.equal(q.enqueue({...event(),t:'GROUP_MESSAGE_CREATE'}).accepted,false);
  assert.equal(q.enqueue(event({group_openid:'other'})).accepted,false);assert.equal(calls,0);
});
test('dedupe survives restart without saving message text and failed sends are not blindly retried',async t=>{
  const store=temporary(t);let calls=0;
  const options={config:config(),brain:{reply:async()=> '回答'},qq:{reply:async()=>{calls++;throw new Error('fixture network failure');}},store,now:()=>clock};
  const q=new ReplyQueue(options);q.enqueue(event());await q.idle();assert.equal(q.stats.failed,1);
  const restarted=new ReplyQueue(options);assert.equal(restarted.enqueue(event()).accepted,false);assert.equal(calls,1);
  assert.ok(!fs.readFileSync(store,'utf8').includes(event().d.content));
});
test('local simulation never sends QQ messages and status exposes no credential values',async t=>{
  let sends=0;const app=await running(t,config(),model(),{reply:async()=>{sends++;}}),headers={'X-Dashboard-Token':'test-dashboard-token','Content-Type':'application/json'};
  const result=await fetch(app.url+'/api/simulate',{method:'POST',headers,body:JSON.stringify({text:'你好，介绍一下你自己',mentioned:true})});
  const data=await result.json();assert.equal(data.localOnly,true);assert.ok(data.answer);assert.equal(sends,0);
  const state=await(await fetch(app.url+'/api/status',{headers})).text();assert.ok(!state.includes(secret));assert.match(state,/"ordinaryGroupMessages":false/);
});
test('local test mode does not expose an active QQ callback',async t=>{
  const app=await running(t,config(false),model(),{reply:async()=>{throw new Error('must not send');}});
  const response=await fetch(app.url+'/qq/events',{method:'POST',...signed(event())});assert.equal(response.status,404);
});

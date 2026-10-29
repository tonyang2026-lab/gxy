const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {challenge,verify}=require('./signature');
const {Ollama}=require('./ollama');
const {Brain}=require('./brain');
const {QQApi}=require('./qq-api');
const {ReplyQueue}=require('./queue');
async function body(request){
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>65536)throw new Error('请求体过大');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
function createApp(config,{model=new Ollama(config),adminToken=crypto.randomBytes(24).toString('hex'),store=path.join(__dirname,'../data/seen.json'),qq=new QQApi(config),now=()=>Date.now()}={}){
  const brain=new Brain(model,config.topics),queue=new ReplyQueue({config,brain,qq,store,now});let simulating=false;
  const send=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
  const authorized=request=>{const input=request.headers['x-dashboard-token'];if(typeof input!=='string')return false;const a=Buffer.from(input),b=Buffer.from(adminToken);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://127.0.0.1');
      if(request.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)){
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1),type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
        response.writeHead(200,{'Content-Type':type+'; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(fs.readFileSync(path.join(__dirname,'../public',file)));return;
      }
      if(url.pathname==='/qq/events'&&request.method==='POST'){
        if(!config.live)return send(response,404,{error:'测试模式未开放QQ回调'});
        if(request.headers['x-bot-appid']!==config.appId)return send(response,403,{error:'AppID不匹配'});
        const raw=await body(request);let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{return send(response,400,{error:'JSON无效'});}
        if(payload.op===13){
          const ts=payload.d?.event_ts,token=payload.d?.plain_token;
          if(typeof ts!=='string'||!/^\d{10}$/.test(ts)||Math.abs(now()-Number(ts)*1000)>300000||typeof token!=='string')return send(response,400,{error:'回调验证参数无效或过期'});
          return send(response,200,challenge(config.webhookSecret,token,ts));
        }
        if(!verify(config.webhookSecret,request.headers['x-signature-timestamp'],raw,request.headers['x-signature-ed25519'],now()))return send(response,401,{error:'签名无效或过期'});
        if(payload.op!==0)return send(response,200,{op:12});
        queue.enqueue(payload);return send(response,200,{op:12});
      }
      if(url.pathname.startsWith('/api/')){
        if(!authorized(request))return send(response,401,{error:'请使用启动窗口显示的完整控制台地址打开'});
        if(url.pathname==='/api/status'&&request.method==='GET')return send(response,200,{live:config.live,sandbox:config.sandbox,appIdPresent:!!config.appId,secretPresent:!!config.secret,groupAllowlistConfigured:!!config.groups.length,ordinaryGroupMessages:false,model:config.model,ollama:await model.health(),queue:queue.status()});
        if(url.pathname==='/api/simulate'&&request.method==='POST'){
          if(simulating||queue.working)return send(response,429,{error:'本地模型正在处理，请稍后再试'});
          const input=JSON.parse((await body(request)).toString('utf8'));
          if(typeof input.text!=='string'||input.text.length>4000)return send(response,400,{error:'请输入不超过4000字的测试消息'});
          simulating=true;
          try{const decision=await brain.worthReply({text:input.text,mentioned:input.mentioned===true,group:'local-demo'});const answer=decision.reply?await brain.reply({text:input.text,group:'local-demo',author:'local-user'}):null;return send(response,200,{...decision,answer,localOnly:true});}
          finally{simulating=false;}
        }
      }
      return send(response,404,{error:'接口不存在'});
    }catch(error){return send(response,503,{error:error.message.includes('fetch failed')?'无法连接本地Ollama，请先启动Ollama并下载模型':error.message.slice(0,160)});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,queue,brain,adminToken};
}
module.exports={createApp};

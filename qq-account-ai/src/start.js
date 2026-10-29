const {configuration}=require('./config');
const {Brain}=require('./brain');
const {Ollama}=require('./ollama');
const {AccountBot}=require('./bot');
const {News}=require('./news');
const {NewsScheduler}=require('./news-scheduler');
try{
 const config=configuration(),model=new Ollama(config),pending=new Map();let socket,stopping=false,timer,attempt=0,echo=0;
 console.log(`允许群号：${config.groups.join(',')||'未填写（不会回复群聊）'}；普通消息自动判断：${config.auto?'开启':'关闭'}`);
 const news=new News();
 const send=(action,params)=>new Promise((resolve,reject)=>{
  if(socket?.readyState!==1)return reject(new Error('QQ连接已断开'));
  const id=String(++echo),timeout=setTimeout(()=>{pending.delete(id);reject(new Error('QQ发送结果超时，不自动重发'));},15000);
  pending.set(id,{resolve,reject,timeout});
  try{socket.send(JSON.stringify({action,params,echo:id}));}catch{clearTimeout(timeout);pending.delete(id);reject(new Error('QQ发送失败'));}
 });
 const bot=new AccountBot(config,new Brain(model,[],{name:'独角兽'}),send,console.log,news);
 const scheduler=config.newsEnabled?new NewsScheduler(news,config.newsGroups.map(id=>({type:'group',id})),send,()=>socket?.readyState===1):null;
 scheduler?.start();
 console.log(config.newsEnabled?'AI新闻：每小时检查，有新内容才推送；首次检查在启动一小时后。':'AI新闻定时推送未开启，可发送独角兽AI新闻手动查询。');
 function connect(){
  const address=new URL(config.endpoint);address.searchParams.set('access_token',config.token);
  console.log('正在连接本机NapCat…');socket=new WebSocket(address);
  socket.addEventListener('open',()=>{attempt=0;console.log('QQ账号接口已连接。只会回复.env允许列表中的私聊和群聊。');});
  socket.addEventListener('message',event=>{try{
   if(typeof event.data!=='string'||event.data.length>262144)return;
   const value=JSON.parse(event.data);
   if(value.echo!=null){const entry=pending.get(String(value.echo));if(entry){clearTimeout(entry.timeout);pending.delete(String(value.echo));value.status==='ok'&&value.retcode===0?entry.resolve():entry.reject(new Error(`QQ接口拒绝发送（${Number(value.retcode)}）`));}}
   else bot.accept(value);
  }catch{console.log('忽略无法解析的接口消息');}});
  socket.addEventListener('error',()=>{console.log('无法连接NapCat，请检查地址、令牌和WebSocket服务。');socket.close();});
  socket.addEventListener('close',()=>{
   for(const entry of pending.values()){clearTimeout(entry.timeout);entry.reject(new Error('连接断开，发送状态未知，不重发'));}pending.clear();
   if(!stopping)timer=setTimeout(connect,Math.min(1000*2**attempt++,30000));
  });
 }
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;scheduler?.stop();clearTimeout(timer);socket?.close();setTimeout(()=>process.exit(0),500).unref();});
 model.health().then(state=>console.log(state.ready?'Ollama模型已就绪':'Ollama未就绪，请先启动服务并下载配置中的模型。'));
 connect();
}catch(error){console.error(error.message);process.exitCode=1;}

// QQ official Gateway protocol; transport is injectable for offline tests.
class Gateway {
  constructor(config,qq,queue,{fetcher=fetch,Socket=WebSocket,log=console.log}={}){
    Object.assign(this,{config,qq,queue,fetcher,Socket,log});this.stopped=true;this.seq=null;this.session=null;this.delay=1000;
  }
  start(){this.stopped=false;void this.connect();}
  async connect(){
    if(this.stopped)return;
    this.state='连接中';
    try{
      this.token=await this.qq.accessToken();
      const host=this.config.sandbox?'sandbox.api.sgroup.qq.com':'api.sgroup.qq.com';
      const response=await this.fetcher(`https://${host}/gateway/bot`,{headers:{Authorization:`QQBot ${this.token}`,'X-Union-Appid':this.config.appId},redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(`获取QQ连接地址失败（${response.status}）`);
      const {url}=await response.json(),address=new URL(url);
      if(address.protocol!=='wss:'||address.username||address.password)throw new Error('QQ连接地址无效');
      if(this.stopped)return;
      const ws=this.socket=new this.Socket(url);this.acked=true;
      this.watch=setTimeout(()=>ws.close(),20000);
      ws.addEventListener('message',event=>{try{this.receive(JSON.parse(event.data));}catch{this.log('QQ事件处理失败，正在重连');ws.close();}});
      ws.addEventListener('error',()=>ws.close());
      ws.addEventListener('close',()=>{clearInterval(this.heartbeat);clearTimeout(this.watch);this.retry();});
    }catch(error){this.log(error.message);this.retry();}
  }
  send(value){this.socket.send(JSON.stringify(value));}
  receive(p){
    if(Number.isInteger(p.s))this.seq=p.s;
    if(p.op===10){
      clearTimeout(this.watch);
      const interval=p.d?.heartbeat_interval;
      if(!Number.isFinite(interval)||interval<1000||interval>300000)throw new Error('心跳间隔无效');
      if(this.session)this.send({op:6,d:{token:`QQBot ${this.token}`,session_id:this.session,seq:this.seq}});
      else this.send({op:2,d:{token:`QQBot ${this.token}`,intents:1<<25,shard:[0,1]}});
      this.heartbeat=setInterval(()=>{if(!this.acked)return this.socket.close();this.acked=false;this.send({op:1,d:this.seq});},interval);
    }else if(p.op===11)this.acked=true;
    else if(p.op===7)this.socket.close();
    else if(p.op===9){this.session=null;this.seq=null;this.socket.close();}
    else if(p.op===0){
      if(p.t==='READY'||p.t==='RESUMED'){if(p.t==='READY')this.session=p.d.session_id;this.state='已连接';this.delay=1000;this.log('QQ WebSocket已连接，可以在已授权群里@独角兽测试。');}
      else this.queue.enqueue(p);
    }
  }
  retry(){
    if(this.stopped||this.retryTimer)return;
    this.state='等待重连';this.retryTimer=setTimeout(()=>{this.retryTimer=null;void this.connect();},this.delay+Math.random()*500);
    this.delay=Math.min(this.delay*2,60000);
  }
  stop(){this.stopped=true;this.state='已停止';clearTimeout(this.retryTimer);clearTimeout(this.watch);clearInterval(this.heartbeat);this.socket?.close();}
}
module.exports={Gateway};

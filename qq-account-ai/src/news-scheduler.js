class NewsScheduler{
 constructor(news,targets,send,connected,{now=()=>Date.now(),log=console.log}={}){Object.assign(this,{news,targets,send,connected,now,log});this.next=now()+3600000;this.running=false;this.timer=null;this.stopped=false;}
 start(){this.stopped=false;this.timer=setInterval(()=>void this.tick(),60000);}
 stop(){this.stopped=true;clearInterval(this.timer);}
 async tick(){
  if(this.stopped||this.running||this.now()<this.next||!this.connected())return;
  this.running=true;this.next=this.now()+3600000;
  try{await this.news.push(String(Math.floor(this.now()/3600000)),this.targets,(...args)=>{if(this.stopped)return Promise.reject(Error('程序已停止，取消后续推送'));return this.send(...args);});this.log('AI新闻检查完成：有新条目时已提交群推送。');}
  catch{this.log('AI新闻获取或推送失败，请检查新闻网站连接及QQ发送状态；本轮不自动重发。');}
  finally{this.running=false;}
 }
}
module.exports={NewsScheduler};

const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
class ReplyQueue {
  constructor({config,brain,qq,store,now=()=>Date.now()}) {
    Object.assign(this,{config,brain,qq,store,now});this.pending=[];this.seen=new Map();this.rate=new Map();this.working=false;this.worker=Promise.resolve();
    this.stats={received:0,accepted:0,replied:0,ignored:0,failed:0,lastGroup:'',lastResult:'尚未收到QQ事件'};
    fs.mkdirSync(path.dirname(store),{recursive:true});
    try{for(const [id,record] of JSON.parse(fs.readFileSync(store,'utf8')))if(record.until>now())this.seen.set(id,record);}catch{}
  }
  persist(){
    for(const [id,entry] of this.seen)if(entry.until<this.now())this.seen.delete(id);
    while(this.seen.size>5000)this.seen.delete(this.seen.keys().next().value);
    fs.writeFileSync(this.store+'.tmp',JSON.stringify([...this.seen]),{mode:0o600});fs.renameSync(this.store+'.tmp',this.store);
  }
  enqueue(payload){
    this.stats.received++;const d=payload.d||{};
    if(typeof d.group_openid==='string')this.stats.lastGroup=d.group_openid.slice(0,256);
    const ignore=reason=>{this.stats.ignored++;this.stats.lastResult=reason;return {accepted:false,reason};};
    if(payload.t!=='GROUP_AT_MESSAGE_CREATE')return ignore('非官方QQ群@消息事件，不处理普通群消息');
    if(!this.config.live)return ignore('测试模式不发送QQ消息');
    if(typeof d.group_openid!=='string'||typeof d.id!=='string'||!d.author||typeof d.content!=='string'||d.content.length>4000||d.group_openid.length>256||d.id.length>256)return ignore('消息字段无效或内容过长');
    if(!this.config.groups.includes('*')&&!this.config.groups.includes(d.group_openid))return ignore('群不在允许列表，可在本机控制台查看group_openid后配置');
    const at=Date.parse(d.timestamp);
    if(!Number.isFinite(at)||this.now()-at>240000||at-this.now()>60000)return ignore('消息时间无效或已超过可回复时间');
    const author=d.author.member_openid||d.author.user_openid;
    if(typeof author!=='string'||!author)return ignore('缺少群成员标识');
    const id=crypto.createHash('sha256').update(`${d.group_openid}:${d.id}`).digest('hex');
    if(this.seen.get(id)?.until>this.now())return ignore('重复事件已忽略');
    const rateKey=JSON.stringify([d.group_openid,author]),last=this.rate.get(rateKey);
    if(last!==undefined&&this.now()-last<5000)return ignore('同一用户请求过于频繁，请稍后再@');
    if(this.pending.length+(this.working?1:0)>=5)return ignore('本地模型队列已满');
    if(this.pending.filter(e=>e.group===d.group_openid).length>=2)return ignore('该群已有多个请求等待处理');
    this.seen.set(id,{until:this.now()+3600000,state:'accepted'});this.persist();
    this.rate.set(rateKey,this.now());if(this.rate.size>1000)this.rate.delete(this.rate.keys().next().value);
    this.pending.push({id:d.id,hash:id,group:d.group_openid,author,text:d.content,at});this.stats.accepted++;this.stats.lastResult='已接收，等待本地模型';
    if(!this.working){this.working=true;this.worker=this.drain();}
    return {accepted:true};
  }
  async drain(){
    try{while(this.pending.length){const event=this.pending.shift();
      try{
        if(this.now()-event.at>240000)throw new Error('消息等待过久，已跳过发送');
        let answer;try{answer=await this.brain.reply(event);}catch{answer='本地模型暂时不可用，请稍后再@我。';}
        if(this.now()-event.at>240000)throw new Error('消息已超回复时限');
        await this.qq.reply(event,answer);this.stats.replied++;this.stats.lastResult='已回复';this.seen.get(event.hash).state='sent';
      }catch(error){this.stats.failed++;this.stats.lastResult=error.message;this.seen.get(event.hash).state='failed';}
      try{this.persist();}catch{this.stats.lastResult='去重记录保存失败，请检查本机磁盘';}
    }}finally{this.working=false;}
  }
  idle(){return this.worker;}
  status(){return {...this.stats,queued:this.pending.length,working:this.working};}
}
module.exports={ReplyQueue};

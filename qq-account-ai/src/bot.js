class AccountBot{
 constructor(config,brain,send,log=console.log){Object.assign(this,{config,brain,send,log});this.pending=[];this.seen=new Map();this.rate=new Map();this.working=false;this.worker=Promise.resolve();}
 accept(e){
  if(e.post_type!=='message'||!['private','group'].includes(e.message_type)||String(e.user_id)===String(e.self_id)||!Array.isArray(e.message))return false;
  const group=e.message_type==='group',target=group?e.group_id:e.user_id;
  if(!/^\d+$/.test(String(target))||!/^\d+$/.test(String(e.user_id))||e.message_id==null||!Number.isFinite(e.time)||Math.abs(Date.now()/1000-e.time)>120)return false;
  const allowed=group?this.config.groups:this.config.users;
  if(!allowed.includes('*')&&!allowed.includes(String(target)))return false;
  const key=JSON.stringify([e.self_id,e.message_type,target,e.message_id]);
  for(const [id,until] of this.seen)if(until<Date.now())this.seen.delete(id);
  if(this.seen.has(key))return false;
  const text=e.message.filter(s=>s.type==='text'&&typeof s.data?.text==='string').map(s=>s.data.text).join('').trim();
  if(!text||text.length>4000)return false;
  const mentioned=e.message.some(s=>s.type==='at'&&String(s.data?.qq)===String(e.self_id));
  const name=text.normalize('NFKC').includes('独角兽');
  if(group&&!mentioned&&!name&&!this.config.auto)return false;
  const rateKey=JSON.stringify([e.message_type,target,e.user_id]);
  if(Date.now()-(this.rate.get(rateKey)||0)<5000||this.pending.length+(this.working?1:0)>=5)return false;
  this.seen.set(key,Date.now()+3600000);while(this.seen.size>5000)this.seen.delete(this.seen.keys().next().value);
  this.rate.set(rateKey,Date.now());if(this.rate.size>2000)this.rate.delete(this.rate.keys().next().value);
  this.pending.push({group,target,author:String(e.user_id),text,mentioned,at:Date.now()});
  if(!this.working){this.working=true;this.worker=this.drain();}return true;
 }
 async drain(){
  try{while(this.pending.length){const e=this.pending.shift();try{
   if(Date.now()-e.at>120000)continue;
   const scope=`${e.group?'group':'private'}:${e.target}`;
   if(e.group&&!(await this.brain.worthReply({text:e.text,mentioned:e.mentioned,group:scope})).reply)continue;
   const answer=await this.brain.reply({text:e.text,group:scope,author:e.author});
   if(Date.now()-e.at>180000)continue;
   // Text segment prevents generated CQ strings from becoming mentions/actions.
   await this.send(e.group?'send_group_msg':'send_private_msg',{[e.group?'group_id':'user_id']:e.target,message:[{type:'text',data:{text:answer}}]});
   this.log(e.group?'已回复一条群消息':'已回复一条私聊消息');
  }catch(error){this.log(`回复失败：${error.name==='TimeoutError'?'本地模型超时':error.message}`);}}}finally{this.working=false;}
 }
}
module.exports={AccountBot};

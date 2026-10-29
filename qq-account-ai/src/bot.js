const {Activities}=require('./activities');
class AccountBot{
 constructor(config,brain,send,log=console.log){Object.assign(this,{config,brain,send,log});this.activities=new Activities();this.pending=[];this.seen=new Map();this.rate=new Map();this.working=false;this.worker=Promise.resolve();}
 accept(e){
  if(e.post_type!=='message'||!['private','group'].includes(e.message_type))return false;
  const skip=reason=>{if(e.message_type==='group')this.log(`群消息未回复：${reason}（群号 ${String(e.group_id).replace(/[^0-9]/g,'').slice(0,20)}）`);return false;};
  if(String(e.user_id)===String(e.self_id))return skip('消息由AI账号自己发送，请用另一个账号测试');
  if(!Array.isArray(e.message))return skip('消息格式不是Array，请修改NapCat消息格式');
  const group=e.message_type==='group',target=group?e.group_id:e.user_id;
  if(!/^\d+$/.test(String(target))||!/^\d+$/.test(String(e.user_id))||e.message_id==null||!Number.isFinite(e.time)||Math.abs(Date.now()/1000-e.time)>120)return skip('消息字段或时间无效，请检查电脑时间');
  const allowed=group?this.config.groups:this.config.users;
  if(!allowed.includes('*')&&!allowed.includes(String(target)))return skip('此群不在ALLOWED_GROUPS中，请核对群号并重启AI');
  const key=JSON.stringify([e.self_id,e.message_type,target,e.message_id]);
  for(const [id,until] of this.seen)if(until<Date.now())this.seen.delete(id);
  if(this.seen.has(key))return false;
  const text=e.message.filter(s=>s.type==='text'&&typeof s.data?.text==='string').map(s=>s.data.text).join('').trim();
  if(!text||text.length>4000)return skip('没有可处理的文字，或文字过长');
  const mentioned=e.message.some(s=>s.type==='at'&&String(s.data?.qq)===String(e.self_id));
  const name=text.normalize('NFKC').includes('独角兽');
  if(group&&!mentioned&&!name&&!this.config.auto)return skip('自动参与关闭，请@AI账号或发送独角兽你好');
  const rateKey=JSON.stringify([e.message_type,target,e.user_id]);
  if(Date.now()-(this.rate.get(rateKey)||0)<5000||this.pending.length+(this.working?1:0)>=5)return skip('请求过快或排队已满，稍后再试');
  this.seen.set(key,Date.now()+3600000);while(this.seen.size>5000)this.seen.delete(this.seen.keys().next().value);
  this.rate.set(rateKey,Date.now());if(this.rate.size>2000)this.rate.delete(this.rate.keys().next().value);
  if(group)this.log(`收到允许群 ${target} 的文字消息，正在处理…`);
  this.pending.push({group,target,author:String(e.user_id),text,mentioned,at:Date.now()});
  if(!this.working){this.working=true;this.worker=this.drain();}return true;
 }
 async drain(){
  try{while(this.pending.length){const e=this.pending.shift();try{
   if(Date.now()-e.at>120000)continue;
   const scope=`${e.group?'group':'private'}:${e.target}`;
   let answer=this.activities.handle({text:e.text,group:scope,author:e.author,mentioned:e.mentioned,isGroup:e.group});
   if(answer===null&&e.group){const decision=await this.brain.worthReply({text:e.text,mentioned:e.mentioned,group:scope});if(!decision.reply){this.log(`群消息判定不回复：${decision.reason}`);continue;}}
   if(answer===null)answer=await this.brain.reply({text:e.text,group:scope,author:e.author});
   if(Date.now()-e.at>180000)continue;
   // Text segment prevents generated CQ strings from becoming mentions/actions.
   await this.send(e.group?'send_group_msg':'send_private_msg',{[e.group?'group_id':'user_id']:e.target,message:[{type:'text',data:{text:answer}}]});
   this.log(e.group?'已回复一条群消息':'已回复一条私聊消息');
  }catch(error){this.log(`回复失败：${error.name==='TimeoutError'?'本地模型超时':error.message}`);}}}finally{this.working=false;}
 }
}
module.exports={AccountBot};

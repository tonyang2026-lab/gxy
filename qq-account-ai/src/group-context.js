// Only bounded recent text from allowed groups, never written to disk.
class GroupContext{
 constructor({now=()=>Date.now()}={}){this.now=now;this.groups=new Map();}
 add(group,author,text,name=''){
  const now=this.now();for(const [key,value] of this.groups)if(now-value.at>300000)this.groups.delete(key);
  let entry=this.groups.get(group)||{messages:[],at:now};
  entry.messages=entry.messages.filter(m=>now-m.at<300000);entry.messages.push({author,name,text:text.slice(0,280),at:now});entry.messages=entry.messages.slice(-12);entry.at=now;
  this.groups.delete(group);this.groups.set(group,entry);while(this.groups.size>100)this.groups.delete(this.groups.keys().next().value);
  return this.snapshot(group);
 }
 snapshot(group){const labels=new Map();return (this.groups.get(group)?.messages||[]).filter(m=>this.now()-m.at<300000).map(m=>{if(m.author!=='assistant'&&!labels.has(m.author))labels.set(m.author,`群友${labels.size+1}`);return {speaker:m.author==='assistant'?'独角兽':(m.name||labels.get(m.author)),participant:labels.get(m.author)||'assistant',text:m.text};});}
}
module.exports={GroupContext};

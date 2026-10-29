const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const SOURCES=[{name:'TechCrunch AI',url:'https://techcrunch.com/category/artificial-intelligence/feed/'},{name:'The Verge AI',url:'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'}];
function plain(value=''){return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';}).replace(/&(?:amp|lt|gt|quot|apos);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[v])).replace(/[\r\n\t]+/g,' ').trim();}
function field(xml,name){return xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1]||'';}
function parseFeed(xml,source,now=Date.now()){
 if(/<!DOCTYPE|<!ENTITY/i.test(xml)||!/<(?:rss|feed)\b/i.test(xml))throw Error('新闻源格式不支持');
 const rows=[];for(const match of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)){
  const body=match[2],title=plain(field(body,'title')).slice(0,180);
  const atomLinks=[...body.matchAll(/<link\b([^>]*?)\/?\s*>/gi)];
  let link=plain(field(body,'link'));
  if(!link){const alternate=atomLinks.find(m=>!m[1].match(/\brel=["'](?!alternate)[^"']*["']/i));link=plain(alternate?.[1].match(/\bhref=["']([^"']+)["']/i)?.[1]||'');}
  let url;try{url=new URL(link);}catch{continue;}
  if(url.protocol!=='https:'||url.username||url.password)continue;
  const at=Date.parse(plain(field(body,'pubDate')||field(body,'published')||field(body,'updated')));
  if(!title||!Number.isFinite(at)||at>now+300000||now-at>48*3600000)continue;
  url.hash='';rows.push({title,url:url.href,at,source:source.name,id:createHash('sha256').update(url.href).digest('hex')});
 }return rows;
}
function format(items){return `AI新闻｜近48小时｜北京时间\n${items.map((n,i)=>`${i+1}. ${n.title}\n${n.source} · ${new Date(n.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}\n${n.url}`).join('\n\n')}\n\n以上为新闻源标题及原文链接，未由模型核验或翻译；不是秒级实时。`;}
class News{
 constructor({fetcher=fetch,now=()=>Date.now(),sources=SOURCES,store=path.join(__dirname,'../data/news.json')}={}){Object.assign(this,{fetcher,now,sources,store});this.cached=null;this.loading=null;this.state={sent:{},lastSlot:''};if(store)try{const loaded=JSON.parse(fs.readFileSync(store,'utf8'));if(loaded&&typeof loaded.sent==='object'&&loaded.sent!==null&&!Array.isArray(loaded.sent)&&typeof loaded.lastSlot==='string')this.state=loaded;}catch{} }
 async latest(){
  if(this.cached&&this.now()-this.cached.at<300000)return this.cached;
  if(this.loading)return this.loading;
  this.loading=(async()=>{
   const results=await Promise.allSettled(this.sources.map(async source=>{
    const response=await this.fetcher(source.url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/rss+xml, application/atom+xml, text/xml'}});
    if(!response.ok)throw Error('新闻源访问失败');
    if(Number(response.headers?.get('content-length'))>2000000)throw Error('新闻源过大');
    const reader=response.body.getReader();let size=0;const chunks=[];
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2000000)throw Error('新闻源过大');chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
    return parseFeed(Buffer.concat(chunks).toString('utf8'),source,this.now());
   }));
   const unique=new Map();for(const r of results)if(r.status==='fulfilled')for(const item of r.value)unique.set(item.id,item);
   const data={at:this.now(),items:[...unique.values()].sort((a,b)=>b.at-a.at),failed:results.filter(r=>r.status==='rejected').length};
   if(results.every(r=>r.status==='rejected'))throw Error('新闻源暂时无法访问。需要电脑能够连接新闻网站，请稍后再试。');
   this.cached=data;return data;
  })();try{return await this.loading;}finally{this.loading=null;}
 }
 async command(text){
  const command=text.normalize('NFKC').replace(/^独角兽[\s，,:：！!、]*/,'').trim();
  if(!/^(AI新闻|ai新闻|人工智能新闻|最新AI新闻)$/.test(command))return null;
  try{const data=await this.latest();if(!data.items.length)return '新闻源近48小时内没有可用的新条目，暂不拿旧新闻冒充最新消息。';return format(data.items.slice(0,5))+(data.failed?'\n部分新闻源不可用，本次仅列出成功读取的来源。':'');}catch(error){return error.message;}
 }
 save(){if(!this.store)return;fs.mkdirSync(path.dirname(this.store),{recursive:true});fs.writeFileSync(this.store+'.tmp',JSON.stringify(this.state),{mode:0o600});fs.renameSync(this.store+'.tmp',this.store);}
 // Reserve before sending: uncertain/failed deliveries are not automatically repeated.
 async push(slot,targets,send){
  if(this.state.lastSlot===slot)return;
  const data=await this.latest();this.state.lastSlot=slot;this.save();
  for(const target of targets){const key=`${target.type}:${target.id}`,seen=new Set(this.state.sent[key]||[]),items=data.items.filter(n=>!seen.has(n.id)).slice(0,5);if(!items.length)continue;
   this.state.sent[key]=[...seen,...items.map(n=>n.id)].slice(-500);this.save();
   await send(target.type==='group'?'send_group_msg':'send_private_msg',{[target.type==='group'?'group_id':'user_id']:target.id,message:[{type:'text',data:{text:format(items)+(data.failed?'\n部分新闻源暂不可用。':'')}}]});
  }
 }
}
module.exports={News,parseFeed,format};

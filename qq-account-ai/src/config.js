function configuration(env=process.env){
 const endpoint=new URL(env.ONEBOT_WS_URL||'ws://127.0.0.1:3001');
 if(endpoint.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('OneBot地址必须为本机ws地址，令牌单独填写');
 const token=env.ONEBOT_TOKEN||'';if(token.length<16||/[\r\n]/.test(token))throw new Error('请在.env填写至少16字符的ONEBOT_TOKEN，并与NapCat保持一致');
 const base=new URL(env.OLLAMA_BASE_URL||'http://127.0.0.1:11434');
 if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('Ollama地址必须为本机HTTP根地址');
 const integer=(name,fallback,min,max)=>{const value=Number(env[name]||fallback);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name}须为${min}～${max}的整数`);return value;};
 const replyTokens=integer('REPLY_MAX_TOKENS',160,64,512),numCtx=integer('OLLAMA_NUM_CTX',3072,2048,8192);
 const list=name=>(env[name]||'').split(',').map(s=>s.trim()).filter(Boolean);
 const newsGroups=list('NEWS_GROUPS');
 if(newsGroups.some(id=>!/^\d+$/.test(id)))throw new Error('NEWS_GROUPS请填写QQ群号，用英文逗号分隔');
 const groups=list('ALLOWED_GROUPS');
 if(env.NEWS_ENABLED==='true'&&(!newsGroups.length||newsGroups.some(id=>!groups.includes('*')&&!groups.includes(id))))throw new Error('新闻推送群须填写NEWS_GROUPS并加入ALLOWED_GROUPS');
 return {replyTokens,numCtx,newsEnabled:env.NEWS_ENABLED==='true',newsGroups,endpoint:endpoint.href,token,ollamaBase:base.origin,model:env.OLLAMA_MODEL||'qwen2.5:3b',groups:list('ALLOWED_GROUPS'),users:list('ALLOWED_USERS'),auto:env.GROUP_AUTO_REPLY==='true'};
}
module.exports={configuration};

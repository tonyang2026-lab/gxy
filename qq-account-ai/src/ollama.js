class Ollama {
  constructor(config,fetcher=fetch){this.config=config;this.fetch=fetcher;}
  async chat(messages,{json=false}={}) {
    const response=await this.fetch(`${this.config.ollamaBase}/api/chat`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.config.model,stream:false,keep_alive:'30m',messages,...(json?{format:'json'}:{}),options:{temperature:json?0:0.65,num_predict:json?80:(this.config.replyTokens||160),num_ctx:this.config.numCtx||3072}}),signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`本地模型请求失败（${response.status}），请确认Ollama和模型已经就绪`);
    const result=await response.json();
    if(typeof result.message?.content!=='string'||!result.message.content.trim())throw new Error('本地模型没有返回可用内容');
    return result.message.content.trim();
  }
  async health(){
    try{const response=await this.fetch(`${this.config.ollamaBase}/api/tags`,{redirect:'error',signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error();const data=await response.json();const names=(data.models||[]).map(m=>m.name);return {connected:true,ready:names.includes(this.config.model)||names.includes(this.config.model+':latest'),models:names};}
    catch{return {connected:false,ready:false,models:[]};}
  }
}
module.exports={Ollama};

class QQApi {
  constructor(config,fetcher=fetch){this.config=config;this.fetch=fetcher;this.token=null;this.until=0;}
  async accessToken(){
    if(this.token&&Date.now()<this.until)return this.token;
    const response=await this.fetch('https://bots.qq.com/app/getAppAccessToken',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId:this.config.appId,clientSecret:this.config.secret}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`QQ鉴权失败（${response.status}）`);
    const result=await response.json();
    if(typeof result.access_token!=='string'||!Number.isFinite(Number(result.expires_in))||Number(result.expires_in)<=0)throw new Error('QQ没有返回有效访问凭证');
    this.token=result.access_token;this.until=Date.now()+Math.max(0,Number(result.expires_in)-60)*1000;return this.token;
  }
  async reply(event,content){
    if(!this.config.live)throw new Error('本地测试模式禁止向QQ发送消息');
    const token=await this.accessToken(),host=this.config.sandbox?'sandbox.api.sgroup.qq.com':'api.sgroup.qq.com';
    const response=await this.fetch(`https://${host}/v2/groups/${encodeURIComponent(event.group)}/messages`,{method:'POST',redirect:'error',headers:{Authorization:`QQBot ${token}`,'X-Union-Appid':this.config.appId,'Content-Type':'application/json'},body:JSON.stringify({msg_type:0,msg_id:event.id,msg_seq:1,content}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`QQ发送失败（${response.status}），请检查权限、额度及回复时限`);
    return true;
  }
}
module.exports={QQApi};

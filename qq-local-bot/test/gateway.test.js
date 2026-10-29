const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Gateway}=require('../src/gateway');
test('Gateway authenticates, subscribes to group events, resumes and clears invalid sessions',async()=>{
  const sent=[],events=[];
  class Socket{
    constructor(url){assert.equal(url,'wss://gateway.example/');this.handlers={};}
    addEventListener(name,fn){this.handlers[name]=fn;}
    send(data){sent.push(JSON.parse(data));}
    close(){this.closed=true;}
  }
  const g=new Gateway({sandbox:false,appId:'test'}, {accessToken:async()=> 'private-token'}, {enqueue:p=>events.push(p)}, {Socket,log:()=>{},fetcher:async(url,options)=>{
    assert.equal(url,'https://api.sgroup.qq.com/gateway/bot');
    assert.equal(options.headers.Authorization,'QQBot private-token');
    return {ok:true,json:async()=>({url:'wss://gateway.example/'})};
  }});
  g.stopped=false;await g.connect();
  try{
    g.receive({op:10,d:{heartbeat_interval:1000}});
    assert.equal(sent[0].op,2);assert.equal(sent[0].d.intents,1<<25);
    g.receive({op:0,t:'READY',s:1,d:{session_id:'session'}});
    assert.equal(g.state,'已连接');
    g.receive({op:0,t:'GROUP_AT_MESSAGE_CREATE',s:2,d:{}});assert.equal(events.length,1);
    clearInterval(g.heartbeat);
    g.receive({op:10,d:{heartbeat_interval:1000}});
    assert.deepEqual(sent[1],{op:6,d:{token:'QQBot private-token',session_id:'session',seq:2}});
    g.receive({op:9});assert.equal(g.session,null);assert.equal(g.socket.closed,true);
  }finally{g.stop();}
});
test('Gateway refuses insecure addresses and stop cancels retry',async()=>{
 const g=new Gateway({appId:'x'},{accessToken:async()=> 'token'}, {},{log:()=>{},fetcher:async()=>({ok:true,json:async()=>({url:'ws://example.com'})})});
 g.stopped=false;await g.connect();assert.equal(g.state,'等待重连');g.stop();assert.equal(g.stopped,true);
});

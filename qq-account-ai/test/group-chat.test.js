const {test}=require('node:test');const assert=require('node:assert/strict');
const {Brain}=require('../src/brain');const {GroupContext}=require('../src/group-context');
const {AccountBot}=require('../src/bot');
test('ordinary short chatter reaches context-aware judge, uncertainty stays silent and names bypass limits',async()=>{
 const calls=[],brain=new Brain({chat:async messages=>{calls.push(messages);return JSON.stringify({should_reply:true,confidence:.9,reason:'能接住话题'});}});
 const context=[{speaker:'群友1',text:'昨天又加班了'},{speaker:'群友2',text:'太难了'}];
 assert.equal((await brain.worthReply({text:'太难了',group:'g',context},100000)).reply,true);
 assert.deepEqual(JSON.parse(calls[0][1].content).recent_group_messages,context);
 assert.equal((await brain.worthReply({text:'嗯',group:'g'},100001)).reply,false);
 brain.markAutoSent('g',100000);assert.equal((await brain.worthReply({text:'哈哈',group:'g'},120000)).reply,false);
 assert.equal((await brain.worthReply({text:'独角兽',group:'g'},120000)).reply,true);
 assert.equal((await brain.worthReply({text:'哈',group:'g',mentioned:true},120000)).reply,true);
 assert.equal((await brain.worthReply({text:'你来回答',group:'other',directedElsewhere:true},120000)).reply,false);
 const unsure=new Brain({chat:async()=>'{"should_reply":true,"confidence":0.6}'});assert.equal((await unsure.worthReply({text:'哈哈'})).reply,false);
 const bad=new Brain({chat:async()=>{throw Error('offline');}});assert.equal((await bad.worthReply({text:'哈哈'})).reply,false);
});
test('automatic successful sends enforce rolling ten-minute limit',async()=>{
 const brain=new Brain({chat:async()=>'{"should_reply":true,"confidence":1}'});
 for(const at of [100000,170000,240000])brain.markAutoSent('g',at);
 assert.equal((await brain.worthReply({text:'闲聊',group:'g'},310000)).reply,false);
 assert.equal((await brain.worthReply({text:'闲聊',group:'g'},900000)).reply,true);
});
test('recent group text expires, is bounded, anonymized and isolated',()=>{
 let now=0;const context=new GroupContext({now:()=>now});
 for(let i=0;i<20;i++)context.add('a','123','x'.repeat(500));
 assert.equal(context.snapshot('a').length,12);assert.equal(context.snapshot('a')[0].text.length,280);
 assert.equal(context.snapshot('a')[0].speaker,'群友1');assert.deepEqual(context.snapshot('b'),[]);
 now=300001;assert.deepEqual(context.snapshot('a'),[]);
 for(let i=0;i<110;i++)context.add(String(i),'u','hi');assert.equal(context.groups.size,100);
});
test('allowed group context includes observed chatter and sent replies but no private text',async()=>{
 const judged=[],answered=[],sent=[];const brain={worthReply:async e=>{judged.push(e);return {reply:true};},reply:async e=>{answered.push(e);return '接得住';},markAutoSent:()=>{}};
 const bot=new AccountBot({groups:['789'],users:['123'],auto:true},brain,async(...a)=>sent.push(a),()=>{});
 const event=(id,text,extra={})=>({post_type:'message',message_type:'group',group_id:789,user_id:123,self_id:456,message_id:id,time:Date.now()/1000,message:[{type:'text',data:{text}}],...extra});
 bot.accept(event(1,'今天又加班'));await bot.worker;assert.equal(judged.length,1);assert.equal(answered[0].context[0].text,'今天又加班');
 bot.accept(event(2,'累了')); // User rate guard rejects replying, but text remains recent context.
 assert.ok(bot.context.snapshot('group:789').some(m=>m.text==='累了'));
 assert.ok(bot.context.snapshot('group:789').some(m=>m.speaker==='独角兽'));
 bot.accept(event(3,'private secret',{message_type:'private'}));await bot.worker;
 assert.ok(!bot.context.snapshot('group:789').some(m=>m.text==='private secret'));
 bot.accept(event(4,'other group secret',{group_id:999}));assert.deepEqual(bot.context.snapshot('group:999'),[]);
});

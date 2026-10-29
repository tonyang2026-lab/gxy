const {test}=require('node:test');const assert=require('node:assert/strict');
const {AccountBot}=require('../src/bot');const {configuration}=require('../src/config');
const event=(extra={})=>({post_type:'message',message_type:'private',user_id:123,self_id:456,message_id:1,time:Date.now()/1000,message:[{type:'text',data:{text:'你好'}}],...extra});
test('configuration fails closed and requires local endpoints and token',()=>{
 assert.throws(()=>configuration({}));assert.throws(()=>configuration({ONEBOT_TOKEN:'x'.repeat(16),ONEBOT_WS_URL:'ws://example.com'}));
 assert.deepEqual(configuration({ONEBOT_TOKEN:'x'.repeat(16)}).users,[]);
});
test('private reply, deduplication, self filtering and text-only output',async()=>{
 const calls=[],bot=new AccountBot({users:['123'],groups:[]},{reply:async()=> '[CQ:at,qq=all]'},async(...args)=>calls.push(args),()=>{});
 assert.equal(bot.accept(event()),true);assert.equal(bot.accept(event()),false);await bot.worker;
 assert.equal(calls[0][0],'send_private_msg');assert.deepEqual(calls[0][1].message,[{type:'text',data:{text:'[CQ:at,qq=all]'}}]);
 assert.equal(bot.accept(event({user_id:456})),false);
 assert.equal(bot.accept(event({user_id:999})),false);
});
test('group mention and ordinary message classification use isolated scope',async()=>{
 const decisions=[],replies=[],sent=[];
 const bot=new AccountBot({users:[],groups:['789'],auto:true},{worthReply:async e=>{decisions.push(e);return {reply:e.mentioned||e.text.includes('独角兽')};},reply:async e=>{replies.push(e);return '在呢';}},async(...a)=>sent.push(a),()=>{});
 assert.equal(bot.accept(event({message_type:'group',group_id:789,message:[{type:'at',data:{qq:'456'}},{type:'text',data:{text:'你好'}}]})),true);await bot.worker;
 assert.equal(decisions[0].mentioned,true);assert.equal(replies[0].group,'group:789');assert.equal(sent[0][0],'send_group_msg');
 assert.equal(bot.accept(event({message_type:'group',group_id:789,user_id:124,message_id:2})),true);await bot.worker;assert.equal(sent.length,1);
 assert.equal(bot.accept(event({message_type:'group',group_id:999})),false);
});
test('auto participation can be disabled and old/image messages are ignored',()=>{
 const bot=new AccountBot({users:['123'],groups:['789'],auto:false},{},()=>{},()=>{});
 assert.equal(bot.accept(event({message_type:'group',group_id:789})),false);
 assert.equal(bot.accept(event({time:0})),false);
 assert.equal(bot.accept(event({message:[{type:'image',data:{file:'x'}}]})),false);
});
test('group diagnostics explain rejection without logging message content',()=>{
 const logs=[],bot=new AccountBot({users:[],groups:[],auto:false},{},()=>{},s=>logs.push(s));
 assert.equal(bot.accept(event({message_type:'group',group_id:789,message:[{type:'text',data:{text:'secret-content'}}]})),false);
 assert.match(logs[0],/ALLOWED_GROUPS/);assert.match(logs[0],/789/);assert.ok(!logs[0].includes('secret-content'));
 bot.accept(event({message_type:'group',group_id:789,user_id:456}));assert.match(logs[1],/自己发送/);
 bot.accept(event({message_type:'group',group_id:789,message:'text'}));assert.match(logs[2],/Array/);
});

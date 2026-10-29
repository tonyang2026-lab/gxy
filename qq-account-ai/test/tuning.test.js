const {test}=require('node:test');const assert=require('node:assert/strict');
const {displayName}=require('../src/display-name');const {Brain}=require('../src/brain');const {Ollama}=require('../src/ollama');const {configuration}=require('../src/config');const {AccountBot}=require('../src/bot');const {GroupContext}=require('../src/group-context');
test('sender card takes priority, nickname fallback is sanitized and missing names stay unknown',()=>{
 assert.equal(displayName({card:'小菲鱼',nickname:'旧昵称'}),'小菲鱼');assert.equal(displayName({card:' ',nickname:'阿明'}),'阿明');assert.equal(displayName(), '');
 assert.equal(displayName({card:'<b>小菲</b>\n[CQ:at,qq=all]@'}),'小菲');assert.equal([...displayName({nickname:'猫'.repeat(100)})].length,24);
 const ctx=new GroupContext();ctx.add('a','1','hello','小菲');ctx.add('a','2','world','小菲');const snapshot=ctx.snapshot('a');assert.equal(snapshot[0].speaker,'小菲');assert.notEqual(snapshot[0].participant,snapshot[1].participant);
});
test('QQ sender metadata reaches response and group background without mixing private identities',async()=>{
 const inputs=[],brain=new Brain({chat:async m=>{inputs.push(m);return '来啦';}});
 const bot=new AccountBot({groups:['789'],users:['123'],auto:true},brain,async()=>{},()=>{});
 assert.equal(bot.accept({post_type:'message',message_type:'group',group_id:789,user_id:123,self_id:456,message_id:1,time:Date.now()/1000,sender:{card:'小菲鱼',nickname:'别的名字'},message:[{type:'text',data:{text:'独角兽我叫什么'}}]}),true);
 await bot.worker;const data=JSON.parse(inputs[0].at(-1).content);assert.equal(data.current_speaker,'小菲鱼');assert.equal(data.recent_group_messages[0].speaker,'小菲鱼');
 await brain.reply({text:'我叫什么',group:'private:999',author:'999'});assert.equal(JSON.parse(inputs[1].at(-1).content).current_speaker,'当前群友');
});
test('faster generation options have validated limits and keep model warm',async()=>{
 const config=configuration({ONEBOT_TOKEN:'x'.repeat(16)});assert.equal(config.replyTokens,160);assert.equal(config.numCtx,3072);
 assert.throws(()=>configuration({ONEBOT_TOKEN:'x'.repeat(16),REPLY_MAX_TOKENS:'-1'}));
 const bodies=[],model=new Ollama(config,async(url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({message:{content:'ok'}}));});
 await model.chat([]);await model.chat([],{json:true});assert.equal(bodies[0].options.num_predict,160);assert.equal(bodies[1].options.num_predict,80);assert.equal(bodies[0].keep_alive,'30m');
});

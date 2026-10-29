// Local protocol simulator: never logs in to or sends messages to a real QQ.
const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),crypto=require('node:crypto'),path=require('node:path');
const {spawn}=require('node:child_process');
function frame(value){const data=Buffer.from(JSON.stringify(value));if(data.length<126)return Buffer.concat([Buffer.from([0x81,data.length]),data]);const head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(data.length,2);return Buffer.concat([head,data]);}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('real startup process exchanges OneBot frames and local model HTTP requests for private/group names', {timeout:15000},async()=>{
 const calls=[],sent=[],sockets=new Set();let child,resolveDone,rejectDone,timeout,output='';
 const completed=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
 const model=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'qwen2.5:3b'}]}));
  try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks));calls.push(request);const last=JSON.parse(request.messages.at(-1).content);res.end(JSON.stringify({message:{content:`${last.current_speaker}，来啦～`}}));}catch(error){res.statusCode=500;res.end('{}');rejectDone(error);}
 });
 const onebot=http.createServer();onebot.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 onebot.on('upgrade',(req,socket)=>{
  try{
   assert.equal(new URL(req.url,'http://localhost').searchParams.get('access_token'),'test-token-123456789');
   const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
   socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
   let buffer=Buffer.alloc(0);
   socket.on('data',chunk=>{
    try{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=2){
     const opcode=buffer[0]&15,masked=!!(buffer[1]&128);let size=buffer[1]&127,offset=2;
     if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}
     assert.notEqual(size,127);if(masked)offset+=4;if(buffer.length<offset+size)return;
     const data=Buffer.from(buffer.subarray(offset,offset+size));if(masked){const mask=buffer.subarray(offset-4,offset);for(let i=0;i<data.length;i++)data[i]^=mask[i%4];}buffer=buffer.subarray(offset+size);
     if(opcode===8){socket.end(Buffer.from([0x88,0]));continue;}if(opcode!==1)continue;
     const action=JSON.parse(data);sent.push(action);socket.write(frame({status:'ok',retcode:0,echo:action.echo,data:{message_id:sent.length}}));if(sent.length===2)resolveDone();
    }}catch(error){rejectDone(error);}
   });
   const base={post_type:'message',message_type:'private',self_id:456,user_id:123,time:Date.now()/1000,message_id:1,sender:{nickname:'阿明'},message:[{type:'text',data:{text:'你好'}}]};
   socket.write(frame(base));socket.write(frame(base)); // duplicate must not trigger a second reply
   socket.write(frame({...base,message_type:'group',group_id:789,message_id:2,sender:{card:'小菲鱼',nickname:'旧名字'},message:[{type:'text',data:{text:'独角兽我叫什么'}}]}));
   socket.write(frame({...base,message_type:'group',group_id:999,message_id:3,message:[{type:'text',data:{text:'独角兽不允许的群'}}]}));
  }catch(error){rejectDone(error);socket.destroy();}
 });
 try{
  const modelPort=await listen(model),wsPort=await listen(onebot);
  child=spawn(process.execPath,[path.join(__dirname,'../src/start.js')],{cwd:path.join(__dirname,'..'),env:{...process.env,ONEBOT_TOKEN:'test-token-123456789',ONEBOT_WS_URL:`ws://127.0.0.1:${wsPort}`,OLLAMA_BASE_URL:`http://127.0.0.1:${modelPort}`,OLLAMA_MODEL:'qwen2.5:3b',ALLOWED_USERS:'123',ALLOWED_GROUPS:'789',GROUP_AUTO_REPLY:'true',NEWS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',rejectDone);
  child.on('exit',code=>{if(sent.length<2)rejectDone(Error(`startup exited (${code}): ${output}`));});
  timeout=setTimeout(()=>rejectDone(Error(`protocol test timed out: ${output}`)),10000);
  await completed;await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(sent.length,2);assert.equal(calls.length,2);
  const privateReply=sent.find(v=>v.action==='send_private_msg'),groupReply=sent.find(v=>v.action==='send_group_msg');
  assert.equal(String(privateReply.params.user_id),'123');assert.equal(privateReply.params.message[0].data.text,'阿明，来啦～');
  assert.equal(String(groupReply.params.group_id),'789');assert.equal(groupReply.params.message[0].data.text,'小菲鱼，来啦～');
  assert.ok(calls.every(v=>v.options.num_predict===160&&v.options.num_ctx===3072));
 }finally{
  clearTimeout(timeout);if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
  for(const socket of sockets)socket.destroy();onebot.closeAllConnections();model.closeAllConnections();await Promise.all([new Promise(resolve=>onebot.close(resolve)),new Promise(resolve=>model.close(resolve))]);
 }
});

const {configuration}=require('./config');
const {createApp}=require('./server');
try{
  const config=configuration(),app=createApp(config);
  app.server.listen(config.port,'127.0.0.1',()=>{
    console.log(config.live?'已启用QQ官方回调模式，请检查群允许列表及HTTPS代理配置。':'本地测试模式：不连接、不发送QQ消息。');
    console.log(`控制台地址（仅本机使用，不要转发）：http://127.0.0.1:${config.port}/#token=${app.adminToken}`);
    if(process.platform==='win32'&&process.env.OPEN_BROWSER==='true'){
      const child=require('node:child_process').spawn('rundll32.exe',['url.dll,FileProtocolHandler',`http://127.0.0.1:${config.port}/#token=${app.adminToken}`],{windowsHide:true,stdio:'ignore'});
      child.on('error',()=>console.log('请手动复制上面的控制台地址打开浏览器。'));
    }
    console.log('普通QQ群消息监听未启用；当前官方适配器只处理@机器人事件。');
  });
  app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口已被占用，请关闭旧进程或修改PORT。':'无法启动本地服务');process.exitCode=1;});
  for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{console.log('正在退出，内存中等待的回复不会继续发送。');app.server.close();setTimeout(()=>process.exit(0),1000).unref();});
}catch(error){console.error(error.message);process.exitCode=1;}

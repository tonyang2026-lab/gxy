const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
test('Windows helper compiles C# and accepts end command without injecting mouse input',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const code=fs.readFileSync(path.join(__dirname,'../src/windows-scroll.ps1'),'utf8');
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Windows helper compilation timed out'));},25000);
    child.stdout.on('data',data=>stdout+=data.toString());child.stderr.on('data',data=>stderr+=data.toString());
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',exit=>{clearTimeout(timer);resolve({stdout,stderr,exit});});
    child.stdin.end(JSON.stringify({id:1,action:'end'})+'\n');
  });
  assert.equal(result.exit,0,result.stderr);const response=result.stdout.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).find(item=>item.id===1);
  assert.equal(response.ok,true);assert.equal(response.result,'stopped');
});

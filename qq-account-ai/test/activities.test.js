const {test}=require('node:test');const assert=require('node:assert/strict');
const {Activities,outcome,bestMove}=require('../src/activities');
const input=(text,extra={})=>({text,group:'g',author:'u',...extra});
test('game commands require addressing in groups and sessions isolate users and chats',()=>{
 const a=new Activities();assert.equal(a.handle(input('井字棋',{isGroup:true})),null);
 assert.match(a.handle(input('独角兽井字棋',{isGroup:true})),/先手/);
 assert.match(a.handle(input('棋盘',{author:'other'})),/没有棋局/);
 assert.match(a.handle(input('棋盘',{group:'other'})),/没有棋局/);
 assert.match(a.handle(input('落子 5')),/⭕/);
 assert.match(a.handle(input('落子 5')),/已经有棋子/);
 assert.match(a.handle(input('结束游戏')),/收起来/);assert.match(a.handle(input('棋盘')),/没有棋局/);
});
test('tic tac toe engine cannot lose for any legal human move sequence',()=>{
 let terminals=0;const visit=board=>{
  for(let i=0;i<9;i++)if(!board[i]){
   const next=[...board];next[i]='X';let result=outcome(next);
   assert.notEqual(result,'X');if(result){terminals++;continue;}
   const move=bestMove(next);assert.ok(move>=0&&!next[move]);next[move]='O';result=outcome(next);
   if(result){assert.notEqual(result,'X');terminals++;}else visit(next);
  }
 };visit(Array(9).fill(null));assert.ok(terminals>100);
});
test('guess attempts, answer, random bounds and tasks are handled without language model',()=>{
 const a=new Activities({random:(min,max)=>{assert.ok(min<max);return min;}});
 assert.match(a.handle(input('猜数字')),/10次/);assert.match(a.handle(input('猜 200')),/不扣/);
 assert.match(a.handle(input('猜 50')),/大了/);assert.match(a.handle(input('猜 1')),/猜中了/);
 assert.match(a.handle(input('掷骰子 3')),/1、1、1/);assert.match(a.handle(input('掷骰子 999')),/最多10/);
 assert.match(a.handle(input('抽签 苹果|梨')),/苹果/);
 assert.match(a.handle(input('添加待办 写周报')),/1\./);
 assert.match(a.handle(input('完成待办 1')),/已完成/);
 assert.match(a.handle(input('待办')),/✅ 1/);
 assert.match(a.handle(input('删除待办 1')),/已删除/);assert.match(a.handle(input('待办')),/没有待办/);
});
test('session expiration and bounded game attempts',()=>{
 let now=0;const a=new Activities({now:()=>now,random:()=>1});
 a.handle(input('猜数字'));for(let i=0;i<9;i++)assert.match(a.handle(input('猜 50')),/还剩/);
 assert.match(a.handle(input('猜 50')),/答案是1/);assert.match(a.handle(input('猜 1')),/先发/);
 a.handle(input('井字棋'));now=86400001;assert.match(a.handle(input('棋盘')),/没有棋局/);
});

const {randomInt}=require('node:crypto');
const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function outcome(board){for(const [a,b,c] of lines)if(board[a]&&board[a]===board[b]&&board[a]===board[c])return board[a];return board.every(Boolean)?'draw':null;}
function score(board,turn){const result=outcome(board);if(result)return result==='O'?1:result==='X'?-1:0;const scores=[];for(let i=0;i<9;i++)if(!board[i]){board[i]=turn;scores.push(score(board,turn==='O'?'X':'O'));board[i]=null;}return turn==='O'?Math.max(...scores):Math.min(...scores);}
function bestMove(board){let best=-2,move=-1;for(const i of [4,0,2,6,8,1,3,5,7])if(!board[i]){board[i]='O';const value=score(board,'X');board[i]=null;if(value>best){best=value;move=i;}}return move;}
const digits=['①','②','③','④','⑤','⑥','⑦','⑧','⑨'];
function render(board){return [0,3,6].map(start=>board.slice(start,start+3).map((v,i)=>v==='X'?'❌':v==='O'?'⭕':digits[start+i]).join(' ')).join('\n');}
const HELP=`独角兽的工具箱：
• 井字棋 / 落子 5 / 棋盘 / 结束游戏
• 猜数字 / 猜 50（范围1～100，最多10次）
• 掷骰子 / 掷骰子 3（最多10颗）
• 抛硬币
• 抽签 火锅|烧烤|面条（用竖线分隔）
• 添加待办 写周报 / 待办 / 完成待办 1 / 删除待办 1
群里请在命令前加“独角兽 ”或@我；私聊直接发送。棋局、猜数字和待办按每人每个会话分别保存。重启会清空，请勿作为重要事项的唯一记录。`;
class Activities{
 constructor({random=randomInt,now=()=>Date.now()}={}){this.random=random;this.now=now;this.sessions=new Map();}
 handle({text,group,author,mentioned=false,isGroup=false}){
  let command=text.normalize('NFKC').trim();const named=/^独角兽[\s，,:：！!、]*/.test(command);
  if(isGroup&&!mentioned&&!named)return null;
  command=command.replace(/^独角兽[\s，,:：！!、]*/,'').trim();
  if(!/^(帮助|功能|菜单|井字棋|落子(?:\s|$)|棋盘|结束游戏|猜数字|猜(?:\s|$)|掷骰子|抛硬币|抽签|添加待办|待办|完成待办|删除待办)/.test(command))return null;
  if(['帮助','功能','菜单'].includes(command))return HELP;
  const now=this.now();for(const [key,s] of this.sessions)if(now-s.at>86400000)this.sessions.delete(key);
  const key=JSON.stringify([group,author]);let state=this.sessions.get(key);
  if(!state){if(this.sessions.size>=500)return '工具箱同时使用人数较多，稍后再试。';state={at:now,board:null,guess:null,tasks:[],next:1};this.sessions.set(key,state);}state.at=now;
  if(command==='井字棋'){if(state.board)return `这盘还没下完哦。\n${render(state.board)}\n发送“落子 数字”，或“结束游戏”。`;state.board=Array(9).fill(null);return `来，你先手❌，我是⭕。\n${render(state.board)}\n发送“落子 5”这样的指令。`;}
  if(command==='棋盘')return state.board?render(state.board):'还没有棋局，发“井字棋”开一盘。';
  if(command==='结束游戏'){state.board=null;state.guess=null;return '好，这局先收起来。想玩随时叫我。';}
  if(command.startsWith('落子')){
   if(!state.board)return '先发“井字棋”开一盘吧。';
   const match=command.match(/^落子\s*([1-9])$/);if(!match)return '用“落子 1”到“落子 9”选择空格。';
   const index=Number(match[1])-1,board=state.board;if(board[index])return '这个位置已经有棋子了，换个空格吧。';
   board[index]='X';let result=outcome(board);if(!result){board[bestMove(board)]='O';result=outcome(board);}
   const picture=render(board);if(result){state.board=null;return `${picture}\n${result==='draw'?'平局！这盘谁也没让谁。':result==='X'?'你赢啦，漂亮！':'这局我拿下啦，再来？'}`;}
   return `${picture}\n轮到你，发送“落子 数字”。`;
  }
  if(command==='猜数字'){if(state.guess)return '已经有一道数字题了，发送“猜 50”继续，或“结束游戏”。';state.guess={value:this.random(1,101),tries:0};return '我想了一个1～100的整数，你有10次机会。发送“猜 50”试试。';}
  if(command.startsWith('猜 ')){
   if(!state.guess)return '先发“猜数字”，我再出题。';
   if(!/^猜\s+\d{1,3}$/.test(command))return '发送“猜 50”这样的整数，范围1～100。';
   const value=Number(command.slice(1).trim());if(value<1||value>100)return '范围是1～100哦，这次不扣机会。';
   const game=state.guess;game.tries++;if(value===game.value){state.guess=null;return `猜中了！就是${value}，用了${game.tries}次。`;}
   if(game.tries>=10){state.guess=null;return `机会用完啦，答案是${game.value}。再发“猜数字”来一局？`;}
   return `${value<game.value?'小了':'大了'}，还剩${10-game.tries}次机会。`;
  }
  if(command.startsWith('掷骰子')){const match=command.match(/^掷骰子(?:\s+(\d{1,2}))?$/);const count=match?Number(match[1]||1):0;if(count<1||count>10)return '发送“掷骰子”或“掷骰子 3”，一次最多10颗。';const values=Array.from({length:count},()=>this.random(1,7));return `🎲 ${values.join('、')}（合计${values.reduce((a,b)=>a+b,0)}）`;}
  if(command==='抛硬币')return `🪙 ${this.random(0,2)?'正面':'反面'}！`;
  if(command.startsWith('抽签')){const options=command.slice(2).trim().split('|').map(v=>v.trim());if(options.length<2||options.length>20||options.some(v=>!v||v.length>80))return '用“抽签 火锅|烧烤|面条”，提供2～20个选项，每项最多80字。';return `抽到了：${options[this.random(0,options.length)]} 🎯`;}
  if(command.startsWith('添加待办')){const task=command.slice(4).trim();if(!task||task.length>100)return '用“添加待办 写周报”，内容1～100字。';if(state.tasks.length>=30)return '待办最多30条，请先删除一些。';const id=state.next++;state.tasks.push({id,text:task,done:false});return `记下了：${id}. ${task}\n待办仅在内存保存，重启会清空。`;}
  if(command==='待办')return state.tasks.length?state.tasks.map(t=>`${t.done?'✅':'⬜'} ${t.id}. ${t.text}`).join('\n'):'目前没有待办，轻松一下～';
  if(/^(完成待办|删除待办)/.test(command)){const match=command.match(/^(完成待办|删除待办)\s+(\d+)$/);if(!match)return '发送“完成待办 1”或“删除待办 1”。';const index=state.tasks.findIndex(t=>t.id===Number(match[2]));if(index<0)return '没找到这个编号，发“待办”看看当前列表。';if(match[1]==='删除待办'){state.tasks.splice(index,1);return '这条待办已删除。';}state.tasks[index].done=true;return `✅ 已完成：${state.tasks[index].text}`;}
  return '命令格式没对上，发“帮助”看看示例。';
 }
}
module.exports={Activities,outcome,bestMove};

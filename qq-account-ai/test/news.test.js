const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {News,parseFeed}=require('../src/news');const {NewsScheduler}=require('../src/news-scheduler');const {configuration}=require('../src/config');
const now=Date.parse('2026-10-29T09:00:00Z');
const feed=(title='AI &amp; tools',link='https://example.com/a',date=new Date(now).toUTCString())=>`<rss><channel><item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate></item></channel></rss>`;
test('RSS/Atom parsing removes markup, filters old/future dates and unsafe links',()=>{
 const data=parseFeed(feed(),{name:'Source'},now);assert.equal(data[0].title,'AI & tools');
 assert.equal(parseFeed(feed('x','javascript:alert(1)'),{name:'S'},now).length,0);
 assert.equal(parseFeed(feed('x','https://example.com',new Date(now-49*3600000).toUTCString()),{name:'S'},now).length,0);
 assert.equal(parseFeed(feed('x','https://example.com',new Date(now+3600000).toUTCString()),{name:'S'},now).length,0);
 assert.throws(()=>parseFeed('<!DOCTYPE rss><rss/>',{name:'S'},now));
 const atom=`<feed><entry><title>Model update</title><link rel="self" href="https://example.com/feed"/><link rel="alternate" href="https://example.com/b"/><updated>${new Date(now).toISOString()}</updated></entry></feed>`;
 assert.equal(parseFeed(atom,{name:'S'},now)[0].url,'https://example.com/b');
});
test('partial feed failure, cache and manual command preserve actual source titles',async()=>{
 let calls=0;const news=new News({store:null,now:()=>now,sources:[{name:'A',url:'a'},{name:'B',url:'b'}],fetcher:async url=>{calls++;if(url==='b')throw Error('offline');return new Response(feed());}});
 assert.match(await news.command('独角兽AI新闻'),/AI & tools/);assert.match(await news.command('AI新闻'),/部分新闻源/);assert.equal(calls,2);assert.equal(await news.command('你好'),null);
 const fail=new News({store:null,sources:[{name:'A',url:'a'}],fetcher:async()=>{throw Error();}});assert.match(await fail.command('AI新闻'),/无法访问/);
});
test('scheduled delivery persists dedupe and never resends ambiguous failures',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-news-'));try{
  const options={store:path.join(dir,'news.json'),now:()=>now,sources:[{name:'A',url:'a'}],fetcher:async()=>new Response(feed())};
  const news=new News(options),targets=[{type:'group',id:'123'}];let sends=0;
  await assert.rejects(news.push('1',targets,async()=>{sends++;throw Error('unknown delivery');}));
  const next=new News(options);await next.push('2',targets,async()=>sends++);assert.equal(sends,1);
  assert.ok(!fs.readFileSync(options.store,'utf8').includes('AI & tools'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('scheduler waits one hour, skips disconnection and prevents overlapping checks',async()=>{
 let time=0,online=false,calls=0,release;const scheduler=new NewsScheduler({push:()=>{calls++;return new Promise(r=>release=r);}},[],()=>{},()=>online,{now:()=>time,log:()=>{}});
 await scheduler.tick();assert.equal(calls,0);time=3600000;await scheduler.tick();assert.equal(calls,0);online=true;
 const active=scheduler.tick();await scheduler.tick();assert.equal(calls,1);release();await active;
 time+=1000;await scheduler.tick();assert.equal(calls,1);scheduler.stop();time+=3600000;await scheduler.tick();assert.equal(calls,1);
});
test('news destinations must be explicit allowed groups',()=>{
 const base={ONEBOT_TOKEN:'x'.repeat(16),NEWS_ENABLED:'true'};
 assert.throws(()=>configuration(base));assert.throws(()=>configuration({...base,NEWS_GROUPS:'123',ALLOWED_GROUPS:'456'}));
 assert.equal(configuration({...base,NEWS_GROUPS:'123',ALLOWED_GROUPS:'123'}).newsEnabled,true);
});

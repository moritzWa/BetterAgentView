import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {privateMcp} from '../private/mcp.mjs';
import {SyncStore} from '../sync/store.mjs';
import {Outbox} from '../private/outbox.mjs';
import {digest} from '../sync/projection.mjs';
import {WakeGate,gateClient} from '../private/gate.mjs';
import {application} from '../private/worker.mjs';
import {OWNER} from '../private/auth.mjs';

let db,store,outbox,reader,writer;
const gate={activity:async()=>({source_checked_at:Date.now(),mac_seen_recently:true,history_fresh:true}),runtime:async()=>({available:true,partial:false,checked_at:Date.now(),statuses:[]}),signal:async()=>{},signalReceipt:async()=>{}};
before(async()=>{
 db=new PGlite();await db.exec(await readFile(new URL('../sync/schema.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../private/schema.sql',import.meta.url),'utf8'));
 store=new SyncStore(db);outbox=new Outbox(db,gate);
 for(const [token,audience,scopes] of [['w'.repeat(43),'sync','history:sync messages:deliver'],['r'.repeat(43),'read','history:read messages:send']])await db.query('INSERT INTO av_credentials(token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)',[await digest(token),OWNER,'device','epoch',audience,Date.now()+3600_000,scopes]);
 writer=await store.authenticate('w'.repeat(43),'sync');reader=await store.authenticate('r'.repeat(43),'read');
});
after(async()=>db?.close());
const state={title:'Latency fixture',archived:false,deleted:false,visible_before:null};
async function seed(id,messages){await store.apply(writer,{version:1,batch_id:id,session_id:id,kind:'baseline',from:0,through:100,upload_id:id,chunk:0,complete:true,session:state,messages,delete_ids:[]});}
async function rpcRaw(name,args){
 const response=await privateMcp(new Request('https://test.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),{db,store,principal:reader,outbox,gate});
 return response.json();
}
async function rpc(name,args){const body=await rpcRaw(name,args);assert(!body.result?.isError,body.result?.content?.[0]?.text);return JSON.parse(body.result.content[0].text);}
const size=value=>JSON.stringify(value).length;

test('search returns a short passage by default and the same match expands on demand',async()=>{
 const text='filler '.repeat(4000)+'The deploy token is quartzneedle for this run. '+'tail '.repeat(4000);
 await seed('compact-search',[{id:'msg_1',role:'user',order:1,created_at:1,updated_at:1,text}]);
 const compact=await rpc('search_history',{query:'quartzneedle'}),hit=compact.matches.find(m=>m.session_id==='compact-search');
 assert(hit);assert(hit.excerpt.includes('quartzneedle'));assert([...hit.excerpt].length<=400);assert.equal(compact.excerpt_chars,400);
 assert.equal(hit.truncated,true);assert.equal(hit.total_characters,[...text].length);assert(hit.excerpt_offset>0);
 const wide=await rpc('search_history',{query:'quartzneedle',excerpt_chars:2000}),wideHit=wide.matches.find(m=>m.session_id==='compact-search');
 assert([...wideHit.excerpt].length>1500&&[...wideHit.excerpt].length<=2000);assert.equal(wideHit.excerpt_offset,hit.excerpt_offset-20,'the wider window starts 120 characters before the match, the compact one 100');
 assert(size(wide)>size(compact)*3);
 // Expansion keeps the send anchors: the same message id, order and cursor.
 const full=await rpc('read_message',{session_id:'compact-search',message_id:hit.message_id,offset:hit.excerpt_offset});
 assert(full.text.startsWith(hit.excerpt));assert.equal(wideHit.message_order,hit.message_order);assert.equal(wideHit.cursor,hit.cursor);
});

test('search pages deterministically with next_offset, including rows with identical timestamps',async()=>{
 for(let i=0;i<12;i++)await seed(`page-${String(i).padStart(2,'0')}`,[{id:`pm_${i}`,role:'user',order:1,created_at:5,updated_at:5,text:`pagetoken number ${i}`}]);
 const seen=[];let offset=0,pages=0;
 for(;;){
  const page=await rpc('search_history',{query:'pagetoken',limit:5,offset});pages++;
  assert(page.matches.length<=5);seen.push(...page.matches.map(m=>`${m.session_id}/${m.message_id}`));
  if(page.next_offset===null)break;assert.equal(page.next_offset,offset+5);offset=page.next_offset;assert(pages<10);
 }
 assert.equal(pages,3);assert.equal(seen.length,12);assert.equal(new Set(seen).size,12);
 const again=await rpc('search_history',{query:'pagetoken',limit:12});assert.equal(again.next_offset,null);
 assert.deepEqual(again.matches.map(m=>`${m.session_id}/${m.message_id}`),seen,'pages concatenate to the same order as one large page');
 assert.equal((await rpc('search_history',{query:'pagetoken',limit:12,offset:12})).matches.length,0);
});

test('list_sessions is compact by default and detail=true restores recent text',async()=>{
 const rows=[];
 for(let i=0;i<14;i++){
  const id=`overview-${i}`;
  await seed(id,[{id:`u${i}`,role:'user',order:1,created_at:1000+i,updated_at:1000+i,text:`Please investigate item ${i}. `+'context '.repeat(300)},{id:`a${i}`,role:'assistant',order:2,created_at:2000+i,updated_at:2000+i,text:'I looked into it. '+'finding '.repeat(500)+'Should I proceed with option A?'}]);
  rows.push({session_id:id,status:'done',completion:'unconfirmed',reason:null,updated_at:2000+i,can_message:true,last_user_message_id:`u${i}`,last_user_ms:1000+i,top_level:true,attention_assessed:true,directory:`/work/project-${i%3}`,health:'idle'});
 }
 const runtimeGate={...gate,runtime:async()=>({available:true,partial:false,checked_at:Date.now(),statuses:rows})};
 const call=async args=>{const r=await (await privateMcp(new Request('https://test.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_sessions',arguments:args}})}),{db,store,principal:reader,outbox,gate:runtimeGate})).json();assert(!r.result.isError,r.result.content[0].text);return JSON.parse(r.result.content[0].text);};
 const compact=await call({}),detail=await call({detail:true});
 assert.equal(compact.sessions.length,detail.sessions.length);assert(compact.sessions.length>=10);
 assert.equal(compact.sessions[0].recent_messages,undefined);assert(detail.sessions[0].recent_messages.length>=2);
 assert.deepEqual(compact.sessions.map(s=>s.session_id).sort(),detail.sessions.map(s=>s.session_id).sort(),'same sessions, less text');
 assert.deepEqual(compact.counts,detail.counts);assert.equal(compact.status_fresh,detail.status_fresh);
 assert(size(compact)*4<size(detail),`compact ${size(compact)} should be far smaller than detail ${size(detail)}`);
 for(const s of compact.sessions)assert(s.project_name&&s.title&&s.status,'rows still say which session and folder');
});

test('the Worker reports phase durations in Server-Timing without any text',async()=>{
 const writerToken='s'.repeat(43),readerToken='t'.repeat(43);
 const map=new Map();
 const storage={get:async k=>Array.isArray(k)?new Map(k.filter(x=>map.has(x)).map(x=>[x,structuredClone(map.get(x))])):structuredClone(map.get(k)),put:async(k,v)=>{if(typeof k==='object')for(const [a,b] of Object.entries(k))map.set(a,structuredClone(b));else map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},transaction:async fn=>fn(storage)};
 const object=new WakeGate({storage}),namespace={idFromName:x=>x,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};
 const realGate=gateClient(namespace,OWNER);
 await db.query('INSERT INTO av_owner_source VALUES ($1,$2,$3) ON CONFLICT (owner_id) DO UPDATE SET device_id=EXCLUDED.device_id,database_epoch=EXCLUDED.database_epoch',[OWNER,'device','epoch']);
 await db.query('INSERT INTO av_credentials(token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)',[await digest(readerToken),OWNER,'device','epoch','read',Date.now()+3600_000,'history:read']);
 await realGate.enroll({token_hash:await digest(writerToken),owner_id:OWNER,device_id:'device',database_epoch:'epoch',expires_at:Date.now()+3600_000});
 const app=application({database:async()=>({query:(...a)=>db.query(...a),transaction:fn=>db.transaction(fn),close:async()=>{}})});
 const env={ISSUER:'https://bridge.invalid',GATE:namespace,DATABASE_URL:'synthetic',GOOGLE_CLIENT_ID:'x',GOOGLE_CLIENT_SECRET:'y'};
 const response=await app.fetch(new Request('https://bridge.invalid/mcp',{method:'POST',headers:{authorization:`Bearer ${readerToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_history',arguments:{query:'pagetoken',limit:2}}})}),env);
 assert.equal(response.status,200);
 const header=response.headers.get('server-timing');assert(header,'Server-Timing is present');
 const phases=Object.fromEntries(header.split(', ').map(p=>{const [name,dur,desc]=p.split(';');return [name,{ms:Number(dur.slice(4)),n:Number(desc.match(/n=(\d+)/)[1])}];}));
 for(const name of ['connect','auth','touch','tool','fresh_wait','db'])assert(phases[name],`${name} phase: ${header}`);
 assert(phases.db.n>=2,'query count is visible: the search plus the grant recheck');
 assert.match(header,/^[A-Za-z_;=0-9." ,]+$/,'only names, durations and counts');
 const body=await response.json();assert(!body.result.isError);assert(!header.includes('pagetoken'));
});

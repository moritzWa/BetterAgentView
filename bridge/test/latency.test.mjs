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
 const phases=Object.fromEntries(header.split(', ').filter(p=>p.includes(';dur=')).map(p=>{const [name,dur,desc]=p.split(';');return [name,{ms:Number(dur.slice(4)),n:Number(desc.match(/n=(\d+)/)[1])}];}));
 for(const name of ['connect','auth','touch','tool','fresh_wait','db'])assert(phases[name],`${name} phase: ${header}`);
 assert(phases.db.n>=2,'query count is visible: the search plus the grant recheck');
 assert.match(header,/^[A-Za-z_;=0-9." ,]+$/,'only names, durations and counts');
  const body=await response.json();assert(!body.result.isError);assert(!header.includes('pagetoken'));
  const dashboard=JSON.parse(await readFile(new URL('./fixtures/dashboard.json',import.meta.url)));
  dashboard.captured_at=Date.now();
  const trace={read_source:'connector',read_at:Date.now(),read_result:'accepted'};
  await realGate.setRuntime(await digest(writerToken),{available:true,partial:false,dashboard,snapshot_trace:trace,statuses:[]});
  // A running Durable Object can still return metadata from the previous shape.
  const meta=map.get('runtime_meta:device|epoch');
  delete meta.dashboard_stored_at;
  const check=await app.fetch(new Request('https://bridge.invalid/mcp',{method:'POST',headers:{authorization:`Bearer ${readerToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'snapshot_diagnostics',arguments:{}}})}),env);
  const rpc=await check.json();assert(!rpc.result.isError,rpc.result.content[0].text);
  const diagnostic=JSON.parse(rpc.result.content[0].text);
  assert.equal(diagnostic.state,'fresh');assert.equal(diagnostic.session_count,5);
  assert.equal(diagnostic.snapshot_stored_at,diagnostic.runtime_stored_at);
  assert.deepEqual(diagnostic.connector,trace);assert(!JSON.stringify(diagnostic).includes(dashboard.sessions[0].title));
  const list=await app.fetch(new Request('https://bridge.invalid/mcp',{method:'POST',headers:{authorization:`Bearer ${readerToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_visible_sessions',arguments:{}}})}),env);
  const listHeader=list.headers.get('server-timing');
  for(const phase of ['fresh_wait','visible_snapshot','visible_context','visible_serialize'])assert(listHeader.includes(phase+';dur='),listHeader);
  assert(listHeader.includes('visible_snapshot_state;desc="fresh"'));
  assert(!listHeader.includes('db_tx;'),'one statement retrieves message previews');
  const listReply=await list.json();assert(!listReply.result.isError,listReply.result.content[0].text);
  const text=listReply.result.content[0].text;
  assert(listHeader.includes(`visible_payload_bytes;desc="${Buffer.byteLength(text)}"`));
  assert(!listHeader.includes(dashboard.sessions[0].title));
});

// The Neon driver returns bigint columns as strings; PGlite returns numbers. The
// deployed read_session failed its response contract on the string cursor.
test('read_session works when the driver returns bigint columns as strings',async()=>{
 await seed('string-bigint',[{id:'sb_1',role:'user',order:1,created_at:1,updated_at:1,text:'hello'},{id:'sb_2',role:'assistant',order:2,created_at:2,updated_at:2,text:'world'}]);
 const stringify=async rows=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='number'&&['cursor','message_order','created_at','updated_at'].includes(k)?String(v):v])));
 const wrap=target=>({query:async(sql,args)=>{const r=await target.query(sql,args);return {...r,rows:await stringify(r.rows)};},transaction:fn=>target.transaction(tx=>fn(wrap(tx)))});
 const response=await privateMcp(new Request('https://test.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_session',arguments:{session_id:'string-bigint'}}})}),{db:wrap(db),store,principal:reader,outbox,gate});
 const body=await response.json();assert(!body.result.isError,body.result.content[0].text);
 const page=JSON.parse(body.result.content[0].text);
 assert.equal(typeof page.cursor,'number');assert.deepEqual(page.messages.map(m=>m.message_order),[1,2]);assert.equal(typeof page.next_after,'number');
});

test('authenticated MCP calls leave a durations-only record the owner can read, and strangers cannot',async()=>{
 const map=new Map();
 const storage={get:async k=>Array.isArray(k)?new Map(k.filter(x=>map.has(x)).map(x=>[x,structuredClone(map.get(x))])):structuredClone(map.get(k)),put:async(k,v)=>{if(typeof k==='object')for(const [a,b] of Object.entries(k))map.set(a,structuredClone(b));else map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},transaction:async fn=>fn(storage)};
 const object=new WakeGate({storage}),namespace={idFromName:x=>x,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};
 const token='u'.repeat(43);
 await db.query('INSERT INTO av_credentials(token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)',[await digest(token),OWNER,'device','epoch','read',Date.now()+3600_000,'history:read']);
 const app=application({database:async()=>({query:(...a)=>db.query(...a),transaction:fn=>db.transaction(fn),close:async()=>{}})});
 const env={ISSUER:'https://bridge.invalid',GATE:namespace,DATABASE_URL:'synthetic',GOOGLE_CLIENT_ID:'x',GOOGLE_CLIENT_SECRET:'y'};
 const pending=[],ctx={waitUntil:p=>pending.push(p)};
 const call=(bearer,body)=>app.fetch(new Request('https://bridge.invalid/mcp',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(body)}),env,ctx);
 await call(token,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_history',arguments:{query:'SECRET_QUERY_TEXT'}}});
 await call(token,{jsonrpc:'2.0',id:2,method:'tools/list'});
 await call('z'.repeat(43),{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'search_history',arguments:{query:'x'}}});
 await Promise.all(pending);
 const read=await app.fetch(new Request('https://bridge.invalid/v1/timings',{headers:{authorization:`Bearer ${token}`}}),env,ctx);
 assert.equal(read.status,200);const {calls}=await read.json();
 assert.equal(calls.length,2,'the unauthenticated call is not logged');
 assert.equal(calls[0].tool,'search_history');assert.equal(calls[0].method,'tools/call');assert.equal(calls[1].method,'tools/list');
 assert(calls[0].ms>=0&&calls[0].result_chars>0&&calls[0].phases.connect>=0&&calls[0].phases.tool>=0,JSON.stringify(calls[0]));
 assert(!JSON.stringify(calls).includes('SECRET_QUERY_TEXT'),'arguments never reach the log');
 const stranger=await app.fetch(new Request('https://bridge.invalid/v1/timings',{headers:{authorization:`Bearer ${'z'.repeat(43)}`}}),env,ctx);
 assert.notEqual(stranger.status,200);
});

test('send and start descriptions tell the voice client not to announce or poll successful writes',async()=>{
 const {SERVER_INSTRUCTIONS}=await import('../private/mcp.mjs');
 const response=await privateMcp(new Request('https://test.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),{db,store,principal:reader,outbox,gate});
 const {tools}=(await response.json()).result;
 for(const text of [SERVER_INSTRUCTIONS.slice(0,512),...tools.filter(t=>['send_session_message','start_session'].includes(t.name)).map(t=>t.description)]) {
  assert.match(text,/say_to_owner:null is a silent success/);
  assert.match(text,/Do not announce, retry, or check status/);
  assert.match(text,/Never infer an error from silence/);
  assert.match(text,/the failed action for real errors/);
 }
});

const fakeStorage=()=>{const map=new Map();const st={get:async k=>Array.isArray(k)?new Map(k.filter(x=>map.has(x)).map(x=>[x,structuredClone(map.get(x))])):structuredClone(map.get(k)),put:async(k,v)=>{if(k&&typeof k==='object')for(const [a,b] of Object.entries(k))map.set(a,structuredClone(b));else map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},transaction:async fn=>fn(st)};return st;};
const wakeGate=()=>{const object=new WakeGate({storage:fakeStorage()}),namespace={idFromName:x=>x,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};return {namespace,gate:gateClient(namespace,OWNER)};};
const probeStatus=(id,extra={})=>({session_id:id,status:'needs_you',completion:'unconfirmed',reason:'question',updated_at:Date.now(),can_message:false,last_user_message_id:'u1',last_user_ms:1,top_level:true,attention_assessed:true,directory:'/work/x',health:'idle',...extra});

test('a probe reaches the open poll, the answer returns to the waiting caller, and stale or unsolicited answers are ignored',async()=>{
 const {gate}=wakeGate(),token='p'.repeat(43),h=await digest(token),source='device|epoch';
 await gate.enroll({token_hash:h,owner_id:OWNER,device_id:'device',database_epoch:'epoch',expires_at:Date.now()+3600_000});
 assert.equal((await gate.probe(source,'ses_x',{max_wait:50})).answered,false,'nobody has polled yet: the Mac was not seen, so it does not wait');
 const first=await gate.poll(h);// records last_seen and returns at once (a signal is pending after enroll)
 assert.equal(first.probe,null);
 await gate.clear(source,first.generation);
 const polled=gate.poll(h);
 await new Promise(r=>setTimeout(r,20));
 const asked=gate.probe(source,'ses_x',{max_wait:3000});
 const delivered=await polled;
 assert.equal(delivered.probe.session_id,'ses_x');
 await gate.probeWrite(h,{probe_id:'not-this-probe',status:probeStatus('ses_other')});
 await new Promise(r=>setTimeout(r,20));
 await gate.probeWrite(h,{probe_id:delivered.probe.probe_id,status:probeStatus('ses_x')});
 const answer=await asked;
 assert.equal(answer.answered,true);assert.equal(answer.status.session_id,'ses_x');assert(answer.waited_ms<1000);
 // The probe was handed to one poll only.
 const again=gate.poll(h);await new Promise(r=>setTimeout(r,20));
 const lateAsk=await gate.probe(source,'ses_y',{max_wait:80});
 assert.equal(lateAsk.answered,false,'no answer within the wait is reported, not invented');
 assert.equal((await again).probe.session_id,'ses_y');
});

test('session_brief uses the probed status instead of waiting for a whole snapshot, and falls back when the Mac does not answer',async()=>{
 await seed('probe-brief',[{id:'u1',role:'user',order:1,created_at:10,updated_at:10,text:'Please decide.'},{id:'a1',role:'assistant',order:2,created_at:11,updated_at:11,text:'Which option should I take?'}]);
 const kinds=[];
 const snapshot={available:true,partial:true,truncated:true,checked_at:Date.now()-600_000,statuses:[{session_id:'probe-brief',status:'done',completion:'unconfirmed',reason:null,updated_at:1,can_message:true,last_user_message_id:'u1',last_user_ms:1,top_level:true,attention_assessed:true,directory:'/work/x',health:'idle'}]};
 const make=probe=>({...gate,activity:async(source,wait,kind)=>{kinds.push(kind);return {source_checked_at:Date.now(),mac_seen_recently:true,history_fresh:true};},runtime:async()=>snapshot,...(probe?{probe}:{})});
 const brief=async g=>{const r=await (await privateMcp(new Request('https://test.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'session_brief',arguments:{session_id:'probe-brief'}}})}),{db,store,principal:reader,outbox,gate:g})).json();assert(!r.result.isError,r.result.content[0].text);return JSON.parse(r.result.content[0].text);};
 const probed=await brief(make(async()=>({answered:true,status:probeStatus('probe-brief'),observed_at:Date.now(),waited_ms:40})));
 assert.equal(probed.session.status,'needs_you');assert.equal(probed.session.needs_you_because.includes('question'),true);
 assert.equal(probed.data_age.status_fresh,true);assert.equal(probed.timing_ms.probed,true);
 assert.deepEqual(kinds,['history'],'only history is waited for; no whole-snapshot wait');
 assert.notEqual(probed.send_params,null,'send anchors are still returned');
 kinds.length=0;
 const fallback=await brief(make(async()=>({answered:false,reason:'timeout'})));
 assert.equal(fallback.session.status,'done','without an answer the old snapshot path applies');
 assert.deepEqual(kinds,['history','both']);assert.equal(fallback.timing_ms.probed,false);assert.equal(fallback.data_age.status_fresh,false);
 kinds.length=0;
 const thrown=await brief(make(async()=>{throw new Error('boom');}));
 assert.equal(thrown.session.status,'done');
});

test('a snapshot under 20 seconds old is used as before, without asking the Mac',async()=>{
 await seed('probe-skip',[{id:'u1',role:'user',order:1,created_at:10,updated_at:10,text:'Hello.'},{id:'a1',role:'assistant',order:2,created_at:11,updated_at:11,text:'Done.'}]);
 const kinds=[];let asked=0;
 const g={...gate,activity:async(source,wait,kind)=>{kinds.push(kind);return {source_checked_at:Date.now(),mac_seen_recently:true,history_fresh:true};},
  runtime:async()=>({available:true,partial:false,checked_at:Date.now()-5_000,statuses:[{session_id:'probe-skip',status:'done',completion:'unconfirmed',reason:null,updated_at:1,can_message:true,last_user_message_id:'u1',last_user_ms:1,top_level:true,attention_assessed:true,directory:'/work/x',health:'idle'}]}),
  probe:async()=>{asked++;return {answered:false};}};
 const r=await (await privateMcp(new Request('https://test.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'session_brief',arguments:{session_id:'probe-skip'}}})}),{db,store,principal:reader,outbox,gate:g})).json();
 assert(!r.result.isError);const brief=JSON.parse(r.result.content[0].text);
 assert.equal(asked,0);assert.deepEqual(kinds,['both']);assert.equal(brief.timing_ms.probed,false);assert.equal(brief.data_age.status_fresh,true);
});

test('the call log is bucketed by hour, keeps no text, and drops hours past retention',async()=>{
 const {gate:g}=wakeGate(),now=Date.now(),old=now-15*86400_000;
 await g.logCall({t:old,ms:5,method:'tools/call',tool:'search_history',status:200,result_chars:1,error:null,phases:{db:1}});
 await g.logCall({t:now-3*3600_000,ms:7,method:'tools/call',tool:'session_brief',status:200,result_chars:9,error:null,phases:{db:2}});
 await g.logCall({t:now,ms:9,method:'tools/call',tool:'list_sessions',status:200,result_chars:3,error:null,phases:{db:3}});
 const day=await g.callLog(24);
 assert.deepEqual(day.calls.map(c=>c.tool),['session_brief','list_sessions']);
 assert.equal((await g.callLog(2)).calls.length,1);
 assert.equal(day.retention_days,14);
});

test('worker returns both enqueue receipts while its connector wake is still pending', {timeout:5000},async()=>{
 await seed('enqueue-latency',[]);
 const pending=[],gateCalls=[];
 let failWake,failCommit=false;
 const blockedWake=new Promise((_,reject)=>{failWake=reject;});
 const namespace={idFromName:x=>x,get:()=>({fetch:async url=>{
   const path=new URL(url).pathname;gateCalls.push(path);
   if(path==='/signal')return blockedWake;
   assert.equal(path,'/call-log','enqueue must not touch presence or check delivery');
   return Response.json({ok:true});
 }})};
 const app=application({database:async()=>({query:(...a)=>db.query(...a),transaction:fn=>db.transaction(async tx=>{const result=await fn(tx);if(failCommit)throw new Error('database commit failed');return result;}),close:async()=>{}})});
 const env={ISSUER:'https://bridge.invalid',GATE:namespace,DATABASE_URL:'synthetic',GOOGLE_CLIENT_ID:'x',GOOGLE_CLIENT_SECRET:'y'};
 const ctx={waitUntil:p=>pending.push(p)};
 const sendArgs={operation_id:'enqueue_latency_send',session_id:'enqueue-latency',text:'exact send'};
 const startArgs={operation_id:'enqueue_latency_start',directory:'/work/fixture',text:'exact start'};
 const call=(name,args)=>app.fetch(new Request('https://bridge.invalid/mcp',{method:'POST',headers:{authorization:'Bearer '+'r'.repeat(43),'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env,ctx);
 try {
  for(const [name,args] of [['send_session_message',sendArgs],['start_session',startArgs]]) {
   const response=await call(name,args);
   const rpc=await response.json();assert(!rpc.result.isError,rpc.result.content[0].text);
   const result=JSON.parse(rpc.result.content[0].text);
   assert.equal(result.enqueued,true);assert.equal(result.say_to_owner,null);
   assert.equal(result.operation_id,args.operation_id);
   assert.equal(result.write_action,name);
   assert.match(result.report_rule,/Saved successfully\. No error occurred/);
   assert.match(result.report_rule,/next requested step, or end silently/);
   assert.match(result.report_rule,/Do not announce, retry, or check status/);
  }
  assert.deepEqual(gateCalls,['/signal','/call-log','/signal','/call-log']);
  assert.equal(pending.length,4,'the Worker keeps each wake and each timing write alive');
  for(const [table,args] of [['av_outbox',sendArgs],['av_starts',startArgs]]) {
   const {rows}=await db.query('SELECT state,text FROM '+table+' WHERE operation_id=$1',[args.operation_id]);
   assert.deepEqual(rows,[{state:'queued',text:args.text}],'enqueue is committed even without a wake response');
  }
  failCommit=true;
  for(const [name,table,args] of [['send_session_message','av_outbox',sendArgs],['start_session','av_starts',startArgs]]) {
   const operation_id=args.operation_id+'_rollback';
   const rpc=await (await call(name,{...args,operation_id})).json();
   assert.equal(rpc.result.isError,true);
   const error=JSON.parse(rpc.result.content[0].text);
   assert.equal(error.error,'operation_failed');
   assert.equal(error.write_action,name);
   assert.equal(error.failure_stage,'save_request');
   assert.equal(error.say_to_owner,`I could not confirm that the ${name==='start_session'?'start':'send'} request was saved.`);
   assert.equal(error.retry_same_operation,true);
   assert.equal((await db.query('SELECT 1 FROM '+table+' WHERE operation_id=$1',[operation_id])).rows.length,0);
  }
  assert.equal(gateCalls.filter(path=>path==='/signal').length,2,'failed commits do not wake the connector');
 } finally {
  failWake(new Error('connector wake unavailable'));
  await blockedWake.catch(()=>{});
  await Promise.all(pending);
 }
});

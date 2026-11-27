import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {visibleView,listVisibleSessions,REVIEW_RULES,snapshotDiagnostics} from '../private/visible.mjs';
import {addVisibleContext,CONTEXT_CHARACTERS} from '../private/visible-context.mjs';
import {voiceView,readableExcerpt} from '../private/voice-view.mjs';
import {WakeGate,gateClient} from '../private/gate.mjs';
const dashboard=JSON.parse(await readFile(new URL('./fixtures/dashboard.json',import.meta.url)));
const directoryDashboard=JSON.parse(await readFile(new URL('./fixtures/dashboard-directories.json',import.meta.url)));
const runtime={available:true,partial:false,checked_at:100000,dashboard,statuses:Array.from({length:381},(_,i)=>({session_id:`old-${i}`,status:'done'}))};
test('MCP counts match the real rendered UI fixture, not 381 old done turns',()=>{
  const result=visibleView(runtime,{mac_seen_recently:true},100001);
  assert.equal(result.exact,true);
  assert.equal(result.counts.total,5);
  assert.equal(result.counts.needs_input,1);
  assert.equal(result.counts.task_done,1);
  assert.equal(result.counts.project_done,1);
  assert.equal(result.counts.idle,1);
  assert.deepEqual(result.dashboard,dashboard);
  assert.deepEqual(result.review_ids,['opencode:host:needs','opencode:host:task','opencode:host:project']);
});
test('collapsed and paged rows retain group totals but not displayed counts',()=>{
  const copy=structuredClone(runtime);copy.dashboard.sessions[2].listed=false;copy.dashboard.groups[2].listed=0;
  const result=visibleView(copy,{mac_seen_recently:true},100001);
  assert.equal(result.counts.task_done,1);assert.equal(result.displayed_counts.task_done,0);
});
test('no UI, stale UI, partial UI and old connector never fall back to history',()=>{
  const missing=visibleView({...runtime,dashboard:undefined},{mac_seen_recently:true},100001);
  assert.equal(missing.available,false);assert.equal(missing.counts,null);
  for(const r of [{...runtime,dashboard:{...dashboard,partial:true}},runtime]) {
    const result=visibleView(r,{mac_seen_recently:true},140001);
    assert.equal(result.exact,false);assert.deepEqual(result.review_ids,[]);
  }
});
test('native-only writes retain the last dashboard for that source and mark it stale',async()=>{
  const map=new Map();
  const storage={get:async k=>Array.isArray(k)?new Map(k.filter(key=>map.has(key)).map(key=>[key,map.get(key)])):map.get(k),
    put:async (entries,value)=>{for(const [key,item] of typeof entries==='string'?[[entries,value]]:Object.entries(entries))map.set(key,structuredClone(item));},transaction:async fn=>fn(storage)};
  const gate=gateClient({idFromName:()=>0,get:()=>({fetch:(url,init)=>new WakeGate({storage}).fetch(new Request(url,init))})},'owner');
  const principal={owner_id:'owner',device_id:'d',database_epoch:'e'},source='d|e';
  const db={query:async()=>({rows:[]})};
  await gate.enroll({...principal,token_hash:'hash',expires_at:Date.now()+60_000});
  const native={available:true,partial:false,statuses:[{session_id:'history-only',status:'done'}]};
  const list=args=>listVisibleSessions({db,gate,principal},args);
  await gate.setRuntime('hash',native);
  assert.equal((await list({})).counts,null);
  assert.equal((await snapshotDiagnostics(gate,principal)).state,'unavailable');
  const observed={...dashboard,captured_at:Date.now()-2_000};
  await gate.setRuntime('hash',{...native,dashboard:observed});
  const original=await snapshotDiagnostics(gate,principal);
  assert.equal(original.state,'fresh');
  assert.equal(visibleView(await gate.runtime(source),{mac_seen_recently:true}).exact,true);
  const trace={read_at:Date.now(),read_source:'desktop',read_result:'expired',previous_upload_at:original.runtime_stored_at,previous_upload_result:'ok'};
  for(let i=0;i<2;i++)await gate.setRuntime('hash',{...native,snapshot_trace:trace,statuses:[{session_id:'history-only',status:'working'}]});
  const diagnostic=await snapshotDiagnostics(gate,principal);
  assert.equal(diagnostic.state,'stale');
  assert.deepEqual(diagnostic.reasons,['latest_upload_omitted_snapshot']);
  assert.equal(diagnostic.snapshot_stored_at,original.snapshot_stored_at);
  assert.equal(diagnostic.snapshot_captured_at,observed.captured_at);
  assert.equal(diagnostic.session_count,5);
  assert.deepEqual(diagnostic.connector,trace);
  assert(!JSON.stringify(diagnostic).includes('Needs test'));
  const saved=await gate.runtime(source);
  assert.deepEqual(saved.dashboard,observed);
  assert.equal(saved.statuses[0].status,'working');
  assert.equal((await gate.runtime('d|other-epoch')).dashboard,undefined);
  assert.deepEqual(visibleView(saved,{mac_seen_recently:true}).review_ids,[]);
  for(const [args,total] of [[{},5],[{directory:'/work'},4]]) {
    const value=await list(args);
    assert.equal(value.counts.total,total);
    assert.match(value.warning,/last observed [(][0-9]+ seconds ago[)]/);
    assert(!JSON.stringify(value).includes('history-only'));
  }
  // A real empty list replaces the old one and restores fresh results.
  await gate.setRuntime('hash',{...native,dashboard:{...observed,captured_at:Date.now(),sessions:[],groups:[]}});
  assert.deepEqual(await list({}),{counts:{total:0},directories:[]});
});
test('only fresh stalled/decision Working rows join the review queue, before Project Done',()=>{
  for(const extra of [{health:'potentially_stalled'},{reason:'question'}]) {
    const r={...runtime,statuses:[{session_id:'working',...extra}]};
    assert.deepEqual(visibleView(r,{mac_seen_recently:true},100001).review_ids,['opencode:host:needs','opencode:host:task','opencode:host:working','opencode:host:project']);
    assert.deepEqual(visibleView({...r,partial:true},{mac_seen_recently:true},100001).review_ids,['opencode:host:needs','opencode:host:task','opencode:host:project']);
  }
  assert.match(REVIEW_RULES,/Never ask whether to close/);
});
test('cached visible list has a short wait, but first snapshot and other callers keep the bootstrap budget',async t=>{
  const now=Date.now();
  t.mock.timers.enable({apis:['Date','setTimeout'],now});
  const principal={owner_id:'owner',device_id:'d',database_epoch:'e'},source='d|e';
  const metaKey='runtime_meta:'+source;
  const map=new Map([['last_seen:'+source,now],['runtime_checked:'+source,now-40_000]]);
  const storage={get:async key=>Array.isArray(key)?new Map():map.get(key),put:async values=>{for(const [k,v] of Object.entries(values))map.set(k,v);},transaction:async fn=>fn(storage)};
  const object=new WakeGate({storage}),gate=gateClient({idFromName:()=>0,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})},'owner');
  const db={query:async()=>({rows:[]})};
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const list=()=>listVisibleSessions({db,gate,principal},{});

  let firstDone=false;
  const first=list().then(result=>{firstDone=true;return result;});
  await flush();
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(firstDone,false,'the wait for the first snapshot is not shortened');
  map.set(metaKey,{...runtime,checked_at:Date.now(),dashboard:{...dashboard,captured_at:Date.now()}});
  map.set('runtime_checked:'+source,Date.now());
  await gate.activity(source); // Wakes the pending read as a production upload does.
  const fresh=await first;
  assert.equal(fresh.counts.total,5);
  assert.doesNotMatch(fresh.warning??'',/last observed/);

  t.mock.timers.tick(40_000);
  const cached=list();
  await flush();
  t.mock.timers.tick(1500);
  const fallback=await cached;
  assert.deepEqual(fallback.counts,fresh.counts);
  assert.match(fallback.warning,/last observed [(]42 seconds ago[)]/);
  assert.equal(map.get(metaKey).dashboard.captured_at,now+1500);

  let otherDone=false;
  const other=gate.activity(source,true,'runtime').then(()=>{otherDone=true;});
  await flush();
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(otherDone,false);
  t.mock.timers.tick(6500);
  await other;
});

test('inventory stays UI-owned; history enrichment only queries the selected directory IDs',async()=>{
  const fresh={...runtime,checked_at:Date.now(),dashboard:{...dashboard,captured_at:Date.now()}};
  let selected;
  const db={query:async(sql,args)=>{assert.match(sql,/^SELECT /);assert.equal(selected,undefined,'one query suffices');selected=args;return {rows:[]};}};
  const result=await listVisibleSessions({db,principal:{owner_id:'owner',device_id:'d',database_epoch:'e'},gate:{activity:async()=>({mac_seen_recently:true}),runtime:async()=>fresh}},{directory:'/work'});
  assert.equal(result.counts.total,4);
  assert.deepEqual(selected.slice(0,3),['owner','d','e']);
  assert.deepEqual(selected[3].sort(),['idle','needs','task','working']);
  assert(result.directories[0].sessions.every(s=>s.user===null&&s.agent===null));
  assert.match(result.warning,/context is unavailable/);
  assert(fresh.dashboard.sessions.every(s=>!('recent_messages' in s)));
});

test('directory grouping matches actual UI directory headers, counts, membership and worktree folding',()=>{
  const result=visibleView({...runtime,dashboard:directoryDashboard},{mac_seen_recently:true},100001);
  assert.deepEqual(result.directories.map(d=>[d.directory_id,d.label,d.counts.total]),directoryDashboard.groups.map(g=>[g.key,g.label,g.total]));
  for(const d of result.directories) {
    const ui=directoryDashboard.sessions.filter(s=>s.group_key===d.directory_id);
    assert.deepEqual([...d.sessions,...d.working].map(s=>s.id).sort(),ui.map(s=>s.id).sort());
    for(const category of ['needs_input','working','task_done','project_done','idle'])assert.equal(d.counts[category],ui.filter(s=>s.category===category).length);
  }
  const work=result.directories.find(d=>d.path==='/work');
  assert.deepEqual(work.sessions.map(s=>s.category),['needs_input','task_done','idle']);
  assert.deepEqual(work.working.map(s=>s.id),['opencode:host:working']);
  assert.deepEqual(work.review_ids,['opencode:host:needs','opencode:host:task']);
  assert.equal(work.sessions.find(s=>s.session_id==='task').directory,'/work/.claude/worktrees/feature');
});
test('directory selection accepts exact ID or project path, does not broaden UI filters or change IDs',()=>{
  for(const directory of ['cwd:/work','/work']) {
    const r=visibleView({...runtime,dashboard:directoryDashboard},{mac_seen_recently:true},100001,{directory});
    assert.equal(r.directories.length,1);assert.equal(r.counts.total,4);assert.equal(r.dashboard_counts.total,5);
    assert.deepEqual(r.review_ids,['opencode:host:needs','opencode:host:task']);
    assert.deepEqual(r.directories[0].working.map(s=>s.id),['opencode:host:working']);
  }
  const filtered={...directoryDashboard,filter:'Needs test',sessions:directoryDashboard.sessions.filter(s=>s.session_id==='needs')};
  assert.equal(visibleView({...runtime,dashboard:filtered},{mac_seen_recently:true},100001,{directory:'/work'}).counts.total,1);
  const missing=visibleView(runtime,{mac_seen_recently:true},100001,{directory:'/not-visible'});
  assert.deepEqual(missing.directories,[]);assert.equal(missing.counts.total,0);assert.equal(missing.directory_found,false);
});
test('a fresh stalled Working row is reviewed only in its selected directory',()=>{
  const r={...runtime,statuses:[{session_id:'working',health:'potentially_stalled'}]};
  assert.deepEqual(visibleView(r,{mac_seen_recently:true},100001,{directory:'/work'}).directories[0].review_ids,['opencode:host:needs','opencode:host:task','opencode:host:working']);
  assert.deepEqual(visibleView(r,{mac_seen_recently:true},100001,{directory:'/other'}).directories[0].review_ids,['opencode:host:project']);
});

test('overview context has a shared Unicode budget and never leaks a matching ID from another provider',async()=>{
 const rows=Array.from({length:400},(_,i)=>({...dashboard.sessions[0],id:`opencode:host:s${i}`,session_id:`s${i}`}));
 rows.push({...rows[0],id:'codex:host:s0',provider:'Codex'});
 const view=visibleView({...runtime,dashboard:{...dashboard,sessions:rows}},{mac_seen_recently:true},100001);
 const db={query:async(sql,args)=>({rows:args?args[3].map(session_id=>({session_id,synced_at:new Date(100000),recent_messages:Array.from({length:2},(_,i)=>({message_id:`m${i}`,message_order:i,role:i%2?'assistant':'user',total_characters:10000,text_head:'🧪'.repeat(args[4])}))})):[]})};
 const result=await addVisibleContext({db,principal:{owner_id:'o',device_id:'d',database_epoch:'e'},runtime,freshness:{}},view);
 const sessions=result.directories.flatMap(d=>[...d.sessions,...d.working]);
 const characters=sessions.flatMap(s=>s.recent_messages).reduce((n,m)=>n+[...(m.text??'')].length,0);
 assert(characters<=CONTEXT_CHARACTERS);
 assert(result.context_budget.budget_limited_sessions>0);
 assert(sessions.some(s=>s.context_synced_at===new Date(100000).toISOString()));
 const other=sessions.find(s=>s.provider==='Codex');
 assert.equal(other.context_state,'unsupported_provider');assert.deepEqual(other.recent_messages,[]);
 assert(result.dashboard.sessions.every(s=>!('recent_messages' in s)));
});

test('voice response keeps UI membership and ordering without duplicate IDs, zero counts or debugger fields',()=>{
 const internal=visibleView(runtime,{mac_seen_recently:true},100001);
 for(const d of internal.directories)for(const s of [...d.sessions,...d.working]) {
  s.context_state='available';s.context_fresh=true;
  s.recent_messages=[{role:'user',text:'Ship the layout.'},{role:'assistant',text:'Deployed and verified.'}];
 }
 const result=voiceView(internal);
 assert.deepEqual(Object.keys(result),['counts','directories']);
 assert(!('scheduled' in result.counts));
 const work=result.directories.find(d=>d.path==='/work');
 assert.deepEqual(Object.keys(work),['path','label','counts','sessions','working']);
 assert.deepEqual(work.sessions.map(s=>s.status),['needs_input','task_done','idle']);
 assert.deepEqual(Object.keys(work.sessions[0]),['id','title','status','user','agent']);
 assert.equal(work.sessions[0].agent,'Deployed and verified.');
 assert(!JSON.stringify(result).includes('review_ids'));
 const stalled=voiceView(visibleView({...runtime,statuses:[{session_id:'working',health:'potentially_stalled'}]},{mac_seen_recently:true},100001));
 assert.equal(stalled.directories.find(d=>d.path==='/work').working[0].review,true);
 const missing=voiceView(visibleView({...runtime,dashboard:undefined},{},100001));
 assert.equal(missing.counts,null);assert.deepEqual(missing.directories,[]);assert.match(missing.warning,/unavailable/);
 const stale=voiceView(visibleView(runtime,{mac_seen_recently:true},140001));
 assert.match(stale.warning,/stale or partial/);
});

test('long excerpts preserve complete opening and concluding units, never chopped fragments',()=>{
 const text='The shared layout is deployed. Final checks passed for the hero, cards and responsive layout. Additional implementation detail follows.';
 const cut=readableExcerpt({text_head:text.slice(0,100),total_characters:text.length},100);
 assert.equal(cut,'The shared layout is deployed. Final checks passed for the hero, cards and responsive layout. …');
 const word=readableExcerpt({text_head:'Updated the research page without changing',total_characters:200},34);
 assert.equal(word,null);
 assert.equal(readableExcerpt({text_head:'Done 🧪',total_characters:6},600),'Done 🧪');
 const unicode=readableExcerpt({text_head:'🧪'.repeat(100),total_characters:200},40);
 assert.equal(unicode,null);
 const long='Opening task delivered. '+'More implementation details. '.repeat(30)+'Final checks passed. No work remains.';
 const balanced=readableExcerpt({text_head:long.slice(0,100),text_tail:long.slice(-100),total_characters:long.length},100);
 assert(balanced.startsWith('Opening task delivered.'));assert(balanced.endsWith('No work remains.'));assert([...balanced].length<=100);
 const markdown=readableExcerpt({text_head:'**Scheduled for November 30.** '+'Implementation continues '.repeat(20),text_tail:'some cut fragment\n\n**Final checks passed.** Nothing remains.',total_characters:1000},120);
 assert(markdown.includes('**Scheduled for November 30.**'));assert(markdown.endsWith('**Final checks passed.** Nothing remains.'));
});

test('Scheduled and Paused are excluded by default; opt-in still cannot reveal hidden history',()=>{
 const shelved=[{...dashboard.sessions[0],id:'opencode:host:scheduled',session_id:'scheduled',category:'scheduled'},{...dashboard.sessions[0],id:'opencode:host:paused',session_id:'paused',category:'paused'}];
 const r={...runtime,dashboard:{...dashboard,sessions:[...dashboard.sessions,...shelved]},statuses:[...runtime.statuses,{session_id:'hidden-history',status:'done'}]};
 const main=voiceView(visibleView(r,{mac_seen_recently:true},100001));
 assert.equal(main.counts.total,5);assert(!('scheduled' in main.counts));assert(!('paused' in main.counts));
 const all=voiceView(visibleView(r,{mac_seen_recently:true},100001,{include_scheduled_and_paused:true}));
 assert.equal(all.counts.total,7);assert.equal(all.counts.scheduled,1);assert.equal(all.counts.paused,1);
 assert(!all.directories.flatMap(d=>[...d.sessions,...d.working]).some(s=>s.id.includes('hidden-history')));
});

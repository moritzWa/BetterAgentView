import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {visibleView,listVisibleSessions,REVIEW_RULES} from '../private/visible.mjs';
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
test('only fresh stalled/decision Working rows join the review queue, before Project Done',()=>{
  for(const extra of [{health:'potentially_stalled'},{reason:'question'}]) {
    const r={...runtime,statuses:[{session_id:'working',...extra}]};
    assert.deepEqual(visibleView(r,{mac_seen_recently:true},100001).review_ids,['opencode:host:needs','opencode:host:task','opencode:host:working','opencode:host:project']);
    assert.deepEqual(visibleView({...r,partial:true},{mac_seen_recently:true},100001).review_ids,['opencode:host:needs','opencode:host:task','opencode:host:project']);
  }
  assert.match(REVIEW_RULES,/Never ask whether to close/);
});
test('tool reads only the dashboard channel, never SQL history',async()=>{
  const fresh={...runtime,checked_at:Date.now(),dashboard:{...dashboard,captured_at:Date.now()}};
  const result=await listVisibleSessions({principal:{device_id:'d',database_epoch:'e'},gate:{activity:async()=>({mac_seen_recently:true}),runtime:async()=>fresh}});
  assert.equal(result.counts.total,5);
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

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {visibleView,listVisibleSessions,REVIEW_RULES} from '../private/visible.mjs';
const dashboard=JSON.parse(await readFile(new URL('./fixtures/dashboard.json',import.meta.url)));
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

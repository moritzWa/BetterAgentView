import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RuntimeSnapshot} from '../private/runtime.mjs';

// The Rust producer asserts byte-for-field parity with this same fixture.
// Adding a connector field without updating the strict Worker rejects every
// snapshot, freezing all statuses even while heartbeats/history keep working.
const status=JSON.parse(readFileSync(new URL('./fixtures/runtime-status.json',import.meta.url),'utf8'));
const snapshot=status=>({available:true,partial:false,truncated:false,statuses:[status]});
test('accept the exact native Rust status contract, including completion',()=>{
  assert.deepEqual(RuntimeSnapshot.parse(snapshot(status)),snapshot(status));
  for(const completion of ['unconfirmed','task_done','project_done']) {
    assert.equal(RuntimeSnapshot.parse(snapshot({...status,completion})).statuses[0].completion,completion);
  }
});
test('older connectors remain compatible while unknown fields still fail closed',()=>{
  const {completion,...older}=status;
  assert.equal(RuntimeSnapshot.parse(snapshot(older)).statuses[0].completion,'unconfirmed');
  assert.equal(RuntimeSnapshot.safeParse(snapshot({...status,completion:'invented'})).success,false);
  assert.equal(RuntimeSnapshot.safeParse(snapshot({...status,private_tool_output:'never accept'})).success,false);
});

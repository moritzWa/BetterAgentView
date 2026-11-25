import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as old from './compat/previous-contract.mjs';
import * as current from '../contracts/contract.mjs';
import {nativeSchemas,PollResponse,toolOutputs} from '../contracts/responses.mjs';
const fixture=async name=>JSON.parse(await readFile(new URL('./fixtures/'+name,import.meta.url),'utf8'));

test('compatibility baseline is pinned to a shipped commit, never regenerated with current code',async()=>{
  const provenance=JSON.parse(await readFile(new URL('./compat/baseline.json',import.meta.url),'utf8'));
  const source=await readFile(new URL('./compat/previous-contract.mjs',import.meta.url));
  assert.match(provenance.commit,/^[a-f0-9]{40}$/);
  assert(Object.keys(provenance.files).length>=10);
  assert.equal(createHash('sha256').update(source).digest('hex'),provenance.sha256);
  for(const [path,hash] of Object.entries(provenance.files))assert.equal(createHash('sha256').update(await readFile(new URL('./compat/previous/'+path.slice(7),import.meta.url))).digest('hex'),hash,path);
});
test('old connector -> new server AND new connector -> old server request matrix',async()=>{
  const fixtures=await fixture('wire-payloads.json');
  fixtures.RuntimeSnapshot={available:true,partial:false,truncated:false,statuses:[await fixture('runtime-status.json')]};
  for(const [name,value] of Object.entries(fixtures)) {
    // A request type the previous release never sent (an additive route) has no old side.
    if(!old.wireSchemas[name]){assert(current.wireSchemas[name].safeParse(value).success,`new ${name}`);continue;}
    const before=old.wireSchemas[name].parse(value),after=current.wireSchemas[name].parse(value);
    assert(current.wireSchemas[name].safeParse(before).success,`old -> new ${name}`);
    assert(old.wireSchemas[name].safeParse(after).success,`new -> old ${name}`);
  }
  for(const status of current.Status.options)assert(old.Status.safeParse(status).success,'new status unsupported by previous server');
  for(const [name,path] of Object.entries(old.routes))assert.equal(current.routes[name],path,name);
  assert(current.limits.cursorBatch<=old.limits.cursorMax);
  assert(old.limits.cursorBatch<=current.limits.cursorMax);
});
test('new connector accepts previous server responses; additive fields are compatible',async()=>{
  const responses=await fixture('previous-responses.json');
  assert.deepEqual(Object.keys(responses).sort(),Object.keys(nativeSchemas).sort());
  for(const [name,value] of Object.entries(responses)) {
    assert(nativeSchemas[name].safeParse(value).success,name);
    assert(nativeSchemas[name].safeParse({...value,future_metadata:42}).success,name);
  }
  // Previous connector consumes exactly these fields. New monitoring is optional.
  const next=PollResponse.parse({...responses.PollResponse,runtime_alert:{incident:1,stale_for_ms:120000}});
  for(const key of ['pending','generation','active_until'])assert.deepEqual(next[key],responses.PollResponse[key]);
});
test('malformed successful responses fail closed, rather than looking like an empty queue',()=>{
  for(const name of ['PollResponse','LeaseResponse','StartLeaseResponse','BatchResponse'])assert.equal(nativeSchemas[name].safeParse({}).success,false,name);
  assert.equal(nativeSchemas.PollResponse.safeParse({pending:'false',generation:0,active_until:0}).success,false);
  assert.equal(toolOutputs.read_message.safeParse({text:'missing message identity'}).success,false);
});

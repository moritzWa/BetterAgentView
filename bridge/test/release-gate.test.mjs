import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeConnection,matchesObservation,verifyTransitions} from '../release/gate.mjs';

test('native service and retained supervisor discovery both work, remote endpoints fail closed',()=>{
  const native=nativeConnection({version:'2.0.32-local.test',url:'http://127.0.0.1:1234',password:'fixture'});
  assert.deepEqual(native,nativeConnection({api:'v2',port:1234,username:'opencode',password:'fixture'}));
  for(const url of ['https://example.com','http://example.com','http://user@127.0.0.1:1234','http://127.0.0.1:1234/private'])assert.throws(()=>nativeConnection({version:'2.0',url,password:'fixture'}));
  assert.throws(()=>nativeConnection({api:'v1',port:1234,password:'fixture'}));
});

const observation=(status,at=1000)=>({status_fresh:true,mac_seen_recently:true,partial:false,truncated:false,status_observed_at:at,sessions:status==='absent'?[]:[{session_id:'ses_fixture',status}]});
test('freshness, correct identity and post-transition observations are all required',()=>{
  const expected={id:'ses_fixture',status:'working',since:1000,now:2000};
  const fresh=observation('working');assert(matchesObservation(fresh,expected));
  for(const bad of [
    {...fresh,status_fresh:false},{...fresh,mac_seen_recently:false},{...fresh,partial:true},{...fresh,truncated:true},
    {...fresh,status_observed_at:999},{...fresh,status_observed_at:2001},{...fresh,status_observed_at:null},
    {...fresh,sessions:[{session_id:'ses_other',status:'working'}]},observation('done'),
  ])assert.equal(matchesObservation(bad,expected),false);
  assert.equal(matchesObservation(fresh,{...expected,now:31_000}),false);
});

function driver({stale=false,neverWorks=false,stopFails=false,removeFails=false}={}) {
  let now=1000,state='done';const calls=[];
  return {calls,now:()=>now,sleep:async ms=>{now+=ms;},
    create:async()=>{calls.push('create');return {id:'ses_fixture'};},
    start:async()=>{calls.push('start');state=neverWorks?'done':'working';return {id:'sh_fixture'};},
    stop:async()=>{calls.push('stop');if(stopFails)throw new Error('stop failed');state='done';},
    remove:async()=>{calls.push('remove');if(removeFails)throw new Error('remove failed');state='absent';},
    read:async()=>{calls.push('mcp');return observation(state,stale?1:now);},
    finish:async()=>{calls.push('finish');},
  };
}
test('gate proves idle -> working -> idle -> removed through the reader',async()=>{
  const io=driver();const observed=await verifyTransitions(io);
  assert.deepEqual(observed.map(x=>x.status),['done','working','done','absent']);
  assert.deepEqual(io.calls,['create','mcp','start','mcp','stop','mcp','remove','mcp','finish']);
});
test('a recent heartbeat with frozen runtime cannot pass and still cleans up',async()=>{
  const io=driver({stale:true});await assert.rejects(verifyTransitions(io,{timeoutMs:3,pollMs:1}),/timed out/);
  assert(io.calls.includes('remove'));assert.equal(io.calls.at(-1),'finish');assert(!io.calls.includes('start'));
});
test('seeing only idle never proves the working transition',async()=>{
  const io=driver({neverWorks:true});await assert.rejects(verifyTransitions(io,{timeoutMs:3,pollMs:1}),/fresh working/);
  assert(io.calls.includes('stop'));assert(io.calls.includes('remove'));assert.equal(io.calls.at(-1),'finish');
});
test('post-stop timeout identifies the phase and reports native and MCP state without session content',async()=>{
  const io=driver();
  io.stop=async()=>{io.calls.push('stop');};
  io.describe=async()=>({active:'not_running',shell:'absent',process_alive:false});
  await assert.rejects(verifyTransitions(io,{timeoutMs:3,pollMs:1}),error=>{
    const diagnostic=JSON.parse(error.message.slice(error.message.indexOf('{')));
    assert.equal(diagnostic.phase,'after_stop');
    assert.deepEqual(diagnostic.last.statuses,['working']);
    assert.deepEqual(diagnostic.native,{active:'not_running',shell:'absent',process_alive:false});
    assert(!error.message.includes('ses_fixture'));
    return true;
  });
  assert.equal(io.calls.at(-1),'finish');
});
test('cleanup failure blocks a green gate, without skipping credential cleanup',async()=>{
  for(const options of [{stopFails:true},{removeFails:true}]) {
    const io=driver(options);await assert.rejects(verifyTransitions(io,{timeoutMs:3,pollMs:1}),/cleanup failed/);
    assert.equal(io.calls.at(-1),'finish');
  }
});

test('operator deploys cannot report success without the live gate',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts.deploy,'node release/deploy.mjs');
  assert.equal(pkg.scripts['verify:live'],'node release/live.mjs');
  const deploy=await readFile(new URL('../release/deploy.mjs',import.meta.url),'utf8');
  assert(deploy.indexOf('await invalidateReceipt()')<deploy.indexOf("execFileSync('wrangler'"));
  assert(deploy.indexOf("execFileSync('wrangler'")<deploy.indexOf('await runLiveGate()'));
  const driver=await readFile(new URL('../release/live.mjs',import.meta.url),'utf8');
  assert(!driver.includes('/prompt'),'the gate must never invoke a model');
  assert(!driver.includes('/v1/connector/runtime'),'the gate must not simulate status publications');
  assert(!driver.includes('sync-once'),'the gate must observe the actual daemon, not manually sync');
});

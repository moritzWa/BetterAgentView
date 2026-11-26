import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeWatch,WATCH} from '../private/runtime-watch.mjs';
import {WakeGate} from '../private/gate.mjs';
test('fresh heartbeats cannot conceal frozen runtime; one incident survives repeated polls',()=>{
  let state={},now=1_000_000;
  const runtime_checked=now;
  for(let i=0;i<8;i++){state=runtimeWatch(now,{last_seen:now-20_000,runtime_checked,active_until:now+300_000,active_since:runtime_checked},state);now+=20_000;}
  assert(state.incident);const incident=state.incident;
  state=runtimeWatch(now,{last_seen:now-20_000,runtime_checked,active_until:now+300_000,active_since:runtime_checked},state);
  assert.equal(state.incident,incident);
  state=runtimeWatch(now+10_000,{last_seen:now,runtime_checked,active_until:0},state);
  assert.equal(state.incident,incident,'ending the phone activity window is not a recovery');
  state=runtimeWatch(now+20_000,{last_seen:now,runtime_checked:now+20_000,active_until:now+300_000},state);
  assert.equal(state.incident,null);
});
test('sleep/offline, startup and normal 15-minute idle sync do not alert',()=>{
  let state={},now=1_000_000;
  for(let i=0;i<50;i++){state=runtimeWatch(now,{last_seen:now-20_000,runtime_checked:1_000_000,active_until:0},state);assert.equal(state.incident,null);now+=20_000;}
  state=runtimeWatch(now+WATCH.idleStale,{last_seen:now+WATCH.idleStale,runtime_checked:1_000_000,active_until:now+2*WATCH.idleStale},state);
  assert.equal(state.incident,null,'a checked call after waking must not hide the poll gap');
});
test('idle runtime outage and never-published runtime are detected after their cadence',()=>{
  for(const runtime_checked of [null,1_000_000]){
    let state={};
    for(let now=1_000_000;now<=1_000_000+WATCH.idleStale+20_000;now+=20_000)state=runtimeWatch(now,{last_seen:now-20_000,runtime_checked},state);
    assert(state.incident);
  }
});
test('durable gate returns an alert through real poll responses, deduplicates, then recovers',async()=>{
  const now=Date.now(),source='device|epoch',map=new Map([
    ['token:hash',{device_id:'device',database_epoch:'epoch',expires_at:now+3600_000}],
    [`pending:${source}`,true],[`last_seen:${source}`,now-20_000],
    [`active_until:${source}`,now+300_000],['active_since:'+source,now-180_000],[`runtime_checked:${source}`,now-180_000],
    [`runtime_meta:${source}`,{available:true,partial:false}],
    [`runtime_watch:${source}`,{since:now-180_000,last_poll:now-20_000,incident:null}],
  ]);
  const storage={get:async k=>Array.isArray(k)?new Map(k.filter(k=>map.has(k)).map(k=>[k,map.get(k)])):map.get(k),put:async(k,v)=>{for(const [key,value] of typeof k==='object'?Object.entries(k):[[k,v]])map.set(key,value);}};
  const gate=new WakeGate({storage});
  const call=async(path,p={})=>(await gate.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify({token_hash:'hash',...p})}))).json();
  const first=await call('/poll');assert(first.runtime_alert);
  assert.equal((await call('/poll')).runtime_alert.incident,first.runtime_alert.incident);
  await call('/runtime-write',{snapshot:{available:true,partial:false,truncated:false,statuses:[]}});
  assert.equal((await call('/poll')).runtime_alert,null);
});

test('the 279s and 863s idle-to-active wakes allow a fresh publication before alerting',()=>{
  const published=1_000_000;
  for(const idleSeconds of [279,863]){
    const wake=published+idleSeconds*1000,active_until=wake+300_000;
    let state={};
    for(let now=published;now<wake;now+=20_000)
      state=runtimeWatch(now,{runtime_checked:published,active_until:0},state);
    state=runtimeWatch(wake,{runtime_checked:published,active_until,active_since:wake},state);
    assert.equal(state.incident,null, 'idle snapshot is not an active publication outage');
    const healthy=runtimeWatch(wake+3000,{runtime_checked:wake+3000,active_until,active_since:wake},state);
    assert.equal(healthy.incident,null);
    for(let now=wake+20_000;now<=wake+120_000;now+=20_000)
      state=runtimeWatch(now,{runtime_checked:published,active_until,active_since:wake},state);
    assert.equal(state.incident,wake+120_000,'a real active failure still alerts');
  }
});

test('MCP calls renew one active window and a request after expiry starts a new one',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1_000_000});
  const source='fixture|epoch',map=new Map();
  const storage={get:async k=>map.get(k),put:async entries=>{for(const [k,v] of Object.entries(entries))map.set(k,v);},transaction:async fn=>fn(storage)};
  const touch=async()=>{
    // Recreate the object to prove the window does not depend on in-memory state.
    const response=await new WakeGate({storage}).fetch(new Request('https://internal/activity',{method:'POST',body:JSON.stringify({source})}));
    assert.equal(response.status,200);
  };
  await touch();
  t.mock.timers.setTime(1_290_000);await touch();
  assert.equal(map.get('active_since:'+source),1_000_000);
  assert.equal(map.get('active_until:'+source),1_590_000);
  t.mock.timers.setTime(1_590_000);await touch();
  assert.equal(map.get('active_since:'+source),1_590_000);
});

test('one partial upload does not erase the last usable runtime publication',async t=>{
  const now=1_684_000,source='fixture|epoch';
  t.mock.timers.enable({apis:['Date'],now:now-12_000});
  const map=new Map([
    ['token:hash',{device_id:'fixture',database_epoch:'epoch',expires_at:now+3600_000}],
    ['pending:'+source,true],['active_until:'+source,now+300_000],['active_since:'+source,now-300_000],
    ['runtime_watch:'+source,{since:now-684_000,last_poll:now-20_000,incident:null}],
  ]);
  const storage={get:async k=>Array.isArray(k)?new Map(k.filter(k=>map.has(k)).map(k=>[k,map.get(k)])):map.get(k),put:async (k,v)=>{for(const [key,value] of typeof k==='object'?Object.entries(k):[[k,v]])map.set(key,value);}};
  const gate=new WakeGate({storage});
  const call=async(path,p={})=>(await gate.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify({token_hash:'hash',...p})}))).json();
  const snapshot=partial=>({available:true,partial,truncated:false,statuses:[]});
  await call('/runtime-write',{snapshot:snapshot(false)});
  t.mock.timers.setTime(now);
  await call('/runtime-write',{snapshot:snapshot(true)});
  assert.equal((await call('/poll')).runtime_alert,null);
  for(let at=now+20_000;at<now+120_000;at+=20_000){
    t.mock.timers.setTime(at);
    await call('/runtime-write',{snapshot:snapshot(true)});
    const {runtime_alert}=await call('/poll');
    assert.equal(Boolean(runtime_alert),at>=now-12_000+WATCH.activeStale);
  }
  t.mock.timers.setTime(now+120_000);
  await call('/runtime-write',{snapshot:snapshot(true)});
  assert((await call('/poll')).runtime_alert,'partial uploads cannot conceal a real failure');
  await call('/runtime-write',{snapshot:snapshot(false)});
  assert.equal((await call('/poll')).runtime_alert,null);
});

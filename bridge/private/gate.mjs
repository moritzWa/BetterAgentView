import {runtimeWatch} from './runtime-watch.mjs';
/** Durable wake metadata only, never chat text. Idle polls do not connect to Neon. */
function runtimeBucket(id){let hash=0;for(let i=0;i<id.length;i++)hash=(hash*31+id.charCodeAt(i))>>>0;return hash%64;}
const CALL_LOG_DAYS=14,CALL_LOG_HOUR_MAX=1500;
export class WakeGate {
  constructor(state) { this.state=state;this.waiters=new Set(); }
  async fetch(request) {
    const p=await request.json(),path=new URL(request.url).pathname,s=this.state.storage;
    if(path==='/enroll') { await s.put(`token:${p.token_hash}`,p);await s.put(`pending:${p.device_id}|${p.database_epoch}`,true);return Response.json({ok:true}); }
    if(path==='/revoke') { await s.delete(`token:${p.token_hash}`);for(const wake of this.waiters)wake();return Response.json({ok:true}); }
    if(path==='/signal') {
      const generation=await s.transaction(async tx=>{const n=(await tx.get(`generation:${p.source}`)??0)+1;await tx.put({[`generation:${p.source}`]:n,[`pending:${p.source}`]:true});return n;});
      for(const wake of this.waiters)wake();
      return Response.json({generation});
    }
    if(path==='/clear') {
      await s.transaction(async tx=>{if((await tx.get(`generation:${p.source}`)??0)===p.generation)await tx.put(`pending:${p.source}`,false);});
      return Response.json({ok:true});
    }
    if(path==='/rate') {
      const minute=Math.floor(Date.now()/60_000),key=`rate:${p.key}`;
      const allowed=await s.transaction(async tx=>{const old=await tx.get(key),n=old?.minute===minute?old.n+1:1;await tx.put(key,{minute,n});return n<=30;});
      return Response.json({allowed});
    }
    if(path==='/activity') {
      const now=Date.now(),untilKey='active_until:'+p.source,sinceKey='active_since:'+p.source;
      await s.transaction(async tx=>{
        const until=await tx.get(untilKey)??0;
        const since=until>now?(await tx.get(sinceKey)??now):now;
        await tx.put({[untilKey]:Math.max(until,now+5*60_000),[sinceKey]:since});
      });
      for(const wake of this.waiters)wake();
      const seen=await s.get(`last_seen:${p.source}`)??0;
      const historyAge=p.history_ms??5000,runtimeAge=p.runtime_ms??20_000,checks=p.kind==='both'?[['checked',historyAge],['runtime_checked',runtimeAge]]:[[p.kind==='runtime'?'runtime_checked':'checked',p.kind==='runtime'?runtimeAge:historyAge]];
      const fresh=async()=>{for(const [key,age] of checks)if((await s.get(`${key}:${p.source}`)??0)<now-age)return false;return true;};
      if(p.wait && seen>now-60_000 && !await fresh()) {
        // Only the visible list has a last-observed dashboard to fall back to.
        // Keep the old bootstrap budget when there is no dashboard at all.
        const meta=p.visible_list&&p.kind==='runtime'?await s.get(`runtime_meta:${p.source}`):null;
        const dashboard=meta?.dashboard;
        const wait=dashboard?1500:8000;
        const deadline=Date.now()+Math.min(wait,p.max_wait??8000);
        while(Date.now()<deadline && !await fresh()) {
          await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};this.waiters.add(wake);timer=setTimeout(wake,Math.max(1,deadline-Date.now()));});
        }
      }
      const checkedAt=await s.get(`checked:${p.source}`)??null,macSeen=seen>now-60_000,result={source_checked_at:checkedAt,mac_seen_recently:macSeen};
      if(p.kind!=='runtime') {
        // Say it outright when the page may lack the newest messages, so a caller
        // retries instead of presenting a stale tail as the latest.
        const history_fresh=checkedAt!==null&&checkedAt>=now-historyAge;
        const behind=await s.get(`behind:${p.source}`)??0,behindSince=await s.get(`behind_since:${p.source}`)??null;
        result.sessions_behind=behind;
        result.behind_for_ms=behind&&behindSince?Math.max(0,now-behindSince):null;
        result.history_fresh=history_fresh;
        result.history_age_ms=checkedAt===null?null:Math.max(0,Date.now()-checkedAt);
        if(!history_fresh)result.history_note=macSeen
          ?'The Mac is syncing: this may be missing the newest messages. Repeat the same call in about 5 seconds before relying on the latest messages.'
          :'The Mac has not been seen recently: history is only as current as source_checked_at.';
        if(!history_fresh&&macSeen)result.retry_after_ms=5000;
        if(behind)result.history_note=[result.history_note,`${behind} session${behind===1?' has':'s have'} not reached the cloud.`].filter(Boolean).join(' ');
      }
      return Response.json(result);
    }
    if(path==='/presence-read') {
      const source=p.source;
      return Response.json({
        last_seen:await s.get(`last_seen:${source}`)??null,
        checked:await s.get(`checked:${source}`)??null,
        sync_attempted:await s.get(`sync_attempted:${source}`)??null,
        sync_skipped:await s.get(`sync_skipped:${source}`)??0,
        behind:await s.get(`behind:${source}`)??0,
        behind_since:await s.get(`behind_since:${source}`)??null,
        runtime_checked:await s.get(`runtime_checked:${source}`)??null,
      });
    }
    if(path==='/changes') {
      // What became "needs you" or finished since the last call. Only busy sessions are kept, so the marker stays small.
      const source=p.source,keys=Array.from({length:64},(_,i)=>`runtime:${source}:${i}`);
      const meta=await s.get(`runtime_meta:${source}`)??{available:false,partial:false};
      if(!meta.available||meta.partial)return Response.json({available:false,baseline:false,changes:[]});
      const stored=await s.get(keys),statuses=keys.flatMap(k=>JSON.parse(stored.get(k)??'[]')).filter(x=>x.top_level!==false);
      return Response.json(await s.transaction(async tx=>{
        const old=await tx.get(`seen:${source}`),baseline=old===undefined,before=baseline?{}:JSON.parse(old),current={},changes=[];
        const ids=new Set(statuses.map(x=>x.session_id));
        if(meta.truncated)for(const [id,mark] of Object.entries(before))if(!ids.has(id))current[id]=mark;
        for(const x of statuses) {
          const mark=`${x.status}:${x.reason??''}`,prior=before[x.session_id];
          if(x.status==='needs_you'||x.status==='working')current[x.session_id]=mark;
          if(x.status==='needs_you'&&prior!==mark)changes.push({session_id:x.session_id,change:'needs_you',reason:x.reason??null,directory:x.directory??null});
          else if(x.status==='done'&&prior)changes.push({session_id:x.session_id,change:'finished',reason:null,directory:x.directory??null});
        }
        await tx.put(`seen:${source}`,JSON.stringify(current));
        return {available:true,baseline,changes,checked_at:meta.checked_at??null};
      }));
    }
    if(path==='/runtime-read') {
      const keys=Array.from({length:64},(_,i)=>`runtime:${p.source}:${i}`),stored=await s.get(keys);
      const meta=await s.get(`runtime_meta:${p.source}`)??{available:false,partial:false,checked_at:null};
      return Response.json({...meta,statuses:keys.flatMap(k=>JSON.parse(stored.get(k)??'[]'))});
    }
    if(path==='/call-log') {
      // Durations and counts only. One key per UTC hour keeps each value far below
      // the 128 KiB limit; hours older than the retention window are dropped as the
      // index rolls. The owner reads it with GET /v1/timings.
      const hour=new Date(p.record.t).toISOString().slice(0,13),key=`calls:${hour}`;
      const index=await s.get('calls_index')??[],keep=Date.now()-CALL_LOG_DAYS*86400_000;
      const live=index.filter(h=>Date.parse(h+':00:00Z')>=keep);
      const bucket=await s.get(key)??[];
      bucket.push(p.record);
      const puts={[key]:bucket.slice(-CALL_LOG_HOUR_MAX)};
      if(!live.includes(hour)){live.push(hour);live.sort();}
      puts.calls_index=live;
      await s.put(puts);
      for(const h of index)if(!live.includes(h))await s.delete(`calls:${h}`);
      return Response.json({ok:true});
    }
    if(path==='/call-log-read') {
      const since=Date.now()-(p.hours??24)*3600_000,index=(await s.get('calls_index')??[]).filter(h=>Date.parse(h+':59:59Z')>=since);
      const calls=[];
      for(let i=0;i<index.length;i+=100) {
        const keys=index.slice(i,i+100).map(h=>`calls:${h}`),stored=await s.get(keys);
        for(const k of keys)calls.push(...(stored.get(k)??[]));
      }
      return Response.json({calls:calls.filter(c=>c.t>=since),retention_days:CALL_LOG_DAYS});
    }
    if(path==='/probe') {
      // Ask the Mac about ONE session and wait for its answer. The poll that is
      // already open wakes at once, so this costs one status read on the Mac
      // instead of waiting for a whole-inventory publication.
      const now=Date.now(),seen=await s.get(`last_seen:${p.source}`)??0;
      if(seen<=now-60_000)return Response.json({answered:false,reason:'mac_not_seen'});
      const probe_id=crypto.randomUUID();
      await s.put({[`probe:${p.source}`]:{probe_id,session_id:p.session_id,taken:false,expires_at:now+10_000},[`probe_result:${p.source}`]:null});
      for(const wake of this.waiters)wake();
      const deadline=now+Math.min(8000,p.max_wait??3000);
      const read=async()=>{const r=await s.get(`probe_result:${p.source}`);return r&&r.probe_id===probe_id?r:null;};
      let result=await read();
      while(!result&&Date.now()<deadline) {
        await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};this.waiters.add(wake);timer=setTimeout(wake,Math.max(1,deadline-Date.now()));});
        result=await read();
      }
      return Response.json(result?{answered:true,status:result.status,observed_at:result.at,waited_ms:Date.now()-now}:{answered:false,reason:'timeout',waited_ms:Date.now()-now});
    }
    if(path==='/receipt-signal') {
      const key=`receipts:${p.source}`,recent=await s.get(key)??[];
      await s.put(key,[...recent.filter(r=>r!==p.operation_id),p.operation_id].slice(-32));
      for(const wake of this.waiters)wake();return Response.json({ok:true});
    }
    if(path==='/receipt-wait') {
      const deadline=Date.now()+8000,key=`receipts:${p.source}`;
      while(Date.now()<deadline && !(await s.get(key)??[]).includes(p.operation_id)) {
        await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};this.waiters.add(wake);timer=setTimeout(wake,Math.max(1,deadline-Date.now()));});
      }
      return Response.json({signalled:(await s.get(key)??[]).includes(p.operation_id)});
    }
    const credential=await s.get(`token:${p.token_hash}`);
    if(!credential || credential.expires_at<=Date.now())return Response.json({error:'unauthorized'},{status:401});
    const source=`${credential.device_id}|${credential.database_epoch}`;
    if(path==='/runtime-write') {
      const {statuses,...meta}=p.snapshot,now=Date.now(),buckets=Array.from({length:64},()=>[]);
      for(const status of statuses)buckets[runtimeBucket(status.session_id)].push(status);
      const metaKey=`runtime_meta:${source}`,keys=buckets.map((_,i)=>`runtime:${source}:${i}`);
      const usable=meta.available&&!meta.partial;
      const old=await s.get(meta.dashboard&&usable?keys:[...keys,metaKey]);
      // Native status keeps publishing when the desktop list is not being drawn.
      // Keep the prior list without renewing its capture time or claiming it is live.
      const retained=meta.dashboard?null:old.get(metaKey)?.dashboard;
      const storedAt=meta.dashboard?now:old.get(metaKey)?.dashboard_stored_at;
      const changed={[metaKey]:{...meta,...(retained?{dashboard:retained,dashboard_retained:true}:{}),...(storedAt?{dashboard_stored_at:storedAt}:{}),checked_at:now},[`runtime_checked:${source}`]:now,[`last_seen:${source}`]:now};
      // Partial writes are still visible to readers, but neither reset nor
      // erase the last usable publication for the watchdog. Save the old
      // stamp only on the transition, not on every successful heartbeat.
      const previous=old.get(metaKey);
      if(!usable&&previous?.available&&!previous.partial)
        changed['runtime_usable:'+source]=previous.checked_at;
      for(let i=0;i<buckets.length;i++) {
        const value=JSON.stringify(buckets[i].sort((a,b)=>a.session_id.localeCompare(b.session_id)));
        if(value!==(old.get(keys[i])??'[]'))changed[keys[i]]=value;
      }
      const event={received_at:now,captured_at:meta.dashboard?.captured_at??null,session_count:meta.dashboard?.sessions.length??null,retained:Boolean(retained)};
      try{await s.put(changed);}catch(error){console.error('bridge_dashboard_store_failed',event);throw error;}
      console.info('bridge_dashboard_runtime_stored',{...event,stored_at:Date.now()});
      for(const wake of this.waiters)wake();
      return Response.json({ok:true});
    }
    if(path==='/checked') {
      const now=Date.now(),complete=p.complete!==false,skipped=Number.isInteger(p.skipped)&&p.skipped>=0?p.skipped:0;
      const behind=Number.isInteger(p.behind)&&p.behind>=0&&p.behind<=100_000?p.behind:0;
      const since=Number.isFinite(p.behind_since)&&p.behind_since>0?p.behind_since:null;
      const put={[`last_seen:${source}`]:now,[`sync_attempted:${source}`]:now,[`sync_skipped:${source}`]:skipped,
        [`behind:${source}`]:behind,[`behind_since:${source}`]:behind?(since??await s.get(`behind_since:${source}`)??now):null};
      if(complete)put[`checked:${source}`]=now;
      await s.put(put);for(const wake of this.waiters)wake();
      return Response.json({ok:true,complete});
    }
    let probe=null;
    if(path==='/poll') {
      const meta=await s.get(`runtime_meta:${source}`);
      const old=await s.get('runtime_watch:'+source);
      const now=Date.now(),watch=runtimeWatch(now,{
        last_seen:await s.get('last_seen:'+source)??null,
        runtime_checked:meta?.available&&!meta.partial?(await s.get('runtime_checked:'+source)??null):(await s.get('runtime_usable:'+source)??null),
        active_until:await s.get('active_until:'+source)??0,
        active_since:await s.get('active_since:'+source)??null,
      },old??{});
      const diagnostic={snapshot_age_ms:watch.stale_for_ms,active_age_ms:watch.active_age_ms,poll_gap_ms:old?now-old.last_poll:null,available:meta?.available??false,partial:meta?.partial??false};
      if(watch.incident&&watch.incident!==old?.incident)console.error('bridge_runtime_publication_stale',diagnostic);
      if(!watch.incident&&old?.incident)console.info('bridge_runtime_publication_recovered',diagnostic);
      await s.put({[`last_seen:${source}`]:now,[`runtime_watch:${source}`]:watch});
      const probeWaiting=async()=>{const q=await s.get(`probe:${source}`);return Boolean(q&&!q.taken&&q.expires_at>Date.now());};
      if(!(await s.get(`pending:${source}`))&&!await probeWaiting()) {
        await new Promise(resolve=>{
          let timer;
          const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};
          this.waiters.add(wake);timer=setTimeout(wake,20_000);
        });
      }
      if(!(await s.get(`token:${p.token_hash}`)))return Response.json({error:'unauthorized'},{status:401});
      // Hand a waiting probe to exactly one poll.
      const q=await s.get(`probe:${source}`);
      if(q&&!q.taken&&q.expires_at>Date.now()) {
        await s.put(`probe:${source}`,{...q,taken:true});
        probe={probe_id:q.probe_id,session_id:q.session_id};
      }
    }
    if(path==='/probe-write') {
      const q=await s.get(`probe:${source}`);
      if(q&&q.probe_id===p.result.probe_id) {
        await s.put(`probe_result:${source}`,{probe_id:q.probe_id,status:p.result.status,at:Date.now()});
        for(const wake of this.waiters)wake();
      }
      return Response.json({ok:true});
    }
    const watch=await s.get(`runtime_watch:${source}`);
    return Response.json({probe,principal:credential,pending:await s.get(`pending:${source}`)??false,generation:await s.get(`generation:${source}`)??0,last_seen:await s.get(`last_seen:${source}`)??null,active_until:await s.get(`active_until:${source}`)??0,runtime_alert:watch?.incident?{incident:watch.incident,stale_for_ms:watch.stale_for_ms}:null});
  }
}

export function gateClient(namespace,key) {
  const stub=namespace.get(namespace.idFromName(key));
  const call=async(path,p)=>{
    const response=await stub.fetch(`https://internal${path}`,{method:'POST',body:JSON.stringify(p)});
    const body=await response.json();if(!response.ok)throw Object.assign(new Error('unauthorized'),{status:response.status});return body;
  };
  return {enroll:p=>call('/enroll',p),revoke:token_hash=>call('/revoke',{token_hash}),signal:source=>call('/signal',{source}),
    clear:(source,generation)=>call('/clear',{source,generation}),poll:token_hash=>call('/poll',{token_hash}),
    inspect:token_hash=>call('/inspect',{token_hash}),checked:(token_hash,meta={})=>call('/checked',{token_hash,...meta}),
    presence:source=>call('/presence-read',{source}),changes:source=>call('/changes',{source}),
    activity:(source,wait=false,kind='history',opts={})=>call('/activity',{source,wait,kind,...opts}),
    runtime:source=>call('/runtime-read',{source}),setRuntime:(token_hash,snapshot)=>call('/runtime-write',{token_hash,snapshot}),
    signalReceipt:(source,operation_id)=>call('/receipt-signal',{source,operation_id}),waitReceipt:(source,operation_id)=>call('/receipt-wait',{source,operation_id}),rate:key=>call('/rate',{key}),logCall:record=>call('/call-log',{record}),callLog:(hours=24)=>call('/call-log-read',{hours}),
    probe:(source,session_id,{max_wait=3000}={})=>call('/probe',{source,session_id,max_wait}),probeWrite:(token_hash,result)=>call('/probe-write',{token_hash,result})};
}

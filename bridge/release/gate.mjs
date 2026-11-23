/** Accept native V2 service discovery and AgentView's retained supervisor record. */
export function nativeConnection(server) {
  if(server.api!=='v2'&&!String(server.version).startsWith('2.'))throw new Error('Release gate requires the actual V2 service');
  const url=new URL(server.url??`http://127.0.0.1:${server.port}`);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Release gate requires a local native service');
  if(typeof server.password!=='string'||!server.password)throw new Error('Native service credentials unavailable');
  return {base:url.origin,authorization:'Basic '+Buffer.from(`${server.username??'opencode'}:${server.password}`).toString('base64')};
}

/** Fail closed on stale, partial, missing or incorrectly labelled observations. */
export function matchesObservation(value,{id,status,since,now}) {
  if(value?.status_fresh!==true||value.mac_seen_recently!==true||value.partial!==false||value.truncated===true)return false;
  const at=value.status_observed_at;
  if(!Number.isSafeInteger(at)||at<since||at>now||now-at>=30_000)return false;
  const rows=value.sessions?.filter(row=>row.session_id===id)??[];
  return status==='absent'?rows.length===0:rows.length===1&&rows[0].status===status;
}

/** The driver supplies real native operations and MCP calls. No fake publication,
 * manual sync or restart is allowed between phases: the installed daemon must
 * discover each transition itself. Cleanup is part of passing, even on failure. */
export async function verifyTransitions(io,{timeoutMs=120_000,pollMs=1000}={}) {
  const observations=[];
  let fixture,work,originalError;
  async function wait(status,since) {
    const deadline=io.now()+timeoutMs;
    while(io.now()<deadline) {
      const value=await io.read(fixture);
      if(matchesObservation(value,{id:fixture.id,status,since,now:io.now()})) {
        observations.push({status,observed_at:value.status_observed_at,latency_ms:io.now()-since});
        return;
      }
      await io.sleep(pollMs);
    }
    throw new Error(`Release gate timed out waiting for fresh ${status} status`);
  }
  try {
    let since=io.now();fixture=await io.create();
    await wait('done',since);
    since=io.now();work=await io.start(fixture);
    await wait('working',since);
    since=io.now();await io.stop(work);work=null;
    await wait('done',since);
  } catch(error) {originalError=error;}
  const failures=[];
  if(work)try{await io.stop(work);}catch{failures.push('probe shell cleanup failed');}
  if(fixture)try{
    const since=io.now();await io.remove(fixture);await wait('absent',since);
  }catch{failures.push('probe session cleanup failed');}
  try{await io.finish();}catch{failures.push('diagnostic credential cleanup failed');}
  if(originalError||failures.length)throw new Error([originalError?.message,...failures].filter(Boolean).join('; '));
  return observations;
}

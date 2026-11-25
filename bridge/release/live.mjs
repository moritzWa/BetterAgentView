/** Operator-only gate: installed daemon -> deployed Worker -> actual MCP reader.
 * No model prompts, synthetic source swaps, manual snapshots or forced syncs.
 * Credentials stay in memory. The only native mutations target our new fixture.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink,stat,mkdir,rmdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../private/database.mjs';
import {digest} from '../sync/projection.mjs';
import {nativeConnection,verifyTransitions} from './gate.mjs';

const json=async path=>JSON.parse(await readFile(path,'utf8'));
const exec=(bin,args)=>execFileSync(bin,args,{encoding:'utf8',timeout:30_000,stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const home=homedir();
export const stateDir=()=>join(process.env.XDG_STATE_HOME??join(home,'.local/state'),'agentview/bridge');

export async function invalidateReceipt(dir=stateDir()) {
  await unlink(join(dir,'release-check.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
}

async function installedDaemon(config,binary) {
  assert.equal(process.platform,'darwin','The installed-daemon gate currently requires macOS');
  const info=exec('launchctl',['print',`gui/${process.getuid()}/com.agentview.bridge.${config.device_id}`]);
  const pid=Number(info.match(/\bpid = (\d+)/)?.[1]);assert(pid>1,'Bridge login item is not running');
  const expected=await stat(binary);let inode;
  for(const line of exec('lsof',['-a','-p',String(pid),'-d','txt','-Ffin']).split('\n')) {
    if(line.startsWith('f'))inode=undefined;
    else if(line.startsWith('i'))inode=Number(line.slice(1));
    else if(line===`n${binary}`&&inode===expected.ino)return {pid,inode,sha256:createHash('sha256').update(await readFile(binary)).digest('hex')};
  }
  throw new Error('Bridge is not running the installed binary; restart only the bridge before checking');
}

export async function runLiveGate() {
  const lock=join(stateDir(),'release-check.lock');
  await mkdir(lock,{mode:0o700}).catch(()=>{throw new Error('Release gate lock unavailable; another gate may be running');});
  try{return await checkLiveGate();}finally{
    try{await rmdir(lock);}catch(error){await invalidateReceipt();throw error;}
  }
}

async function checkLiveGate() {
  const dir=stateDir();await invalidateReceipt(dir);
  const config=await json(join(dir,'config.json'));
  const endpoint=new URL(config.endpoint);
  assert(endpoint.protocol==='https:'&&!endpoint.username&&!endpoint.password&&endpoint.origin===config.endpoint,'Release gate requires the paired HTTPS origin');
  const binary=resolve(process.env.AGENTVIEW_GATE_BINARY??join(home,'.local/share/opencode-v2/bin/native/agentview'));
  const daemon=await installedDaemon(config,binary);
  const service=process.env.AGENTVIEW_OPENCODE_SERVICE_FILE??join(home,'.local/state/agentview/opencode/server.json');
  const server=await json(service);
  const {base:localBase,authorization:nativeAuth}=nativeConnection(server);
  const title='Bridge release probe '+randomUUID();
  // An existing folder avoids native location creation, and an empty one of the
  // gate's own means no project files are read and no project code runs.
  // In a project folder with a running OpenCode TUI the
  // daemon gives the new empty session to that process ("waiting at prompt"), the
  // fixture reads needs_you instead of done, and the gate times out (2026-11-24).
  const cwd=process.env.AGENTVIEW_GATE_DIRECTORY??join(dir,'gate-fixture');
  await mkdir(cwd,{recursive:true,mode:0o700});
  const location='?'+new URLSearchParams({'location[directory]':cwd});
  const owner='wallawitsch@gmail.com',reader=randomBytes(32).toString('base64url');
  let db,hash,fixtureId,shellId,shellPid,finished=false,passed=false,cancelled=false;
  const cancel=()=>{cancelled=true;};
  const started=Date.now();
  async function native(method,path,body) {
    const response=await fetch(localBase+path,{method,headers:{authorization:nativeAuth,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw Object.assign(new Error(`Native release probe HTTP ${response.status}`),{status:response.status});
    return response.status===204?null:(await response.json()).data;
  }
  async function mcp() {
    if(cancelled)throw new Error('Release gate interrupted');
    const response=await fetch(config.endpoint+'/mcp',{method:'POST',headers:{authorization:`Bearer ${reader}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_sessions',arguments:{query:title,view:'all',limit:5}}}),signal:AbortSignal.timeout(35_000)});
    if(!response.ok)throw new Error(`Deployed MCP release probe HTTP ${response.status}`);
    const body=await response.json();
    if(body.error||body.result?.isError)throw new Error('Deployed MCP rejected the release probe');
    const value=JSON.parse(body.result.content[0].text);
    assert.equal(value.source?.device_id,config.device_id,'MCP returned the wrong paired source');
    return value;
  }
  async function finish() {
    if(finished)return;
    if(hash&&db){await db.query('DELETE FROM av_credentials WHERE token_hash=$1',[hash]);hash=null;}
    if(db){await db.close();db=null;}
    finished=true;
  }
  async function stopProbe() {
    try{await native('DELETE',`/api/shell/${encodeURIComponent(shellId)}`+location);}catch(error){if(error.status!==404)throw error;}
    // OpenCode removes the shell record on DELETE. Check the actual process too,
    // rather than treating either a 204 or missing registry entry as proof.
    const deadline=Date.now()+5000;
    while(shellPid&&Date.now()<deadline) {
      try{process.kill(shellPid,0);}catch(error){if(error.code==='ESRCH'){shellId=null;shellPid=null;return;}throw error;}
      await sleep(100);
    }
    assert(!shellPid,'Probe shell process did not exit');shellId=null;
  }
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try {
    const url=exec('neonctl',['connection-string','--project-id','frosty-pond-48075355','--role-name','neondb_owner','--pooled']);
    db=await openDatabase(url);
    const source=(await db.query('SELECT device_id,database_epoch FROM av_owner_source WHERE owner_id=$1',[owner])).rows[0];
    assert.equal(source?.device_id,config.device_id,'Installed connector is not the primary source');
    assert.equal(source.database_epoch,config.database_epoch,'Wrong source database epoch');
    hash=await digest(reader);
    await db.query('INSERT INTO av_credentials(token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [hash,owner,config.device_id,config.database_epoch,'read',Date.now()+15*60_000,'history:read']);
    const observations=await verifyTransitions({now:Date.now,sleep,
      create:async()=>{
        if(cancelled)throw new Error('Release gate interrupted');
        const value=await native('POST','/api/session',{title,location:{directory:cwd}});
        fixtureId=value.id;assert.match(fixtureId,/^ses_[A-Za-z0-9]+$/);
        // Refuse a mismatched native database before executing even a sleep.
        const seen=exec('sqlite3',[config.database,`SELECT title FROM session_v2 WHERE id='${fixtureId}'`]);
        assert.equal(seen,title,'Native session did not enter the connector source database');
        return {id:fixtureId};
      },
      start:async()=>{
        if(cancelled)throw new Error('Release gate interrupted');
        // The server owns this bounded process. No detached agent or model call.
        const value=await native('POST','/api/shell'+location,{command:'/bin/sleep 180',cwd,timeout:180_000,metadata:{sessionID:fixtureId}});
        shellId=value.id;shellPid=value.pid;assert.equal(value.status,'running');assert(shellPid>1,'Missing probe process ID');return {id:shellId};
      },
      stop:async work=>{
        assert.equal(work.id,shellId);
        await stopProbe();
      },
      read:mcp,
      remove:async fixture=>{
        assert.equal(fixture.id,fixtureId);
        const value=await native('GET',`/api/session/${fixtureId}`);
        assert.equal(value.title,title,'Refusing to remove a session not created by this gate');
        await native('DELETE',`/api/session/${fixtureId}`);fixtureId=null;
      },finish,
    });
    const after=await installedDaemon(config,binary);
    assert.deepEqual(after,daemon,'Daemon changed during the release gate');
    const receipt={healthy:true,checked_at:new Date().toISOString(),endpoint:config.endpoint,daemon,observations,elapsed_ms:Date.now()-started};
    await mkdir(dir,{recursive:true,mode:0o700});
    await writeFile(join(dir,'release-check.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    passed=true;
    console.log(`PASS installed bridge -> deployed MCP: idle -> working -> idle -> removed (${Math.round(receipt.elapsed_ms/1000)}s)`);
    return receipt;
  } finally {
    // Also cover failure during create/start, before the generic runner receives
    // the returned resource handle. Never touch any other session or process.
    const failures=[];
    if(shellId)try{await stopProbe();}catch{failures.push('probe shell cleanup failed');}
    if(fixtureId)try{const value=await native('GET',`/api/session/${fixtureId}`);assert.equal(value.title,title);await native('DELETE',`/api/session/${fixtureId}`);}catch{failures.push('probe session cleanup failed');}
    try{await finish();}catch{failures.push('credential cleanup failed');}
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
    if(!passed||failures.length)await invalidateReceipt(dir);
    if(failures.length)throw new Error(failures.join('; '));
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runLiveGate().catch(error=>{
    const safe=/^(Release gate|Native release probe HTTP|Deployed MCP|Bridge is not running|Bridge login item is not running)/.test(error.message)?error.message.split('\n')[0]:'Operator preflight or fixture cleanup failed';
    console.error(`FAIL live bridge release gate: ${safe}. Rollout is not healthy.`);process.exitCode=1;
  });
}

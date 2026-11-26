import { OwnerAuth, OWNER, json, html } from './auth.mjs';
import { openDatabase } from './database.mjs';
import { gateClient } from './gate.mjs';
import { Outbox } from './outbox.mjs';
import { Starts } from './starts.mjs';
import { privateMcp } from './mcp.mjs';
import { Timing } from './timing.mjs';
import { SyncStore } from '../sync/store.mjs';
import { privateHandler } from '../sync/http.mjs';
import { digest, SyncError } from '../sync/projection.mjs';
import { RuntimeSnapshot } from './runtime.mjs';
import {publishArtifact} from './artifacts.mjs';
import {CheckedRequest,EmptyRequest,ProbeResult,AckRequest,StartAckRequest,routes} from '../contracts/contract.mjs';
import {responseByRoute} from '../contracts/responses.mjs';
export { WakeGate } from './gate.mjs';

const AUTH_PATHS=new Set(['/register','/authorize','/token','/revoke','/pair/start','/pair/token','/pair','/consent','/auth/google/callback']);
async function wire(schema,request,code='invalid_connector_request') {
  const parsed=schema.safeParse(request.body===null?{}:await request.json().catch(()=>null));
  if(!parsed.success)throw new SyncError(code,400);
  return parsed.data;
}
async function bounded(request,limit) {
  if(!request.body)return request;
  const reader=request.body.getReader(),chunks=[];let n=0;
  try {
    for(;;) { const {done,value}=await reader.read();if(done)break;n+=value.length;
      if(n>limit){await reader.cancel();throw new SyncError('request_too_large',413);}chunks.push(value); }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(n);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new Request(request.url,{method:request.method,headers:request.headers,body:bytes});
}
export function application({database=openDatabase}={}) {
  const app={async fetch(request,env) {
    const url=new URL(request.url),path=url.pathname;
    if(path==='/health')return json({ok:true,private:true});
    if(path==='/oauth/test-callback')return html('<h1>Authorization callback received</h1><p>The integration test can finish exchanging its one-use code. You can close this tab.</p>');
    if(!env.ISSUER || url.origin!==env.ISSUER || !env.GATE) return json({error:'not_configured'},503);
    const gate=gateClient(env.GATE,OWNER);
    const authHeader=request.headers.get('authorization')??'',token=authHeader.startsWith('Bearer ')?authHeader.slice(7):'';
    let db;
    try {
      if(Number(request.headers.get('content-length')??0)>1_000_000)throw new SyncError('request_too_large',413);
      if(path.startsWith('/.well-known/'))return await new OwnerAuth(null,env).handle(request)??json({error:'not_found'},404);
      if(path==='/')return new Response('AgentVoice private bridge. Pair a device to get started.',{headers:{'Cache-Control':'no-store'}});
      if(path===routes.checked && request.method==='POST') {
        if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new SyncError('unauthorized',401);
        const body=await wire(CheckedRequest,request);
        await gate.checked(await digest(token),{complete:body?.complete!==false,skipped:Number(body?.skipped)||0,behind:Number(body?.behind)||0,behind_since:Number(body?.behind_since)||null});
        return json({ok:true}); // No Neon query. A partial scan does not stamp history fresh.
      }
      if(path===routes.poll && request.method==='POST') {
        if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new SyncError('unauthorized',401);
        await wire(EmptyRequest,request);
        const value=await gate.poll(await digest(token));
        return json({pending:value.pending,generation:value.generation,active_until:value.active_until,runtime_alert:value.runtime_alert??null,probe:value.probe??null}); // No Neon query.
      }
      if(path===routes.probe && request.method==='POST') {
        if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new SyncError('unauthorized',401);
        const result=await wire(ProbeResult,await bounded(request,100_000));
        await gate.probeWrite(await digest(token),result);return json({ok:true}); // No Neon query.
      }
      if(path===routes.runtime && request.method==='POST') {
        if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new SyncError('unauthorized',401);
        request=await bounded(request,850_000);
        const parsed=RuntimeSnapshot.safeParse(await request.json());
        if(!parsed.success){console.warn('bridge_dashboard_runtime_rejected',{received_at:Date.now(),reason:'invalid_runtime_snapshot'});throw new SyncError('invalid_runtime_snapshot',400);}
        await gate.setRuntime(await digest(token),parsed.data);return json({ok:true});
      }
      if(AUTH_PATHS.has(path)) {
        const ip=request.headers.get('cf-connecting-ip')??'local';
        const rate=await gate.rate(await digest(`${ip}:${path}`));
        if(!rate.allowed)throw new SyncError('rate_limited',429);
      } else if(!token) {
        return new Response(null,{status:401,headers:{'Cache-Control':'no-store','WWW-Authenticate':`Bearer resource_metadata="${env.ISSUER}/.well-known/oauth-protected-resource/mcp"`}});
      }
      request=await bounded(request,AUTH_PATHS.has(path)?32_000:1_000_000);
      if(!env.DATABASE_URL)throw new SyncError('not_configured',503);
      const timing=new Timing();
      db=await timing.time('connect',()=>database(env.DATABASE_URL));
      const auth=await new OwnerAuth(db,env,{gate}).handle(request);if(auth)return auth;
      const store=new SyncStore(db),outbox=new Outbox(db,gate),starts=new Starts(db,gate);
      if(path==='/v1/timings' && request.method==='GET') {
        await store.authenticate(token,'read');
        return json(await gate.callLog(Math.min(336,Math.max(1,Number(url.searchParams.get('hours'))||24))));
      }
      if(path==='/mcp') {
        const principal=await timing.time('auth',()=>store.authenticate(token,'read'));
        const initialPresence=await timing.time('touch',()=>gate.activity(`${principal.device_id}|${principal.database_epoch}`));
        return await privateMcp(request,{db,store,principal,gate,timing,initialPresence});
      }
      if(path===routes.lease && request.method==='POST') {
        await wire(EmptyRequest,request);
        const principal=await store.authenticate(token,'sync'),value=await gate.inspect(await digest(token));
        // Old connectors must never interpret a registry operation as a prompt.
        const message=await outbox.lease(principal,url.searchParams.get('session_visibility')==='1');
        if(!message)await gate.clear(`${principal.device_id}|${principal.database_epoch}`,value.generation);
        if(message?.action)return json({message:null,visibility:message});
        return json({message});
      }
      if(path===routes.ack && request.method==='POST') {
        const principal=await store.authenticate(token,'sync');return json(await outbox.ack(principal,await wire(AckRequest,request,'invalid_receipt')));
      }
      if(path===routes.startLease && request.method==='POST') {
        await wire(EmptyRequest,request);
        const principal=await store.authenticate(token,'sync');
        return json({start:await starts.lease(principal)});
      }
      if(path===routes.startAck && request.method==='POST') {
        const principal=await store.authenticate(token,'sync');return json(await starts.ack(principal,await wire(StartAckRequest,request,'invalid_receipt')));
      }
      if((path===routes.cursors || path===routes.verify) && request.method==='POST') {
        const principal=await store.authenticate(token,'sync');
        const body=await request.json();
        return json(path===routes.cursors?await store.cursors(principal,body):await store.verify(principal,body));
      }
      if(path===routes.artifact && request.method==='POST') {
        const principal=await store.authenticate(token,'sync');
        return json(await publishArtifact(db,principal,await request.json()));
      }
      return await privateHandler(store)(request);
    } catch(e) {
      if(e instanceof SyncError){const response=json({error:e.code},e.status);if(e.status===401)response.headers.set('WWW-Authenticate',`Bearer resource_metadata="${env.ISSUER}/.well-known/oauth-protected-resource/mcp"`);return response;}
      if(e?.status===401)return json({error:'unauthorized'},401);
      // Static class/code only. Never log the message, stack, URL, token or SQL.
      const name=/^[A-Za-z]{1,60}$/.test(e?.name??'')?e.name:'Error';
      const code=/^[A-Z0-9_]{1,60}$/.test(String(e?.code??''))?String(e.code):'UNKNOWN';
      console.error('bridge_request_failed',name,code);
      return json({error:'request_failed'},500); // Deliberately no SQL, token or body logging.
    } finally { try{await db?.close();}catch{console.error('bridge_db_close_failed');} }
  }};
  return {async fetch(request,env,ctx) {
    const url=new URL(request.url),started=Date.now();
    // Which tool a call named, from the JSON-RPC envelope only; never its arguments.
    const envelope=url.pathname==='/mcp'&&request.method==='POST'&&Number(request.headers.get('content-length')??0)<=1_000_000
      ?await request.clone().json().catch(()=>null):null;
    const response=await app.fetch(request,env),schema=responseByRoute[url.pathname];
    // Authenticated MCP calls only: they are the ones that carry Server-Timing.
    if(envelope&&env.GATE&&ctx?.waitUntil&&response.headers.has('server-timing')) {
      const header=response.headers.get('server-timing')??'',note=name=>header.match(new RegExp(`${name};desc="([^"]*)"`))?.[1]??null;
      ctx.waitUntil(gateClient(env.GATE,OWNER).logCall({t:started,ms:Date.now()-started,method:String(envelope.method??'').slice(0,40),
        tool:note('tool_name')??(typeof envelope.params?.name==='string'?envelope.params.name.slice(0,40):null),status:response.status,
        result_chars:Number(note('result_chars'))||null,error:note('error'),
        phases:Object.fromEntries([...header.matchAll(/(?:^|, )([a-z_]+);dur=([\d.]+)/g)].map(m=>[m[1],Math.round(Number(m[2]))]))}).catch(()=>{}));
    }
    if(response.ok&&schema) {
      const parsed=schema.safeParse(await response.clone().json().catch(()=>null));
      if(!parsed.success){console.error('bridge_response_contract_failed');return json({error:'invalid_server_response'},500);}
    }
    return response;
  }};
}
export default application();

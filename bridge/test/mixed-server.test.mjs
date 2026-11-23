import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import * as previous from './compat/previous-contract.mjs';
import * as current from '../contracts/contract.mjs';
import {application as oldApplication} from './compat/previous/private/worker.mjs';
import {WakeGate as OldGate} from './compat/previous/private/gate.mjs';
import {application as newApplication} from '../private/worker.mjs';
import {WakeGate as NewGate,gateClient} from '../private/gate.mjs';
import {responseByRoute} from '../contracts/responses.mjs';
import {digest} from '../sync/projection.mjs';
const token='x'.repeat(43),owner='wallawitsch@gmail.com';
function storage(){const map=new Map();const s={
  get:async k=>Array.isArray(k)?new Map(k.filter(k=>map.has(k)).map(k=>[k,structuredClone(map.get(k))])):structuredClone(map.get(k)),
  put:async(k,v)=>{for(const [key,value] of typeof k==='object'?Object.entries(k):[[k,v]])map.set(key,structuredClone(value));},
  delete:async k=>map.delete(k),transaction:async fn=>fn(s),
};return s;}
test('mixed-version HTTP matrix exercises the frozen shipped Worker, not just copied validators',async()=>{
  for(const [serverName,application,Gate] of [['old',oldApplication,OldGate],['new',newApplication,NewGate]]){
    const pg=new PGlite();
    try {
      await pg.exec(await readFile(new URL('../sync/schema.sql',import.meta.url),'utf8'));
      await pg.exec(await readFile(new URL('../private/schema.sql',import.meta.url),'utf8'));
      const object=new Gate({storage:storage()}),namespace={idFromName:x=>x,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};
      const gate=gateClient(namespace,owner),hash=await digest(token),expires=Date.now()+3600_000;
      await gate.enroll({token_hash:hash,owner_id:owner,device_id:'device123',database_epoch:'epoch123',expires_at:expires});
      await pg.query('INSERT INTO av_credentials(token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)',[hash,owner,'device123','epoch123','sync',expires,'history:sync messages:deliver']);
      const db={query:(...a)=>pg.query(...a),transaction:fn=>pg.transaction(tx=>fn({query:(...a)=>tx.query(...a)})),close:async()=>{}};
      const app=application({database:async()=>db}),env={ISSUER:'https://bridge.invalid',GATE:namespace,DATABASE_URL:'synthetic'};
      for(const [clientName,client] of [['old',previous],['new',current]]){
        const post=async(path,value)=>{
          const response=await app.fetch(new Request('https://bridge.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(value)}),env);
          const body=await response.json();assert.equal(response.status,200,`${clientName} client -> ${serverName} server ${path}: ${JSON.stringify(body)}`);
          assert(responseByRoute[path].safeParse(body).success,`${serverName} response ${path}`);return body;
        };
        await post(client.routes.runtime,client.RuntimeSnapshot.parse({available:true,partial:false,statuses:[]}));
        await post(client.routes.checked,client.CheckedRequest.parse({complete:true}));
        const poll=await post(client.routes.poll,{});assert.equal(typeof poll.pending,'boolean');
        await post(client.routes.cursors,client.CursorRequest.parse({sessions:[]}));
        await post(client.routes.verify,client.VerifyRequest.parse({session_id:'missing',hash:'a'.repeat(32)}));
        const session_id=`ses_${clientName}`,batch=client.Batch.parse({version:1,batch_id:`batch_${clientName}`,session_id,kind:'baseline',from:0,through:1,upload_id:`upload_${clientName}`,chunk:0,complete:true,session:{title:'Synthetic compatibility fixture',archived:false,deleted:false,visible_before:null},messages:[],delete_ids:[]});
        const receipt=await post(client.routes.batches,batch);assert.equal(receipt.committed,true);
      }
    } finally {await pg.close();}
  }
});

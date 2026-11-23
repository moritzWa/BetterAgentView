import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {wireSchemas,Batch,CursorRequest,limits} from '../contracts/contract.mjs';

test('shared wire fixtures match both generated Rust DTOs and Worker validators',async()=>{
  const fixtures=JSON.parse(await readFile(new URL('./fixtures/wire-payloads.json',import.meta.url),'utf8'));
  for(const [name,value] of Object.entries(fixtures))assert.deepEqual(wireSchemas[name].parse(value),value,name);
  assert(Batch.safeParse(fixtures.Batch).success);
});
test('both sides use the same cursor and batch size limits',()=>{
  assert(limits.cursorBatch<=limits.cursorMax);assert(limits.batchChunk<=limits.batchMessages);
  assert(CursorRequest.safeParse({sessions:Array.from({length:limits.cursorBatch},()=>({session_id:'ses_fixture',cursor:1}))}).success);
  assert.equal(CursorRequest.safeParse({sessions:Array.from({length:limits.cursorMax+1},()=>({session_id:'ses_fixture',cursor:1}))}).success,false);
});

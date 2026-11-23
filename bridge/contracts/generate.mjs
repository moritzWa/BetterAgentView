import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {quicktype,InputData,JSONSchemaInput,FetchingJSONSchemaStore} from 'quicktype-core';
import {z} from 'zod';

const check=process.argv.includes('--check');
async function output(url,value) {
  if(check){if(await readFile(url,'utf8').catch(()=>'')!==value)throw new Error(`Generated contract drift: ${fileURLToPath(url)}. Run npm run contracts:generate.`);}
  else await writeFile(url,value);
}
// Compile only authored TS boundaries. Node and Workers run the checked-in ESM.
for(const file of ['contract','../private/mcp']) {
  const source=new URL(file+'.mts',import.meta.url);
  const compiled=ts.transpileModule(await readFile(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:true}}).outputText;
  await output(new URL(file+'.mjs',import.meta.url),'// Generated. Edit the .mts source, not this file.\n'+compiled);
}
const {wireSchemas,toolInputs,limits,routes}=await import('./contract.mjs');
if(limits.cursorBatch>limits.cursorMax||limits.batchChunk>limits.batchMessages)throw new Error('Connector batch limits exceed the server contract');
const schema=z.toJSONSchema(z.object(wireSchemas).strict(),{target:'draft-07',reused:'inline',override:({jsonSchema})=>{
  if(typeof jsonSchema.const==='number'&&Number.isInteger(jsonSchema.const))jsonSchema.type='integer';
}});
schema.title='BridgeContracts';
await output(new URL('contract.schema.json',import.meta.url),JSON.stringify(schema,null,2)+'\n');
const mcp=Object.fromEntries(Object.entries(toolInputs).map(([name,schema])=>[name,z.toJSONSchema(schema,{target:'draft-07',io:'input'})]));
await output(new URL('mcp-inputs.schema.json',import.meta.url),JSON.stringify(mcp,null,2)+'\n');
const input=new JSONSchemaInput(new FetchingJSONSchemaStore());
await input.addSource({name:'BridgeContracts',schema:JSON.stringify(schema)});
const inputData=new InputData();inputData.addInput(input);
const rust=await quicktype({inputData,lang:'rust',rendererOptions:{'derive-partial-eq':'true','leading-comments':'false','integer-type':'force-i64'},combineClasses:false});
const constants=Object.entries(limits).map(([k,v])=>`pub const ${k.replace(/[A-Z]/g,c=>'_'+c).toUpperCase()}: usize = ${v};`).join('\n');
const routeConstants=Object.entries(routes).map(([k,v])=>`pub const ROUTE_${k.replace(/[A-Z]/g,c=>'_'+c).toUpperCase()}: &str = ${JSON.stringify(v)};`).join('\n');
// Preserve optional-vs-required nullable fields. In particular a required
// nullable reason must serialize null, while absent optional batch chunk fields
// must not become null. This rule comes from the schema, never a field list.
let struct;
const lines=rust.lines.flatMap(line=>{
  const match=line.match(/^pub struct (\w+)/);if(match){
    struct=match[1];
    if(schema.definitions?.[struct]?.additionalProperties===false)return ['#[serde(deny_unknown_fields)]',line];
  }
  const field=line.match(/^    pub (\w+): Option</),definition=schema.definitions?.[struct];
  if(field&&definition?.properties?.[field[1]]&&!definition.required?.includes(field[1]))return ['    #[serde(skip_serializing_if = "Option::is_none")]',line];
  return [line];
});
const enumHelpers=Object.entries(schema.definitions??{}).filter(([,d])=>d.enum?.every(v=>typeof v==='string')).map(([name])=>`
impl std::str::FromStr for ${name} {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}
`).join('\n');
const raw='// Generated from bridge/contracts/contract.mts. Do not edit.\n'+constants+'\n'+routeConstants+'\n'+lines.join('\n')+'\n'+enumHelpers;
const formatted=execFileSync('rustup',['run','1.75.0','rustfmt','--edition','2021'],{input:raw,encoding:'utf8'});
await output(new URL('../../src/bridge/contract.rs',import.meta.url),formatted);
console.log(check?'Shared bridge contracts are current':'Generated shared bridge contracts');

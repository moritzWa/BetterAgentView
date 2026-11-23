// Explicit maintenance command only. Normal generation never advances the baseline.
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const ref=process.argv[2];
if(!/^[a-f0-9]{40}$/.test(ref??''))throw new Error('Pass an explicit full shipped commit SHA');
const source=execFileSync('git',['show',`${ref}:bridge/contracts/contract.mjs`],{encoding:'utf8'});
const dir=new URL('../test/compat/',import.meta.url);await mkdir(dir,{recursive:true});
await writeFile(new URL('previous-contract.mjs',dir),source);
const files=execFileSync('git',['ls-tree','-r','--name-only',ref,'bridge/private','bridge/sync','bridge/contracts/contract.mjs'],{encoding:'utf8',cwd:new URL('../../',import.meta.url)}).trim().split('\n').filter(p=>p.endsWith('.mjs')&&!p.endsWith('/provision.mjs'));
if(files.length<10)throw new Error('Incomplete previous Worker source inventory');
const hashes={};
for(const path of files){
  const value=execFileSync('git',['show',`${ref}:${path}`]);
  const target=new URL('previous/'+path.slice('bridge/'.length),dir);
  await mkdir(dirname(fileURLToPath(target)),{recursive:true});await writeFile(target,value);
  hashes[path]=createHash('sha256').update(value).digest('hex');
}
await writeFile(new URL('baseline.json',dir),JSON.stringify({commit:ref,sha256:createHash('sha256').update(source).digest('hex'),files:hashes},null,2)+'\n');

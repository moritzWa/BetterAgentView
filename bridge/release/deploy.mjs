import {execFileSync} from 'node:child_process';
import {invalidateReceipt,runLiveGate} from './live.mjs';

await invalidateReceipt();
execFileSync('wrangler',['deploy','--config','wrangler.private.jsonc'],{stdio:'inherit',timeout:120_000});
await runLiveGate();
console.log('Required next check: verify real ChatGPT delivery in a fresh chat (SETUP.md#required-chatgpt-client-check).');

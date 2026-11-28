import {execFileSync} from 'node:child_process';
import {invalidateReceipt,runLiveGate} from './live.mjs';

await invalidateReceipt();
execFileSync('wrangler',['deploy','--config','wrangler.private.jsonc'],{stdio:'inherit',timeout:120_000});
await runLiveGate();
console.log('Next check: run the OpenCode MCP smoke test (SETUP.md#mcp-client-smoke-test).');

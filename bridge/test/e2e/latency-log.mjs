/** Summarises the Worker's own record of recent MCP calls (GET /v1/timings): per tool
 * counts and durations, how long each call waited for the Mac, and how long the
 * bridge had been idle before each call. Durations and sizes only, never text.
 *   node latency-log.mjs [--since-hours 24] [--json]
 * Mints a short-lived read credential in memory and removes it on every exit path.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../../private/database.mjs';
import {digest} from '../../sync/projection.mjs';

const base = process.env.BASE ?? 'https://agentvoice-private.moritzw.workers.dev', owner = 'wallawitsch@gmail.com';
const args = process.argv.slice(2), hours = Number(args[args.indexOf('--since-hours') + 1] || 24), asJson = args.includes('--json');
const reader = randomBytes(32).toString('base64url');
let db, hash;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const phase = (call, name) => Number(call.phases?.[name] ?? 0);

try {
  const url = execFileSync('neonctl', ['connection-string', '--project-id', 'frosty-pond-48075355', '--role-name', 'neondb_owner', '--pooled'], {encoding: 'utf8', timeout: 30_000}).trim();
  db = await openDatabase(url);
  const primary = (await db.query('SELECT device_id,database_epoch FROM av_owner_source WHERE owner_id=$1', [owner])).rows[0];
  assert(primary, 'no paired source');
  hash = await digest(reader);
  await db.query('INSERT INTO av_credentials(token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [hash, owner, primary.device_id, primary.database_epoch, 'read', Date.now() + 5 * 60_000, 'history:read']);
  const response = await fetch(base + '/v1/timings?hours=' + hours, {headers: {authorization: `Bearer ${reader}`}, signal: AbortSignal.timeout(30_000)});
  if (response.status !== 200) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const all = (await response.json()).calls, cutoff = Date.now() - hours * 3600_000;
  // The credential's own request is not in the log; idle time is measured on the full log.
  const calls = all.map((c, i) => ({...c, idle_before_ms: i ? c.t - (all[i - 1].t + all[i - 1].ms) : null})).filter(c => c.t >= cutoff);
  const toolCalls = calls.filter(c => c.method === 'tools/call');
  const rows = {};
  for (const c of toolCalls) (rows[c.tool ?? '?'] ??= []).push(c);
  const summary = Object.entries(rows).map(([tool, cs]) => ({tool, n: cs.length, errors: cs.filter(c => c.error).length,
    ms_p50: pct(cs.map(c => c.ms), .5), ms_p90: pct(cs.map(c => c.ms), .9), ms_max: Math.max(...cs.map(c => c.ms)),
    wait_p50: pct(cs.map(c => phase(c, 'fresh_wait')), .5), wait_max: Math.max(...cs.map(c => phase(c, 'fresh_wait'))),
    result_chars_p50: pct(cs.map(c => c.result_chars ?? 0), .5)})).sort((a, b) => b.n - a.n);
  const cold = toolCalls.filter(c => c.idle_before_ms !== null && c.idle_before_ms > 5 * 60_000);
  const slow = [...toolCalls].sort((a, b) => b.ms - a.ms).slice(0, 10).map(c => ({at: new Date(c.t).toISOString(), tool: c.tool, ms: c.ms, wait: phase(c, 'fresh_wait'), idle_s: c.idle_before_ms === null ? null : Math.round(c.idle_before_ms / 1000), result_chars: c.result_chars, error: c.error}));
  const out = {window_hours: hours, calls_logged: all.length, tool_calls: toolCalls.length, summary,
    after_more_than_5_min_idle: {n: cold.length, ms_p50: pct(cold.map(c => c.ms), .5), ms_max: cold.length ? Math.max(...cold.map(c => c.ms)) : null}, slowest: slow};
  console.log(asJson ? JSON.stringify(out) : JSON.stringify(out, null, 1));
} finally {
  if (hash && db) try { await db.query('DELETE FROM av_credentials WHERE token_hash=$1', [hash]); } catch { console.error('CREDENTIAL CLEANUP FAILED'); process.exitCode = 1; }
  if (db) await db.close();
}

/** Operator-only latency probe against the real deployed Worker.
 * Mints a short-lived history:read credential in memory, times real /mcp calls end to
 * end, and removes the credential on every exit path. Prints timings, sizes and
 * freshness flags only, never message text.
 *   node latency-probe.mjs                         # default call set, 6 rounds
 *   ROUNDS=10 CALLS=search_history,session_brief node latency-probe.mjs
 *   VISIBLE_ONLY=1 node latency-probe.mjs           # list and snapshot diagnostics only
 *   VISIBLE_ONLY=1 DIRECTORY=/exact/path VOICE_START_MS=1795735348920 node latency-probe.mjs
 *   VISIBLE_ONLY=1 IDLE_FIRST=1 node latency-probe.mjs # first call after 5.5 minutes of this probe being idle
 *   IDLE_FIRST=1 node latency-probe.mjs            # also time the first call after 5.5 min idle
 *   TOKENIZER=/path/to/node_modules/gpt-tokenizer node latency-probe.mjs   # exact o200k token counts
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../../private/database.mjs';
import {digest} from '../../sync/projection.mjs';

const base = process.env.BASE ?? 'https://agentvoice-private.moritzw.workers.dev', owner = 'wallawitsch@gmail.com';
const rounds = Number(process.env.ROUNDS ?? 6), gapMs = Number(process.env.GAP_MS ?? 400);
const queries = (process.env.QUERIES ?? 'digitization|voice latency|session').split('|');
const reader = randomBytes(32).toString('base64url');
let db, hash, countTokens = text => Math.ceil(text.length / 4), tokenizer = 'chars/4';

if (process.env.TOKENIZER) {
  const mod = await import(pathToFileURL(`${process.env.TOKENIZER}/esm/main.js`).href).catch(() => import(process.env.TOKENIZER));
  countTokens = text => mod.encode(text).length;
  tokenizer = 'o200k (gpt-tokenizer)';
}

// Server-Timing: connect;dur=51.2;desc="n=1", auth;dur=8.1;desc="n=1", ... (present once the Worker emits it)
const parseTiming = header => Object.fromEntries((header ?? '').split(/,\s*/).filter(Boolean).map(part => {
  const [name, ...rest] = part.split(';'), dur = rest.find(x => x.startsWith('dur='));
  return dur ? [name, Number(dur.slice(4))] : [name, rest.find(x => x.startsWith('desc='))?.slice(6, -1) ?? null];
}));
let nextId = 1;
async function post(body, extra = {}) {
  const started = performance.now();
  const response = await fetch(base + '/mcp', {method: 'POST', headers: {authorization: `Bearer ${reader}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra},
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000)});
  const firstByte = performance.now() - started;
  const text = await response.text();
  return {status: response.status, ms: Math.round(performance.now() - started), ttfb: Math.round(firstByte), text, bytes: Buffer.byteLength(text), headers: response.headers};
}
async function call(name, args) {
  const r = await post({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}});
  assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
  const rpc = JSON.parse(r.text), result = rpc.result;
  const payload = result?.content?.map(c => c.text ?? '').join('') ?? '';
  let value = null;
  try { value = JSON.parse(payload); } catch { /* error text */ }
  return {ms: r.ms, ttfb: r.ttfb, bytes: r.bytes, payload_chars: payload.length, tokens: countTokens(payload), error: result?.isError ? payload : null, value, cf: r.headers.get('cf-ray')?.split('-')[1] ?? null, phases: parseTiming(r.headers.get('server-timing'))};
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = xs => ({n: xs.length, min: Math.min(...xs), p50: pct(xs, .5), p90: pct(xs, .9), max: Math.max(...xs)});
const phaseMedians = rs => { const names = new Set(rs.flatMap(r => Object.keys(r.phases ?? {}).filter(n => typeof r.phases[n] === 'number'))); return names.size ? Object.fromEntries([...names].map(n => [n, pct(rs.map(r => r.phases?.[n]).filter(n => typeof n === 'number'), .5)])) : null; };
const fresh = v => v ? {history_fresh: v.history_fresh, history_age_ms: v.history_age_ms, mac_seen_recently: v.mac_seen_recently, retry_after_ms: v.retry_after_ms, server_timing: v.timing_ms, digest_timing: v.digest?.timing} : {};

async function visibleProbe() {
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const r = await call('list_visible_sessions', process.env.DIRECTORY ? {directory: process.env.DIRECTORY} : {});
    assert(r.value && !r.error, 'list_visible_sessions did not return a list');
    const {ms, ttfb, bytes, payload_chars, tokens, cf, phases, value} = r;
    const freshness = value.counts === null ? 'missing' : /stale or partial/i.test(value.warning ?? '') ? 'stale' : 'fresh';
    if (phases.visible_snapshot_state) {
      assert.equal(phases.visible_snapshot_state, freshness, 'Snapshot timing and list freshness warning disagree');
      assert(Number(phases.visible_payload_bytes) > 0, 'Expected payload size in Server-Timing');
    }
    samples.push(r);
    console.log(JSON.stringify({label: 'list_visible_sessions', i, ms, ttfb, bytes, payload_chars, tokens, tokenizer, cf, phases, total: value.counts?.total ?? null, freshness}));
    if (i + 1 < rounds) await new Promise(resolve => setTimeout(resolve, gapMs));
  }
  const voiceStart = Number(process.env.VOICE_START_MS);
  if (Number.isFinite(voiceStart)) {
    const response = await fetch(base + '/v1/timings?hours=24', {headers: {authorization: `Bearer ${reader}`}, signal: AbortSignal.timeout(30_000)});
    assert.equal(response.status, 200, 'Could not fetch Worker call timings');
    const {calls} = await response.json();
    console.log(JSON.stringify({label: 'worker_calls_near_voice_timestamp', calls: calls.filter(c => c.tool === 'list_visible_sessions' && Math.abs(c.t - voiceStart) < 15_000)}));
  }
  const diagnostic = await call('snapshot_diagnostics', {});
  assert(diagnostic.value && !diagnostic.error, 'snapshot_diagnostics unavailable');
  console.log(JSON.stringify({label: 'snapshot_diagnostics', ...diagnostic.value}));
  const warm = samples.slice(1);
  if (warm.length) console.log(JSON.stringify({label: 'list_visible_sessions_after_first', ms: stat(warm.map(r => r.ms)), phases_p50: phaseMedians(warm)}));
}

async function generalProbe() {

  // Protocol-level costs every conversation pays.
  const init = await post({jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'latency-probe', version: '1'}}});
  const list = await post({jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {}});
  const tools = JSON.parse(list.text).result.tools;
  const instructions = JSON.parse(init.text).result.instructions ?? '';
  console.log(JSON.stringify({label: 'protocol', tokenizer, initialize_ms: init.ms, tools_list_ms: list.ms, tools: tools.length, tools_list_bytes: list.bytes, tools_list_tokens: countTokens(JSON.stringify(tools)),
    description_tokens: tools.map(t => [t.name, countTokens(t.description ?? '')]), instructions_tokens: countTokens(instructions)}));

  // Discover one real session to brief/read without printing its text.
  const overview = await call('list_visible_sessions', {});
  const rows = overview.value?.directories?.flatMap(d => [...d.sessions, ...d.working]) ?? [];
  let sessionId = (rows.find(s => s.id?.startsWith('opencode:host:')) ?? rows[0])?.id?.replace('opencode:host:', '');
  if (!sessionId) {
    // The dashboard snapshot is optional; fall back to the historical inventory.
    const inventory = await call('list_sessions', {});
    sessionId = inventory.value?.sessions?.find(s => s.mirrored !== false)?.session_id;
    console.log(JSON.stringify({label: 'overview_unavailable', error: overview.error, keys: Object.keys(overview.value ?? {}), warning: overview.value?.warning}));
  }
  assert(sessionId, 'no session to probe');
  const first = await call('search_history', {query: queries[0]});
  const hit = first.value?.matches?.[0];
  console.log(JSON.stringify({label: 'discovery', visible_rows: rows.length, session: sessionId, search_matches: first.value?.matches?.length}));

  const plan = {
    mac_presence: () => call('mac_presence', {}),
    list_visible_sessions: () => call('list_visible_sessions', {}),
    list_sessions_active: () => call('list_sessions', {status: 'active'}),
    list_sessions_default: () => call('list_sessions', {}),
    list_sessions_detail: () => call('list_sessions', {detail: true}),
    session_brief: () => call('session_brief', {session_id: sessionId}),
    read_session: () => call('read_session', {session_id: sessionId}),
    read_message: () => hit ? call('read_message', {session_id: hit.session_id, message_id: hit.message_id}) : call('mac_presence', {}),
    ...Object.fromEntries(queries.map((q, i) => [`search_history[${q}]`, () => call('search_history', {query: q})])),
    ...Object.fromEntries(queries.map(q => [`search_history[${q}]x5`, () => call('search_history', {query: q, limit: 5})])),
  };
  if (process.env.BRIEF_SWEEP) {
    // Token volume of one session_brief per recent session: sizes only, never text.
    const inventory = await call('list_sessions', {limit: Number(process.env.BRIEF_SWEEP)});
    const ids = (inventory.value?.sessions ?? []).map(x => x.session_id);
    const rows = [];
    for (const id of ids) { const r = await call('session_brief', {session_id: id}); rows.push({ms: r.ms, tokens: r.tokens, bytes: r.bytes, found: r.value?.found, messages: r.value?.transcript?.length, phases: r.phases}); }
    console.log(JSON.stringify({label: 'session_brief_sweep', n: rows.length, ms: stat(rows.map(r => r.ms)), tokens: stat(rows.map(r => r.tokens)), bytes: stat(rows.map(r => r.bytes)), rows}));
  }
  const wanted = (process.env.CALLS ?? Object.keys(plan).join(',')).split(',');

  if (process.env.IDLE_FIRST) {
    for (const label of wanted) {
      if (!plan[label]) continue;
      await new Promise(r => setTimeout(r, 5.5 * 60_000));
      const r = await plan[label]();
      console.log(JSON.stringify({label, scenario: 'first_after_idle_5.5min', ms: r.ms, bytes: r.bytes, tokens: r.tokens, error: r.error, phases: r.phases, ...fresh(r.value)}));
    }
  }

  const results = {};
  for (let i = 0; i < rounds; i++) for (const label of wanted) {
    if (!plan[label]) continue;
    const r = await plan[label]();
    (results[label] ??= []).push(r);
    if (process.env.VERBOSE) console.log(JSON.stringify({label, round: i, ms: r.ms, ttfb: r.ttfb, bytes: r.bytes, tokens: r.tokens, error: r.error, ...fresh(r.value)}));
    await new Promise(r => setTimeout(r, gapMs));
  }
  for (const [label, rs] of Object.entries(results)) {
    const ok = rs.filter(r => !r.error);
    console.log(JSON.stringify({label, scenario: 'warm_back_to_back', errors: rs.length - ok.length, ms: stat(rs.map(r => r.ms)), bytes: ok.at(-1)?.bytes, payload_chars: ok.at(-1)?.payload_chars, tokens: ok.at(-1)?.tokens,
      history_fresh_rate: ok.filter(r => r.value?.history_fresh).length + '/' + ok.length, last_server_timing: fresh(ok.at(-1)?.value).server_timing ?? null, phases_p50: phaseMedians(rs)}));
  }
}

try {
  if (process.env.VISIBLE_ONLY === '1' && process.env.IDLE_FIRST) {
    // Run before minting the credential and without MCP calls of our own.
    // Other connector use can still warm the Mac; inspect the first sample.
    await new Promise(resolve => setTimeout(resolve, 5.5 * 60_000));
  }
  const url = execFileSync('neonctl', ['connection-string', '--project-id', 'frosty-pond-48075355', '--role-name', 'neondb_owner', '--pooled'], {encoding: 'utf8', timeout: 30_000}).trim();
  db = await openDatabase(url);
  const primary = (await db.query('SELECT device_id,database_epoch FROM av_owner_source WHERE owner_id=$1', [owner])).rows[0];
  assert(primary, 'no paired source');
  hash = await digest(reader);
  await db.query('INSERT INTO av_credentials(token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [hash, owner, primary.device_id, primary.database_epoch, 'read', Date.now() + (process.env.VISIBLE_ONLY === '1' ? 5 : 45) * 60_000, 'history:read']);
  if (process.env.VISIBLE_ONLY === '1') await visibleProbe();
  else await generalProbe();
} finally {
  if (hash && db) try { await db.query('DELETE FROM av_credentials WHERE token_hash=$1', [hash]); console.log('credential removed'); } catch { console.log('CREDENTIAL CLEANUP FAILED'); process.exitCode = 1; }
  await fetch(base + '/revoke', {method: 'POST', body: new URLSearchParams({token: reader}), signal: AbortSignal.timeout(30_000)}).catch(() => {});
  if (db) await db.close();
}

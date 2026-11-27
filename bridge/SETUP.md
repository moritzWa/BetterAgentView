# Mobile bridge deployment

## Existing deployment

The repository move needs **no deployment or provisioning**. Keep these identities:

| Resource | Existing value |
| --- | --- |
| Worker name | `agentvoice-private` |
| Issuer | `https://agentvoice-private.moritzw.workers.dev` |
| ChatGPT MCP URL | `https://agentvoice-private.moritzw.workers.dev/mcp` |
| Google callback | `https://agentvoice-private.moritzw.workers.dev/auth/google/callback` |
| Durable Object | `GATE`, class `WakeGate`, migration `v1` |
| Neon organization | AgentVoice Free, `org-purple-unit-21830200` |
| Neon project | `frosty-pond-48075355` |
| Owner | `wallawitsch@gmail.com` |

The Google web client remains the one saved as **AgentVoice Google OAuth** in
1Password's Main vault. The runtime role credential remains **AgentVoice Neon
database**. Do not register a replacement client or reset the database for this
move. Existing OAuth grants and connector credentials remain valid.

Worker secrets are `DATABASE_URL`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
They stay in Cloudflare. Neither GitHub Actions nor a source checkout needs them
for local checks. Do not commit credentials, local Wrangler state or journals.

## Later Worker updates

Use Node 24, Cloudflare access to the **existing account**, and this directory:

```console
npm ci
npm test
npm run build
npx wrangler whoami
npx wrangler deployments list --config wrangler.private.jsonc
```

Confirm the account owns the existing Worker before an intentional deployment:

```console
npm run deploy
```

This updates the same Worker, not a new service. Keep `name`, `ISSUER`, the
Durable Object binding/class and migration history unchanged. Do not delete or
recreate the Worker or replace its secrets. No push or PR automatically deploys.

Wire types, validation, MCP inputs, routes and limits share one [contract](contracts/README.md).
Edit its TypeScript source and run `npm run contracts:generate`. Tests and builds
reject generated drift and type errors before deployment.

`npm run deploy` now runs the installed-connector live gate after deployment.
Do not deploy directly with Wrangler: that bypasses the gate. A failed gate means
the rollout is not healthy, even if Cloudflare accepted the upload.

The gate requires the paired Mac, its running installed bridge, native OpenCode V2,
and the existing operator `neonctl` login. It creates one disposable session and a
bounded sleep process. Fresh MCP reads must show idle, working, idle, then removal.
It never calls a model or changes another session. Temporary read credentials are
removed on success and failure. Cleanup failure also fails the gate.

Run `npm run verify:live` to repeat it without deploying. Your Mac's
`~/.claude/scripts/install-latest.sh agentview` runs this same gate after replacing
the binary and restarting only the bridge. It reports installation success only
after the gate passes. A receipt in `~/.local/state/agentview/bridge/release-check.json`
records the running binary hash and cloud observation timestamps, not secrets.
The receipt proves that rollout, not perpetual health. Failed checks remove it.

After rollout, each authenticated connector poll checks runtime publication age
independently of heartbeats. A continuously online Mac alerts after two minutes
without a usable runtime snapshot while the phone is active, or 20 minutes while
idle (normal idle sync is 15 minutes). Time spent idle does not count toward the
active deadline. Partial snapshots do not erase the last usable time. The incident
log records snapshot age, active-window age, poll gap, and snapshot availability.
Startup/wake gets a two-minute grace period;
offline gaps reset continuity. The cloud logs one incident and includes it in poll
responses. The installed Mac bridge shows a notification once per incident, with
durable deduplication across restarts, and logs recovery. No chat text, tokens or
session titles are included. A Mac that is asleep or wholly offline cannot show
this local notification; presence remains offline/unknown in that case.

This is an operator gate for the private bridge. Public GitHub release jobs do not
have the owner's Mac or account credentials; their synthetic tests are not a live
private-bridge pass.

## Required ChatGPT client check

Do this after every BetterAgentView MCP deployment. The installed-connector gate and
raw MCP tests do not exercise ChatGPT's tools or approval UI.

1. Create a disposable native OpenCode session in an empty test directory and
   wait for it to appear in the dashboard and history mirror. Open a fresh,
   authenticated ChatGPT web or desktop chat with the deployed BetterAgentView app.
   Refresh the app's tools if ChatGPT is using an old schema, then start another
   fresh chat.
2. Ask ChatGPT to call `list_visible_sessions` for that directory and send a
   unique, harmless instruction to the test session. Check that it passed the
   exact row `id` to `send_session_message` without stripping the prefix. Send and start should not ask for per-action
   approval after the owner gives the instruction. Both still require the write grant.
3. Record the operation and message IDs, verify native admission, then check the
   target OpenCode history for exactly one user message with that ID and text.
   ChatGPT should not announce a successful save. The enqueue receipt is not
   proof of delivery. If checking completion, require a new reply tied to that input.
4. Repeat with a different marker in voice if the client offers BetterAgentView in
   voice mode. Check that no on-screen approval is required. If blocked, record the client,
   what was tried, and what prevented verification. Record the deployed Worker
   version and the text and voice results separately. Remove only your fixture.

## Provisioning is not migration

`private/provision.mjs` is an operator tool for initial setup or explicit schema
maintenance. It applies both SQL schemas, creates or reuses `agentvoice_runtime`,
grants runtime access and writes the three Worker secrets. It requires `neonctl`,
`op`, Cloudflare authentication and the dedicated Google OAuth item. Its macOS
credential path uses the `op-service-account` Keychain item and Homebrew `op`.
Read the script before running it. Do not run it to relocate this repository.

For a separate installation, create a dedicated Neon project and Google web
client, configure the intended owner in `private/auth.mjs`, and change the Worker
name and issuer to your own URL. Register that URL's Google callback. The current
provisioner uses the named 1Password items above, so adapt those names rather than
overwriting an existing installation's secrets. Run from `bridge`:

```console
NEON_PROJECT_ID=<dedicated-project> node private/provision.mjs
npm run deploy
```

The service is single-owner, not a public signup product. Do not point a new
installation at the existing owner's database.

## Operator verification

The `test/e2e` scripts retain their original prepared-VM paths and deployment
targets. `cloud-vm.mjs` also loads Playwright from the operator's Understand
checkout. Inspect and adapt these paths before reuse. `tool-contracts.mjs` writes
disposable synthetic fixtures to the deployed Neon database and removes them on
exit. It is not read-only. None of these scripts runs in CI.

Existing verification and limitations are in [VERIFIED.md](test/e2e/VERIFIED.md).
Maintenance remains tracked in
[voizecode issue #18 (credential renewal, retention and oversized future messages)](https://github.com/moritzWa/voizecode/issues/18).
Its earlier iPhone rollout-gate wording predates the confirmed rollout.

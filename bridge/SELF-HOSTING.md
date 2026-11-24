# Host your own mobile MCP bridge

The desktop dashboard and desktop voice do **not** need this backend. The bridge
is optional, single-owner software for searching OpenCode history and queuing
replies through ChatGPT. It currently needs a Mac for the supported background
connector and installed-daemon verification. This is an operator setup, not a
one-command public service installer.

You need your own [Cloudflare Workers](https://developers.cloudflare.com/workers/),
[Neon Postgres project](https://neon.com/docs/introduction), and
[Google OAuth web client](https://developers.google.com/identity/protocols/oauth2/web-server).
The Worker hosts `/mcp` and OAuth; Neon holds conversation text, credentials and
the message queue. A Durable Object coordinates wake requests. Your Mac uploads
the copy and executes queued instructions when it is awake and online.

**Never use the repository owner's Worker, Neon project, Google client or
1Password items.** The private addresses in [SETUP.md](SETUP.md) describe an
existing installation, not shared infrastructure for new users.

## 1. Prepare your checkout and identities

Clone the repository and work in `bridge` with Node 24:

```console
npm ci
npx wrangler login
```

In `wrangler.private.jsonc`, choose your own Worker `name` and set `vars.ISSUER`
to its HTTPS origin, for example `https://my-agentvoice.my-account.workers.dev`.
Keep the `GATE` binding, `WakeGate` class and `v1` migration. Cloudflare creates
the Durable Object storage on deployment; you do not create another database
for it. The root repository Wrangler config is for the website, not this bridge.

Set `OWNER` in `private/auth.mjs` to your own Google email. Access is restricted
to that verified identity. Update owner-specific test fixtures in your checkout
as needed. There is no self-service multi-user signup.

Create a Google OAuth **Web application** client. Configure its consent screen
and, if in testing mode, add yourself as a test user. Register exactly:

```text
https://my-agentvoice.my-account.workers.dev/auth/google/callback
```

Use your real issuer in that URL. Keep the client ID and client secret private.

## 2. Create Neon storage and a runtime role

Create a dedicated project/database in Neon. In its SQL editor, as the database
owner, run the complete contents of `sync/schema.sql`, then `private/schema.sql`.
Both are required. Do not apply them to someone else's database.

Create a separate `agentvoice_runtime` login with a unique password. Grant only
the access used by the Worker. The following mirrors `private/provision.mjs`;
substitute the password privately, not in a committed SQL file:

```sql
CREATE ROLE agentvoice_runtime LOGIN PASSWORD '<your-unique-password>';
GRANT USAGE ON SCHEMA public TO agentvoice_runtime;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename LIKE 'av\_%' ESCAPE '\'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO agentvoice_runtime', t.tablename);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE av_outbox_sequence_seq TO agentvoice_runtime;
GRANT USAGE, SELECT ON SEQUENCE av_starts_sequence_seq TO agentvoice_runtime;
```

Get Neon's **pooled** connection URL for that runtime role, with SSL enabled.
Keep the database-owner URL for schema maintenance only. Save the runtime URL
and the Google credentials as Worker secrets using the interactive prompts:

```console
npx wrangler secret put DATABASE_URL --config wrangler.private.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID --config wrangler.private.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.private.jsonc
```

Do not run `private/provision.mjs` unchanged. Its 1Password names, vault, Keychain
service and owner metadata belong to the original operator. Manual provisioning
above avoids needing that operator's credential setup.

## 3. Bootstrap your Worker, then pair

Run `npm test` and `npm run build`. The build is a dry run, not a deployment.
Review the Worker name, account and issuer before deploying anything.

The existing `npm run deploy` wraps deployment in an installed-connector live
gate. That gate is **not portable unchanged**: `release/live.mjs` contains the
original owner's email, Neon project ID, local binary and checkout defaults.
Adapt it to your own installation, including `AGENTVIEW_GATE_BINARY`,
`AGENTVIEW_GATE_DIRECTORY` and service discovery where needed. Its checks write
a short-lived reader credential and create/remove a disposable OpenCode session
and bounded shell. Run it only against infrastructure you own and intend to test.

For the **first deployment only**, before a connector can be paired, bootstrap
the reviewed Worker directly:

```console
npx wrangler deploy --config wrangler.private.jsonc
```

This publishes the Worker but does not prove end-to-end delivery. On your Mac,
using the same OpenCode binary/profile you normally use, run:

```console
betteragentview --opencode-bin /absolute/path/to/opencode bridge pair --endpoint https://my-agentvoice.my-account.workers.dev
betteragentview bridge sync-once
betteragentview bridge install
betteragentview bridge status
```

Pairing prints a Google approval URL and stores connector credentials. It does
not upload history. **`sync-once` uploads conversation text**; run it only after
reading the [privacy details](../docs/mobile-bridge.md#privacy). `install` starts
the connector at login, independently of the dashboard. `bridge stop` disables
that background service but does not delete uploaded history.

Add `https://my-agentvoice.my-account.workers.dev/mcp` as a custom MCP app in
ChatGPT, authenticate with your owner Google account, and approve the scopes you
want. Custom MCP availability depends on your ChatGPT account and client. See
[mobile setup](../docs/mobile-bridge.md#connect-chatgpt-mobile-voice).

## 4. Verify before relying on it

Run the adapted `npm run verify:live` against your installed connector. Check an
actual history read and an explicitly approved test reply from ChatGPT; inspect
`message_status` through completion. A queued receipt is not proof the Mac
received or executed the instruction. Never claim a successful rollout from a
Wrangler upload alone. For later Worker updates use `npm run deploy`, which runs
the live gate after publishing, rather than bypassing it with direct Wrangler.

This guide documents the source's current deployment steps. It is not a claim
that a second owner's deployment has been tested. Database backups, retention,
credential rotation and monitoring remain your responsibility. Read
[SETUP.md](SETUP.md) for rollout checks and [mobile-bridge.md](../docs/mobile-bridge.md)
for supported actions, offline behavior and recovery limits.

# Shared bridge contract

Edit **`contract.mts`**, not generated files. It owns native status snapshots,
history batches, context guards, connector requests, artifact uploads, pairing,
MCP input schemas, endpoint paths and batch limits.

```sh
npm run contracts:generate
npm test
```

Generation emits the Worker ESM validators, Rust structs/enums/constants and JSON
Schemas. The Rust connector constructs these generated types. MCP registration
uses the same Zod schemas; its TypeScript handlers receive their inferred types.
`mcp.mts` is the authored handler; `mcp.mjs` is its checked-in runtime output.

`contracts:check` regenerates in memory and rejects stale or hand-edited output.
`typecheck` rejects wrong fields, missing required fields, unknown statuses and
wrong MCP arguments. Negative type tests must keep producing compiler errors.
Rust compile-fail tests and shared roundtrip fixtures cover the other side.
TypeScript/compiler and generator versions are pinned; formatting uses Rust 1.75.
Normal Rust builds need neither Node nor code generation.

Tests, Worker builds/deploys and public release checks run these guards. Numeric
and array limits still need runtime validation; ordinary TypeScript numbers and
arrays cannot encode those bounds. A shared schema also cannot prove which cloud
version is deployed. Keep the installed-connector live release gate.

`responses.mts` owns connector responses and per-tool MCP output envelopes.
The Worker validates successful connector responses and MCP results before
returning them. Rust deserializes generated response types, including required
nullable queue envelopes, rather than treating missing fields as empty queues.
MCP attachment results use the official SDK's result schema. Rich read envelopes
allow extra metadata; critical fields are typed and validated. Database adapters
remain dynamic, so runtime checks still matter.

The previous shipped contract and Worker source are frozen under `test/compat`.
Tests exercise old/new request validators, both HTTP servers, and old response
fixtures consumed by generated Rust types. The baseline is not updated by normal
generation. To advance it intentionally after a rollout, run
`node contracts/snapshot-compat.mjs <full-shipped-commit-sha>` and review the diff.

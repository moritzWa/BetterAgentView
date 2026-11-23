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

# Visible sessions and voice review

`list_visible_sessions` reads a snapshot published by the running dashboard. It does
not rediscover sessions or count the history database. The local equivalent is
`agentview sessions visible`. Both return the same typed dashboard payload.

## Why the old counts differed

The bridge discovers up to 5,000 OpenCode history records. The dashboard defaults
to a 100-record history window, with managed/live sessions added separately.
Hidden IDs are removed **after** discovery. Loading more history therefore brings
older, never-hidden sessions back into the bridge inventory. The running owner
dashboard was launched with `--include-external --include-interactive
--no-host-claude`, without a history-limit override. A read-only investigation on
2026-11-23 found 36 non-hidden roots in the newest 101 records versus 414 in the
bridge's 5,001-record window, before runtime and other filters. These are diagnostic
inventory sizes, not a reproduction of the owner's earlier 4/5/11 UI counts.

The old `list_sessions` also:

- Removes paused and locally hidden sessions, then removes linked child rows.
- Excludes cloud-mirrored archived/deleted records. Those flags are not the local
  hidden registry. Restorable history is not the dashboard list.
- Applies its own recent/active/query selection and pagination, but counts the
  whole inventory before those selections.
- Uses only OpenCode, unlike a dashboard with several providers.
- Collapses idle, Task Done and Project Done into runtime `done`. Recent-message
  heuristics can add follow-ups without changing that runtime status.
- Refreshes native states separately from the dashboard. Saved classification,
  background holds and history sync can arrive at different times.

`list_sessions` remains a history/inventory lookup for compatibility. Its counts
are not UI counts. Use `list_visible_sessions` for current counts and review.

## Exact scope

The publisher walks `App::groups()`, the same groups the renderer uses. This
preserves the dashboard's discovery options, provider coverage, hidden registry,
scope/text filters, saved classification, aliases, child layout, pause and schedule
overlays. It does not modify sessions or UI state.

- `dashboard.sessions` is the full filtered group membership, including children,
  collapsed rows and rows behind Show More. `counts` matches that membership and
  the status group totals. In directory view, category counts span the folders.
- `listed` marks rows exposed by the current expansion/page state.
  `displayed_counts` counts those rows. Terminal viewport clipping and temporary
  popups do not redefine the workstream set. `dashboard.groups` retains the actual
  UI group names, totals and listed counts.
- `dashboard.terminal_title` copies the actual terminal tab title. That existing
  title counts the discovery snapshot before text/scope filters and combines
  Ready for Review with Needs Input. It can differ from filtered group counts;
  neither is interchangeable with the bridge history inventory.
- `id` is the stable, provider/runtime-qualified UI identity. Track reviewed IDs,
  never array positions, titles or spoken aliases. `session_id` is the provider's
  native ID. Only paired host OpenCode rows support this bridge's history/send
  tools; other providers are counted but must not be sent to OpenCode tools.
- Categories are `needs_input`, `working`, `task_done`, `project_done`, plus
  `idle`, `ready_for_review`, `scheduled`, `paused`, `unknown`. Unknown and idle
  states are never silently relabeled as Task Done. Task Done means the latest
  task finished, not the project. Project Done means the workstream is wrapped up;
  it still does not authorize closing it.

## Freshness and multiple dashboards

Each real dashboard publishes a private, atomic file every two seconds while its
event loop runs. Fixtures never publish. The connector reads the most recently
refreshed dashboard file, identifies it with `dashboard_id`, and ignores files
older than 15 seconds. Multiple dashboards are **not** merged; clients must notice
a changed dashboard ID and restart their review queue. A parked, blocked or closed
dashboard can expire. This is not proof that its sessions are done.

The tool reports `exact` only for an untruncated dashboard capture observed within
30 seconds while the Mac heartbeat is recent. Stale data retains its timestamp
and last-observed counts but has no review queue. Missing data returns null counts,
not zero and not a history fallback. Native health is independently gated on fresh,
available, non-partial runtime data (`native_status_fresh`). `status_fresh` describes
the UI observation, not a fresh history sync. History-sync age is separate from UI age.
The local snapshot is bounded to 1,000 rows/groups and 100 KB; oversized snapshots
expire rather than silently claiming exactness.

## One-at-a-time review

1. Call `list_visible_sessions`. If unavailable or inexact, report that limitation.
2. Use `review_ids`: Needs Input first, Task Done second, Project Done last.
   Normally skip Working. Fresh native evidence of a stall or pending decision
   admits a Working row before Project Done. A long-running tool is not a stall.
3. Read a brief for the first unreviewed supported ID. Explain that session only.
   Ask its actual decision, if any, then stop speaking.
4. On "next", refresh and skip already-reviewed or disappeared IDs. If
   `dashboard_id` changes, establish the new scope before continuing.
5. Do not ask whether to close after each review. Leave unfinished projects visible.
   No completion category grants permission to hide, archive, close or send.

## Verification and rollout

The Rust UI test renders a real `App` with Ratatui's headless TestBackend and
compares its published data with the shared MCP fixture. It also checks filtering
and collapse behavior against rendered text. The JS tests consume that same
fixture, inject 381 historical done records, and verify unchanged UI counts,
category separation, review order, stale/partial handling and Working exceptions.

Rollout needs the updated Worker, installed connector and a restarted dashboard.
An old dashboard deliberately returns unavailable instead of an approximate set.
Older strict Workers reject the optional dashboard field; the updated connector
retries that validation rejection without it, preserving existing status sync.
The new visible tool still requires an updated Worker. Both the normal deployment
command and `install-latest.sh agentview` run the live release gate. That gate
creates its own native probe and temporary production reader credential; it must
not be run under a no-production-writes constraint. No unrelated session needs to
be hidden, archived, renamed, restarted or messaged to enable this API.

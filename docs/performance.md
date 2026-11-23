# Performance measurements

## Dashboard refresh

The README's refresh numbers are the original medians over 30 seconds of
one-second refreshes on an Apple M5 Pro, with a 17 GB OpenCode history.
They were recorded using Moritz's OpenCode setup, not separate stock/fork runs.
See the [timing log](cli.md#timing-log) to measure your own setup.

BetterAgentView reads OpenCode's database directly, read-only. This optimization
supports stock OpenCode too. It does not depend on the fork's TUI switching API.
The historical CLI-based OpenCode refresh took about 460 ms versus 130 ms for
direct reads. Cursor refresh dropped from about 80 ms using `lsof` to 3 ms using
chat files and macOS process APIs.

## Native chat opening

Measured on November 23, 2026, on the same Apple M5 Pro:

- **Stock:** official OpenCode v2.4.0, macOS arm64 release, checked against its published SHA256SUMS.
- **Fork:** `v2.0.32-local.efafe6107c`, with targeted TUI switching.
- **Workload:** identical synthetic chats, 40 messages each, one folder, no plugins
  or credentials. Each build has its own disposable HOME, XDG directories, and server.
- **Terminal:** headless PTY, 140 columns by 40 rows. No window or sound.

Across 40 measured openings per build, the median was **203.603 ms for stock**
and **52.470 ms for the fork**, a **3.88×** ratio. The README rounds these to
204 ms, 52 ms, and 3.9×. The first batch ran stock first (10 openings per build);
the confirmation batch ran the fork first (30 per build). Their separate medians
were 176/61 ms and 214/51 ms, respectively. The published numbers include both
batches, not just the faster run.

Both servers and an initial chat are warmed before measuring. Each measured chat
is visited for the first time. Stock starts a new TUI; the fork switches its
already-running TUI through `/api/tui/select-session`, targeting its client ID.
These are the native paths BetterAgentView uses when the capability is absent or present.

The clock starts before launching the TUI or sending the switch request. It stops
when a unique marker in the last assistant reply reaches the PTY. This includes
loading and rendering the transcript, not just the HTTP acknowledgment.

**This is a component benchmark, not a dashboard end-to-end benchmark.** It excludes
server startup, dashboard dispatch and preview, revisits to retained interfaces,
and model response generation. The versions differ, so it compares these two
builds, not the isolated effect of a single patch. Synthetic history is much
smaller than the 17 GB history used for the separate refresh measurements.

Reproduce with Python 3 on macOS or Linux and two OpenCode V2 binaries:

```sh
python3 scripts/bench-opencode-open.py \
  --stock /path/to/stock/opencode --fork /path/to/fork/opencode \
  --runs 30 --order fork-first --output results.json
```

On Moritz's machine, prefix this command with
`python3 ~/.claude/scripts/heavy-job.py --wait --` to use the heavy-job queue.
The script imports fixtures without making a model request, shuts down its
servers and TUIs, and removes its temporary data. Existing services and histories
are untouched. Use `--order stock-first` to check the other run order.

[Raw samples and build versions](benchmarks/opencode-open-2026-11-23.json).

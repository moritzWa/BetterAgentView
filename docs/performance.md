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

## Other harnesses' native chat opening

Measured on the same Apple M5 Pro on November 23, 2026. Each valid result is
the median of 30 openings, after a separate uncounted warm-up:

| Harness | Version | Median |
| --- | --- | ---: |
| Claude Code | 2.1.330 | 208.021 ms |
| OpenAI Codex | 0.163.0 | 1347.072 ms |
| Cursor | 2026.09.28-64d2043 | 1306.790 ms |
| Pi | 1.6.0 | 159.377 ms |

Each opening starts a new native process and resumes a different saved chat.
The workload matches the OpenCode test: 40 short user/assistant messages,
one folder, a 140-column by 40-row headless PTY, and a unique marker in the last
assistant reply. The timer includes process startup and initial conversation
rendering, but not fixture import, shutdown, dashboard dispatch, or a model turn.
Some clients initially render only the most recent messages. This measures the
initial conversation view, not eagerly rendering every older message.

Fixtures are generated as Claude JSONL and converted with `session-migrate`.
HOME, agent homes, and XDG directories are private and disposable. No user plugins
or project configuration are inherited. Trust is configured only for the
temporary test folder. Claude and Codex use placeholder API keys; no model
request is submitted. Cursor requires an existing valid login for startup and
uses it only in its verified in-memory credential backend. Its authentication
metadata traffic is included. Retained-interface revisits are not measured.

The clients' startup paths differ, so these are clean-profile reference numbers,
not a controlled comparison of rendering engines or a promise for a configured
daily workspace. Terminal logs were checked for authentication, connection,
and retry errors before accepting the four results. The OpenCode comparison
remains the separate 40-opening run above, not a new 30-opening measurement.

### Excluded results

- **Devin 3000.11.3:** one early smoke test rendered, but the full run entered
  browser sign-in instead of restoring the chat. Its empty-profile startup can
  enter that flow despite no-browser environment flags. The run was stopped;
  neither login time nor the single smoke sample is published as a chat-opening
  result. The benchmark runner now refuses this macOS test before launching it.
  Diagnostic profiles were removed rather than retaining account state.
- **Antigravity 1.5.15:** its official macOS binary did not recognize the
  conversation generated by the converter pinned to the older 1.1.16 format.
  It displayed “conversation not found” and sign-in, not the transcript.
- **Terminal:** no native chat transcript to resume, so the metric does not apply.

### Reproduce

Install the native CLIs and `session-migrate`, then run from the repository:

```sh
python3 scripts/bench-harness-open.py --runs 30 \
  --bin claude=/path/to/claude --bin codex=/path/to/codex \
  --bin cursor=/path/to/cursor-agent --bin pi=/path/to/pi \
  --output harness-results.json
```

For Cursor, the runner reads `CURSOR_AUTH_TOKEN` from its parent environment or
the existing macOS Keychain item. An existing OpenCode login can instead be read
with `--cursor-auth-file /path/to/opencode/auth.json`. It does not modify that file
or persist the token to the test profile or Keychain. Expired credentials are a
failed validation, not a performance result. Optional `--logs /path/to/logs`
keeps synthetic terminal output for checking startup warnings.

On Moritz's machine, prefix the benchmark with
`python3 ~/.claude/scripts/heavy-job.py --wait --`. Pure helper tests run with
`python3 scripts/test-benchmark-helpers.py`. Every native process is stopped and
its private profile removed after the run; failed diagnostics retain only
terminal logs, not account profiles.

[Raw samples and excluded-result reasons](benchmarks/harness-open-2026-11-23.json).

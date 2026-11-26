# Connector recovery checks

These are manual operator tests, not CI tests. They need macOS and an existing
paired installation. They never write to the OpenCode source database.

## Live cloud outage

Run `live-outage.py` through the heavy-job queue. It temporarily stops only the
bridge login item and runs the installed connector with the same pairing and
journal. Set `AGENTVIEW_TEST_BRIDGE_BIN` to test a candidate binary instead.

The test waits for an idle sync to finish, then routes only that process's new
HTTPS connections to a silent local listener for 70 seconds. The real curl
processes time out. Add a visible assistant message when the test prints `DROP`.
After restoring the route, the test compares that session's full text hash and
message count with the deployed Worker's `/v1/sync/verify` endpoint. It also waits
for the connector to finish its sync pass. It does not log text or credentials.

The login item is restored in `finally`, including on interrupt. A report goes to
`~/Documents/agentview-bridge-outage-results.json`. Do not run two copies together.
The host's network and other apps are not disconnected.

## macOS VM pause and resume

Start and exclusively lease the `office-marketplace` macOS Space. Run
`vm-sleep.py` through the heavy-job queue. The test copies the installed binary
into the guest and uses an empty synthetic source, a disposable keychain, and a
local HTTPS server. No personal pairing credentials enter the VM.

After the first sync finishes, it pauses the guest for 45 seconds and resumes it.
It checks for a fresh sync before the 15-minute idle timer expires and requires
the daemon's sleep-detection log. The daemon, HTTPS server, test SSH key and
temporary keychain are cleaned up. Stop the VM afterwards if nobody else holds it.

The report goes to `~/Documents/agentview-bridge-vm-sleep-results.json`.
This checks a real VM pause/resume. It is not a physical laptop lid-close test or
a ChatGPT mobile-client test.

## November 22, 2026

- An outage during upload recovered in 9.83 seconds after the route returned.
  This session's text hash and message count matched the real cloud copy.
- The installed connector detected the macOS guest's sleep gap. A new sync
  completed 8.35 seconds after the resume command began.
- The idle-connector test exposed a missing recovery signal: polling recovered,
  but history was still behind after 92.44 seconds. The successful poll woke the
  loop without bypassing its idle timer. The fix requests one immediate sync
  after a failed polling cycle recovers.
- With that fix, the same idle test passed. All 56 visible messages matched the
  real cloud copy, and the complete sync pass finished within 69.11 seconds of
  restoring transport. No restart or mobile activity triggered the catch-up.
- The candidate binary also passed the VM pause/resume test. It logged the
  sleep gap and completed a fresh sync 9.10 seconds after resume began.

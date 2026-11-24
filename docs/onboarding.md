# Getting started

**Paste the [setup prompt](SETUP-PROMPT.md) into your coding agent** to have it
check your computer and walk you through setup. In the dashboard, `/onboarding`
copies the same prompt. From a terminal:

```console
betteragentview onboarding --copy
```

Without a desktop clipboard, `betteragentview onboarding` prints it. Linux copy
needs `wl-copy` or `xclip`. You can also follow the steps below yourself.

## 1. Install and connect a coding harness

Use the [installer](../README.md#install), then run `av`. Existing local sessions
are discovered automatically. No BetterAgentView account or cloud backend is
needed for the dashboard.

Run `betteragentview doctor` to check installed harnesses. To install and sign in:

```console
betteragentview setup opencode
```

The dashboard equivalent is `/setup opencode`. `/setup claude`, `/setup codex`
and other [supported harnesses](../README.md#harnesses) work too. Installation
asks before changing your computer; authentication opens the harness's own UI.
For an installed harness, `/login` opens its native login. API keys and subscription
logins for coding models belong to that harness, not BetterAgentView.

**OpenCode is recommended** for desktop voice and the mobile bridge. Stock
OpenCode works. Moritz's optional [V2 fork](https://github.com/moritzWa/opencode/tree/v2-parity)
adds targeted warm session switching. His [setup notes](https://gist.github.com/moritzWa/9c0eb6f5d36a238714a40b900fde09ce)
also link a [Cursor provider fork](https://github.com/moritzWa/cursor-opencode-provider)
for Cursor subscription models inside OpenCode. Use the current V2 section,
not the legacy V1 snippets. These are optional source-based additions, not
prerequisites or bundled accounts. Keep stock OpenCode and launch the fork with
`av --opencode-bin /absolute/path/to/opencode-dev`.

Type a task, use `Tab` to pick the harness and `Shift+Tab` to pick its model, then
press `Enter`. A login completing is not proof that a model call works: send a
small task and check its reply.

## 2. Optional desktop voice

Desktop voice reads and controls OpenCode sessions. Choose one voice provider:

| Provider | Dashboard command | Get a separate API key |
| --- | --- | --- |
| OpenAI | `/voice openai` | [OpenAI API keys](https://platform.openai.com/api-keys) |
| xAI Grok | `/voice grok` | [xAI console](https://console.x.ai/) |

The next `/voice` or `Ctrl+K` asks for the key in a masked input if none is
available. You can skip voice entirely. **Grok is not Groq.** Groq keys are not
supported. ChatGPT, Claude, Cursor subscriptions and OpenCode credentials do not
provide voice API access; voice calls have separate API billing. BetterAgentView
does not extract coding-provider keys from OpenCode.

Keys are stored locally in `~/.local/state/agentview/voice/key.json` (or under
`$XDG_STATE_HOME`). `OPENAI_API_KEY` and `XAI_API_KEY` can also supply them.
Do not paste keys into an agent conversation. Allow microphone access on the
first call. See [Voice Mode](voice.md) for settings, costs and troubleshooting.

## 3. Navigation and shortcuts

Arrow keys select sessions and directory headings. `Enter` opens a session;
`F7` returns to the dashboard. `?` shows the full shortcut list.
Mouse movement does not change selection. Clicking a row opens it, and the wheel
moves through the list. Run `av --mouse-hover` to restore hover-to-select, or set
`AGENTVIEW_MOUSE_HOVER=true` in your shell profile.

Shortcuts have two layers: BetterAgentView handles terminal keys, while the
terminal decides which bytes a physical shortcut sends. There is no general
BetterAgentView keybinding editor yet. Use your terminal's settings to map a
preferred combination to an existing key, and configure the harness's own
shortcuts separately. For example, Ghostty's config can map `Cmd+K` to the
existing voice key:

```ini
keybind = super+k=text:\x0b
```

See the [keyboard guide](cli.md#tui-keys-and-mode-behavior) and
[dedicated return key](cli.md#a-dedicated-key-to-return-to-the-dashboard).
Keep a working return key when changing terminal mappings.

## 4. Optional ChatGPT mobile and MCP sync

This is a separate feature, not a requirement for desktop voice or the dashboard.
Your own Cloudflare Worker serves an authenticated `/mcp` endpoint; Neon stores
the synced conversation copy and queued messages. Google OAuth restricts access
to your owner account. It is a single-owner service, not a hosted signup product.

Follow [self-hosting](../bridge/SELF-HOSTING.md) to provision your own backend,
then [pair the Mac and connect ChatGPT](mobile-bridge.md). Read the privacy section
before syncing: conversation text leaves your computer, and the backend and
ChatGPT can read it. Nothing is uploaded by the basic dashboard or this setup
prompt. Pairing alone does not upload history; `sync-once` or the installed
connector does. The Mac must be awake to execute queued work.

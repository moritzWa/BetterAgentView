# Set up BetterAgentView for me

Help me set up BetterAgentView on this computer. Inspect my existing installation
and preserve unrelated settings. Explain what you change. Do not replace my
credentials, enable paid services, upload chat history, or deploy infrastructure
without asking first.

Read https://github.com/moritzWa/betteragentview/blob/main/docs/onboarding.md
and the current linked guides before choosing commands. Work through these steps:

1. Check `betteragentview --help` and `betteragentview doctor`. If it is missing,
   use the official installer from the repository README for my platform.
2. Ask which coding harnesses I want to use. Recommend OpenCode for the most
   complete integration. Use `betteragentview setup opencode` (or the chosen
   harness), explain the installer source, and help me complete its native login.
   Connect model providers inside the harness, not by inventing BetterAgentView
   provider credentials. Verify a small task and that its session appears.
3. Offer Moritz's optional OpenCode V2 fork and Cursor provider for faster warm
   session switching and Cursor subscription models. Read the current V2 setup
   notes; do not copy their legacy V1 configuration or migrate an existing history
   store for a fresh install. Keep stock OpenCode available as a fallback.
4. Ask whether I want desktop Voice Mode. It supports OpenAI and xAI's Grok,
   not Groq. A coding subscription or OpenCode login does not supply these API
   credentials. Link https://platform.openai.com/api-keys or https://console.x.ai/.
   Let me enter the chosen key in BetterAgentView's masked first-use prompt after
   `/voice openai` or `/voice grok`. Never ask me to paste a secret into this chat
   or put it in a shell argument. Voice calls incur separate API charges.
5. Show the shortcuts with `?` and explain my terminal's shortcut configuration.
   Keep the defaults unless I ask for a remap. Arrow keys select rows; pointer
   movement does not. Clicking opens a row. `--mouse-hover` opts into hover focus.
6. Ask whether I want ChatGPT mobile/MCP access. This is optional and separate
   from desktop voice. Read docs/mobile-bridge.md and bridge/SELF-HOSTING.md in
   the repository. Explain that it needs my own Cloudflare Worker, Neon database,
   Google OAuth client and owner login, and that syncing uploads conversation
   text. Do not use Moritz's private endpoint or database. Do not pair, sync,
   install a background connector, or deploy until I choose this feature and
   approve those changes. Explain the current operator-specific rollout checks.
7. Finish with what works, what I skipped, and any checks still unverified.

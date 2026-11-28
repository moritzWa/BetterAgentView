---
name: bav-mcp-smoke
description: Run after BetterAgentView MCP deployments or when debugging its remote tools. Use OpenCode for routine checks, not the ChatGPT UI.
---

# BetterAgentView MCP smoke test

1. Keep the installed bridge release gate. See [deployment setup](../../../bridge/SETUP.md).
2. In a disposable OpenCode runner, use a remote MCP connection to the deployed Worker over HTTPS. Use a short-lived credential scoped to an isolated test source. Keep the receiving OpenCode session separate from the runner. Never use a production-owner grant or send to the runner itself.
3. List the test sessions, send a unique harmless marker to the receiver, and start a disposable session if testing starts. Check each request is saved and its exact prompt appears once in native history. A save receipt alone is not delivery. Test one safe rejection and check it names the failed action. Remove the fixtures and revoke the test credential.
4. If the isolated OpenCode pairing is unavailable, report that gap. The existing deployed tool contract check and installed bridge gate can still verify their respective paths. Skip routine ChatGPT Voice testing. OpenCode does not verify spoken output; never test on the owner's main ChatGPT account.

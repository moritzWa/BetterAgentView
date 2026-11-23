// Diagnostic preload for Cursor's Node runtime. No request bodies, headers,
// tokens, or user file contents are recorded. Not used for published timings.
const fs = require("node:fs")
const Module = require("node:module")
const http2 = require("node:http2")
const start = process.hrtime.bigint()
const file = process.env.AV_PROFILE_EVENTS
function event(name, detail = {}) {
  fs.appendFileSync(file, JSON.stringify({event: name, pid: process.pid, ms: Number(process.hrtime.bigint() - start) / 1e6, ...detail}) + "\n")
}
event("node-preload", {wall_ms: Date.now()})
const load = Module._extensions[".js"]
Module._extensions[".js"] = function (module, filename) {
  const main = filename.endsWith("/index.js") && filename.includes("cursor-agent/")
  if (main) event("main-module-start")
  const result = load(module, filename)
  if (main) event("main-module-loaded")
  return result
}
let first = true
let reply = false
const write = process.stdout.write
process.stdout.write = function (chunk, ...args) {
  if (first) { first = false; event("first-stdout") }
  if (!reply && String(chunk).includes("RENDER_BENCH_0000")) {
    reply = true
    event("reply-written")
  }
  return write.call(this, chunk, ...args)
}
const connect = http2.connect
http2.connect = function (authority, ...args) {
  let hostname
  try { hostname = new URL(String(authority)).hostname } catch { hostname = "unknown" }
  event("http2-connect", {hostname})
  const session = connect.call(this, authority, ...args)
  session.once("connect", () => event("http2-ready", {hostname}))
  session.once("error", error => event("http2-error", {hostname, code: error.code || "unknown"}))
  return session
}

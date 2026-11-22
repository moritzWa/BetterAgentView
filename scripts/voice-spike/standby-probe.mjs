// Does GPT-Live standby swallow an update agentview sends while it is paused?
// Creates a gpt-live-1.1 session with a 5 second idle timeout, waits for session.paused,
// sends a commentary (or instructions) append and reports whether the voice speaks.
//   node standby-probe.mjs [commentary|instructions|keepalive]   microphone: PROBE_WAV or /tmp/silence.wav (60 s of silence)
// keepalive sends a thinking append every 3 s instead, to see whether that keeps the session out of standby.
// Run under heavy-job.py. Costs a few cents.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(process.env.VOICE_E2E_MODULES_FROM || `${process.env.HOME}/Code/understand/package.json`);
const { chromium } = require("playwright");
const key = process.env.OPENAI_API_KEY || execFileSync("op", ["item", "get", process.env.VOICE_E2E_OP_ITEM || "arca agentview voice agent", "--fields", "api key", "--reveal"]).toString().trim();
const mode = process.argv[2] || "commentary";
const t0 = Date.now();
const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${process.env.PROBE_WAV || "/tmp/silence.wav"}%noloop`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage();
await page.route("http://localhost/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><audio id=a autoplay></audio></html>" }));
await page.goto("http://localhost/");
await page.exposeFunction("note", (text) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), "s", text));
await page.exposeFunction("makeSession", async (sdp) => {
  const body = { session: { model: "gpt-live-1.1", instructions: "You are a quiet assistant. Speak only when you have something to say.", audio: { output: { voice: "meridian" } }, wake_policy: { type: "speech" }, idle_timeout_s: 5, store: false }, transport: { type: "webrtc", sdp } };
  const response = await fetch("https://api.openai.com/v1/live/sessions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (response.status > 201) throw new Error(JSON.stringify(json));
  return json.transport.sdp;
});
await page.evaluate(async (mode) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc = new RTCPeerConnection();
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  pc.ontrack = (e) => { document.getElementById("a").srcObject = e.streams[0]; };
  const dc = pc.createDataChannel("oai-events");
  const energy = async () => { let total = 0; (await pc.getStats()).forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio") total = r.totalAudioEnergy || 0; }); return total; };
  dc.onmessage = async (m) => {
    const event = JSON.parse(m.data), type = event.type;
    if (type.includes("usage") || type.includes("audio.delta")) return;
    if (mode === "keepalive" && type === "session.started") setInterval(() => dc.send(JSON.stringify({ type: "session.thinking.append", delegation_id: null, content: "A session is still being watched." })), 3000);
    note(type.endsWith(".delta") ? `${type} ${(event.delta || "").slice(0, 60)}` : type);
    if (type === "session.paused" && mode !== "keepalive") {
      const base = await energy();
      note(`paused; sending ${mode} in 1s`);
      setTimeout(() => dc.send(JSON.stringify({ type: `session.${mode}.append`, event_id: "p1", delegation_id: null, content: "The bench session just finished. Tell the developer so, in one short sentence." })), 1000);
      setTimeout(async () => note(`audio energy received in the 12 s after: ${((await energy()) - base).toFixed(4)}`), 13000);
    }
  };
  await new Promise((resolve) => {
    dc.onopen = resolve;
    pc.createOffer().then((o) => pc.setLocalDescription(o))
      .then(() => new Promise((r) => { if (pc.iceGatheringState === "complete") r(); else pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); }))
      .then(() => makeSession(pc.localDescription.sdp))
      .then((sdp) => pc.setRemoteDescription({ type: "answer", sdp }));
  });
}, mode);
await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SECONDS || 30) * 1000));
await browser.close();

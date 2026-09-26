#!/usr/bin/env node
// Renders the link-preview card (og:image) to a PNG.
//
// A link with no preview looks like spam in WhatsApp and Telegram, which is where a Nigerian P2P offer
// actually gets shared. This draws the card in headless Chrome — the same way the cold check drives a
// browser — so the type and colours are the app's own rather than an approximation in an image editor.
//
//   node scripts/make-og-image.mjs            # writes packages/contracts/my-rainbowkit-app/public/og.png
//
// Re-run it when the wording or the brand colours change; the output is committed, since a static export
// has nowhere to generate it at build time.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../packages/contracts/my-rainbowkit-app/public/og.png");

const CHROME = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(2);
}

// 1200x630 is what Open Graph consumers crop to; anything else gets letterboxed or cut.
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&family=Geist+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #0b0d0c; color: #f4f6f5;
         font-family: Geist, system-ui, sans-serif; display: flex; flex-direction: column;
         justify-content: space-between; padding: 72px 80px;
         background-image: radial-gradient(circle at 78% 18%, rgba(44,214,125,0.16), transparent 46%); }
  .mark { display: flex; align-items: center; gap: 16px; }
  .glyph { width: 52px; height: 52px; border-radius: 13px; background: #f4f6f5; color: #0b0d0c;
           display: grid; place-items: center; font-size: 27px; font-weight: 700; }
  .name { font-size: 34px; font-weight: 700; letter-spacing: -0.5px; }
  .name span { color: #2cd67d; }
  h1 { font-size: 66px; line-height: 1.06; font-weight: 700; letter-spacing: -2.2px; max-width: 15ch; }
  h1 em { font-style: normal; color: #2cd67d; }
  p { font-size: 27px; line-height: 1.45; color: #9aa4a0; max-width: 34ch; margin-top: 26px; }
  .foot { display: flex; gap: 12px; align-items: center; }
  .chip { font-family: "Geist Mono", ui-monospace, monospace; font-size: 19px; color: #c8d0cd;
          border: 1px solid #2a2f2d; border-radius: 999px; padding: 11px 20px; }
</style></head><body>
  <div class="mark"><div class="glyph">⇄</div><div class="name">escrow<span>x</span></div></div>
  <div>
    <h1>Trade crypto for cash, <em>without trusting us</em></h1>
    <p>Funds sit in a contract only you, your counterparty and an independent arbitrator can move.</p>
  </div>
  <div class="foot">
    <span class="chip">non-custodial escrow</span>
    <span class="chip">encrypted chat</span>
    <span class="chip">public arbitration</span>
  </div>
</body></html>`;

const profile = mkdtempSync(join(tmpdir(), "escrowx-og-"));
const port = 9800 + Math.floor(Math.random() * 190);
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--window-size=1200,630",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome never opened a debugging port");
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}` });
  await sleep(2500); // let the webfont land — without it the card renders in a fallback face
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(OUT, Buffer.from(data, "base64"));
  const kb = (Buffer.from(data, "base64").length / 1024).toFixed(0);
  console.log(`Wrote ${OUT} (1200×630, ${kb} KB)`);
} finally {
  ws.close();
  chrome.kill();
}

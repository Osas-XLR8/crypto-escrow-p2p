#!/usr/bin/env node
// `npm run check:cold` — load the app the way a stranger does, and fail if the promises are empty.
//
// Everything we get wrong in a way we can't see, we get wrong because we are always connected, always cached,
// always on a machine that has already run the thing once. This opens a fresh browser profile with **no wallet
// extension and no injected provider**, loads the published site, and checks that the pages which claim to
// work in that state actually do:
//
//   • the market lists offers, with prices and reputation
//   • the arbitration desk renders firms, panels, cases and rulings — it promises to be readable without a
//     wallet, and a page that advertises that and shows nothing is worse than one that never promised it
//
//   npm run check:cold
//   npm run check:cold -- --url http://localhost:3200/
//
// No dependencies: it drives whatever Chrome is installed over the DevTools protocol.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SITE = (arg("url", process.env.COLD_CHECK_URL || "https://osas-xlr8.github.io/crypto-escrow-p2p/")).replace(/\/?$/, "/");
const TIMEOUT_MS = Number(arg("timeout", "60")) * 1000;

const CHROME = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), "escrowx-cold-"));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions", // the point: no wallet
    "--window-size=1440,1200",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome never opened a debugging port");
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");

const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

async function open(path) {
  await send("Page.navigate", { url: `${SITE}${path}?cold=${Date.now()}` });
  await sleep(1500);
}

async function waitForText(pattern, label) {
  const until = Date.now() + TIMEOUT_MS;
  while (Date.now() < until) {
    const text = await evaluate("document.body.innerText");
    if (pattern.test(text ?? "")) return true;
    await sleep(1000);
  }
  console.error(`  ✗ ${label}`);
  return false;
}

const failures = [];
const check = async (label, pattern) => {
  const found = await waitForText(pattern, label);
  if (found) console.log(`  ✓ ${label}`);
  else failures.push(label);
};

try {
  console.log(`Cold check — no wallet, fresh profile, ${SITE}`);

  console.log("\nMarket");
  await open("");
  if (await evaluate("!!window.ethereum")) throw new Error("this browser has a wallet injected — not a cold state");
  await check("offers are listed", /per tUSDT/);
  await check("the market median is shown", /Market median/);
  await check("counterparty history is shown", /\d+ trades|no trades here yet/);
  await check("the fee is disclosed", /No EscrowX fee|No trading fee/);

  console.log("\nArbitration desk");
  await open("arbitrate/");
  await check("the desk loads", /Arbitration desk/);
  await check("it offers a way to connect", /Connect wallet/i);
  await check("the firm's own details render", /Fee per side/);
  await check("the panel renders", /Panel/);
  await check("cases render", /Case #\d/);
  await check("a ruling or a case status renders", /Ruled:|Proposed ruling|Needs assignment|With panelist/);

  const errors = await evaluate(`JSON.stringify(window.__coldErrors ?? [])`);
  if (errors && errors !== "[]") console.log(`  page errors: ${errors}`);
} catch (e) {
  failures.push(e.message);
} finally {
  try {
    ws.close();
  } catch {
    /* closing anyway */
  }
  chrome.kill();
  // Chrome can still be letting go of its profile directory; a leftover temp dir must never fail the check.
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* the OS will clean it up */
  }
}

if (failures.length) {
  console.error(`\n✗ Cold check failed:\n  - ${failures.join("\n  - ")}`);
  console.error("\nThis is what a first-time visitor sees. Fix it before anything else.");
  process.exit(1);
}
console.log("\n✓ Everything a visitor is promised without a wallet actually renders.");

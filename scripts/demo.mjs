#!/usr/bin/env node
// `npm run demo` — a clean clone to a working demo, in one command.
//
// The demo environment is the first thing an investor, a partner or an auditor touches, so it gets treated
// like a product surface rather than a pile of tribal knowledge. This kills stale processes (including a chain
// left running inside WSL), clears the build cache, installs, starts a local chain, deploys the contracts,
// seeds a market with history, starts the demo counterparties, and serves the app on a known port — then
// prints the URL and stays up until Ctrl-C.
//
//   npm run demo                 # local chain, http://localhost:3200
//   npm run demo -- --port 4000
//   npm run demo -- --no-install # skip npm install (faster when nothing changed)
//
// Nothing here touches your .env.local: the app is started with the fresh addresses in its environment, so
// whatever you had pointed at a testnet still points there afterwards.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contracts = join(root, "packages/contracts");
const app = join(contracts, "my-rainbowkit-app");
const sdk = join(root, "packages/sdk");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "3200"));
const ANVIL_PORT = 8545;
const RELAY_PORT = 7777;
const INSTALL = !process.argv.includes("--no-install");
const WINDOWS = process.platform === "win32";

const children = [];
let step = 0;
const say = (text) => console.log(`\n[${++step}] ${text}`);
const ok = (text) => console.log(`    ✓ ${text}`);
const warn = (text) => console.log(`    ! ${text}`);

function die(message, fix) {
  console.error(`\n✗ ${message}`);
  if (fix) console.error(`  ${fix}`);
  shutdown(1);
}

function shutdown(code = 0) {
  for (const { child } of children) {
    try {
      if (WINDOWS && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // A chain started inside WSL outlives the Windows process that launched it.
  if (WINDOWS && hasWsl) spawnSync("wsl.exe", ["-e", "bash", "-lc", "pkill -f anvil >/dev/null 2>&1; true"], { stdio: "ignore" });
  process.exit(code);
}
process.on("SIGINT", () => {
  console.log("\nStopping everything…");
  shutdown(0);
});

// On Windows only npm/npx need a shell (they are .cmd shims). Everything else is spawned directly, because a
// shell would re-parse arguments like `bash -lc "cd … && anvil"` and mangle them.
const needsShell = (cmd) => WINDOWS && /^(npm|npx|yarn|pnpm)$/.test(cmd);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? "pipe" : "inherit", shell: needsShell(cmd), ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    if (opts.quiet) console.error(String(r.stdout ?? "") + String(r.stderr ?? ""));
    die(`${cmd} ${args.join(" ")} failed`);
  }
  return r;
}

function background(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: needsShell(cmd), ...opts });
  children.push({ name, child });
  const log = (buf) =>
    String(buf)
      .split("\n")
      .filter((l) => l.trim() && opts.echo?.(l))
      .forEach((l) => console.log(`    [${name}] ${l.trim()}`));
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("exit", (code) => code && warn(`${name} exited with ${code}`));
  return child;
}

// ─── Foundry, wherever it lives ───────────────────────────────────────────────
// Foundry is often only installed inside WSL on Windows. Rather than make that the reader's problem, find it.

function onPath(cmd) {
  return spawnSync(WINDOWS ? "where" : "which", [cmd], { stdio: "pipe" }).status === 0;
}

const wslPath = (p) => "/mnt/" + p[0].toLowerCase() + p.slice(2).replace(/\\/g, "/");
const hasWsl = WINDOWS && onPath("wsl.exe") && spawnSync("wsl.exe", ["-e", "bash", "-lc", "command -v anvil forge"], { stdio: "pipe" }).status === 0;

function foundry(tool, args, cwd, env = {}) {
  const exported = Object.entries(env)
    .map(([k, v]) => `${k}=${v} `)
    .join("");
  if (onPath(tool)) return { cmd: tool, args, opts: { cwd, env: { ...process.env, ...env } } };
  if (hasWsl) return { cmd: "wsl.exe", args: ["-e", "bash", "-lc", `cd ${wslPath(cwd)} && ${exported}${tool} ${args.join(" ")}`], opts: {} };
  die(
    `${tool} not found (Foundry)`,
    "Install it with:  curl -L https://foundry.paradigm.xyz | bash && foundryup\n  (on Windows, inside WSL is fine — this script will find it there)"
  );
}

/** Frees a port whatever holds it — including a process inside WSL, which Windows can't see or kill. */
function freePort(port, wslPattern) {
  if (WINDOWS && hasWsl && wslPattern) {
    spawnSync("wsl.exe", ["-e", "bash", "-lc", `fuser -k ${port}/tcp >/dev/null 2>&1; pkill -f '${wslPattern}' >/dev/null 2>&1; true`], { stdio: "ignore" });
  }
  if (WINDOWS) {
    const out = String(spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? "");
    const pids = new Set(
      out
        .split("\n")
        .filter((l) => l.includes(`:${port} `) && l.includes("LISTENING"))
        .map((l) => l.trim().split(/\s+/).pop())
        .filter((pid) => pid && pid !== "0")
    );
    for (const pid of pids) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
    return pids.size;
  }
  const out = String(spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" }).stdout ?? "").trim();
  const pids = out ? out.split("\n") : [];
  for (const pid of pids) spawnSync("kill", ["-9", pid], { stdio: "ignore" });
  return pids.length;
}

const free = (port) =>
  new Promise((resolve) => {
    const s = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });

async function waitFor(what, check, timeoutMs = 120_000, fatal = true) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (fatal) die(`Timed out waiting for ${what}`);
  return false;
}

/** Where the chain answers. Not always localhost — see the WSL note further down. */
let CHAIN_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

const rpc = async (method, params = [], url = CHAIN_RPC) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(3000),
    });
    return (await res.json()).result;
  } catch {
    return null;
  }
};

const wslIp = () =>
  String(spawnSync("wsl.exe", ["-e", "bash", "-lc", "hostname -I"], { encoding: "utf8" }).stdout ?? "")
    .trim()
    .split(/\s+/)[0] || null;

// ─── Go ───────────────────────────────────────────────────────────────────────

console.log("EscrowX demo environment");

say("Checking tools");
if (Number(process.versions.node.split(".")[0]) < 20) die(`Node ${process.versions.node} is too old`, "Install Node 20 or newer.");
ok(`Node ${process.versions.node}`);
foundry("anvil", ["--version"], contracts); // dies with instructions if missing
ok(onPath("anvil") ? "Foundry" : "Foundry (via WSL)");

say("Clearing anything left running");
for (const [port, wslPattern] of [
  [ANVIL_PORT, "anvil"],
  [RELAY_PORT, "dev-relay"],
  [PORT, null],
]) {
  const killed = freePort(port, wslPattern);
  if (killed) ok(`freed port ${port} (${killed} process${killed === 1 ? "" : "es"})`);
}
await waitFor("ports to free up", async () => (await free(PORT)) && (await free(RELAY_PORT)));
ok("ports are free");

const DIST = ".next-demo";

say("Clearing the build cache");
rmSync(join(app, DIST), { recursive: true, force: true });
ok(`removed ${DIST} (a stale chunk here is the classic 500 on first load)`);

if (INSTALL) {
  say("Installing dependencies");
  for (const [name, dir] of [
    ["sdk", sdk],
    ["web app", app],
  ]) {
    const lock = join(dir, "package-lock.json");
    const r = run("npm", [existsSync(lock) ? "ci" : "install", "--no-audit", "--no-fund"], { cwd: dir, quiet: true, allowFail: true });
    if (r.status !== 0) run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, quiet: true });
    ok(`${name} installed`);
  }
}

say("Building the SDK");
run("npm", ["run", "build"], { cwd: sdk, quiet: true });
ok("@escrowx/sdk built");

say("Starting a local chain");
// --host 0.0.0.0 matters when the chain runs inside WSL: bound to 127.0.0.1 there, Windows can't reach it.
const anvil = foundry("anvil", ["--port", String(ANVIL_PORT), "--host", "0.0.0.0", "--silent"], contracts);
background("chain", anvil.cmd, anvil.args, { ...anvil.opts, echo: () => false });
let up = await waitFor("the chain", async () => (await rpc("eth_chainId")) === "0x7a69", 20_000, false);
if (!up && hasWsl) {
  // Some Windows setups don't forward localhost into WSL. The chain is fine; it just isn't at localhost.
  const ip = wslIp();
  if (ip && (await rpc("eth_chainId", [], `http://${ip}:${ANVIL_PORT}`)) === "0x7a69") {
    CHAIN_RPC = `http://${ip}:${ANVIL_PORT}`;
    up = true;
    ok("this machine doesn't forward localhost into WSL, so everything here uses the WSL address instead");
  }
}
if (!up) die("The local chain never answered", "Check that anvil can bind port 8545.");
ok(`anvil on ${CHAIN_RPC} (chain 31337)`);

say("Deploying the contracts");
// The windows are the contracts' own minimums, so a demo can show a whole dispute without waiting a week.
const deploy = foundry(
  "forge",
  ["script", "script/DeployV4.s.sol:DeployV4", "--rpc-url", `http://127.0.0.1:${ANVIL_PORT}`, "--broadcast", "--silent"],
  contracts,
  { FIRM_FEE: "500000000000000", REVIEW_PERIOD: "3600", ARBITRATION_TIMEOUT: "604800", FEE_TIMEOUT: "86400" }
);
run(deploy.cmd, deploy.args, { ...deploy.opts, cwd: deploy.opts.cwd ?? contracts, quiet: true });
const deployment = JSON.parse(readFileSync(join(contracts, ".deployments/v4-31337.json"), "utf8"));
ok(`escrow ${deployment.escrow}`);

say("Starting the relay that offers and chat travel over");
background("relay", "node", ["scripts/dev-relay.mjs"], { cwd: sdk, echo: () => false });
await waitFor("the relay", async () => !(await free(RELAY_PORT)));
ok(`relay on ws://127.0.0.1:${RELAY_PORT}`);

say("Seeding the market");
run("node", ["scripts/seed-demo.mjs", "--chain", "31337", "--rpc", CHAIN_RPC], { cwd: sdk, quiet: true });
ok("offers posted by the demo makers");
run("node", ["scripts/seed-history.mjs", "--chain", "31337", "--scale", "0.35", "--rpc", CHAIN_RPC], { cwd: sdk, quiet: true });
ok("settled trades, so the reputation badges have something to say");

say("Recording a dispute, so the desk has a case to show");
// A demo whose arbitration page is empty is a demo of the wrong thing. This runs a whole contested dispute —
// both sides filing sealed evidence, a panelist ruling, the firm executing — in a couple of seconds.
run("node", ["scripts/demo-dispute.mjs", "--chain", "31337", "--rpc", CHAIN_RPC, "--warp", "--contested"], { cwd: sdk, quiet: true });
ok("a contested case, ruled and executed, readable at /arbitrate/");

say("Starting the demo counterparties");
background("bots", "node", ["scripts/demo-bots.mjs", "--chain", "31337", "--rpc", CHAIN_RPC], { cwd: sdk, echo: (l) => /#\d|out of gas/.test(l) });
ok("demo wallets answer trades you open, whoever opened them");

say("Starting the app");
background("app", "npx", ["next", "dev", "-p", String(PORT)], {
  cwd: app,
  env: {
    ...process.env,
    // Its own build directory, so a `next build` running elsewhere cannot pull chunks out from under it.
    NEXT_DIST_DIR: DIST,
    NEXT_PUBLIC_CHAIN_ID: "31337",
    NEXT_PUBLIC_RPC_URL: CHAIN_RPC,
    NEXT_PUBLIC_V4_ESCROW: deployment.escrow,
    NEXT_PUBLIC_V4_USDT: deployment.usdt,
    NEXT_PUBLIC_V4_PRIMARY_ARBITRATOR: deployment.primaryArbitrator,
    NEXT_PUBLIC_V4_FALLBACK_ARBITRATOR: deployment.fallbackArbitrator,
    NEXT_PUBLIC_V4_DEPLOY_BLOCK: String(deployment.deployBlock ?? 0),
    NEXT_PUBLIC_V4_TOKEN_SYMBOL: "tUSDT",
    NEXT_PUBLIC_V4_TOKEN_FAUCET: "true",
    NEXT_PUBLIC_RELAYS: `ws://127.0.0.1:${RELAY_PORT}`,
  },
  echo: (l) => /error/i.test(l),
});
await waitFor(
  "the app",
  async () => {
    try {
      return (await fetch(`http://localhost:${PORT}/`)).ok;
    } catch {
      return false;
    }
  },
  180_000
);

console.log(`
────────────────────────────────────────────────────────────
  EscrowX is running:  http://localhost:${PORT}
  Arbitration desk:    http://localhost:${PORT}/arbitrate/

  Local chain 31337 · escrow ${deployment.escrow}
  Add the chain to your wallet: RPC ${CHAIN_RPC}, chain id 31337.
  The app's own checklist hands out test ETH and tUSDT.

  Take any offer and the demo seller sends payment details and releases,
  so a whole trade completes without a second person.

  Ctrl-C stops everything this started.
────────────────────────────────────────────────────────────
`);

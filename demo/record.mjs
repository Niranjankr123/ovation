// Record the demo video's footage from the real site, against the live testnet contracts.
//
//   node demo/record.mjs               title cards, then one full round on chain
//   node demo/record.mjs cards         only the title cards
//   node demo/record.mjs live          only the on-chain footage (a fresh round, start to payout)
//   node demo/record.mjs payouts 23    only the payouts shot, for round 23
//   node demo/record.mjs total 23      only its last moment, once round 23 is paid
//   node demo/record.mjs feed|how|record   one of the other shots on its own
//
// Needs the demo accounts' keys (so only the deployer can run it) and playwright-core with
// its Chromium. It starts the site in demo mode on its own port, drives it with a visible
// cursor, and saves every screen frame with its timestamp to demo/out/shots/<shot>/.
// demo/edit.py then cuts those shots to the narration.
//
// Nothing on screen is staged: every click is a real transaction, and the waits you would
// sit through (a two-minute round, transaction finality) are recorded and later shortened.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ROOT, deployment, view, near, fmt, sleep, balanceOf, topUp } from "../scripts/lib.mjs";

const OUT = path.join(ROOT, "demo", "out", "shots");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1280;
const H = 720;
const what = process.argv[2] || "all";

const d = deployment();
const C = d.contract;
const DAO = d.dao;
const P = (name) => `${name}.${d.namespace}`;
const HQ = C.split(".").slice(1).join(".");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- a cursor you can see, and a ripple on every click ----
function overlay() {
  const install = () => {
    if (!document.documentElement || document.getElementById("__cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }
      @keyframes __ripple { from { transform: translate(-50%,-50%) scale(.2); opacity: .5 } to { transform: translate(-50%,-50%) scale(1); opacity: 0 } }
      .__ripple { position: fixed; width: 54px; height: 54px; border-radius: 50%; background: #c2412d; pointer-events: none; z-index: 2147483646; animation: __ripple .55s ease-out forwards; }`;
    document.documentElement.appendChild(style);
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 2.5l14.5 11.2-6.6 1.1-3.9 6.2z" fill="#1b1a17" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-200px,-200px)" });
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => (c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`), true);
    addEventListener(
      "mousedown",
      (e) => {
        const r = document.createElement("div");
        r.className = "__ripple";
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
  };
  install();
  document.addEventListener("DOMContentLoaded", install);
}

// ---- recording ----
async function cast(page, name) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const marks = {};
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = `f${String(n++).padStart(6, "0")}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 93, everyNthFrame: 1 });
  const save = () => fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ frames, marks }));
  const mark = (event) => {
    marks[event] = Date.now() / 1000;
    log(`  ${name}: ${event}`);
    save();
  };
  mark("start");
  return {
    mark,
    stop: async () => {
      mark("end");
      await cdp.send("Page.stopScreencast").catch(() => {});
      await sleep(250);
      save();
      await cdp.detach().catch(() => {});
      log(`  ${name}: ${frames.length} frames`);
    },
  };
}

const at = new WeakMap();
/** Move the cursor along an eased path that takes `ms`, however slow the machine is. */
async function glide(page, x, y, ms = 550) {
  const from = at.get(page) || { x: W * 0.62, y: H * 0.7 };
  const t0 = Date.now();
  for (;;) {
    const p = Math.min(1, (Date.now() - t0) / ms);
    const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    if (p >= 1) break;
    await sleep(10);
  }
  at.set(page, { x, y });
}

// Where an element is now. The page redraws itself every few seconds, so an element found a
// moment ago can be gone for an instant; look again rather than fail.
async function boxOf(locator) {
  for (let i = 0; i < 40; i++) {
    await locator.waitFor({ state: "visible", timeout: 60000 });
    const box = await locator.boundingBox().catch(() => null);
    if (box) return box;
    await sleep(150);
  }
  throw new Error("an element kept disappearing before it could be measured");
}

async function click(page, locator, { before = 140, ms = 550 } = {}) {
  const box = await boxOf(locator);
  await glide(page, box.x + box.width / 2, box.y + Math.min(box.height / 2, 22), ms);
  await sleep(before);
  // The page redraws itself every few seconds, which can move a button between the glide
  // and the press. Playwright finds it again and presses it wherever it is now.
  await locator.click({ delay: 60, timeout: 60000 });
  const now = await locator.boundingBox().catch(() => null);
  if (now) at.set(page, { x: now.x + now.width / 2, y: now.y + now.height / 2 });
}

async function scrollTo(page, y, ms = 800) {
  await page.evaluate(
    ([y, ms]) =>
      new Promise((done) => {
        const from = scrollY;
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms);
          const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
          scrollTo(0, from + (y - from) * e);
          if (p < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [y, ms],
  );
}

const refresh = (page) => page.evaluate(() => window.ovation?.refresh());
const become = async (page, name) => {
  await page.selectOption("#who select", name ? P(name) : "");
  await sleep(700);
};

/** Wait for the next toast, and say whether the action went through. */
async function toast(page) {
  const el = page.locator("#toasts .toast").last();
  await el.waitFor({ state: "visible", timeout: 120000 });
  const bad = await el.evaluate((n) => n.classList.contains("bad"));
  const text = await el.innerText();
  if (bad) throw new Error(`the site said: ${text}`);
  return text;
}
const clearToasts = (page) => page.evaluate(() => document.getElementById("toasts").replaceChildren());

async function act(as, action, args) {
  const res = await fetch(`${BASE}/demo/act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ as: P(as), action, args }) });
  const j = await res.json();
  if (!j.ok) throw new Error(`${as} ${action}: ${j.error}`);
  return j;
}

// ---- the title cards ----
async function cards(page) {
  const url = pathToFileURL(path.join(ROOT, "demo", "scenes.html")).href;
  for (const [s, secs] of [["intro1", 6], ["intro2", 5], ["intro3", 4], ["intro4", 5], ["brand", 4.5], ["d0", 2], ["d1", 2.5], ["d2", 2.5], ["d3", 2.5], ["close1", 5], ["close2", 5]]) {
    await page.goto(`${url}?s=${s}`);
    const shot = await cast(page, `card-${s}`);
    await sleep(secs * 1000);
    await shot.stop();
  }
}

// ---- a fresh round: Asha applauds Ravi, the crowd joins, Leo tries to cheat ----
async function roundShots(page) {
  await topUp(HQ, P("noor"), near(0.3)).catch(() => {});
  if (BigInt(await view(DAO, "get_available_amount")) < near(0.2)) throw new Error(`the demo treasury is low: send ${DAO} some NEAR first`);

  // Have the page open before the round starts, and film the opening once it has, so the
  // round on screen is the one the next shots play in.
  await page.goto(`${BASE}/#/`);
  await page.locator("h1").waitFor();
  await page.locator(".standing, .empty").first().waitFor();
  let round = await view(C, "get_round", { dao: DAO });
  log(`waiting ${Math.ceil((round.ends_ms - Date.now()) / 1000)} s for a fresh round`);
  await sleep(Math.max(0, round.ends_ms - Date.now()) + 1500);
  round = await view(C, "get_round", { dao: DAO });
  const left = () => Math.round((round.ends_ms - Date.now()) / 1000);
  await refresh(page);
  await page.locator(".round-head", { hasText: `Round ${round.round}` }).first().waitFor({ timeout: 20000 }).catch(() => {});
  log(`round ${round.round}, ${left()} s on the clock`);

  let shot = await cast(page, "open");
  await sleep(900);
  const chip = await boxOf(page.locator(".hero .chip.green"));
  await glide(page, chip.x + chip.width / 2, chip.y + chip.height / 2 + 3, 800);
  shot.mark("role");
  await sleep(1500);
  await scrollTo(page, 205, 900);
  await sleep(900);
  await shot.stop();
  await become(page, "asha");
  await page.locator("#ap-to").waitFor({ state: "visible" });

  // June and Kofi are applauded too, so the round has all three sizes of payout. Their
  // applause is sent now and lands while Asha is typing.
  const seeds = Promise.all([
    act("diego", "applaud", { to: P("june"), claps: 1, note: "Translated the docs to Spanish" }),
    act("mei", "applaud", { to: P("june"), claps: 1, note: "Kept the newcomer channel alive" }),
    (async () => {
      await act("noor", "applaud", { to: P("june"), claps: 1, note: "Patient answers in the help channel" });
      await act("noor", "applaud", { to: P("kofi"), claps: 1, note: "Clear write-up of the outage" });
    })(),
    (async () => {
      await act("sana", "applaud", { to: P("kofi"), claps: 1, note: "Reviewed my first pull request the same day" });
      await act("sana", "applaud", { to: P("june"), claps: 1, note: "Ran the newcomer call three weeks in a row" });
    })(),
  ]);
  await refresh(page);

  shot = await cast(page, "stage");
  await sleep(700);
  await click(page, page.locator("#ap-to"));
  await page.keyboard.type("ravi", { delay: 70 });
  shot.mark("who");
  await click(page, page.locator(".steps button", { hasText: /^2$/ }));
  shot.mark("claps");
  await click(page, page.locator("#ap-note"));
  await page.keyboard.type("Rewrote the indexer in a weekend", { delay: 32 });
  shot.mark("note");
  await sleep(300);
  await clearToasts(page);
  await click(page, page.locator("form button.primary"));
  shot.mark("send");
  await toast(page);
  shot.mark("landed");
  await seeds;
  await sleep(900);
  await scrollTo(page, 420, 800);
  await refresh(page);
  shot.mark("scrolled");
  await sleep(500);
  // The crowd: three more members, sent a beat apart, each shown as it lands.
  await Promise.all(
    [["diego", "The indexer rewrite saved our launch", 0], ["mei", "Sync is ten times faster now", 700], ["noor", "Found the bug nobody else could", 1400]].map(async ([who, note, delay]) => {
      await sleep(delay);
      await act(who, "applaud", { to: P("ravi"), claps: 2, note });
      await refresh(page);
      shot.mark(who);
    }),
  );
  await sleep(2200);
  await shot.stop();
  log(`${left()} s left in the round`);

  // The feed comes next in the video, so it is filmed now, while Ravi's applause is the
  // newest thing on it.
  await feedShot(page, "Found the bug nobody else could");
  log(`${left()} s left in the round`);
  if (left() < 30) throw new Error("not enough of the round left for the next shot; run it again");

  // Leo gives a friend five claps, alone.
  await page.goto(`${BASE}/#/`);
  await page.locator(".standing, .empty").first().waitFor();
  await scrollTo(page, 205, 400);
  await become(page, "leo");
  await page.locator("#ap-to").waitFor({ state: "visible" });
  shot = await cast(page, "cheat");
  await sleep(500);
  await click(page, page.locator("#ap-to"));
  await page.keyboard.type("sana", { delay: 70 });
  await click(page, page.locator(".steps button", { hasText: /^5$/ }));
  await click(page, page.locator("#ap-note"));
  await page.keyboard.type("For being my best friend", { delay: 32 });
  await sleep(250);
  await clearToasts(page);
  await click(page, page.locator("form button.primary"));
  shot.mark("send");
  await toast(page);
  shot.mark("landed");
  if (left() < 2) throw new Error("the round closed before Leo's applause landed; run it again");
  await sleep(600);
  await scrollTo(page, 420, 700);
  const row = page.locator(".standing", { hasText: "sana" });
  await row.waitFor();
  const box = await boxOf(row);
  await glide(page, box.x + box.width * 0.78, box.y + box.height / 2, 700);
  shot.mark("row");
  await sleep(3200);
  await shot.stop();
  log(`${left()} s left in the round`);
  return round;
}

// ---- the stage's own feed ----
// With `newest`, wait until the public index shows the post holding that text at the top.
async function feedShot(page, newest) {
  await page.goto(`${BASE}/#/`);
  await become(page, "");
  await page.goto(`${BASE}/#/feed`);
  await page.locator(".post").first().waitFor({ timeout: 90000 });
  for (let i = 0; newest && !(await page.locator(".post").first().innerText()).includes(newest); i++) {
    if (i >= 15) throw new Error("the public index has not shown the newest post yet; run it again");
    await sleep(2000);
    await refresh(page);
  }
  const shot = await cast(page, "feed");
  await sleep(1200);
  const first = await boxOf(page.locator(".post").first());
  await glide(page, first.x + 340, first.y + 46, 800);
  shot.mark("post");
  await sleep(3500);
  await scrollTo(page, 260, 1600);
  await sleep(2200);
  await shot.stop();
}

// ---- the formula: the same number of claps, very different scores ----
async function howShot(page) {
  await page.goto(`${BASE}/#/how`);
  await page.locator(".duel").waitFor();
  const shot = await cast(page, "how");
  await sleep(1500);
  const duel = await boxOf(page.locator(".split"));
  await glide(page, duel.x + duel.width * 0.9, duel.y + 16, 700);
  shot.mark("loud");
  await sleep(2600);
  // June's ten claps now come from five members instead of one.
  shot.mark("crowd");
  const set = (side, key, value) =>
    page.evaluate(
      ([side, key, value]) => {
        const input = document.querySelectorAll(".duel .side")[side].querySelectorAll('input[type="range"]')[key];
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      [side, key, value],
    );
  for (const [members, each] of [[2, 5], [3, 3], [4, 3], [5, 2]]) {
    await set(1, 0, members);
    await set(1, 1, each);
    await sleep(520);
  }
  shot.mark("even");
  await sleep(2200);
  await shot.stop();
}

// ---- the last seconds of a round, seen on the stage ----
async function closingShot(page, roundNo) {
  const round = await view(C, "get_round", { dao: DAO, round: roundNo });
  const until = round.ends_ms - Date.now();
  if (until < 9000) return log("too late to film the round closing");
  await page.goto(`${BASE}/#/`);
  await page.locator(".round-head").waitFor();
  await scrollTo(page, 205, 300);
  await sleep(Math.max(0, round.ends_ms - Date.now() - 6500));
  const shot = await cast(page, "closing");
  const head = await boxOf(page.locator(".round-head .left"));
  await glide(page, head.x + head.width / 2, head.y + head.height / 2 + 4, 800);
  await sleep(Math.max(0, round.ends_ms - Date.now()));
  shot.mark("closed");
  await refresh(page);
  await sleep(2200);
  await shot.stop();
}

// ---- the three payouts of one finished round ----
async function payoutsShot(page, roundNo) {
  const round = await view(C, "get_round", { dao: DAO, round: roundNo });
  const wait = round.review_ends_ms - Date.now() + 3000;
  if (wait > 0) {
    log(`waiting ${Math.ceil(wait / 1000)} s for round ${roundNo} to close`);
    await sleep(wait);
  }
  await page.goto(`${BASE}/#/payouts`);
  await become(page, "noor");
  const card = page.locator("section.card").filter({ has: page.locator("h2", { hasText: new RegExp(`^Round ${roundNo}$`) }) });
  await card.locator("tr", { hasText: "kofi" }).waitFor({ timeout: 90000 });
  const top = await card.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await scrollTo(page, Math.max(0, top - 150), 500);
  const row = (name) => card.locator("tr", { hasText: name });
  let shot;
  const press = async (name, label, event) => {
    await clearToasts(page);
    await click(page, row(name).locator("button", { hasText: label }).first());
    shot.mark(`${event}-click`);
    const text = await toast(page);
    shot.mark(event);
    log(`    ${text}`);
    await sleep(700);
  };
  shot = await cast(page, "payouts");
  await sleep(1500);
  await press("kofi", "Claim", "kofi-filed");
  await press("june", "Claim", "june-filed");
  await become(page, "asha");
  shot.mark("asha");
  await press("june", "Co-sign", "june-approved");
  await press("ravi", "Claim", "ravi-filed");
  await press("ravi", "Vote yes", "vote1");
  await become(page, "diego");
  shot.mark("diego");
  await press("ravi", "Vote yes", "vote2");
  await press("kofi", "Check the DAO", "kofi-paid");
  await press("june", "Check the DAO", "june-paid");
  await press("ravi", "Check the DAO", "ravi-approved");
  await sleep(16500);
  await press("ravi", "Check the DAO", "ravi-paid");
  await sleep(600);
  // Anything that was looked at too early gets a second look. The row redraws a moment
  // after each answer, so the button is looked for again right before every press.
  const waiting = async (name) => {
    await sleep(1500);
    return (await row(name).locator("button", { hasText: "Check the DAO" }).count()) > 0;
  };
  // A slow answer here costs nothing on screen, so it is logged instead of ending the take.
  for (const name of ["kofi", "june", "ravi"]) {
    for (let i = 0; i < 3 && (await waiting(name)); i++) {
      await sleep(6500);
      if (!(await waiting(name))) break;
      try {
        await press(name, "Check the DAO", `${name}-paid`);
      } catch (e) {
        log(`    ${name}: ${e.message.split("\n")[0]}`);
      }
    }
  }
  await shot.stop();
  // The round's total is its own shot, filmed once every payout reads Paid.
  await totalShot(page, roundNo);
  log(`round ${roundNo} paid: treasury ${fmt(await balanceOf(DAO), 4)} NEAR`);
}

// ---- after the payouts: the finished round, all of it paid ----
// The payouts shot ends with it. On its own it re-films that moment if a take stopped early.
async function totalShot(page, roundNo) {
  await page.goto(`${BASE}/#/payouts`);
  await become(page, "diego");
  const card = page.locator("section.card").filter({ has: page.locator("h2", { hasText: new RegExp(`^Round ${roundNo}$`) }) });
  for (const name of ["kofi", "june", "ravi"]) await card.locator("tr", { hasText: name }).filter({ hasText: "Paid" }).waitFor({ timeout: 90000 });
  const top = await card.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await scrollTo(page, Math.max(0, top - 150), 500);
  const shot = await cast(page, "total");
  await sleep(1200);
  const bar = await boxOf(card.locator(".round-title .right"));
  await glide(page, bar.x + bar.width / 2, bar.y + bar.height / 2, 700);
  shot.mark("total");
  await sleep(3000);
  await shot.stop();
}

// ---- a record: every line of it, then what the lines add up to ----
async function recordShot(page) {
  await page.goto(`${BASE}/#/`);
  await become(page, "");
  await page.goto(`${BASE}/#/people/${P("kofi")}`);
  await page.locator(".clap").first().waitFor({ timeout: 90000 });
  await scrollTo(page, 150, 300);
  const shot = await cast(page, "record");
  await sleep(900);
  const line = await boxOf(page.locator(".clap").nth(1));
  await glide(page, line.x + 300, line.y + 40, 800);
  shot.mark("lines");
  await sleep(1200);
  await scrollTo(page, 330, 1500);
  await sleep(1300);
  await scrollTo(page, 0, 900);
  const chip = await boxOf(page.locator(".hero .chip.gold").first());
  await glide(page, chip.x + chip.width / 2, chip.y + chip.height / 2 + 3, 700);
  shot.mark("trusted");
  await sleep(1500);
  const standing = await boxOf(page.locator("aside .card p.small").last());
  await glide(page, standing.x + 120, standing.y + 14, 800);
  shot.mark("limit");
  await sleep(2600);
  await shot.stop();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, ["scripts/serve.mjs", "--demo", "--port", String(PORT)], { cwd: ROOT, stdio: "ignore" });
  let browser;
  try {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${BASE}/deployment.json`).then((r) => r.ok).catch(() => false)) break;
      await sleep(250);
    }
    // The window is 1280x720 CSS pixels drawn at 1.5x, so frames come out at 1920x1080.
    browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=1.5", `--window-size=${W},${H}`, "--hide-scrollbars"] });
    const context = await browser.newContext({ viewport: null, colorScheme: "light" });
    await context.addInitScript(overlay);
    const page = await context.newPage();
    if (what === "all" || what === "cards") await cards(page);
    if (what === "all" || what === "live") {
      const round = await roundShots(page);
      await howShot(page);
      await closingShot(page, round.round);
      await payoutsShot(page, round.round);
      await recordShot(page);
    }
    if (what === "feed") await feedShot(page);
    if (what === "how") await howShot(page);
    if (what === "payouts") await payoutsShot(page, Number(process.argv[3]));
    if (what === "total") await totalShot(page, Number(process.argv[3]));
    if (what === "record") await recordShot(page);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }
}

main().catch((e) => {
  console.error(`Stopped: ${e.message}`);
  process.exit(1);
});

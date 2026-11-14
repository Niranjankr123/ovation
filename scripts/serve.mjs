// Serve the site.
//
//   node scripts/serve.mjs            read-only: everything on screen is read from NEAR
//   node scripts/serve.mjs --demo     also lets you act as the demo community's members
//
// The site itself is static files that read the chain from the browser. `--demo` adds one
// thing: a relay on this machine that signs for the demo accounts, whose keys are in
// ~/.near-credentials/testnet. It listens on 127.0.0.1 only and will only make the handful
// of calls listed in ACTIONS, on the contract and DAO named in deployments/testnet.json.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, deployment, call, vote, pass, view, reason, functionCallKind, hasKey, short } from "./lib.mjs";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.PORT) || 4173;
const WEB = path.join(ROOT, "web");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const d = deployment();
const people = demo
  ? [
      ...d.council.map((id) => ({ id, name: short(id), role: "council" })),
      ...d.members.map((id) => ({ id, name: short(id), role: "member" })),
      ...d.guests.map((id) => ({ id, name: short(id), role: "guest" })),
    ].filter((p) => hasKey(p.id))
  : [];
const isPerson = (id) => people.some((p) => p.id === id);
const C = d.contract;
const DAO = d.dao;

// Everything the relay is willing to sign. Nothing else, and for nobody else.
const ACTIONS = {
  applaud: (as, a) => call(as, C, "applaud", { dao: DAO, to: String(a.to), claps: Number(a.claps), note: a.note || null, quote: a.quote || null }, { gas: 30 }),
  void: (as, a) => call(as, C, "void_applause", { dao: DAO, round: Number(a.round), from: String(a.from), to: String(a.to), reason: String(a.reason || "") }, { gas: 30 }),
  claim: (as, a) => call(as, C, "claim", { dao: DAO, round: Number(a.round), account: String(a.account) }, { gas: 150 }),
  cosign: (as, a) => call(as, C, "cosign", { dao: DAO, round: Number(a.round), account: String(a.account) }, { gas: 100 }),
  settle: (as, a) => call(as, C, "settle", { dao: DAO, round: Number(a.round), account: String(a.account) }, { gas: 100 }),
  sync: (as) => call(as, C, "sync_members", { dao: DAO }, { gas: 100 }),
  pause: (as) => call(as, C, "pause_stage", { dao: DAO }, { gas: 30 }),
  // A council member's vote on the DAO itself, only on a payout the stage's own account filed.
  vote: async (as, a) => {
    const p = await view(DAO, "get_proposal", { id: Number(a.id) });
    if (!d.agent || p.proposer !== d.agent || !p.kind?.Transfer) throw new Error("the demo relay only votes on payouts filed by the stage's own account");
    if (!["VoteApprove", "VoteReject", "VoteRemove"].includes(a.action)) throw new Error("unknown vote");
    return vote(DAO, as, Number(a.id), a.action);
  },
  // Resuming takes a DAO proposal. In the demo two council members pass it in one go.
  resume: async (as) => {
    const other = d.council.find((c) => c !== as);
    const r = await pass(DAO, [as, other], "* Title: Resume the Ovation stage <br>* Summary: Lift the pause.", functionCallKind(C, "resume_stage", {}, { gas: 30 }));
    return { ok: true, value: `proposal #${r.id}`, logs: [], link: r.links.at(-1) };
  },
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20_000) throw new Error("request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

// One persona sends one transaction at a time, so their nonces never collide.
const queues = new Map();
function inTurn(who, job) {
  const next = (queues.get(who) || Promise.resolve()).then(job, job);
  queues.set(who, next.catch(() => {}));
  return next;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/deployment.json") {
      return send(res, 200, { ...d, demo, people });
    }
    if (url.pathname.startsWith("/demo/")) {
      if (!demo) return send(res, 404, { error: "start the server with --demo to act as the demo members" });
      // A page on another site must not be able to make this relay sign anything.
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "wrong origin" });
      if (req.method !== "POST" || url.pathname !== "/demo/act") return send(res, 404, { error: "not found" });
      const body = await readBody(req);
      const run = ACTIONS[body.action];
      if (!run) return send(res, 400, { error: `unknown action ${body.action}` });
      if (!isPerson(body.as)) return send(res, 400, { error: "not a demo account" });
      try {
        const out = await inTurn(body.as, () => run(body.as, body.args || {}));
        return send(res, 200, { ok: out.ok, value: out.value ?? null, error: out.ok ? null : reason(out.failure), link: out.link, logs: out.logs, tgas: out.tgas });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB)) return send(res, 403, "forbidden", "text/plain");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Ovation site: http://127.0.0.1:${port}`);
  console.log(`  contract ${C}\n  DAO      ${DAO}`);
  console.log(demo ? `  demo mode: you can act as ${people.map((p) => p.name).join(", ")}` : "  read-only (add --demo to act as the demo members)");
});

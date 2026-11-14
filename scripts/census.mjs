// Who asks for the money a Sputnik DAO pays out?
//
//   node scripts/census.mjs fetch     read every proposal of every DAO on sputnik-dao.near (public RPC, about an hour)
//   node scripts/census.mjs report    count, and write data/census.json
//
// For every approved Transfer proposal on mainnet it looks at one thing: who filed it.
//   - the account that was paid (they asked for themselves)
//   - a member who then voted on it (the council asked)
//   - anyone else (someone spoke up for another person's work)
// Ovation exists for the third case. This measures how often it happens today.
//
// Raw answers are cached in data/raw/ so a run can be stopped and resumed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const FACTORY = "sputnik-dao.near";
const RPCS = (process.env.CENSUS_RPC || "https://free.rpc.fastnear.com,https://near.drpc.org,https://1rpc.io/near,https://rpc.mainnet.fastnear.com").split(",");
// DAOs whose proposals are not people asking for money: a bridge's validators, and two
// newsrooms where every article submission is a proposal.
const SKIP = new Set(["bridge-validator.sputnik-dao.near"]);
const MAX_PROPOSALS = 30_000;

let at = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function view(account, method, args = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
  });
  let last;
  for (let i = 0; i < 40; i++) {
    const url = RPCS[at % RPCS.length];
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) {
        const name = j.error.cause?.name || "";
        if (/UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR/.test(name)) return { gone: name };
        throw new Error(j.error.message || name);
      }
      if (j.result.error) return { gone: String(j.result.error).slice(0, 200) };
      return { value: JSON.parse(Buffer.from(j.result.result).toString() || "null") };
    } catch (e) {
      // Free endpoints limit how fast they can be read. Move on, and wait longer each time.
      last = e;
      at++;
      await sleep(Math.min(30_000, 500 + 700 * i));
    }
  }
  throw last;
}

async function fetchAll() {
  fs.mkdirSync(RAW, { recursive: true });
  const listFile = path.join(RAW, "_daos.json");
  let daos;
  if (fs.existsSync(listFile)) daos = JSON.parse(fs.readFileSync(listFile, "utf8"));
  else {
    const n = (await view(FACTORY, "get_number_daos")).value;
    daos = [];
    for (let i = 0; i < n; i += 500) daos.push(...(await view(FACTORY, "get_daos", { from_index: i, limit: 500 })).value);
    fs.writeFileSync(listFile, JSON.stringify(daos));
  }
  console.log(`${daos.length} DAOs on ${FACTORY}`);
  let done = 0;
  let proposals = 0;
  const queue = daos.filter((d) => !SKIP.has(d));
  async function worker() {
    for (;;) {
      const dao = queue.shift();
      if (!dao) return;
      const file = path.join(RAW, `${dao}.json`);
      if (!fs.existsSync(file)) {
        const out = { dao, last: 0, transfers: [], total: 0 };
        const last = await view(dao, "get_last_proposal_id");
        if (last.gone) out.gone = last.gone;
        else if (last.value > MAX_PROPOSALS) out.skipped = `more than ${MAX_PROPOSALS} proposals`;
        else {
          out.last = last.value;
          let page = 50;
          let misses = 0;
          for (let i = 0; i < last.value; ) {
            const r = await view(dao, "get_proposals", { from_index: i, limit: page });
            if (r.gone) {
              // An answer too large for a view call: ask for fewer at a time.
              if (page > 1) {
                page = Math.max(1, Math.floor(page / 4));
                continue;
              }
              if (++misses > 20) {
                out.partial = r.gone;
                break;
              }
              i += 1;
              continue;
            }
            misses = 0;
            for (const p of r.value) {
              out.total++;
              const t = p.kind?.Transfer;
              if (!t) continue;
              out.transfers.push({
                id: p.id,
                proposer: p.proposer,
                receiver: t.receiver_id,
                token: t.token_id || "",
                amount: t.amount,
                status: p.status,
                voters: Object.keys(p.votes || {}),
                at: p.submission_time,
              });
            }
            i += page;
            page = Math.min(50, page * 2);
          }
        }
        fs.writeFileSync(file, JSON.stringify(out));
      }
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      proposals += saved.total || 0;
      done++;
      if (done % 50 === 0) console.log(`${done} of ${daos.length} DAOs, ${proposals} proposals read`);
    }
  }
  await Promise.all(Array.from({ length: Number(process.env.CENSUS_WORKERS || 3) }, worker));
  console.log(`done: ${done} DAOs, ${proposals} proposals`);
}

function report() {
  const files = fs.readdirSync(RAW).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  const NEWSROOMS = new Set(["nearweek-news-contribution.sputnik-dao.near", "news.sputnik-dao.near"]);
  const all = { daos: 0, proposals: 0, paid: 0, self: 0, council: 0, other: 0 };
  const perDao = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
    if (d.gone || d.skipped || NEWSROOMS.has(d.dao)) continue;
    all.daos++;
    all.proposals += d.total;
    const paid = d.transfers.filter((t) => t.status === "Approved");
    if (!paid.length) continue;
    const row = { dao: d.dao, paid: paid.length, self: 0, council: 0, other: 0, recipients: new Set(), top: 0 };
    const count = new Map();
    for (const t of paid) {
      row.recipients.add(t.receiver);
      count.set(t.receiver, (count.get(t.receiver) || 0) + 1);
      if (t.proposer === t.receiver) row.self++;
      else if (t.voters.includes(t.proposer)) row.council++;
      else row.other++;
    }
    row.top = Math.max(...count.values());
    row.recipients = row.recipients.size;
    all.paid += row.paid;
    all.self += row.self;
    all.council += row.council;
    all.other += row.other;
    perDao.push(row);
  }
  const active = perDao.filter((r) => r.paid >= 10);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const out = {
    measured_at: new Date().toISOString(),
    source: `every DAO created by ${FACTORY}, read over public RPC`,
    left_out: [...SKIP, ...NEWSROOMS],
    daos_read: all.daos,
    proposals_read: all.proposals,
    daos_that_paid_someone: perDao.length,
    payouts: all.paid,
    filed_by_the_account_paid: { count: all.self, percent: pct(all.self, all.paid) },
    filed_by_a_member_who_voted_on_it: { count: all.council, percent: pct(all.council, all.paid) },
    filed_by_someone_else: { count: all.other, percent: pct(all.other, all.paid) },
    daos_with_10_or_more_payouts: active.length,
    of_those: {
      where_nobody_ever_filed_for_someone_else: active.filter((r) => r.other === 0).length,
      where_under_a_tenth_were_filed_for_someone_else: active.filter((r) => r.other / r.paid < 0.1).length,
      median_accounts_ever_paid: median(active.map((r) => r.recipients)),
      median_share_of_payouts_to_the_most_paid_account_percent: Math.round(median(active.map((r) => (r.top / r.paid) * 100))),
    },
  };
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "census.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

const cmd = process.argv[2];
if (cmd === "fetch") await fetchAll();
else if (cmd === "report") report();
else console.log("usage: node scripts/census.mjs fetch | report");

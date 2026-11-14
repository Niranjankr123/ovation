// Measure what each call burns, from real transactions on testnet, and print a table.
//
//   node scripts/gas.mjs
//
// Reads the transactions recorded in deployments/testnet-e2e.json and asks the RPC for each
// one's full outcome, adding up the gas burnt by every receipt it caused, including the
// stage account's calls and the DAO's.

import fs from "node:fs";
import path from "node:path";
import { ROOT, RPC_URLS, sleep } from "./lib.mjs";

const e2e = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet-e2e.json"), "utf8"));
const want = [
  ["applaud", /twelve pieces of applause/],
  ["`claim` that files a NEAR payout and votes for it", /a small payout is filed and voted for/],
  ["`claim` that files a payout for the council", /a large payout becomes a normal DAO proposal/],
  ["`cosign`, including the vote", /one steward's co-signature is enough/],
  ["`settle` that records a payout as paid", /all three payouts settle as Paid/],
  ["a refused call, for example a second claim", /the same payout cannot be claimed twice/],
];

async function burnt(link, sender) {
  const hash = link.split("/").pop();
  for (let i = 0; i < 6; i++) {
    const url = RPC_URLS[i % RPC_URLS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      if (!j.result) throw new Error(JSON.stringify(j.error || j).slice(0, 120));
      let g = BigInt(j.result.transaction_outcome.outcome.gas_burnt);
      for (const r of j.result.receipts_outcome) g += BigInt(r.outcome.gas_burnt);
      return Number(g / 10n ** 10n) / 100;
    } catch {
      await sleep(800);
    }
  }
  return null;
}

const d = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));
const signers = [...d.council, ...d.members, ...d.guests];
const rows = [];
for (const [what, re] of want) {
  const c = e2e.checks.find((x) => re.test(x.name) && x.link);
  if (!c) continue;
  let tg = null;
  for (const s of signers) {
    tg = await burnt(c.link, s);
    if (tg !== null) break;
  }
  rows.push(`| ${what} | ${tg === null ? "?" : `${tg} Tgas`} | [transaction](${c.link}) |`);
}
console.log(["| Call | Gas burnt, all receipts | Example |", "|---|---|---|", ...rows].join("\n"));

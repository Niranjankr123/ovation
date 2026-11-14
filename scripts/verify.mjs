// Check the live deployment from the outside. Needs no account and no key: it only reads.
//
//   node scripts/verify.mjs
//
// It answers, from the chain itself:
//   1. What power does the stage hold in the demo DAO, and who controls the account that holds it?
//   2. Who voted on each payout the stage filed?
//   3. Do the contract's books add up?
//   4. Are the stage's near.social posts really written by the stage's own account?

import { deployment, view, provider, fmt, short, KV_API, EXPLORER } from "./lib.mjs";

const d = deployment();
const C = d.contract;
const DAO = d.dao;
let failed = 0;
let AGENT;
const who = (id) => (id === AGENT ? "the stage" : short(id));

function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `\n         ${detail}` : ""}`);
}

async function main() {
  console.log(`Ovation on NEAR testnet\n  contract ${EXPLORER}/address/${C}\n  DAO      ${EXPLORER}/address/${DAO}\n`);

  console.log("1. What the stage can do in the DAO");
  const stage = await view(C, "get_stage", { dao: DAO });
  AGENT = stage.agent;
  check("the stage's own account is named by the contract after the DAO", AGENT === (await view(C, "agent_for", { dao: DAO })), AGENT);
  const agentKeys = await provider.viewAccessKeyList({ accountId: AGENT });
  check("it has no access keys, so no person can sign for it: only the contract above it can make it act", agentKeys.keys.length === 0, `${agentKeys.keys.length} keys`);
  const policy = await view(DAO, "get_policy");
  check("the contract itself holds no role in the DAO", !policy.roles.some((r) => r.kind?.Group?.includes(C)));
  const roles = policy.roles.filter((r) => r.kind?.Group?.includes(AGENT));
  const role = roles[0];
  check("the stage's account sits in exactly one role of the DAO", roles.length === 1, role ? `role "${role.name}"` : "no role holds it");
  check("it is alone in that role", role?.kind.Group.length === 1, role?.kind.Group.join(", "));
  check(
    "the role holds three transfer permissions and nothing else",
    role && [...role.permissions].sort().join(", ") === "transfer:AddProposal, transfer:Finalize, transfer:VoteApprove",
    role?.permissions.join(", "),
  );
  check("the contract read the same thing from the DAO's policy", stage?.ready && !stage.wide && !stage.shared, `can file ${stage?.can_add}, can approve ${stage?.can_approve}, approves alone ${stage?.solo}, wider than needed ${stage?.wide}`);
  check("who may applaud is exactly who the DAO holds in the stage's roles", sameSet(stage.clappers, membersOf(policy, stage.config.clapper_roles, C)), `${stage.clappers.length} accounts in ${stage.config.clapper_roles.join(", ")}`);
  check("stewards are exactly who the DAO holds in the steward roles", sameSet(stage.stewards, membersOf(policy, stage.config.steward_roles, C)), `${stage.stewards.map(short).join(", ")}`);
  console.log(`         Removing role "${role?.name}" with one ChangePolicyRemoveRole proposal ends all of it.`);

  console.log("\n2. Who voted on each payout");
  const rounds = await view(C, "list_rounds", { dao: DAO, from_index: Math.max(0, stage.rounds - 25), limit: 25 });
  const tally = { Auto: 0, Cosign: 0, Council: 0 };
  const C_ = AGENT;
  let autoOk = true, cosignOk = true, councilOk = true, matchOk = true, paidSum = 0n, n = 0;
  const lines = [];
  for (const r of rounds) {
    const rows = await view(C, "list_standings", { dao: DAO, round: r.round, limit: 100 });
    for (const row of rows) {
      const c = row.claim;
      if (!c || c.proposal_id === null) continue;
      n++;
      const list = await view(DAO, "get_proposals", { from_index: c.proposal_id, limit: 1 });
      const p = list[0];
      if (!p) {
        if (c.state !== "Removed") matchOk = false;
        lines.push(`round ${r.round} ${short(row.account)}: proposal #${c.proposal_id} was removed by the council, recorded as ${c.state}`);
        continue;
      }
      const t = p.kind.Transfer;
      if (!t || p.proposer !== C_ || t.receiver_id !== row.account || t.amount !== c.amount) matchOk = false;
      const voters = Object.keys(p.votes);
      const mine = voters.includes(C_);
      const others = voters.filter((v) => v !== C_);
      if (c.state === "Paid") {
        tally[c.tier]++;
        paidSum += BigInt(c.amount);
        if (c.tier === "Auto" && !(mine && others.length === 0)) autoOk = false;
        if (c.tier === "Cosign" && !(mine && others.length === 0 && c.cosigner && stage.stewards.includes(c.cosigner) && c.cosigner !== row.account)) cosignOk = false;
      }
      if (c.tier === "Council" && mine) councilOk = false;
      if (c.tier !== "Auto" && c.tier !== "Council" && mine && !c.cosigner) cosignOk = false;
      lines.push(
        `round ${r.round} ${short(row.account)}: ${fmt(c.amount, 5)} NEAR, ${c.tier}, ${c.state}, proposal #${c.proposal_id} is ${p.status}, voted by ${voters.map(who).join(" + ") || "nobody yet"}${c.cosigner ? `, co-signed by ${short(c.cosigner)}` : ""}`,
      );
    }
  }
  for (const l of lines.slice(-14)) console.log(`         ${l}`);
  check(`every payout on the board is a Transfer proposal the stage filed, for the same account and amount (${n} checked)`, matchOk && n > 0);
  check(`small payouts passed on the stage's vote alone (${tally.Auto} paid)`, autoOk && tally.Auto > 0);
  check(`mid-size payouts passed on the stage's vote only after a steward who is not the recipient co-signed (${tally.Cosign} paid)`, cosignOk && tally.Cosign > 0);
  check(`the stage never voted on a payout above the co-sign limit (${tally.Council} paid by council votes)`, councilOk);

  console.log("\n3. The books");
  const allRounds = [];
  for (let i = 0; i < stage.rounds; i += 100) allRounds.push(...(await view(C, "list_rounds", { dao: DAO, from_index: i, limit: 100 })));
  const paidByRounds = allRounds.reduce((a, r) => a + BigInt(r.paid), 0n);
  check("payouts recorded per round add up to the stage's total", paidByRounds === BigInt(stage.paid), `${fmt(paidByRounds, 5)} NEAR over ${stage.payouts} payouts in ${stage.rounds} rounds`);
  check("no round paid or reserved more than its budget", allRounds.every((r) => BigInt(r.filed) <= BigInt(r.budget) && BigInt(r.paid) <= BigInt(r.filed)), `budget ${fmt(stage.config.round_budget, 4)} NEAR a round`);
  check("no amount on the board exceeds the share cap", (await overCap(rounds)) === 0, `cap ${stage.config.max_share_bps / 100}% of a round`);

  console.log("\n4. The stage's near.social posts");
  const res = await fetch(`${KV_API}/v0/latest/${d.social}/${AGENT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key_prefix: "post/" }) });
  const posts = ((await res.json()).entries || []).filter((e) => e.value?.text);
  check(`the public FastData index holds posts whose author is the stage's own account (${posts.length} on the first page)`, posts.length > 0 && posts.every((p) => p.predecessor_id === AGENT && p.current_account_id === d.social));
  const last = posts.sort((a, b) => Number(BigInt(b.block_timestamp) - BigInt(a.block_timestamp)))[0];
  if (last) console.log(`         latest: ${last.value.text.split("\n").join(" / ").slice(0, 150)}`);
  const keys = await provider.viewAccessKeyList({ accountId: C }).catch(() => null);
  const full = (keys?.keys || []).filter((k) => k.access_key.permission === "FullAccess").length;
  console.log(
    `\nNote: ${C} still has ${full} full-access key${full === 1 ? "" : "s"}, so its code can be replaced during the hackathon, and with it what the stage's account is told to do. A mainnet deployment should delete that key, after which only the code can make a stage vote or post.`,
  );

  console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

function membersOf(policy, roleNames, me) {
  const out = new Set();
  for (const r of policy.roles) if (roleNames.includes(r.name)) for (const a of r.kind?.Group || []) if (a !== me && a !== DAO) out.add(a);
  return [...out];
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

async function overCap(rounds) {
  let over = 0;
  for (const r of rounds) {
    const cap = (BigInt(r.budget) * BigInt(r.max_share_bps)) / 10_000n;
    const rows = await view(C, "list_standings", { dao: DAO, round: r.round, limit: 100 });
    for (const row of rows) if (BigInt(row.amount) > cap) over++;
  }
  return over;
}

main().catch((e) => {
  console.error(`Could not finish: ${e.message}`);
  process.exit(1);
});

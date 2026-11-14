// Live checks against the deployed contract and the demo DAO on NEAR testnet.
//
//   node scripts/e2e.mjs
//
// Needs the demo accounts' keys in ~/.near-credentials/testnet, so only the deployer can
// run it. Everyone else can read what it did: every check is written to
// deployments/testnet-e2e.json with the transaction that proves it.
//
// It plays four rounds, about twelve minutes in all:
//   round A  every refusal, the formula, voiding, and one payout through each tier
//   round B  a second paid round, pausing and resuming, and a payout the council rejects
//   round C  earned trust: the same amount needs a co-signature from a newcomer's side and
//            none for a trusted recipient; plus a removed payout and a bounced transfer
//   round D  the cap on how many different people one member can name in a round

import fs from "node:fs";
import path from "node:path";
import {
  ROOT, KV_API, near, fmt, sleep, view, call, balanceOf, topUp, vote, pass, functionCallKind, reason, deployment, short, provider,
} from "./lib.mjs";

const d = deployment();
const C = d.contract;
// The stage's own account: the one the DAO's role holds, that files, votes and posts.
const AGENT = d.agent;
const DAO = d.dao;
const P = (name) => `${name}.${d.namespace}`;
const results = [];
let failed = 0;

function check(name, ok, detail = "", link = null) {
  results.push({ name, ok: !!ok, detail: String(detail), link });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  [${detail}]` : ""}`);
}

/** A call that must be refused with a given error code. */
async function refused(name, code, signer, method, args, opts = { gas: 150 }) {
  const out = await call(signer, C, method, args, opts);
  const why = out.ok ? "it went through" : reason(out.failure);
  check(name, !out.ok && why.startsWith(code), why.slice(0, 90), out.link);
}

async function must(name, signer, contractId, method, args, opts = { gas: 150 }) {
  const out = await call(signer, contractId, method, args, opts);
  if (!out.ok) check(name, false, reason(out.failure).slice(0, 120), out.link);
  return out;
}

// ---- The formula again, in JavaScript, to compare with what the contract stores ----
const SCALE = 1_000_000n;
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
const root = (claps) => isqrt(BigInt(claps) * SCALE * SCALE);
function expected(gifts, budget, minBackers, maxShareBps) {
  const by = new Map();
  for (const [, to, claps] of gifts) {
    if (!claps) continue;
    const t = by.get(to) || { sum: 0n, backers: 0, claps: 0 };
    t.sum += root(claps); t.backers += 1; t.claps += claps;
    by.set(to, t);
  }
  let total = 0n;
  for (const t of by.values()) { t.score = t.sum * t.sum; t.part = t.backers >= minBackers ? t.score : 0n; total += t.part; }
  const cap = (budget * BigInt(maxShareBps)) / 10_000n;
  for (const t of by.values()) {
    const pro = total ? (budget * t.part) / total : 0n;
    t.amount = pro < cap ? pro : cap;
  }
  return { by, total };
}

async function applaud(from, to, claps, note, quote) {
  const args = { dao: DAO, to: P(to), claps };
  if (note !== undefined) args.note = note;
  if (quote) args.quote = quote;
  return call(P(from), C, "applaud", args, { gas: 30 });
}

/** Send a list of applause. Each member sends theirs in order; different members send at once. */
async function applaudAll(gifts) {
  const bySigner = new Map();
  for (const g of gifts) {
    if (!bySigner.has(g[0])) bySigner.set(g[0], []);
    bySigner.get(g[0]).push(g);
  }
  const outs = [];
  await Promise.all(
    [...bySigner.values()].map(async (list) => {
      for (const [from, to, claps, note, quote] of list) {
        const out = await applaud(from, to, claps, note, quote);
        outs.push(out);
        if (!out.ok) check(`applause ${from} to ${to}`, false, reason(out.failure), out.link);
      }
    }),
  );
  return outs;
}

async function nextRound() {
  let r = await view(C, "get_round", { dao: DAO });
  // Start each scenario at the top of a round, so all its applause lands in the same one.
  const left = r.ends_ms - Date.now();
  if (left < 105_000) {
    console.log(`   (waiting ${Math.ceil(left / 1000)} s for round ${r.round + 1} to open)`);
    await sleep(left + 2500);
    r = await view(C, "get_round", { dao: DAO });
  }
  return r;
}

async function waitFor(ms, what) {
  const left = ms - Date.now();
  if (left > 0) {
    console.log(`   (waiting ${Math.ceil(left / 1000)} s for ${what})`);
    await sleep(left + 2500);
  }
}

/** Every post the stage's account has written, read from the public FastData index. */
async function kvPosts() {
  const all = [];
  let page_token;
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${KV_API}/v0/latest/${d.social}/${AGENT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(page_token ? { key_prefix: "post/", page_token } : { key_prefix: "post/" }),
    });
    const j = await res.json();
    all.push(...(j.entries || []));
    page_token = j.page_token;
    if (!page_token) break;
  }
  return all;
}

const standing = (round, name) => view(C, "get_standing", { dao: DAO, round, account: P(name) });
const record = (name) => view(C, "get_record", { dao: DAO, account: P(name) });

/** Settle until the claim reaches a final state or we give up. Returns the last state. */
async function settleUntil(round, name, want, by = "sana") {
  let last = "";
  for (let i = 0; i < 4; i++) {
    const out = await call(P(by), C, "settle", { dao: DAO, round, account: P(name) }, { gas: 100 });
    last = out.ok ? out.value : reason(out.failure);
    if (last === want) return { state: last, link: out.link };
    await sleep(16_000);
  }
  return { state: last, link: null };
}

async function main() {
  console.log(`Ovation live checks\n  contract ${C}\n  stage    ${AGENT}\n  DAO      ${DAO}\n`);
  const stage0 = await view(C, "get_stage", { dao: DAO });
  check("the stage is open and the DAO's policy gives the contract exactly what it needs", stage0?.ready && !stage0.wide && !stage0.shared, `role ${stage0?.role}`);
  const policy = await view(DAO, "get_policy");
  const role = policy.roles.find((r) => r.kind?.Group?.includes(AGENT));
  const keys = await provider.viewAccessKeyList({ accountId: AGENT });
  const agentInfo = await provider.viewAccount({ accountId: AGENT });
  check("the stage's own account exists, has no keys, and runs the 1.4 KB stage contract", keys.keys.length === 0 && agentInfo.code_hash !== "11111111111111111111111111111111", `${AGENT}, code ${agentInfo.code_hash.slice(0, 10)}...`);
  check("only the Ovation contract can make the stage's account act", (await call(P("asha"), AGENT, "send", {}, { gas: 10 })).ok === false, "a call from a council member is refused");
  check(
    "the DAO role holding the stage's account has three transfer permissions and nothing else",
    role && [...role.permissions].sort().join() === "transfer:AddProposal,transfer:Finalize,transfer:VoteApprove" && role.kind.Group.length === 1,
    role?.permissions.join(" "),
  );
  if (stage0.paused) throw new Error("the stage is paused; resume it before running the checks");
  const budget = BigInt(stage0.config.round_budget);
  // The checks below are sent by "sana" on other people's behalf, and file four rounds of
  // applause, so both she and the stage's prepaid storage get what that takes.
  const HQ = C.split(".").slice(1).join(".");
  for (const who of [...d.members, ...d.guests]) await topUp(HQ, who, near(0.22));
  for (const who of d.council) await topUp(HQ, who, near(0.3));
  if (BigInt(stage0.storage_balance) < near(0.5)) {
    const f = await call(HQ, C, "fund_stage", { dao: DAO }, { gas: 30, deposit: near(0.4) });
    check("anyone can add NEAR to a stage's prepaid storage", f.ok, `+0.4 NEAR, now ${fmt(f.value, 4)}`, f.link);
  }

  // =====================================================================
  console.log("\nRound A: refusals, the formula, voiding, one payout through each tier");
  // =====================================================================
  const A = (await nextRound()).round;
  console.log(`   round ${A}`);

  await Promise.all([
    refused("someone outside the DAO's roles cannot applaud", "ERR_NOT_A_MEMBER", P("ravi"), "applaud", { dao: DAO, to: P("june"), claps: 1 }, { gas: 30 }),
    refused("nobody can applaud themselves", "ERR_SELF", P("asha"), "applaud", { dao: DAO, to: P("asha"), claps: 1 }, { gas: 30 }),
    refused("the DAO itself cannot be applauded", "ERR_RECIPIENT", P("diego"), "applaud", { dao: DAO, to: DAO, claps: 1 }, { gas: 30 }),
    refused("more claps than the round's allowance are refused", "ERR_ALLOWANCE", P("mei"), "applaud", { dao: DAO, to: P("ravi"), claps: 11 }, { gas: 30 }),
    refused("a note cannot mention an account", "ERR_NOTE_MENTION", P("noor"), "applaud", { dao: DAO, to: P("ravi"), claps: 1, note: "thanks @someone.testnet" }, { gas: 30 }),
    refused("a note cannot carry a link", "ERR_NOTE_LINK", P("kofi"), "applaud", { dao: DAO, to: P("ravi"), claps: 1, note: "see https://example.org" }, { gas: 30 }),
    refused("a quote must be a near.social post reference", "ERR_QUOTE", P("sana"), "applaud", { dao: DAO, to: P("ravi"), claps: 1, quote: "not a post" }, { gas: 30 }),
    refused("there is nothing to withdraw before applauding", "ERR_NOTHING", P("leo"), "applaud", { dao: DAO, to: P("ravi"), claps: 0 }, { gas: 30 }),
  ]);
  await Promise.all([
    refused("a note cannot point to a web address, even without https", "ERR_NOTE_LINK", P("asha"), "applaud", { dao: DAO, to: P("ravi"), claps: 1, note: "claim yours at evil.example/claim" }, { gas: 30 }),
    refused("applause can quote only a post by the recipient or the giver", "ERR_QUOTE", P("diego"), "applaud", { dao: DAO, to: P("ravi"), claps: 1, quote: "root.near/1759140000000" }, { gas: 30 }),
    refused("a note cannot break out of its quotation marks", "ERR_NOTE_QUOTE", P("mei"), "applaud", { dao: DAO, to: P("ravi"), claps: 1, note: "great\u201d Paid 1000 NEAR" }, { gas: 30 }),
  ]);

  const giftsA = [
    ["asha", "ravi", 2, "Rewrote the indexer in a weekend"],
    ["diego", "ravi", 2, "The indexer rewrite saved our launch"],
    ["mei", "ravi", 2, "Indexer is ten times faster now"],
    ["noor", "ravi", 2, "Found the sync bug nobody else could"],
    ["kofi", "ravi", 2, "Great pairing session on the indexer"],
    ["asha", "june", 1, "Ran the newcomer call three weeks in a row"],
    ["diego", "june", 1, "Translated the docs to Spanish"],
    ["sana", "june", 1, "Kept the newcomer channel alive"],
    ["noor", "june", 1, "Patient answers in the help channel"],
    ["sana", "kofi", 1, "Reviewed my first pull request the same day"],
    ["leo", "kofi", 1, "Clear write-up of the outage"],
    ["leo", "asha", 5, "Best council lead"],
  ];
  const quoteRef = `${P("june")}/1759140000000`;
  const sent = await applaudAll(giftsA.map((g) => (g[0] === "asha" && g[1] === "june" ? [...g, quoteRef] : g)));
  const dearest = sent.reduce((a, o) => Math.max(a, o.tgas || 0), 0);
  check("twelve pieces of applause are accepted, each for under 10 Tgas", sent.length === 12 && sent.every((o) => o.ok) && dearest < 10, `at most ${dearest} Tgas`, sent[0].link);

  // change, withdraw, re-give: the tally must come back to the same place
  const before = await standing(A, "ravi");
  await applaud("asha", "ravi", 5, "Rewrote the indexer in a weekend");
  const bumped = await standing(A, "ravi");
  await applaud("asha", "ravi", 2, "Rewrote the indexer in a weekend");
  const back = await standing(A, "ravi");
  check("changing applause moves the score, and changing it back restores it exactly", BigInt(bumped.score) > BigInt(before.score) && back.score === before.score && back.claps === before.claps, `${before.score} -> ${bumped.score} -> ${back.score}`);
  await applaud("leo", "kofi", 0);
  const gone = await standing(A, "kofi");
  await applaud("leo", "kofi", 1, "Clear write-up of the outage");
  const again = await standing(A, "kofi");
  check("withdrawn applause leaves the tally, and giving it again brings it back", gone.backers === 1 && again.backers === 2 && again.claps === 2, `${gone.backers} backer, then ${again.backers}`);

  // the formula, recomputed here, against what the contract holds
  const exp = expected(giftsA, budget, stage0.config.min_backers, stage0.config.max_share_bps);
  const rows = await view(C, "list_standings", { dao: DAO, round: A });
  let formulaOk = rows.length === exp.by.size;
  for (const row of rows) {
    const e = exp.by.get(short(row.account));
    if (!e || e.score.toString() !== row.score || e.amount.toString() !== row.amount || e.backers !== row.backers) formulaOk = false;
  }
  const roundA = await view(C, "get_round", { dao: DAO, round: A });
  check("every score and amount equals (sum of square roots) squared, pro rata, capped", formulaOk && roundA.eligible === exp.total.toString(), rows.map((r) => `${short(r.account)} ${fmt(r.amount, 5)}`).join(", "));
  const sum = rows.reduce((a, r) => a + BigInt(r.amount), 0n);
  check("a round's amounts never add up to more than its budget", sum <= budget, `${fmt(sum, 5)} of ${fmt(budget, 5)}`);
  const ravi = rows.find((r) => short(r.account) === "ravi");
  const leoPick = rows.find((r) => short(r.account) === "asha");
  check("breadth beats volume: ten claps from five members score ten times five claps from one", BigInt(ravi.score) > 9n * BigInt(leoPick.score), `${ravi.score} vs ${leoPick.score}`);
  check("one recipient cannot take more than the share cap", BigInt(ravi.amount) === (budget * BigInt(stage0.config.max_share_bps)) / 10_000n, fmt(ravi.amount, 5));
  check("one backer is not enough: applause from a single member earns nothing", leoPick.eligible === false && leoPick.amount === "0", `${leoPick.backers} backer`);

  // voiding
  await refused("a member who is not a steward cannot void applause", "ERR_NOT_A_STEWARD", P("noor"), "void_applause", { dao: DAO, round: A, from: P("leo"), to: P("asha"), reason: "test" }, { gas: 30 });
  await refused("voiding needs a reason", "ERR_REASON", P("mei"), "void_applause", { dao: DAO, round: A, from: P("leo"), to: P("asha"), reason: "  " }, { gas: 30 });
  const voided = await must("void", P("mei"), C, "void_applause", { dao: DAO, round: A, from: P("leo"), to: P("asha"), reason: "Thanks for the council lead belongs in the next retro, not here" }, { gas: 30 });
  const log = await view(C, "list_applause", { dao: DAO, round: A });
  const struck = log.find((a) => short(a.from) === "leo" && short(a.to) === "asha");
  check("a steward can strike out applause, and the reason and their name are public", struck?.voided && struck.claps === 0 && struck.voided_claps === 5 && short(struck.voided_by) === "mei", struck?.void_reason, voided.link);
  await refused("struck-out applause cannot be changed", "ERR_VOIDED", P("leo"), "applaud", { dao: DAO, to: P("asha"), claps: 1 }, { gas: 30 });
  const leoMember = await view(C, "get_member", { dao: DAO, account: P("leo") });
  check("the claps of struck-out applause are not handed back", leoMember.claps_used === 6 && leoMember.claps_left === 4, `${leoMember.claps_used} used`);

  // posts written by the contract
  await sleep(6000);
  const posts = await kvPosts();
  const mine = log.filter((a) => a.post_id).map((a) => a.post_id);
  const found = mine.filter((id) => posts.some((p) => p.key === `post/${id}` && p.value && p.predecessor_id === AGENT));
  check("each applause is a near.social post whose author is the stage's own account", mine.length === 11 && found.length === 11, `${found.length} of ${mine.length} posts indexed at ${KV_API}`);
  const ashaToRavi = log.find((a) => short(a.from) === "asha" && short(a.to) === "ravi");
  const sample = posts.find((p) => p.key === `post/${ashaToRavi.post_id}`);
  check("a post mentions the recipient and the giver, and carries the note", sample?.value?.text.includes(`@${P("ravi")}`) && sample.value.text.includes(`@${P("asha")}`) && sample.value.text.includes("Rewrote the indexer"), sample?.value?.text.split("\n")[0]);
  const quoted = posts.find((p) => p.value?.quote);
  check("applause for a near.social post by the recipient quotes that post", quoted?.value?.quote === quoteRef, quoted?.value?.quote);
  check("voiding takes the post down", !struck.post_id && posts.filter((p) => p.value === null).length >= 1, "tombstone written");

  // claims
  await refused("a payout cannot be claimed while its round is open", "ERR_ROUND_OPEN", P("sana"), "claim", { dao: DAO, round: A, account: P("kofi") });
  await waitFor(roundA.ends_ms, "the round to end");
  if (Date.now() < roundA.review_ends_ms - 3000) {
    await refused("a payout cannot be claimed during the review window", "ERR_IN_REVIEW", P("sana"), "claim", { dao: DAO, round: A, account: P("kofi") });
  }
  await waitFor(roundA.review_ends_ms, "the review window to end");
  await refused("voiding is over once the review window has ended", "ERR_TOO_LATE", P("mei"), "void_applause", { dao: DAO, round: A, from: P("sana"), to: P("kofi"), reason: "too late" }, { gas: 30 });
  await refused("an account with too few backers cannot claim", "ERR_TOO_FEW_BACKERS", P("sana"), "claim", { dao: DAO, round: A, account: P("asha") });
  await refused("a claim without enough gas for the whole chain is refused up front", "ERR_GAS", P("sana"), "claim", { dao: DAO, round: A, account: P("kofi") }, { gas: 40 });

  const bal = { kofi: await balanceOf(P("kofi")), june: await balanceOf(P("june")), ravi: await balanceOf(P("ravi")) };
  const treasury0 = await balanceOf(DAO);

  // Auto: filed and approved in one call, by anyone, for the account that earned it
  const cKofi = await must("claim kofi", P("sana"), C, "claim", { dao: DAO, round: A, account: P("kofi") });
  const sKofi = await standing(A, "kofi");
  const propKofi = await view(DAO, "get_proposal", { id: sKofi.claim.proposal_id });
  check("a small payout is filed and voted for in one call, for about 30 Tgas", cKofi.value === "Voted" && sKofi.claim.tier === "Auto" && cKofi.tgas < 45, `${cKofi.tgas} Tgas, proposal #${sKofi.claim.proposal_id}`, cKofi.link);
  check("on the DAO it is an ordinary Transfer proposal, filed by the stage's account, whose vote is the only one", propKofi.proposer === AGENT && propKofi.kind.Transfer.receiver_id === P("kofi") && Object.keys(propKofi.votes).join() === AGENT, JSON.stringify(propKofi.votes));
  check("its description is in the form Trezu reads as a payment request", /^\* Title: Ovation round \d+ for .+ <br>\* Summary: .+ <br>\* Notes: /.test(propKofi.description), propKofi.description.slice(0, 70));
  await refused("the same payout cannot be claimed twice", "ERR_CLAIMED", P("sana"), "claim", { dao: DAO, round: A, account: P("kofi") });

  // Cosign
  const cJune = await must("claim june", P("sana"), C, "claim", { dao: DAO, round: A, account: P("june") });
  const sJune = await standing(A, "june");
  const propJune0 = await view(DAO, "get_proposal", { id: sJune.claim.proposal_id });
  check("a mid-size payout is filed and left unvoted", cJune.value === "Filed" && sJune.claim.tier === "Cosign" && Object.keys(propJune0.votes).length === 0, `${fmt(sJune.amount, 5)} NEAR`, cJune.link);
  await refused("a member who is not a steward cannot co-sign", "ERR_NOT_A_STEWARD", P("noor"), "cosign", { dao: DAO, round: A, account: P("june") });
  await refused("a steward who applauded the recipient this round cannot co-sign the payout", "ERR_CONFLICT", P("asha"), "cosign", { dao: DAO, round: A, account: P("june") });
  const co = await must("cosign june", P("mei"), C, "cosign", { dao: DAO, round: A, account: P("june") });
  const propJune = await view(DAO, "get_proposal", { id: sJune.claim.proposal_id });
  check("one steward's co-signature is enough: the stage's account then casts the only vote", co.value === "Voted" && Object.keys(propJune.votes).join() === AGENT && short((await standing(A, "june")).claim.cosigner) === "mei", `${co.tgas} Tgas`, co.link);

  // Council
  const cRavi = await must("claim ravi", P("sana"), C, "claim", { dao: DAO, round: A, account: P("ravi") });
  const sRavi = await standing(A, "ravi");
  check("a large payout becomes a normal DAO proposal", cRavi.value === "Filed" && sRavi.claim.tier === "Council", `${fmt(sRavi.amount, 5)} NEAR, proposal #${sRavi.claim.proposal_id}`, cRavi.link);
  await refused("a large payout cannot be co-signed through", "ERR_WRONG_TIER", P("asha"), "cosign", { dao: DAO, round: A, account: P("ravi") });
  await refused("calling claim again does not make the contract vote on a council payout", "ERR_CLAIMED", P("sana"), "claim", { dao: DAO, round: A, account: P("ravi") });
  for (const who of ["asha", "diego"]) {
    const v = await vote(DAO, P(who), sRavi.claim.proposal_id);
    if (!v.ok) check(`council vote ${who}`, false, reason(v.failure), v.link);
  }
  const propRavi = await view(DAO, "get_proposal", { id: sRavi.claim.proposal_id });
  check("the council passes it by its own votes, and the contract never votes on it", propRavi.status === "Approved" && !(AGENT in propRavi.votes) && Object.keys(propRavi.votes).length === 2, Object.keys(propRavi.votes).map(short).join(" + "));

  // settle
  const early = await call(P("sana"), C, "settle", { dao: DAO, round: A, account: P("ravi") }, { gas: 100 });
  check("first sight of an approved proposal does not yet count as paid", early.value === "Approved", String(early.value), early.link);
  await sleep(16_000);
  const paid = {};
  for (const who of ["kofi", "june", "ravi"]) paid[who] = await settleUntil(A, who, "Paid");
  check("all three payouts settle as Paid once the DAO has shown them approved twice", Object.values(paid).every((p) => p.state === "Paid"), Object.entries(paid).map(([k, v]) => `${k} ${v.state}`).join(", "), paid.ravi.link);
  const got = { kofi: (await balanceOf(P("kofi"))) - bal.kofi, june: (await balanceOf(P("june"))) - bal.june, ravi: (await balanceOf(P("ravi"))) - bal.ravi };
  check(
    "each recipient's balance rose by exactly the amount on the board",
    got.kofi === BigInt(sKofi.amount) && got.june === BigInt(sJune.amount) && got.ravi === BigInt(sRavi.amount),
    `kofi +${fmt(got.kofi, 5)}, june +${fmt(got.june, 5)}, ravi +${fmt(got.ravi, 5)}`,
  );
  const treasury1 = await balanceOf(DAO);
  const paidOut = BigInt(sKofi.amount) + BigInt(sJune.amount) + BigInt(sRavi.amount);
  // The DAO's balance also earns a sliver of gas fees as a contract, hence "within 0.002".
  const drift = treasury0 - treasury1 - paidOut;
  check("the money came out of the DAO's own account", drift < near(0.002) && drift > -near(0.002), `${fmt(treasury0, 5)} -> ${fmt(treasury1, 5)}, paid ${fmt(paidOut, 5)}`);
  const roundA2 = await view(C, "get_round", { dao: DAO, round: A });
  check("the round's books match: filed equals paid equals what left the treasury", roundA2.paid === paidOut.toString() && roundA2.filed === roundA2.paid, fmt(roundA2.paid, 5));
  await refused("a settled payout has nothing left to settle", "ERR_SETTLED", P("sana"), "settle", { dao: DAO, round: A, account: P("kofi") });
  await sleep(6000);
  const posts2 = await kvPosts();
  const paidPosts = posts2.filter((p) => p.value?.text?.includes("was paid") && p.value.text.includes(`round ${A} `));
  check("each payout is announced in a post by the contract", paidPosts.length === 3, paidPosts[0]?.value.text.split("\n")[0].slice(0, 110));
  const recKofi = await record("kofi");
  const lines = await view(C, "list_record_lines", { dao: DAO, account: P("kofi") });
  check("a record is the sum of its lines: every clap traces to a member, a round and a note", lines.reduce((a, l) => a + l.claps, 0) === recKofi.claps_received && lines.length === recKofi.lines && recKofi.rounds_paid >= 1, `${recKofi.claps_received} claps over ${recKofi.lines} lines`);

  // =====================================================================
  console.log("\nRound B: a second paid round, pause and resume, a payout the council rejects");
  // =====================================================================
  const B = (await nextRound()).round;
  console.log(`   round ${B}`);
  const giftsB = [
    ["asha", "kofi", 1, "Second on-call week without a miss"],
    ["noor", "kofi", 1, "Kept the release notes honest"],
    ["mei", "kofi", 1, "Mentored two newcomers"],
    ["asha", "ravi", 3, "Shipped the migration tool"],
    ["diego", "ravi", 3, "Migration tool saved a week"],
    ["mei", "ravi", 3, "Careful rollout of the migration"],
    ["noor", "ravi", 3, "Docs for the migration tool"],
  ];
  await applaudAll(giftsB);
  // pause
  await refused("a member who is not a steward cannot pause the stage", "ERR_NOT_A_STEWARD", P("noor"), "pause_stage", { dao: DAO }, { gas: 30 });
  const paused = await must("pause", P("diego"), C, "pause_stage", { dao: DAO }, { gas: 30 });
  await refused("a paused stage takes no applause", "ERR_PAUSED", P("sana"), "applaud", { dao: DAO, to: P("june"), claps: 1 }, { gas: 30 });
  await refused("a paused stage files no payouts", "ERR_PAUSED", P("sana"), "claim", { dao: DAO, round: A, account: P("kofi") });
  await refused("a steward cannot lift the pause: only the DAO can", "ERR_NO_STAGE", P("diego"), "resume_stage", {}, { gas: 30 });
  check("any one steward can pause the stage", (await view(C, "get_stage", { dao: DAO })).paused === true, `by ${short(P("diego"))}`, paused.link);
  const resumed = await pass(DAO, [P("asha"), P("diego")], "* Title: Resume the Ovation stage <br>* Summary: The pause was a drill.", functionCallKind(C, "resume_stage", {}, { gas: 30 }));
  check("the DAO resumes it with an ordinary proposal", (await view(C, "get_stage", { dao: DAO })).paused === false, `proposal #${resumed.id}`, resumed.links.at(-1));

  const roundB = await view(C, "get_round", { dao: DAO, round: B });
  await waitFor(roundB.review_ends_ms, "round B to end and its review to pass");
  const cKofiB = await must("claim kofi B", P("sana"), C, "claim", { dao: DAO, round: B, account: P("kofi") });
  check("kofi's second small payout is voted through without anyone signing", cKofiB.value === "Voted", `${cKofiB.tgas} Tgas`, cKofiB.link);
  const cRaviB = await must("claim ravi B", P("sana"), C, "claim", { dao: DAO, round: B, account: P("ravi") });
  const sRaviB = await standing(B, "ravi");
  const agentBefore = await balanceOf(AGENT);
  for (const who of ["asha", "diego"]) await vote(DAO, P(who), sRaviB.claim.proposal_id, "VoteReject");
  const raviBefore = await balanceOf(P("ravi"));
  const rej = await settleUntil(B, "ravi", "Rejected");
  const agentAfter = await balanceOf(AGENT);
  check("a payout the council votes down settles as Rejected, and nothing is paid", cRaviB.value === "Filed" && rej.state === "Rejected" && (await balanceOf(P("ravi"))) === raviBefore, `proposal #${sRaviB.claim.proposal_id}`, rej.link);
  // The stage's account also earns a sliver of gas rewards, hence "at most 0.001 more".
  const bondBack = agentAfter - agentBefore;
  check("the DAO hands the proposal bond back to the stage's own account", bondBack >= BigInt(stage0.bond) && bondBack < BigInt(stage0.bond) + near(0.001), `+${fmt(bondBack, 5)} NEAR`);
  await sleep(16_000);
  const paidB = await settleUntil(B, "kofi", "Paid");
  const recKofi2 = await record("kofi");
  check("after two paid rounds and three different backers, kofi is trusted", paidB.state === "Paid" && recKofi2.trusted && recKofi2.rounds_paid >= 2 && recKofi2.backers >= 3, `${recKofi2.rounds_paid} paid rounds, ${recKofi2.backers} backers`, paidB.link);

  // =====================================================================
  console.log("\nRound C: earned trust, a removed payout, a bounced transfer");
  // =====================================================================
  const Cr = (await nextRound()).round;
  console.log(`   round ${Cr}`);
  const ghost = `ghost-${Date.now().toString(36)}`; // a well-formed name nobody has created
  const giftsC = [
    // kofi (trusted by now) and diego (never paid before) get identical applause, so identical amounts
    ["asha", "kofi", 2, "Third round running: steady hands"],
    ["diego", "kofi", 2, "Unblocked the release"],
    ["mei", "kofi", 2, "Wrote the postmortem"],
    ["asha", "diego", 2, "Negotiated the hosting deal"],
    ["mei", "diego", 2, "Ran the audit kickoff"],
    ["noor", "diego", 2, "Unstuck the grant paperwork"],
    ["noor", "june", 1, "Onboarding guide rewrite"],
    ["sana", "june", 1, "Hosted the community call"],
    ["leo", "june", 1, "Made the community call welcoming"],
    ["noor", ghost, 1, "Applause for an account that does not exist"],
    ["sana", ghost, 1, "Applause for an account that does not exist"],
  ];
  await applaudAll(giftsC);
  const rowsC = await view(C, "list_standings", { dao: DAO, round: Cr });
  const k = rowsC.find((r) => short(r.account) === "kofi");
  const l = rowsC.find((r) => short(r.account) === "diego");
  check("earned trust: the same amount is Auto for a trusted recipient and Cosign for a newcomer", k.amount === l.amount && k.trusted && !l.trusted && k.tier === "Auto" && l.tier === "Cosign", `${fmt(k.amount, 5)} NEAR each: kofi ${k.tier}, diego ${l.tier}`);

  const roundC = await view(C, "get_round", { dao: DAO, round: Cr });
  await waitFor(roundC.review_ends_ms, "round C to end and its review to pass");

  const cK = await must("claim kofi C", P("sana"), C, "claim", { dao: DAO, round: Cr, account: P("kofi") });
  const cL = await must("claim diego C", P("sana"), C, "claim", { dao: DAO, round: Cr, account: P("diego") });
  check("the trusted recipient's payout goes straight through, the newcomer's waits for a steward", cK.value === "Voted" && cL.value === "Filed", `kofi ${cK.value}, diego ${cL.value}`, cK.link);
  await refused("a steward cannot co-sign their own payout", "ERR_OWN_PAYOUT", P("diego"), "cosign", { dao: DAO, round: Cr, account: P("diego") });

  // removed: the council deletes diego's proposal as spam
  const sLeo = await standing(Cr, "diego");
  for (const who of ["asha", "mei"]) await vote(DAO, P(who), sLeo.claim.proposal_id, "VoteRemove");
  const leftover = await view(DAO, "get_proposals", { from_index: sLeo.claim.proposal_id, limit: 1 });
  const rem = await settleUntil(Cr, "diego", "Removed");
  check("a payout the council removes settles as Removed, proved by the DAO's own empty answer", leftover.length === 0 && rem.state === "Removed", `proposal #${sLeo.claim.proposal_id} is gone`, rem.link);

  // bounced: the DAO approves a transfer to an account that does not exist
  const cG = await must("claim ghost", P("sana"), C, "claim", { dao: DAO, round: Cr, account: P(ghost) });
  await sleep(4000);
  const sG = await standing(Cr, ghost);
  const propG = await view(DAO, "get_proposal", { id: sG.claim.proposal_id });
  const bounced = await settleUntil(Cr, ghost, "Failed");
  await sleep(16_000);
  const still = await call(P("sana"), C, "settle", { dao: DAO, round: Cr, account: P(ghost) }, { gas: 100 });
  check("a transfer that bounces is never recorded as paid", cG.value === "Voted" && propG.status === "Failed" && bounced.state === "Failed" && still.value === "Failed", `DAO proposal #${sG.claim.proposal_id} is ${propG.status}`, bounced.link);

  await sleep(14_000);
  const paidC = await settleUntil(Cr, "kofi", "Paid");
  check("the trusted recipient's payout settles as Paid", paidC.state === "Paid", "", paidC.link);

  const roundC2 = await view(C, "get_round", { dao: DAO, round: Cr });
  check("refused payouts leave the round's books: only live claims count as filed", BigInt(roundC2.paid) === BigInt(k.amount) && BigInt(roundC2.filed) === BigInt(k.amount) + BigInt(sG.amount), `paid ${fmt(roundC2.paid, 5)}, filed ${fmt(roundC2.filed, 5)}`);

  // =====================================================================
  console.log("\nRound D: nobody can run a stage out of storage by naming endless recipients");
  // =====================================================================
  const D = (await nextRound()).round;
  console.log(`   round ${D}`);
  const allowance = stage0.config.claps_per_round;
  const tag = Date.now().toString(36);
  let named = 0;
  for (let i = 0; i < allowance; i++) {
    const give = await call(P("leo"), C, "applaud", { dao: DAO, to: `x${i}-${tag}.${d.namespace}`, claps: 1 }, { gas: 30 });
    if (give.ok) named++;
    await call(P("leo"), C, "applaud", { dao: DAO, to: `x${i}-${tag}.${d.namespace}`, claps: 0 }, { gas: 30 });
  }
  const leoD = await view(C, "get_member", { dao: DAO, account: P("leo") });
  const roundD = await view(C, "get_round", { dao: DAO, round: D });
  check(`a member can name ${allowance} different people in a round and take every clap back`, named === allowance && leoD.claps_used === 0 && roundD.round === D, `${named} named, ${leoD.claps_used} claps in use`);
  await refused("an eleventh person in the same round is refused, even with every clap free again", "ERR_TOO_MANY_PEOPLE", P("leo"), "applaud", { dao: DAO, to: `x99-${tag}.${d.namespace}`, claps: 1 }, { gas: 30 });
  const reuse = await call(P("leo"), C, "applaud", { dao: DAO, to: `x0-${tag}.${d.namespace}`, claps: 2 }, { gas: 30 });
  check("applauding someone already named this round is still allowed", reuse.ok, reuse.ok ? "2 claps" : reason(reuse.failure), reuse.link);
  await call(P("leo"), C, "applaud", { dao: DAO, to: `x0-${tag}.${d.namespace}`, claps: 0 }, { gas: 30 });

  // update and the things that cannot be updated
  await refused("only the DAO can change its stage", "ERR_NO_STAGE", P("asha"), "update_stage", { config: stage0.config }, { gas: 100 });
  const stageEnd = await view(C, "get_stage", { dao: DAO });
  const roundsList = await view(C, "list_rounds", { dao: DAO });
  check("the stage lists every round that had applause", roundsList.length === stageEnd.rounds && [A, B, Cr, D].every((n) => roundsList.some((r) => r.round === n)), `${stageEnd.rounds} rounds`);
  check("members never attach a deposit to applaud: storage is charged to the stage's prepaid balance", stageEnd.entries > stage0.entries, `${stageEnd.entries - stage0.entries} entries stored, ${fmt(stageEnd.storage_balance, 4)} NEAR left prepaid`);

  const out = {
    ran_at: new Date().toISOString(),
    contract: C,
    dao: DAO,
    rounds: { A, B, C: Cr, D },
    passed: results.length - failed,
    failed,
    checks: results,
  };
  fs.writeFileSync(path.join(ROOT, "deployments", "testnet-e2e.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${results.length - failed} of ${results.length} checks passed. Written to deployments/testnet-e2e.json`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`\nStopped: ${e.message}`);
  try {
    fs.writeFileSync(path.join(ROOT, "deployments", "testnet-e2e.partial.json"), JSON.stringify({ error: e.message, checks: results }, null, 2));
  } catch {}
  process.exit(1);
});

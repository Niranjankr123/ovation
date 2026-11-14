// Install Ovation on a DAO of your own and watch applause turn into a payout.
//
//   node scripts/try.mjs <your-account>.testnet
//
// Needs a testnet account with about 7 NEAR whose key is in ~/.near-credentials/testnet.
// The faucet gives a new account 10. Create one with near-cli:
//
//   near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
//
// What you will see, in about three minutes, each step with its transaction:
//   1. Three named accounts are created under yours: two members and one outsider.
//   2. A real Sputnik DAO is created with you as its council.
//   3. You pass the two proposals that install Ovation: a role for your stage's own account,
//      then the stage, which creates that account.
//   4. The two members and you applaud the outsider.
//   5. Your stage's account posts each applause on near.social.
//   6. The round closes. One call files the payout and your stage's account votes for it.
//   7. Your DAO pays the outsider, and their balance rises by exactly that amount.
//
// It uses the public Ovation contract named in deployments/testnet.json. Nothing here is
// special to the demo: this is what any DAO would do. About 5.5 NEAR of the cost is the
// Sputnik factory's storage deposit for a new DAO.

import { actions } from "near-api-js";
import {
  FACTORY, KV_API, EXPLORER, near, fmt, b64, sleep, view, call, mustCall, send, accountInfo, balanceOf, ensureAccount, hasKey,
  COUNCIL_PERMISSIONS, ovationRole, functionCallKind, pass, reason, deployment, short, step, note, provider,
} from "./lib.mjs";

const me = process.argv[2];
const d = deployment();
const C = d.contract;

async function main() {
  if (!me || !/\.testnet$/.test(me)) throw new Error("Give your testnet account: node scripts/try.mjs <your-account>.testnet");
  if (!hasKey(me)) throw new Error(`No key for ${me} in ~/.near-credentials/testnet. Create the account with the near-cli command at the top of this file.`);
  if (!(await accountInfo(me))) throw new Error(`${me} does not exist on testnet.`);
  const have = await balanceOf(me);
  if (have < near(6.8)) throw new Error(`${me} holds ${fmt(have, 2)} NEAR. This walk-through needs about 7, most of it the Sputnik factory's deposit for a new DAO.`);

  const ana = `ana.${me}`;
  const ben = `ben.${me}`;
  const cy = `cy.${me}`;
  const daoName = `ovt-${short(me).replace(/[^a-z0-9]/g, "").slice(0, 18)}-${Date.now().toString(36).slice(-5)}`;
  const DAO = `${daoName}.${FACTORY}`;
  console.log(`Ovation, on a DAO of your own\n  you          ${me}\n  contract     ${C}\n  your DAO     ${DAO}`);

  step(1, "Three named accounts under yours");
  for (const [id, what] of [[ana, "a member"], [ben, "a member"], [cy, "not a member"]]) {
    const made = await ensureAccount(me, id, near(0.15));
    note(`${id} (${what})${made ? " created" : " already there"}`);
  }

  step(2, "A Sputnik DAO with you as its council");
  const out = await call(
    me,
    FACTORY,
    "create",
    {
      name: daoName,
      args: b64({
        config: { name: daoName, purpose: "Trying Ovation", metadata: "" },
        policy: {
          roles: [
            { name: "council", kind: { Group: [me] }, permissions: COUNCIL_PERMISSIONS, vote_policy: {} },
            { name: "members", kind: { Group: [ana, ben] }, permissions: [], vote_policy: {} },
          ],
          default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
          proposal_bond: near(0.01).toString(),
          proposal_period: (7n * 86400n * 10n ** 9n).toString(),
          bounty_bond: near(0.01).toString(),
          bounty_forgiveness_period: (86400n * 10n ** 9n).toString(),
        },
      }),
    },
    { gas: 250, deposit: near(5.55) },
  );
  if (!out.ok || out.anyFailure) throw new Error(`the factory refused: ${reason(out.failure)} (${out.link})`);
  note(`created ${out.link}`);
  const fund = await send(me, DAO, [actions.transfer(near(0.4))]);
  note(`sent 0.4 NEAR to its treasury ${fund.link}`);

  step(3, "You pass the two proposals that install Ovation");
  const AGENT = await view(C, "agent_for", { dao: DAO });
  const role = ovationRole(AGENT);
  const r1 = await pass(DAO, [me], "* Title: Add the Ovation role <br>* Summary: Transfers only.", { ChangePolicyAddOrUpdateRole: { role } });
  note(`proposal #${r1.id}: role "ovation" holding only ${AGENT}, with ${role.permissions.join(", ")} ${r1.links.at(-1)}`);
  const config = {
    label: "Try it",
    token_id: null,
    token_symbol: "NEAR",
    token_decimals: 24,
    round_budget: near(0.05).toString(),
    round_secs: 60,
    review_secs: 0,
    claim_secs: 86400,
    claps_per_round: 10,
    clapper_roles: ["council", "members"],
    steward_roles: ["council"],
    min_backers: 2,
    max_share_bps: 10000,
    min_payout: near(0.001).toString(),
    auto_limit_new: near(0.05).toString(),
    auto_limit_trusted: near(0.05).toString(),
    cosign_limit: near(0.05).toString(),
    auto_round_cap: near(0.05).toString(),
    trusted_after_rounds: 1,
    trusted_after_backers: 2,
    post_to_social: true,
  };
  const r2 = await pass(
    DAO,
    [me],
    "* Title: Open an Ovation stage <br>* Summary: 0.05 NEAR per one-minute round.",
    functionCallKind(C, "open_stage", { config, bonds: near(0.03).toString() }, { deposit: near(0.12), gas: 150 }),
  );
  note(`proposal #${r2.id}: stage opened, 0.05 NEAR per one-minute round ${r2.links.at(-1)}`);
  await sleep(4000);
  const agentKeys = await provider.viewAccessKeyList({ accountId: AGENT });
  note(`your stage's own account ${AGENT} exists with ${fmt(await balanceOf(AGENT), 4)} NEAR for bonds and ${agentKeys.keys.length} access keys`);
  let stage = await view(C, "get_stage", { dao: DAO });
  if (!stage?.ready) {
    await mustCall(me, C, "sync_members", { dao: DAO }, { gas: 100 });
    stage = await view(C, "get_stage", { dao: DAO });
  }
  if (!stage?.ready) throw new Error("the stage is not ready; read get_stage to see which check failed");
  note(`the contract read your DAO's policy: ${stage.clappers.length} may applaud (${stage.clappers.map(short).join(", ")}), and your stage's account can file and approve small transfers, and nothing else`);

  step(4, "Applause");
  let round = await view(C, "get_round", { dao: DAO });
  if (round.ends_ms - Date.now() < 25_000) {
    note(`waiting ${Math.ceil((round.ends_ms - Date.now()) / 1000)} s for a fresh round`);
    await sleep(round.ends_ms - Date.now() + 2500);
    round = await view(C, "get_round", { dao: DAO });
  }
  const gifts = [
    [ana, 2, "Fixed the build on a Sunday"],
    [ben, 2, "Wrote the docs everyone links to"],
    [me, 1, "Showed up every week"],
  ];
  const posts = [];
  await Promise.all(
    gifts.map(async ([from, claps, text]) => {
      const a = await mustCall(from, C, "applaud", { dao: DAO, to: cy, claps, note: text }, { gas: 30 });
      posts.push(a.value.post_id);
      note(`${short(from)} gave ${short(cy)} ${claps} clap${claps === 1 ? "" : "s"}: "${text}" ${a.link}`);
    }),
  );
  const refused = await call(ana, C, "applaud", { dao: DAO, to: ana, claps: 1 }, { gas: 30 });
  note(`${short(ana)} tried to applaud themselves: ${refused.ok ? "it went through (unexpected)" : reason(refused.failure)}`);
  const row = await view(C, "get_standing", { dao: DAO, round: round.round, account: cy });
  note(`round ${round.round}: ${short(cy)} has ${row.claps} claps from ${row.backers} members, worth ${fmt(row.amount, 4)} NEAR, sign-off: ${row.tier}`);

  step(5, "Your stage's posts");
  await sleep(6000);
  const kv = await fetch(`${KV_API}/v0/latest/${d.social}/${AGENT}/${encodeURIComponent(`post/${posts[0]}`)}`).then((r) => r.json()).catch(() => ({}));
  const post = kv.entries?.[0];
  if (post) {
    note(`author ${post.predecessor_id}, written to ${post.current_account_id}:`);
    for (const line of post.value.text.split("\n")) note(`  ${line}`);
  } else {
    note("the public index has not caught up yet; look again in a few seconds:");
  }
  note(`${KV_API}/v0/latest/${d.social}/${AGENT}/${encodeURIComponent(`post/${posts[0]}`)}`);

  step(6, "The round closes, and one call files the payout and votes for it");
  const wait = round.review_ends_ms - Date.now();
  if (wait > 0) {
    note(`waiting ${Math.ceil(wait / 1000)} s for round ${round.round} to close`);
    await sleep(wait + 2500);
  }
  const before = await balanceOf(cy);
  const claim = await mustCall(me, C, "claim", { dao: DAO, round: round.round, account: cy }, { gas: 150 });
  const filed = await view(C, "get_standing", { dao: DAO, round: round.round, account: cy });
  const proposal = await view(DAO, "get_proposal", { id: filed.claim.proposal_id });
  note(`claim returned "${claim.value}" for ${claim.tgas} Tgas ${claim.link}`);
  note(`on your DAO it is proposal #${filed.claim.proposal_id}, a Transfer of ${fmt(proposal.kind.Transfer.amount, 4)} NEAR to ${proposal.kind.Transfer.receiver_id}`);
  note(`votes on it: ${JSON.stringify(proposal.votes)}`);

  step(7, "Your DAO pays");
  let state = "";
  for (let i = 0; i < 5 && state !== "Paid"; i++) {
    await sleep(i === 0 ? 3000 : 16_000);
    const s = await call(me, C, "settle", { dao: DAO, round: round.round, account: cy }, { gas: 100 });
    state = s.ok ? s.value : reason(s.failure);
    note(`settle says: ${state} ${s.link}`);
  }
  const after = await balanceOf(cy);
  note(`${cy} held ${fmt(before, 4)} NEAR and now holds ${fmt(after, 4)}: +${fmt(after - before, 4)}, exactly the amount on the board: ${after - before === BigInt(filed.amount)}`);
  const rec = await view(C, "get_record", { dao: DAO, account: cy });
  note(`their record: ${rec.claps_received} claps from ${rec.backers} different members, paid in ${rec.rounds_paid} round, trusted: ${rec.trusted}`);

  console.log(`\nDone. Look for yourself:\n  your DAO      ${EXPLORER}/address/${DAO}\n  your stage    ${EXPLORER}/address/${AGENT}\n  the recipient ${EXPLORER}/address/${cy}\n  the contract  ${EXPLORER}/address/${C}`);
  console.log(`To uninstall, pass one proposal of kind ChangePolicyRemoveRole with role "ovation".`);
}

main().catch((e) => {
  console.error(`\nStopped: ${e.message}`);
  process.exit(1);
});

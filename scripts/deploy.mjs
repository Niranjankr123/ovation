// Stand up the whole demo on NEAR testnet, the way a real community would install Ovation.
//
//   node scripts/deploy.mjs                  create what is missing, skip what exists
//   node scripts/deploy.mjs --code-only      redeploy the contract code and nothing else
//
// Needs one funded testnet account whose key is in ~/.near-credentials/testnet, named in
// OVATION_HQ (default ovation-hq.testnet), and the built contract (see README, "Build").
//
// What it does, in order:
//   1. Creates the contract account under the HQ account and deploys the code.
//   2. Creates a namespace for the community and a named account for each person.
//   3. Creates a real Sputnik DAO through the testnet factory, with a three-person council.
//   4. Puts some NEAR in the DAO's treasury so there is something to pay out.
//   5. Has the council pass two ordinary proposals: one adds a role holding only the stage's
//      own account and only three transfer permissions, one opens the stage, which creates
//      that account.
//
// Every step first checks the chain and does nothing if the step is already done.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { actions } from "near-api-js";
import {
  ROOT, FACTORY, SOCIAL, EXPLORER, NEAR, near, fmt, b64, sleep,
  view, call, mustCall, send, accountInfo, balanceOf, ensureAccount, topUp, faucet,
  COUNCIL_PERMISSIONS, ovationRole, functionCallKind, pass, reason,
  saveDeployment, deployment, step, note,
} from "./lib.mjs";

const HQ = process.env.OVATION_HQ || "ovation-hq.testnet";
const CONTRACT = process.env.OVATION_CONTRACT || `v1.${HQ}`;
const SPACE = process.env.OVATION_SPACE || "lantern-guild.testnet";
const DAO_NAME = process.env.OVATION_DAO_NAME || "lantern-guild";
const DAO = `${DAO_NAME}.${FACTORY}`;
const LABEL = "Lantern Guild";
const WASM =
  process.env.OVATION_WASM ||
  [path.join(ROOT, "contract", "target", "wasm32-unknown-unknown", "release", "ovation.wasm")].find((p) => fs.existsSync(p));

// The people of the demo. Council members are also the stage's stewards.
const COUNCIL = ["asha", "diego", "mei"];
const MEMBERS = ["noor", "kofi", "sana", "leo"];
// Not members of the DAO at all. They can be applauded and paid, and cannot applaud.
const GUESTS = ["ravi", "june"];
const id = (name) => `${name}.${SPACE}`;

// Demo timings are short so a person can watch a round close. A real stage would use
// something like 14-day rounds, a 2-day review and a 30-day claim window.
// NEAR the stage's own account holds for the bonds of its payout proposals. The demo DAO's
// bond is 0.01 NEAR, and every bond comes back once its proposal is decided.
export const STAGE_BONDS = near(0.15).toString();

export const STAGE_CONFIG = {
  label: LABEL,
  token_id: null,
  token_symbol: "NEAR",
  token_decimals: 24,
  round_budget: near(0.1).toString(),
  round_secs: 120,
  review_secs: 20,
  claim_secs: 7 * 86400,
  claps_per_round: 10,
  clapper_roles: ["council", "members"],
  steward_roles: ["council"],
  min_backers: 2,
  max_share_bps: 5000,
  min_payout: near(0.001).toString(),
  auto_limit_new: near(0.02).toString(),
  auto_limit_trusted: near(0.04).toString(),
  cosign_limit: near(0.045).toString(),
  auto_round_cap: near(0.06).toString(),
  trusted_after_rounds: 2,
  trusted_after_backers: 3,
  post_to_social: true,
};

const codeOnly = process.argv.includes("--code-only");

async function deployCode() {
  if (!WASM) throw new Error("Contract not built. See README, section Build, or set OVATION_WASM to the .wasm file.");
  const code = fs.readFileSync(WASM);
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  const out = await send(CONTRACT, CONTRACT, [actions.deployContract(code)]);
  if (!out.ok) throw new Error(`deploy failed: ${reason(out.failure)} (${out.link})`);
  note(`deployed ${code.length} bytes, sha256 ${hash.slice(0, 16)}... ${out.link}`);
  return { bytes: code.length, sha256: hash, tx: out.link };
}

async function main() {
  const links = {};
  console.log(`Ovation demo on NEAR testnet\n  HQ account:  ${HQ}\n  contract:    ${CONTRACT}\n  DAO:         ${DAO}\n  people:      *.${SPACE}`);
  if (!(await accountInfo(HQ))) throw new Error(`${HQ} does not exist. Create it with the faucet first (see README).`);

  step(1, "Contract account and code");
  const wasmBytes = WASM ? fs.statSync(WASM).size : 0;
  // Each byte of code locks 0.00001 NEAR on the account that holds it.
  const needed = (BigInt(wasmBytes) * NEAR) / 100_000n + near(0.35);
  if (await ensureAccount(HQ, CONTRACT, needed)) note(`created ${CONTRACT} with ${fmt(needed)} NEAR`);
  let code;
  const info = await accountInfo(CONTRACT);
  const hasCode = info.code_hash !== "11111111111111111111111111111111";
  if (!hasCode || codeOnly) {
    code = await deployCode();
    links.deploy = code.tx;
  } else {
    note("code already deployed (use --code-only to replace it)");
  }
  let initialised = true;
  try {
    await view(CONTRACT, "version");
  } catch {
    initialised = false;
  }
  if (!initialised) {
    const out = await mustCall(CONTRACT, CONTRACT, "new", { social: SOCIAL }, { gas: 30 });
    note(`initialised: near.social writes go to ${SOCIAL} ${out.link}`);
    links.init = out.link;
  }
  note(`version ${await view(CONTRACT, "version")}`);
  let prev = {};
  try {
    prev = deployment();
  } catch {}
  if (codeOnly) {
    if (prev.contract === CONTRACT && code) saveDeployment({ ...prev, code: { bytes: code.bytes, sha256: code.sha256 } });
    return;
  }

  step(2, `A namespace for the community, and a named account for each person`);
  if (await ensureAccount(HQ, SPACE, near(0.3))) note(`created ${SPACE}`);
  const people = [...COUNCIL, ...MEMBERS, ...GUESTS];
  // A transaction must be able to cover its attached gas up front, at about ten times the
  // gas price: 100 Tgas needs 0.1 NEAR on hand. Council members vote and guests claim, so
  // they hold more than members, who only applaud.
  const floor = (p) => (COUNCIL.includes(p) ? near(0.45) : GUESTS.includes(p) ? near(0.4) : near(0.1));
  let need = near(0.1);
  for (const p of people) {
    const have = await balanceOf(id(p));
    if (have < floor(p)) need += floor(p) - have;
  }
  if ((await balanceOf(SPACE)) < need) {
    // The community faucet contract funds any single-label testnet account, 2 NEAR per ask.
    note((await faucet(SPACE)) ? `faucet sent 2 NEAR to ${SPACE}` : `the faucet gave nothing this time`);
    const short = need - (await balanceOf(SPACE));
    if (short > 0n) {
      await send(HQ, SPACE, [actions.transfer(short)]);
      note(`sent ${fmt(short)} NEAR from ${HQ} to ${SPACE}`);
    }
  }
  for (const p of people) {
    if (await ensureAccount(SPACE, id(p), floor(p))) note(`created ${id(p)} with ${fmt(floor(p))} NEAR`);
    else {
      const sent = await topUp(SPACE, id(p), floor(p));
      if (sent) note(`topped up ${id(p)} by ${fmt(sent)} NEAR`);
    }
  }

  step(3, "A Sputnik DAO with a three-person council");
  if (!(await accountInfo(DAO))) {
    const args = {
      config: { name: DAO_NAME, purpose: `${LABEL}: an open-source collective. Demo treasury for Ovation.`, metadata: "" },
      policy: {
        roles: [
          { name: "council", kind: { Group: COUNCIL.map(id) }, permissions: COUNCIL_PERMISSIONS, vote_policy: {} },
          { name: "members", kind: { Group: MEMBERS.map(id) }, permissions: ["transfer:AddProposal"], vote_policy: {} },
        ],
        default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
        proposal_bond: near(0.01).toString(),
        proposal_period: (7n * 86400n * 10n ** 9n).toString(),
        bounty_bond: near(0.01).toString(),
        bounty_forgiveness_period: (86400n * 10n ** 9n).toString(),
      },
    };
    const out = await call(HQ, FACTORY, "create", { name: DAO_NAME, args: b64(args) }, { gas: 250, deposit: near(5.55) });
    if (!out.ok || out.anyFailure) throw new Error(`DAO creation failed: ${reason(out.failure)} (${out.link})`);
    note(`created ${DAO} ${out.link}`);
    links.dao = out.link;
  } else {
    note(`${DAO} exists`);
  }
  const policy = await view(DAO, "get_policy");
  note(`council: ${policy.roles.find((r) => r.name === "council").kind.Group.join(", ")}`);

  step(4, "Money in the treasury");
  // The stage's storage deposit and every payout come out of the DAO's own balance.
  if (BigInt(await view(DAO, "get_available_amount")) < near(0.7)) {
    const out = await send(HQ, DAO, [actions.transfer(near(1))]);
    note(`sent 1 NEAR to ${DAO} ${out.link}`);
  }
  note(`the DAO can spend ${fmt(await view(DAO, "get_available_amount"))} NEAR`);

  step(5, "The council installs Ovation with two ordinary proposals");
  // The role holds the stage's own account, which the contract names after the DAO before
  // the stage exists, so the council can grant it first.
  const AGENT = await view(CONTRACT, "agent_for", { dao: DAO });
  note(`the stage's own account will be ${AGENT}`);
  const voters = COUNCIL.slice(0, 2).map(id);
  if (!policy.roles.some((r) => r.kind?.Group?.includes(AGENT))) {
    const role = ovationRole(AGENT);
    const r = await pass(DAO, voters, `* Title: Add the Ovation role <br>* Summary: Lets ${AGENT} file transfer proposals and approve the small ones it filed. Nothing else.`, {
      ChangePolicyAddOrUpdateRole: { role },
    });
    note(`proposal #${r.id} passed: role "ovation" holds only ${AGENT}, with ${role.permissions.join(", ")}`);
    links.role = r.links;
  } else {
    note("the DAO's policy already has a role holding the stage's account");
  }
  let stage = await view(CONTRACT, "get_stage", { dao: DAO });
  if (!stage) {
    const r = await pass(
      DAO,
      voters,
      `* Title: Open an Ovation stage <br>* Summary: ${fmt(STAGE_CONFIG.round_budget)} NEAR per round, split by applause from the council and members roles.`,
      functionCallKind(CONTRACT, "open_stage", { config: STAGE_CONFIG, bonds: STAGE_BONDS }, { deposit: near(0.5), gas: 150 }),
    );
    note(`proposal #${r.id} passed: stage opened with 0.5 NEAR: ${fmt(STAGE_BONDS)} to the stage's account for bonds, the rest for storage`);
    links.stage = r.links;
    await sleep(4000);
    stage = await view(CONTRACT, "get_stage", { dao: DAO });
    note(`the stage's account holds ${fmt(await balanceOf(AGENT), 4)} NEAR`);
  } else {
    note("the stage is already open");
  }
  if (!stage) throw new Error("the stage did not open; look at the proposal's transaction");
  if (!stage.synced_ms || !stage.ready) {
    const out = await mustCall(HQ, CONTRACT, "sync_members", { dao: DAO }, { gas: 150 });
    note(`re-read the DAO's policy ${out.link}`);
    stage = await view(CONTRACT, "get_stage", { dao: DAO });
  }
  note(`ready: ${stage.ready} (role "${stage.role}", can file ${stage.can_add}, can approve ${stage.can_approve}, approves alone ${stage.solo}, wider than needed ${stage.wide})`);
  note(`may applaud: ${stage.clappers.join(", ")}`);
  note(`stewards: ${stage.stewards.join(", ")}`);

  note(`the DAO can spend ${fmt(await view(DAO, "get_available_amount"))} NEAR`);

  saveDeployment({
    network: "testnet",
    contract: CONTRACT,
    social: SOCIAL,
    dao: DAO,
    agent: AGENT,
    label: LABEL,
    namespace: SPACE,
    council: COUNCIL.map(id),
    members: MEMBERS.map(id),
    guests: GUESTS.map(id),
    code: code ? { bytes: code.bytes, sha256: code.sha256 } : prev.code,
    explorer: { contract: `${EXPLORER}/address/${CONTRACT}`, dao: `${EXPLORER}/address/${DAO}`, agent: `${EXPLORER}/address/${AGENT}` },
    transactions: { ...(prev.transactions || {}), ...links },
  });
  // The site reads this copy when it is served as plain static files.
  fs.writeFileSync(path.join(ROOT, "web", "deployment.json"), JSON.stringify(deployment(), null, 2) + "\n");
  console.log(`\nDone. Recorded in deployments/testnet.json\n  contract ${EXPLORER}/address/${CONTRACT}\n  DAO      ${EXPLORER}/address/${DAO}`);
}

// Only run when called directly, so other scripts can import STAGE_CONFIG.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((e) => {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  });
}

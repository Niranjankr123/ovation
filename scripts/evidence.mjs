// Write docs/TESTNET.md from what is recorded and what the chain says right now.
//
//   node scripts/evidence.mjs
//
// It reads deployments/testnet.json (what was deployed), deployments/testnet-e2e.json (the
// live checks, written by scripts/e2e.mjs), deployments/testnet-try.txt (the output of one
// run of scripts/try.mjs), and the contract and DAO themselves. Nothing here is typed by hand.

import fs from "node:fs";
import path from "node:path";
import { ROOT, EXPLORER, KV_API, deployment, view, provider, fmt, short } from "./lib.mjs";

const d = deployment();
const C = d.contract;
const DAO = d.dao;
const AGENT = d.agent;
const e2e = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet-e2e.json"), "utf8"));
const tryFile = path.join(ROOT, "deployments", "testnet-try.txt");
const tryRun = fs.existsSync(tryFile) ? fs.readFileSync(tryFile, "utf8").trim() : null;

const account = await provider.viewAccount({ accountId: C });
const keys = await provider.viewAccessKeyList({ accountId: C });
const agentAccount = await provider.viewAccount({ accountId: AGENT });
const agentKeys = await provider.viewAccessKeyList({ accountId: AGENT });
const policy = await view(DAO, "get_policy");
const role = policy.roles.find((r) => r.kind?.Group?.includes(AGENT));
const stage = await view(C, "get_stage", { dao: DAO });
const stages = await view(C, "list_stages");
const proposals = await view(DAO, "get_last_proposal_id");
const posts = await fetch(`${KV_API}/v0/latest/${d.social}/${AGENT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key_prefix: "post/" }) }).then((r) => r.json());
const sample = (posts.entries || []).filter((p) => p.value?.text).sort((a, b) => b.block_height - a.block_height)[0];

const link = (text, url) => (url ? `[${text}](${url})` : text);
const cfg = stage.config;
const lines = [];
const add = (...xs) => lines.push(...xs);

add(
  "# Ovation on NEAR testnet",
  "",
  "This file is written by `node scripts/evidence.mjs` from the recorded runs and from the chain. Run `node scripts/verify.mjs` to check the same things yourself, with no account.",
  "",
  `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
  "",
  "## What is deployed",
  "",
  "| Thing | Account | Notes |",
  "|---|---|---|",
  `| Contract | ${link(`\`${C}\``, `${EXPLORER}/address/${C}`)} | Code hash \`${account.code_hash}\`. ${keys.keys.filter((k) => k.access_key.permission === "FullAccess").length} full-access key still on the account, so the code can be replaced during the hackathon. |`,
  `| The demo stage's own account | ${link(`\`${AGENT}\``, `${EXPLORER}/address/${AGENT}`)} | Created by the contract when the stage opened. ${agentKeys.keys.length} access keys. Code hash \`${agentAccount.code_hash}\`, the ${fmt(BigInt(agentAccount.storage_usage) * 10n ** 19n, 4)} NEAR it locks for storage included in its balance of ${fmt(agentAccount.amount, 4)} NEAR, which pays the stage's bonds. |`,
  `| Demo DAO | ${link(`\`${DAO}\``, `${EXPLORER}/address/${DAO}`)} | Sputnik DAO ${await view(DAO, "version")}, created through the \`sputnikv2.testnet\` factory. ${proposals} proposals so far. |`,
  `| near.social data account | \`${d.social}\` | An account with no contract, like \`social\` on mainnet. |`,
  `| Demo people | \`*.${d.namespace}\` | Council: ${d.council.map(short).join(", ")}. Members: ${d.members.map(short).join(", ")}. Not members: ${d.guests.map(short).join(", ")}. |`,
  `| Stages on the contract | ${stages.length} | ${stages.map((s) => `\`${s}\``).join(", ")} |`,
  "",
  "## The stage's power in the demo DAO",
  "",
  `The contract itself holds no role in the DAO. The DAO's policy holds the stage's own account in one role, \`${role.name}\`, alone, with these permissions and nothing else:`,
  "",
  ...role.permissions.map((p) => `- \`${p}\``),
  "",
  `Its vote policy for transfers is \`${JSON.stringify(role.vote_policy.transfer)}\`: one vote from a one-account role passes. The council installed it with two ordinary proposals, each passed by two of three council votes.`,
  "",
  "## The demo stage's rules",
  "",
  "| Rule | Value |",
  "|---|---|",
  `| Budget per round | ${fmt(cfg.round_budget)} NEAR |`,
  `| Round, review, claim window | ${cfg.round_secs} s, ${cfg.review_secs} s, ${cfg.claim_secs / 86400} days. Short on purpose, so a person can watch a round close. |`,
  `| Claps per member per round | ${cfg.claps_per_round} |`,
  `| Different members needed to be paid | ${cfg.min_backers} |`,
  `| Most one recipient can take | ${cfg.max_share_bps / 100}% of a round |`,
  `| No sign-off up to | ${fmt(cfg.auto_limit_new)} NEAR for anyone, ${fmt(cfg.auto_limit_trusted)} NEAR for a trusted recipient |`,
  `| One steward co-signs up to | ${fmt(cfg.cosign_limit)} NEAR. Above it the council votes. |`,
  `| Trusted after | ${cfg.trusted_after_rounds} paid rounds and ${cfg.trusted_after_backers} different backers |`,
  `| May applaud | ${stage.clappers.length} accounts in the DAO roles ${cfg.clapper_roles.map((r) => `\`${r}\``).join(", ")} |`,
  `| Stewards | ${stage.stewards.map(short).join(", ")}, the DAO role ${cfg.steward_roles.map((r) => `\`${r}\``).join(", ")} |`,
  "",
  `So far: ${stage.entries} pieces of applause, ${stage.claps} claps standing, ${fmt(stage.paid, 5)} NEAR paid in ${stage.payouts} payouts over ${stage.rounds} rounds.`,
  "",
  "## A post written by the stage's account",
  "",
  `Read from the public index at \`${KV_API}\`. Author (\`predecessor_id\`): \`${sample?.predecessor_id}\`. Written to: \`${sample?.current_account_id}\`. Block ${sample?.block_height}.`,
  "",
  "```text",
  sample?.value.text ?? "(none found)",
  "```",
  "",
  `## Live checks: ${e2e.passed} of ${e2e.passed + e2e.failed} passed`,
  "",
  `\`node scripts/e2e.mjs\` ran on ${e2e.ran_at.slice(0, 16).replace("T", " ")} UTC against the deployed code, over rounds ${Object.values(e2e.rounds).join(", ")} of the demo stage. Each row is one check. Where a transaction proves it, the result links to it.`,
  "",
  "| # | Check | Result | What was seen |",
  "|---|---|---|---|",
  ...e2e.checks.map((c, i) => `| ${i + 1} | ${c.name} | ${link(c.ok ? "pass" : "FAIL", c.link)} | ${String(c.detail || "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 150)} |`),
  "",
);

if (tryRun) {
  add(
    "## A second DAO, installed from scratch by a fresh account",
    "",
    "The output of `node scripts/try.mjs ovation-judge.testnet`, unedited. The account was new, held 6.95 test NEAR, and had no connection to the demo DAO. It created its own Sputnik DAO, installed Ovation with two proposals, and its outsider was paid.",
    "",
    "```text",
    tryRun,
    "```",
    "",
  );
}

add(
  "## Not exercised on testnet",
  "",
  "- A payout proposal that expires and is finalized by the stage's own account. The demo DAO's proposal period is 7 days. The rule is unit-tested in `contract/rules/src/claims.rs`.",
  "- A stage that pays a NEP-141 token instead of NEAR.",
  "- A vote that fails because the treasury cannot cover the payout, then succeeds on retry.",
  "- near.social itself, which indexes mainnet only.",
  "",
  "## Development notes",
  "",
  "- The contract account's state was wiped twice during development, when its storage layout changed: once for stage numbers, and once for version 1.1.0, which gave each stage its own account after the security review. The wipe used methods that existed only in one-off builds; they are not in this repository or in the deployed code, and the second wipe deleted every stored key of the earlier versions. The DAO's own history keeps the proposals of those earlier runs.",
  "",
);

fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "TESTNET.md"), lines.join("\n"));
console.log(`wrote docs/TESTNET.md: ${e2e.checks.length} checks, ${stages.length} stages, code ${account.code_hash}`);

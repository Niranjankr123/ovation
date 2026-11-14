// Change the demo stage's no-sign-off limit for trusted recipients, through an ordinary
// council proposal, the way a real DAO would.
//
//   node scripts/set-limit.mjs 0.025     lower it
//   node scripts/set-limit.mjs 0.04      put it back
//
// Only rounds that start after the change use the new limit: a round keeps the rules it
// started under.

import { deployment, view, pass, functionCallKind, near, fmt } from "./lib.mjs";

const d = deployment();
const value = process.argv[2];
if (!value) throw new Error("say the new limit in NEAR, for example 0.025");
const stage = await view(d.contract, "get_stage", { dao: d.dao });
const config = { ...stage.config, auto_limit_trusted: near(value).toString() };
const r = await pass(
  d.dao,
  d.council.slice(0, 2),
  `* Title: Change the Ovation stage <br>* Summary: Trusted recipients are paid with no sign-off up to ${value} NEAR.`,
  functionCallKind(d.contract, "update_stage", { config }, { gas: 100 }),
);
const after = await view(d.contract, "get_stage", { dao: d.dao });
console.log(`proposal #${r.id} passed: no sign-off for trusted recipients up to ${fmt(after.config.auto_limit_trusted, 4)} NEAR (was ${fmt(stage.config.auto_limit_trusted, 4)}) ${r.links.at(-1)}`);

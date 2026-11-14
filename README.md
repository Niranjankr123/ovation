# Ovation

Applause that pays, on Sputnik DAO.

Members of a DAO applaud whoever did good work. When a round closes, the breadth of that applause splits a budget the council approved once, and each person is paid from the DAO's own treasury. Nobody has to ask for money for themselves.

- **Track:** Social Money (`social`)
- **Built on:** Sputnik DAO v2, Trezu's proposal format, NEAR named accounts, near.social (FastData KV)
- **Network:** NEAR testnet
- **Contract:** [`v1.ovation-hq.testnet`](https://testnet.nearblocks.io/address/v1.ovation-hq.testnet)
- **Demo DAO:** [`lantern-guild.sputnikv2.testnet`](https://testnet.nearblocks.io/address/lantern-guild.sputnikv2.testnet), and its stage's own account [`lantern-guild-7796.v1.ovation-hq.testnet`](https://testnet.nearblocks.io/address/lantern-guild-7796.v1.ovation-hq.testnet)
- **Demo video:** [`demo/ovation-demo.mp4`](demo/ovation-demo.mp4), recorded from the real site on live testnet. The narration is an AI voice.
- **Hosted site, read-only:** <https://niranjankr123.github.io/ovation/>, published from `web/` by `.github/workflows/pages.yml`

Built at NEAR HACKATHON, November 2026.

## The problem

A Sputnik DAO pays whoever files a proposal and gets the council to vote. So the money follows the asking, and two kinds of people do the asking.

`scripts/census.mjs` read every proposal of every DAO created by `sputnik-dao.near` over public RPC on 2026-11-11: 2,111 DAOs, 67,701 proposals, 24,392 approved transfers.

| Who filed the payout | Payouts | Share |
|---|---|---|
| The account that was paid | 12,763 | 52.3% |
| A member who then voted on it | 9,136 | 37.5% |
| Anyone else | 2,493 | 10.2% |

Among the 264 DAOs that have made ten or more payouts, 209 had under a tenth of them filed by a third party, and 108 never had one.

What the numbers mean and do not mean:

- "Anyone else" is an upper bound on people speaking up for a colleague. It also holds staff who file payroll but have no vote, such as Trezu's Requestor role.
- It leaves out `bridge-validator.sputnik-dao.near`, whose proposals are filed by bridge software, and two newsroom DAOs where each article is a proposal.
- It does not say the payouts were wrong. It says who had to speak for the money to move.

The people who know who did the work are the teammates who saw it. They have no channel that moves money. The person who did the work has one, and it is to write "pay me" and lobby a council that did not see the work. Many never do.

Ovation gives the teammates that channel, with the treasury and the members the DAO already has.

## How it works

| Step | What happens | Who can do it |
|---|---|---|
| Install | The council passes two ordinary proposals. One adds a role holding only the stage's own account, with only `transfer:AddProposal`, `transfer:VoteApprove`, `transfer:Finalize`. One opens the stage: a budget per round and the rules. Opening it creates that account. | The DAO |
| Applaud | Each member of the DAO roles the stage names has a few claps per round. They give them to whoever did good work, with a note. They cannot applaud themselves. | Members |
| Post | Each applause is written to near.social as a post by the stage's account. | The contract |
| Review | After the round closes, stewards can strike out applause for a set time. The reason is public. | Stewards (a DAO role) |
| Claim | One call files a Transfer proposal on the DAO for the recipient's share. | Anyone, for anyone |
| Pay | The DAO executes the transfer. Unclaimed money never leaves the treasury. | The DAO |

**The score.** A recipient's score in a round is `(sum over members of sqrt(claps from that member))^2`. Five members giving two claps each score 50. One member giving ten claps scores 10. The round's budget is split in proportion to scores, among recipients applauded by at least `min_backers` different members, and no one can take more than `max_share_bps` of a round. Everything rounds down, so a round can never pay more than its budget.

**Who signs off a payout.** It depends on the amount and on the recipient's record.

| Amount | What it takes |
|---|---|
| Up to `auto_limit_new`, or `auto_limit_trusted` for a trusted recipient | The stage's account votes for it alone, in the same call that files it. |
| Up to `cosign_limit` | One steward co-signs, then the stage's account votes. A steward cannot co-sign their own payout, or the payout of someone they applauded that round. |
| Above that | A normal DAO proposal. The stage files it and never votes on it. |

On top of that, at most `auto_round_cap` of a round goes out with nobody signing at all. Past it, payouts that would have gone through alone wait for a steward.

**Earned trust.** A recipient is trusted once they have been paid in `trusted_after_rounds` rounds and applauded by `trusted_after_backers` different members over their whole record. A record belongs to a named account. `list_record_lines` returns every applause it is made of: who gave it, in which round, how many claps, and their note.

**Each stage has its own account.** When a DAO opens a stage, the contract creates an account for it under itself, named after the DAO: `lantern-guild-7796.v1.ovation-hq.testnet` for the demo. That account is the one in the DAO's role. It runs a 1.4 KB contract with no state and no keys, which does two things when the Ovation contract asks: make one call with a deposit from its own balance, or send NEAR from its own balance. It files the stage's proposals, pays their bonds and gets them back, casts the stage's votes, and writes the stage's posts. So one stage's NEAR is never mixed with another's.

**What the contract cannot do.**

- Hold a DAO's money. It has no code that sends a DAO's tokens.
- Mix one stage's NEAR with another's, or credit a stage with NEAR it did not receive. A DAO that lies in its answers can only spend its own stage's money.
- Vote on a proposal its stage did not file, or on a payout above the limits the DAO set.
- Decide who is a member. That is whoever the DAO holds in the roles the stage names, re-read from the DAO's policy by `sync_members`.
- Keep its power. One `ChangePolicyRemoveRole` proposal ends it.

## Try it: do X, see Y

Needs Node 22 or later. Run `npm ci` once.

**1. Check the live deployment from the outside. No account needed.**

```bash
node scripts/verify.mjs
```

See: the stage's account has no keys, the contract itself holds no role in the DAO, and the stage's account sits alone in one role with exactly three transfer permissions; a list of every payout with who voted on its proposal (small ones: the stage only; mid-size: the stage after a steward co-signed; large: council members, never the stage); the books adding up; and posts in the public FastData index whose author is the stage's account.

**2. Open the site. No account needed.**

```bash
node scripts/serve.mjs
```

Open <http://127.0.0.1:4173>, or skip the command and open the hosted copy at <https://niranjankr123.github.io/ovation/>. Everything on screen is read from NEAR testnet by your browser.

- **Stage:** see the round that is open now, its countdown, and how its budget would be split.
- **Payouts:** see finished rounds. Each row shows the amount, who has to sign it off, its state, and the DAO proposal number.
- **People:** open `kofi`. See a `trusted` badge and every applause in the record, each with its giver, round and note.
- **Feed:** see the posts the stage's account wrote.
- **Install:** type any Sputnik DAO on testnet and press "Read its policy". See its roles, the name of the account its stage would get, and the two proposals that would install Ovation, ready to copy.
- **How it works:** move the sliders. See ten claps from one member lose to ten claps from five.

**3. Install it on a DAO of your own and get someone paid. Needs a testnet account with about 7 test NEAR. Takes about three minutes.**

```bash
near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

```bash
node scripts/try.mjs <name>.testnet
```

See, each with its transaction link: three named accounts created under yours; a real Sputnik DAO created with you as its council; the two install proposals passing; your stage's own account appearing with no keys; three members applauding an outsider; a member's attempt to applaud themselves refused with `ERR_SELF`; your stage's post read back from the public index; one `claim` call returning `Voted`; and the outsider's balance rising by exactly the amount on the board. About 5.5 of the 7 NEAR is the Sputnik factory's storage deposit for a new DAO.

**4. Run the rules.**

```bash
cd contract && cargo test -p ovation-rules
```

See: 64 tests pass. Every rule about applause and money is a pure function in `contract/rules`, with no NEAR runtime, so this needs only Rust.

**5. Re-measure the problem. About 20 minutes on free RPC.**

```bash
node scripts/census.mjs fetch
```

```bash
node scripts/census.mjs report
```

See: `data/census.json` with the table above, moved by whatever has happened on chain since.

**6. Act as the demo community. Deployer only, because it needs the demo accounts' keys.**

```bash
node scripts/serve.mjs --demo
```

See: an "Acting as" menu. Pick a member and applaud; pick a steward and co-sign or strike out. `node scripts/e2e.mjs` runs 81 live checks the same way and writes them to `deployments/testnet-e2e.json`.

## A stage with a voice

near.social stores posts as [FastData KV](https://docs.fastnear.com/fastdata/kv) writes: a function call to the account `social`, which has no contract. Its [standard](https://api2.near.social/standard.md) says the author of a write is the `predecessor_id` of the receipt, and that the indexer does not look at whether the receipt succeeded.

So a smart contract can post. Each Ovation stage posts from its own account, which has no keys: only the Ovation contract can make it act. Each post exists only because the contract's rules were met: this member applauded that account, or this DAO paid that amount.

- A post mentions the recipient and the giver. On near.social, a mention is a notification.
- A member's note is published under the stage's account, so a note may not contain `@`, a link, anything that reads as a web address, double quotes or invisible characters.
- If the applause is about a near.social post by the recipient or the giver, the stage's post quotes it, which notifies its author.
- A struck-out or withdrawn applause takes its post down. Giving it again edits the same post, so nobody is notified twice.
- Each stage stays under near.social's limit of 300 new posts per account per day, and its profile says it is automated.

Verified on testnet: `social.testnet` is also an account with no contract, and the public testnet index returns the stage's posts with `predecessor_id` equal to the stage's account. See them:

```bash
curl -s -X POST https://kv.test.fastnear.com/v0/latest/social.testnet/lantern-guild-7796.v1.ovation-hq.testnet -H "Content-Type: application/json" -d "{\"key_prefix\":\"post/\"}"
```

Not run: mainnet. near.social itself indexes only mainnet's `social`, so no post has appeared on near.social yet. The contract takes the account to write to as an `init` argument.

## How it fits Social Money

The track asks for shared budgets, programmable rewards, collective ownership and reputation-based access on Sputnik DAO and Trezu, without rebuilding the multisig.

| Track idea | In Ovation |
|---|---|
| Shared budgets | The council sets a budget per round once. The round can never pay more. |
| Programmable rewards | Peer applause, scored by breadth, splits the budget. |
| Reputation-based access | A record of paid rounds and different backers raises the amount that needs no sign-off. Other contracts can read it with `get_record`. |
| Collective ownership | Not addressed. The DAO owns the treasury as before. |
| Named accounts | Records, applause and posts all carry named accounts. Members are whoever the DAO's roles hold. Each stage gets a named account of its own. |

### Approval flows: what exists and what this adds

| Need | Already in Sputnik DAO | Already in Trezu | Added by Ovation |
|---|---|---|---|
| Custody | The DAO holds everything | The same DAO | Nothing. The contract never holds a DAO's funds. |
| Paying someone | `Transfer` proposals, voted on by roles | Payment requests, single and bulk | Files the `Transfer` itself, for an amount computed from applause |
| Who starts a payout | Whoever a role lets file proposals | The Requestor role | Nobody asks. Applause from several members creates the claim. |
| Approval by amount | Not possible: a threshold depends on the proposal kind and the role, not the amount | One threshold for all payments | Three tiers by amount and by the recipient's record, and a cap per round on what goes out unsigned |
| Approval without a meeting | A role whose single member's vote passes a proposal kind | None | Uses exactly that: a role holding only the stage's own account, limited to transfers |
| Reputation | None. Bounties leave no record | None | A record per named account, each clap traceable |
| Paying for work | Bounties: the task is posted first, then claimed | Not surfaced | Not used. Ovation rewards work after it is done. |
| Membership | Roles with fixed groups | Members page | Reuses the DAO's roles as they are |
| Oversight | `VoteReject`, `VoteRemove`, removing a role | Voting on requests | Stewards void applause, co-sign or pause; the DAO resumes |
| Uninstall | `ChangePolicyRemoveRole` | Shown as a policy change | Nothing needed |

Trezu's hosted app is mainnet-only and was not run. Ovation's proposals use the description form its parser reads (`* Title: ... <br>* Summary: ... <br>* Notes: ...`, read in `NEAR-DevHub/trezu`, `nt-fe/lib/utils.ts`), and a `Transfer` proposal is what Trezu lists as a payment request (`nt-fe/features/proposals/utils/proposal-utils.ts`).

### The track's example prompt

The [example prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/12-social.md) is a bounty board with earned trust, offered as a starting point. Ovation meets its four requirements for work that nobody posted a bounty for:

| Example requirement | In Ovation |
|---|---|
| Use the existing treasury, with no new multisig | Yes. The DAO holds the money and executes every payout. |
| Reputation on named accounts, every point traceable | Yes. `list_record_lines` returns each applause behind a record. |
| Small payouts auto-approve for trusted contributors, mid-size need one council member, large become a normal proposal | Yes. See "Who signs off a payout". Live check: the same amount went through alone for a trusted recipient and waited for a co-signature for a newcomer. |
| A public board of items, claims, payouts and records | Yes. The site, and the stage's feed on near.social. |

## What ran and what did not

| Piece | State | Evidence |
|---|---|---|
| Contract on testnet, all three payout paths paying through a real Sputnik DAO | Ran | [docs/TESTNET.md](docs/TESTNET.md), `deployments/testnet-e2e.json` |
| Bonds paid from the stage's own account and returned to it | Ran | The same |
| Every refusal, voiding, pause and resume, rejected, removed and bounced payouts | Ran | The same: 81 of 81 live checks pass |
| A second DAO on the same contract, installed from scratch by a fresh account | Ran | `scripts/try.mjs`, [docs/TESTNET.md](docs/TESTNET.md) |
| Rules: score, amounts, tiers, wording, policy reading, payout states | Ran | `cargo test -p ovation-rules`, 64 tests |
| The stage's posts in the public testnet index of near.social's data standard | Ran | `scripts/verify.mjs`, the Feed page |
| The census of mainnet Sputnik DAOs | Ran | `data/census.json` |
| Site in demo mode, acting as the demo members | Ran locally | Demo video |
| Posts on near.social itself | Not run. Needs a mainnet deployment. | |
| Trezu | Not run. Hosted Trezu is mainnet-only. Checked against its parser's source only. | |
| A proposal that expires and is finalized by the stage | Implemented and unit-tested. Not exercised on chain: the demo DAO's proposal period is 7 days. | `contract/rules/src/claims.rs` |
| A stage that pays a NEP-141 token | Implemented. Not exercised on chain. | `contract/src/lib.rs` |
| Signing with a real wallet from the site | Not built into this copy. The site is read-only without the demo relay. | `web/session.js` |
| Mainnet deployment | Not done. | |

The testnet contract account still has its deploy key, so the code can be replaced during the hackathon. `scripts/verify.mjs` says so. A mainnet deployment should delete that key. The stages' own accounts have no keys at all.

The demo stage uses two-minute rounds and a 20-second review so a person can watch one close. A real stage would use something like 14-day rounds and a 2-day review.

For the demo video, the council lowered the no-sign-off limit for trusted recipients from 0.04 to 0.025 NEAR with an ordinary `update_stage` proposal ([#57](https://testnet.nearblocks.io/txns/AUYtsGjmATQtQLR7r7pgzUPrFKcimLaMvFUXTdWqucfA)). June had become trusted during earlier test runs, and her payout of about 0.031 NEAR would otherwise have gone through with no co-signature. The limit went back to 0.04 NEAR afterwards ([#61](https://testnet.nearblocks.io/txns/2xEedU62wr1JmJ8gUP7cqtb6LwRmCwB5idDHD1QEUkqz)). `scripts/set-limit.mjs` does this.

## Contract

Called by a DAO, through a `FunctionCall` proposal: `open_stage`, `update_stage`, `resume_stage`, `withdraw_storage`, `withdraw_bonds`.

Called by members of the stage's roles: `applaud`.

Called by stewards: `void_applause`, `cosign`, `pause_stage`.

Called by anyone: `claim`, `settle`, `sync_members`, `fund_stage`.

Views: `get_stage`, `agent_for`, `list_stages`, `count_stages`, `get_round`, `list_rounds`, `list_applause`, `list_standings`, `get_standing`, `get_record`, `list_record_lines`, `get_member`, `get_social_account`, `version`.

Every state change logs a NEP-297 event with `"standard": "ovation"`.

Measured on testnet:

| Call | Gas burnt, all receipts | Example |
|---|---|---|
| applaud | 7.77 Tgas | [transaction](https://testnet.nearblocks.io/txns/3TnarGhxCgwttMZNHXfPjVU5MHnSS5mXvMhuZEgLyvrN) |
| `claim` that files a NEAR payout and votes for it | 22.45 Tgas | [transaction](https://testnet.nearblocks.io/txns/w2bfBpPPTy844VdCjg7XGSyCEYTcMceeTQsHkKkSL12) |
| `claim` that files a payout for the council | 10.6 Tgas | [transaction](https://testnet.nearblocks.io/txns/5aMUs3JvGS5t8if8dtsWrxfFgNxogVuqxFrXaMh3UtXa) |
| `cosign`, including the vote | 14.94 Tgas | [transaction](https://testnet.nearblocks.io/txns/FXjPZFJTnWVBqurj9PNcryZjPSWw6j1UPzD7BJT3fUFk) |
| `settle` that records a payout as paid | 11.25 Tgas | [transaction](https://testnet.nearblocks.io/txns/7xomw4DnP55CuWKYwgkViFd4hzbTkfan7vkkAzCycWC3) |
| a refused call, for example a second claim | 2.32 Tgas | [transaction](https://testnet.nearblocks.io/txns/B5BY57fWSjpX5BWD7CDNJ3xMfF2kdwi4GmwXshwQvZXf) |

A call must attach more gas than it burns, because each step reserves gas for the next one. So `claim` refuses to start with less than 110 Tgas attached, `settle` with less than 80, `cosign` with less than 70 and `sync_members` with less than 60: a caller cannot starve a step to make a DAO's answer look like a refusal.

Members never attach a deposit. A stage's storage here comes out of NEAR the DAO prepaid in `open_stage`, and anyone can add to it with `fund_stage`. The bonds of its payout proposals come out of the stage's own account and go back there; anyone can top that account up with a plain transfer. The DAO takes back what is unused with `withdraw_storage` and `withdraw_bonds`.

A payout counts as paid only after the DAO's proposal has been read as approved twice, at least 15 seconds apart, because Sputnik marks a proposal approved before the transfer has run. A transfer that bounces is recorded as `Failed`, never as paid.

## Security review

An independent AI review of the first version found a critical bug: every stage's NEAR sat in the contract's one balance, and proposal bonds were credited back to a stage on the DAO's word, so a DAO written to lie could drain the others. Version 1.1.0, which is what is deployed and tested here, gives each stage its own account and credits nothing on a DAO's word. [docs/DESIGN.md](docs/DESIGN.md) lists every finding and what changed. It was not a professional audit.

Known limits:

- Friends can still applaud friends. Needing several different members, the square root, the share cap, the per-round cap on unsigned payouts and the public feed make it pay badly and show plainly, and stewards can strike it out. They do not make it impossible.
- Stewards are trusted to void and pause fairly. Both are public and carry the steward's name.
- Who may applaud is read from the DAO's policy when someone calls `sync_members`. A member the DAO removed keeps their claps until that call. Anyone can make it.
- A payout read as approved twice, 15 seconds apart, counts as paid. A transfer that failed even later would still be recorded as paid.
- Storage grows with every applause and is never pruned.

## Repository

| Path | What |
|---|---|
| `contract/src/lib.rs` | The contract: storage, promises, callbacks, views |
| `contract/agent/` | The 1.4 KB contract each stage's own account runs, and its build (`agent.wasm`) |
| `contract/rules/src/` | Every decision as pure functions, with tests: `math`, `gates`, `claims`, `policy`, `rounds`, `text`, `config` |
| `web/` | The static site. Reads RPC and the FastData index directly. No backend |
| `scripts/serve.mjs` | Serves the site. `--demo` adds a local relay that signs for the demo accounts |
| `scripts/deploy.mjs` | Deploys the contract and installs it on a new DAO through real council votes |
| `scripts/e2e.mjs` | The live checks against testnet |
| `scripts/verify.mjs` | Read-only proof of the deployment |
| `scripts/try.mjs` | Installs Ovation on a DAO of your own and pays someone |
| `scripts/census.mjs` | The measurement in "The problem" |
| `scripts/evidence.mjs` | Writes `docs/TESTNET.md` from the recorded runs and the chain |
| `demo/` | The demo video and how it was made |

Build, from `contract/`. The stage contract first, because the main contract embeds it:

```bash
cargo build --release --target wasm32-unknown-unknown -p ovation-agent
```

Copy `target/wasm32-unknown-unknown/release/ovation_agent.wasm` to `contract/agent/agent.wasm` (the repository holds the build, passed through `wasm-opt -Oz`). Then:

```bash
cargo build --release --target wasm32-unknown-unknown -p ovation
```

`contract/.cargo/config.toml` sets `--cfg near`, which near-sdk needs when built with plain cargo. The deployed code is that build passed through `wasm-opt -Oz`, which takes it from 412 KB to 337 KB.

## Prior art

Ovation's parts are older ideas, put together on Sputnik DAO:

- Peers allocating a shared budget among themselves, as in gift circles.
- Scoring breadth with square roots: quadratic funding (Buterin, Hitzig and Weyl, 2018).
- A contract acting inside a DAO through a narrow role: a known pattern on NEAR.
- Kudos and badges for NEAR accounts have existed before, without moving money.

New here, as far as I could find: keyless per-stage accounts that post to near.social on a contract's behalf, and peer applause that pays out of a Sputnik treasury with sign-off tiers.

## Libraries and AI-written code

Written with Claude Code (Anthropic) during the hackathon. Everything in this repository is new work.

Libraries: `near-sdk` and `serde_json` (contract), `near-api-js` (scripts), `playwright-core` (recording the demo), `binaryen`'s `wasm-opt` (shrinking the build). The demo narration is an AI voice made with Chatterbox, and checked against the script with faster-whisper.

## License

MIT. See [LICENSE](LICENSE).

# Design notes

Why Ovation's rules are what they are, who could attack it, what an independent review found, and what a mainnet deployment would still need.

## The rules, and the reason for each

**Applause instead of requests.** A payout request is written by the person who wants the money or by the council. Neither is the best witness. The teammates who saw the work are, and a clap costs them a few seconds. Nobody has to write "pay me".

**Square roots.** A recipient's score is `(sum of sqrt(claps per member))^2`. If `k` members give `c` claps each, the score is `k^2 * c`: doubling the claps doubles the score, doubling the members quadruples it. Splitting the same claps across more members never lowers a score (`contract/rules/src/math.rs`, test `splitting_the_same_claps_across_more_members_never_lowers_a_score`). The formula is quadratic funding's, applied to applause. Quadratic funding breaks when one person can pose as many. Here the people who may applaud are the named accounts the DAO itself holds in its roles, so posing as many means getting the council to admit many accounts.

**A minimum number of backers.** With `min_backers` at 2 or more, two friends who only applaud each other each have one backer and earn nothing. A recipient below the minimum adds nothing to the round's total either, so their applause cannot shrink anyone else's share.

**A cap per recipient.** No one takes more than `max_share_bps` of a round. What the cap cuts off is not shared out again. It stays in the treasury.

**Rounding down.** Every amount is rounded down, with a 256-bit intermediate product so no precision is lost before the division. A round's amounts can therefore never add up to more than its budget (test `payouts_never_exceed_the_budget`, and the contract refuses any claim that would take `filed` over `budget`).

**Three tiers of sign-off.** Sputnik sets a voting threshold per proposal kind and per role, not per amount. A council that wants "small payments just go, big ones get a vote" has no way to say so. Ovation adds that one thing: the stage's account votes only when the amount is under a limit the DAO chose.

**Earned trust.** The limit is higher for a recipient who has been paid in several rounds and applauded by several different members over their whole record. Both are needed: paid rounds alone could come from one friend, and many backers in one round could be a single lucky week. Trust is read when the claim is filed and is never stored, so it cannot go stale.

**A role, not custody.** The contract holds no DAO funds. Each stage files `Transfer` proposals and, for small ones, casts the vote that passes them. Sputnik lets each role pass a proposal on its own count of votes, so a role containing one account, with a 1-of-1 threshold for transfers, is exactly "this account may approve transfers alone". The DAO grants that with one proposal and takes it back with one proposal.

**A stage's own account.** The account in that role is not the contract but one made for the stage, `<dao-name>-<4 hex>.<contract>`, which the contract names before the stage exists so the council can grant the role first. It runs a 1.4 KB contract (`contract/agent`) that has no state and no keys, and does exactly two things when the contract above it asks: make one call with a deposit from its own balance, or send NEAR from its own balance. It pays the bonds of its stage's proposals and the DAO returns them to it. So one stage's NEAR is never mixed with another's, and nothing is ever credited on a DAO's word: a DAO written to lie can only spend its own stage's money. The first version kept every stage's NEAR in the contract's one balance, and the review below found how a lying DAO could drain it.

**Anyone can file a claim, for anyone.** The money can only go to the account that earned it, so there is nothing to protect by restricting who files. It means a recipient with no NEAR for gas can still be paid.

**Unclaimed money never moves.** There is no payout to push and no escrow to drain. A payout exists only once someone files it.

**Approved has to be read twice.** Sputnik marks a proposal `Approved` in the same call that starts the transfer. If the transfer then fails, its callback changes the status to `Failed`. So `settle` records `Paid` only after it has read `Approved` twice, at least 15 seconds apart. A vote Sputnik accepts never counts as one of those reads, because the proposal may need more votes or have just expired. On testnet, a transfer to an account that does not exist ended as `Failed` on the DAO and was never recorded as paid.

**Removal is proved, not assumed.** A proposal the council removes as spam is deleted. Reading a deleted proposal fails the same way a read that ran out of gas fails. So `settle` reads with `get_proposals(from_index, limit: 1)`, which answers with an empty list for a deleted proposal, and it refuses to start with too little gas for the whole chain. A read that fails changes nothing.

**No member list.** Who may applaud and who oversees is whoever the DAO holds in the roles the stage names. `sync_members` copies those lists from the DAO's `get_policy`. Anyone can call it. Between a DAO removing a member and that call, the member keeps their claps for the round. The alternative, reading the policy on every clap, would make each clap cost several times more.

**Notes without mentions or links.** A member's note is published on near.social under the stage's account. If notes could contain `@account`, any member could make the stage notify strangers. If they could carry links or anything that reads as a web address, the stage's feed would carry advertising. Both are refused on chain, and so are double quotes, which could break out of the quotation marks the post puts around a note, and invisible formatting characters.

**A cap on how many people one member can name.** Each new recipient costs the stage storage that taking the applause back does not free. Without a cap, one member could applaud and withdraw in a loop and run the stage's prepaid storage dry for the price of gas. A member can name at most as many different people per round as they have claps.

**Members never pay.** Storage and the bonds of payout proposals come from NEAR the DAO prepaid. `applaud` takes no deposit, so a wallet can sign it with a function-call key and no pop-up.

## Who could attack it

| Attacker | What they could try | What stops it |
|---|---|---|
| A member | Applaud themselves | Refused (`ERR_SELF`) |
| Two members | Trade claps | `min_backers`, the square root, the share cap. With `min_backers` of 2 they earn nothing alone. |
| A ring of members | Applaud one account in turn | Not stopped by code. The share cap bounds it, every clap is a public post, and stewards can void. |
| A member | Run the stage out of storage | The cap on people named per round |
| A member | Make the stage post abuse or ping strangers | Notes cannot contain `@`, links or addresses, are at most 200 characters, and a steward's void takes the post down |
| A member | Withdraw and re-give applause to notify someone over and over | Giving it again edits the same post, which notifies nobody twice |
| Anyone | Starve a call of gas so a failed read looks like "removed" or "paid" | Minimum gas per entry point. A failed read changes nothing. |
| Anyone | Claim twice, or claim for more than the share | One claim per account per round. The amount is computed by the contract, never passed in. |
| A steward | Void a rival's applause | Not stopped. Voids are public, carry a reason, and work only until the review window ends. |
| A steward | Co-sign their own payout, or that of someone they applauded | Refused (`ERR_OWN_PAYOUT`, `ERR_CONFLICT`) |
| A ring of members | Split a payout across many accounts, each under the no-sign-off limit | The per-round `auto_round_cap`: past it, every payout waits for a steward |
| A fake DAO | Open a stage and lie in its answers, for example about returning bonds | A stage is keyed by the account that opened it, and its bonds live in its own account. Nothing is credited on a DAO's word, so its lies reach only its own stage and its own NEAR. |
| The deployer | Replace the code | Possible on testnet today: the deploy key is still on the account. A mainnet deployment must delete it. |

## Independent review

A separate AI agent reviewed the contract and the rules with a threat model and an instruction to break them, without being told the design's reasoning. It read the code against the Sputnik DAO 2.3.1 source and near-sdk 5.30.1 and executed nothing on chain. This is not a human or professional audit.

It found one critical and one high problem in the first version, both in how the contract accounted for proposal bonds, and a list of medium and low ones. Everything below was changed in version 1.1.0, which is what is deployed and what the live checks ran against.

| # | Finding | Severity | What changed |
|---|---|---|---|
| 1 | All stages' NEAR sat in one account, and bonds were credited back to a stage on the DAO's word. A DAO written to lie could take a bond, answer "not filed", be credited, and repeat until every stage's NEAR was gone. | Critical | Each stage now has its own account under the contract, created when the stage opens, with no keys. It pays its bonds from its own balance and the DAO returns them there, so nothing is credited on anyone's word, and a lying DAO can only spend its own stage's NEAR. A failed filing is undone only when the call really failed, which is when the runtime refunds the deposit. A DAO that takes the bond and gives no proposal number gets the claim marked `Unanswered`, and it is never filed again. |
| 2 | Sputnik returns its current bond, not the one attached, so a DAO that lowered its bond was over-credited. | High | Gone with 1: bonds are no longer credited anywhere. |
| 3 | A claim could stick in `Filing` if the callback could not pay for 8 more bytes. | Medium | A claim's proposal number is stored at full size from the start, so callbacks add no storage. Callbacks charge storage without ever panicking. The gas floor for `claim` rose to 110 Tgas, leaving the callback room to spare. |
| 4 | A vote Sputnik accepted was recorded as `Approved`, though the proposal may have needed more votes or have expired. | Medium | A vote is never taken as a sighting of `Approved`; only reading the proposal is. The contract stops voting 2 minutes before the DAO's voting period ends, and votes only when its role's single vote can pass a transfer. |
| 5 | Anyone could make the contract's one near.social account post their text and link, and one stage could use up the daily post limit for all. | Medium | Each stage posts from its own account, with its own limit. Stage links are gone from posts. Withdrawing and giving applause again edits the same post, so it cannot notify anyone twice. |
| 6 | The share cap and no-sign-off limits are per account, so payouts split across many accounts could all go through with no sign-off. | Medium | A new per-round cap, `auto_round_cap`, on what may be paid with no person signing at all. Past it, payouts wait for a steward. |
| 7 | A steward who applauded someone could co-sign that person's payout. | Medium | Refused (`ERR_CONFLICT`). |
| 8 | A bounced payout's bond stayed with the DAO, and could never be recovered. | Medium | Once a bounced proposal's period is over, `settle` finalizes it, and the DAO returns the bond to the stage's account. |
| 11 | A steward's pause did not stop a vote already in flight. | Low | The vote at filing is skipped while the stage is paused. |
| 12 | Notes could carry addresses without `https://`, break out of their quotation marks, or hide text with invisible characters. Any account's post could be quoted. | Low | Refused, each with its own error. A quote must be a post by the recipient or the giver. Stage names are plain words only. |
| 13 | Fixed gas could be too little for DAOs with large policies. | Low | `add_proposal` gets 20 Tgas and reading a proposal 15 Tgas, with room for a 64 KB answer. |
| 14 | A payout filed while its recipient was not yet trusted kept needing a co-signature. | Low | Calling `claim` again lets it through on its own once the recipient is trusted, within the round's cap. |
| 15 | Some rules were read live, so a DAO changing them moved a round already in play. | Low | Claps per member and the trust thresholds are now copied into each round with the money rules. |
| - | Anyone could initialise the contract between its deploy and its init. | Informational | Only the contract account itself can call `new`. |

Accepted as they are, and written into the README's limits:

- Finding 9: a payout counts as paid after the DAO's proposal reads as approved twice, 15 seconds apart. A transfer that fails later still would be recorded as paid. On testnet, a transfer to an account that does not exist failed within a few seconds, and was recorded as `Failed`.
- Finding 10: the member list is a copy of the DAO's roles, refreshed by `sync_members`. A member the DAO removes keeps their claps until someone calls it.
- Finding 7, the rest: a steward can strike out applause and pause the stage. Both are public, carry the steward's name, and the DAO can remove the steward.
- Finding 15, the rest: trust counts backers in the round still open, so a member can lend a recipient a backer for one filing. The member must be one the DAO admitted.
- A stage's state is never pruned.

## Before mainnet

- Delete the contract account's full-access key, or put upgrades behind a DAO.
- A professional audit. The review above was done by an AI agent.
- Run a stage that pays a NEP-141 token end to end, including a recipient who is not registered on the token.
- Run the expiry path against a DAO with a short proposal period.
- Prune finished rounds, or let a DAO buy back their storage.
- Wallet signing in the site, tested with real wallets.

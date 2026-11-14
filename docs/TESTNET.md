# Ovation on NEAR testnet

This file is written by `node scripts/evidence.mjs` from the recorded runs and from the chain. Run `node scripts/verify.mjs` to check the same things yourself, with no account.

Generated 2026-11-11 17:42 UTC.

## What is deployed

| Thing | Account | Notes |
|---|---|---|
| Contract | [`v1.ovation-hq.testnet`](https://testnet.nearblocks.io/address/v1.ovation-hq.testnet) | Code hash `8Zc3dZDvd5YUrrmmu8tqmAYBWEKbg8TzBtoZ2NTcjjQ1`. 1 full-access key still on the account, so the code can be replaced during the hackathon. |
| The demo stage's own account | [`lantern-guild-7796.v1.ovation-hq.testnet`](https://testnet.nearblocks.io/address/lantern-guild-7796.v1.ovation-hq.testnet) | Created by the contract when the stage opened. 0 access keys. Code hash `GKUz57qSinU5sXra9A4jKBzEzHH3tUAEpPycVqVGMEUD`, the 0.0151 NEAR it locks for storage included in its balance of 0.1271 NEAR, which pays the stage's bonds. |
| Demo DAO | [`lantern-guild.sputnikv2.testnet`](https://testnet.nearblocks.io/address/lantern-guild.sputnikv2.testnet) | Sputnik DAO 2.3.1, created through the `sputnikv2.testnet` factory. 62 proposals so far. |
| near.social data account | `social.testnet` | An account with no contract, like `social` on mainnet. |
| Demo people | `*.lantern-guild.testnet` | Council: asha, diego, mei. Members: noor, kofi, sana, leo. Not members: ravi, june. |
| Stages on the contract | 2 | `lantern-guild.sputnikv2.testnet`, `ovt-ovationjudge-ayw9r.sputnikv2.testnet` |

## The stage's power in the demo DAO

The contract itself holds no role in the DAO. The DAO's policy holds the stage's own account in one role, `ovation`, alone, with these permissions and nothing else:

- `transfer:AddProposal`
- `transfer:Finalize`
- `transfer:VoteApprove`

Its vote policy for transfers is `{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,1]}`: one vote from a one-account role passes. The council installed it with two ordinary proposals, each passed by two of three council votes.

## The demo stage's rules

| Rule | Value |
|---|---|
| Budget per round | 0.1 NEAR |
| Round, review, claim window | 120 s, 20 s, 7 days. Short on purpose, so a person can watch a round close. |
| Claps per member per round | 10 |
| Different members needed to be paid | 2 |
| Most one recipient can take | 50% of a round |
| No sign-off up to | 0.02 NEAR for anyone, 0.04 NEAR for a trusted recipient |
| One steward co-signs up to | 0.045 NEAR. Above it the council votes. |
| Trusted after | 2 paid rounds and 3 different backers |
| May applaud | 7 accounts in the DAO roles `council`, `members` |
| Stewards | asha, diego, mei, the DAO role `council` |

So far: 146 pieces of applause, 207 claps standing, 0.66219 NEAR paid in 25 payouts over 14 rounds.

## A post written by the stage's account

Read from the public index at `https://kv.test.fastnear.com`. Author (`predecessor_id`): `lantern-guild-7796.v1.ovation-hq.testnet`. Written to: `social.testnet`. Block 277237624.

```text
👏 @kofi.lantern-guild.testnet got 1 clap from @leo.lantern-guild.testnet at Lantern Guild.
“Clear write-up of the outage”
Round 10 of @lantern-guild.sputnikv2.testnet #ovation
```

## Live checks: 81 of 81 passed

`node scripts/e2e.mjs` ran on 2026-11-11 16:18 UTC against the deployed code, over rounds 10, 13, 15, 17 of the demo stage. Each row is one check. Where a transaction proves it, the result links to it.

| # | Check | Result | What was seen |
|---|---|---|---|
| 1 | the stage is open and the DAO's policy gives the contract exactly what it needs | pass | role ovation |
| 2 | the stage's own account exists, has no keys, and runs the 1.4 KB stage contract | pass | lantern-guild-7796.v1.ovation-hq.testnet, code GKUz57qSin... |
| 3 | only the Ovation contract can make the stage's account act | pass | a call from a council member is refused |
| 4 | the DAO role holding the stage's account has three transfer permissions and nothing else | pass | transfer:AddProposal transfer:Finalize transfer:VoteApprove |
| 5 | anyone can add NEAR to a stage's prepaid storage | [pass](https://testnet.nearblocks.io/txns/89zBD8Q3TwBBQsJMUwf6FBxVmd6UW1Ho4axk61WxRwcu) | +0.4 NEAR, now 0.8492 |
| 6 | nobody can applaud themselves | [pass](https://testnet.nearblocks.io/txns/CGT6V4cGmqcUGrqno14WLbsLuQUtv96idzk3ts5rdiAv) | ERR_SELF: you cannot applaud yourself |
| 7 | the DAO itself cannot be applauded | [pass](https://testnet.nearblocks.io/txns/DPU7PhA3n4C6SVN7tEpwiL8VeUfJ5eT1SfTmrUgmweaG) | ERR_RECIPIENT: the DAO and this contract cannot be applauded |
| 8 | a note cannot carry a link | [pass](https://testnet.nearblocks.io/txns/GJguffkqpanfesfS1zA3wxNAPBgSuiuW9bQbJFNQtvmL) | ERR_NOTE_LINK: a note cannot contain a link or a web address |
| 9 | more claps than the round's allowance are refused | [pass](https://testnet.nearblocks.io/txns/8ouxJXQcZJDWxafWrBpuTHM2Jpyoaax5uUr5miEyAEZq) | ERR_ALLOWANCE: not enough claps left this round |
| 10 | a quote must be a near.social post reference | [pass](https://testnet.nearblocks.io/txns/F9fTStNwZiFkY5YGikBE8yA5UD9PD9BEt7QMLWvJdgN7) | ERR_QUOTE: quote must be a near.social post, written account/post_id |
| 11 | someone outside the DAO's roles cannot applaud | [pass](https://testnet.nearblocks.io/txns/qTjbfU865rL1qnm4pDo8g24wFyy3avmpbvgTkrm3JbY) | ERR_NOT_A_MEMBER: only members of the stage's roles can applaud; call sync_members if the  |
| 12 | there is nothing to withdraw before applauding | [pass](https://testnet.nearblocks.io/txns/8g494CoLspx6rW1aWWs5qDuHaHVVgfnKsoC8Wj4xYE5M) | ERR_NOTHING: there is no applause to withdraw |
| 13 | a note cannot mention an account | [pass](https://testnet.nearblocks.io/txns/5RAhygvTcy8ryKRnjbGx26Aiv9uZ26RVsfPVqjxF11xf) | ERR_NOTE_MENTION: a note cannot contain @, because the post would notify that account |
| 14 | a note cannot break out of its quotation marks | [pass](https://testnet.nearblocks.io/txns/96cxJR3AEcHddktALhbw4JtSKyM9raamDRUJYyT8shdu) | ERR_NOTE_QUOTE: a note cannot contain double quotes; the post puts them around it |
| 15 | a note cannot point to a web address, even without https | [pass](https://testnet.nearblocks.io/txns/G552CagDU36vAvLMVPjaGPCmjX3YRHTnB4ZqjHmtynj1) | ERR_NOTE_LINK: a note cannot contain a link or a web address |
| 16 | applause can quote only a post by the recipient or the giver | [pass](https://testnet.nearblocks.io/txns/HHxMvwfHcRPyqXFKbjLXffQ7kThMnWhL9VaufS9wtPMh) | ERR_QUOTE: quote a post by the person you applaud, or your own |
| 17 | twelve pieces of applause are accepted, each for under 10 Tgas | [pass](https://testnet.nearblocks.io/txns/3TnarGhxCgwttMZNHXfPjVU5MHnSS5mXvMhuZEgLyvrN) | at most 7.55 Tgas |
| 18 | changing applause moves the score, and changing it back restores it exactly | pass | 49999960234225 -> 62298170340561 -> 49999960234225 |
| 19 | withdrawn applause leaves the tally, and giving it again brings it back | pass | 1 backer, then 2 |
| 20 | every score and amount equals (sum of square roots) squared, pro rata, capped | pass | ravi 0.05, june 0.02285, kofi 0.00571, asha 0 |
| 21 | a round's amounts never add up to more than its budget | pass | 0.07857 of 0.1 |
| 22 | breadth beats volume: ten claps from five members score ten times five claps from one | pass | 49999960234225 vs 4999995628489 |
| 23 | one recipient cannot take more than the share cap | pass | 0.05 |
| 24 | one backer is not enough: applause from a single member earns nothing | pass | 1 backer |
| 25 | a member who is not a steward cannot void applause | [pass](https://testnet.nearblocks.io/txns/9GrU1ZbnL9GyF1jx2sH2jvgJ2k2xRuVWWFPAWvEXJiJ7) | ERR_NOT_A_STEWARD: only members of the stage's steward roles can void applause |
| 26 | voiding needs a reason | [pass](https://testnet.nearblocks.io/txns/JAKWYoFQ2JfiXgkD3JkG8E8WFgQ5NVyyW4FNdZacoYyx) | ERR_REASON: say why this applause is struck out |
| 27 | a steward can strike out applause, and the reason and their name are public | [pass](https://testnet.nearblocks.io/txns/FR7gRcMBa2KM7r1QtG9KdgGz6kvHLWMxUQ9jkCBZqnfC) | Thanks for the council lead belongs in the next retro, not here |
| 28 | struck-out applause cannot be changed | [pass](https://testnet.nearblocks.io/txns/AhZLKBtD1xf3gUszrzpDKZ6mKXMdwXAJtdMYpeU9sx5M) | ERR_VOIDED: a steward struck out this applause; it cannot be changed this round |
| 29 | the claps of struck-out applause are not handed back | pass | 6 used |
| 30 | each applause is a near.social post whose author is the stage's own account | pass | 11 of 11 posts indexed at https://kv.test.fastnear.com |
| 31 | a post mentions the recipient and the giver, and carries the note | pass | 👏 @ravi.lantern-guild.testnet got 2 claps from @asha.lantern-guild.testnet at Lantern Guild. |
| 32 | applause for a near.social post by the recipient quotes that post | pass | june.lantern-guild.testnet/1759140000000 |
| 33 | voiding takes the post down | pass | tombstone written |
| 34 | a payout cannot be claimed while its round is open | [pass](https://testnet.nearblocks.io/txns/HxrrGBve2jGyPgLifu5YuVMcP8DorRsTRBdK6aYGvenY) | ERR_ROUND_OPEN: this round has not ended |
| 35 | a payout cannot be claimed during the review window | [pass](https://testnet.nearblocks.io/txns/2NsA9nSJUPWdrZXjLQsmZGTKb9acARaFxgXVX57chohr) | ERR_IN_REVIEW: claims open when the review window ends |
| 36 | voiding is over once the review window has ended | [pass](https://testnet.nearblocks.io/txns/5DC3rKp3s8KDaccc1USX8VMPbrALEDhiF981HDiPdsap) | ERR_TOO_LATE: applause can be voided only until the review window ends |
| 37 | an account with too few backers cannot claim | [pass](https://testnet.nearblocks.io/txns/C9FLvgs29VyYUusWQ9MG4eroBdUHEGxxjPTDs8rz1crr) | ERR_TOO_FEW_BACKERS: not enough different members applauded this account in this round |
| 38 | a claim without enough gas for the whole chain is refused up front | [pass](https://testnet.nearblocks.io/txns/t6nnUiGXfe4t4ynS6x3bnKmFo3C5aoE5WgAHLSpyZGa) | ERR_GAS: attach at least 110 Tgas |
| 39 | a small payout is filed and voted for in one call, for about 30 Tgas | [pass](https://testnet.nearblocks.io/txns/w2bfBpPPTy844VdCjg7XGSyCEYTcMceeTQsHkKkSL12) | 22.22 Tgas, proposal #34 |
| 40 | on the DAO it is an ordinary Transfer proposal, filed by the stage's account, whose vote is the only one | pass | {"lantern-guild-7796.v1.ovation-hq.testnet":"Approve"} |
| 41 | its description is in the form Trezu reads as a payment request | pass | * Title: Ovation round 10 for kofi.lantern-guild.testnet <br>* Summary |
| 42 | the same payout cannot be claimed twice | [pass](https://testnet.nearblocks.io/txns/B5BY57fWSjpX5BWD7CDNJ3xMfF2kdwi4GmwXshwQvZXf) | ERR_CLAIMED: this payout was already filed |
| 43 | a mid-size payout is filed and left unvoted | [pass](https://testnet.nearblocks.io/txns/EWe6jrTfDzwXYWPHHgsagGqc5DTRYNkLKopiDQLT2qz4) | 0.02285 NEAR |
| 44 | a member who is not a steward cannot co-sign | [pass](https://testnet.nearblocks.io/txns/3yPHuSqfPXU3kHQyTiVU4QvsN6ZQdpwomcparjmfqb4d) | ERR_NOT_A_STEWARD: only members of the stage's steward roles can co-sign |
| 45 | a steward who applauded the recipient this round cannot co-sign the payout | [pass](https://testnet.nearblocks.io/txns/61NFkzCGZUe6KabGy5tp49WQSPCp4StZxkauaiLhKa9k) | ERR_CONFLICT: a steward who applauded this account in this round cannot co-sign the payout |
| 46 | one steward's co-signature is enough: the stage's account then casts the only vote | [pass](https://testnet.nearblocks.io/txns/FXjPZFJTnWVBqurj9PNcryZjPSWw6j1UPzD7BJT3fUFk) | 14.72 Tgas |
| 47 | a large payout becomes a normal DAO proposal | [pass](https://testnet.nearblocks.io/txns/5aMUs3JvGS5t8if8dtsWrxfFgNxogVuqxFrXaMh3UtXa) | 0.05 NEAR, proposal #36 |
| 48 | a large payout cannot be co-signed through | [pass](https://testnet.nearblocks.io/txns/EdKy7GStbmUkm5dV9qgNmPuwpnmrQmfwm7xjj5Q7rEmE) | ERR_WRONG_TIER: only mid-size payouts take a co-signature |
| 49 | calling claim again does not make the contract vote on a council payout | [pass](https://testnet.nearblocks.io/txns/6hgMsXAqEzFoeFK72pbovBBWWsaYCyfJN49T1zqsXb5H) | ERR_CLAIMED: this payout was already filed and waits for its sign-off |
| 50 | the council passes it by its own votes, and the contract never votes on it | pass | asha + diego |
| 51 | first sight of an approved proposal does not yet count as paid | [pass](https://testnet.nearblocks.io/txns/Hop1RDbcjZmEcq4tXTsZmCN1RAcvdt2k1CB6ZRgi4cPF) | Approved |
| 52 | all three payouts settle as Paid once the DAO has shown them approved twice | [pass](https://testnet.nearblocks.io/txns/7xomw4DnP55CuWKYwgkViFd4hzbTkfan7vkkAzCycWC3) | kofi Paid, june Paid, ravi Paid |
| 53 | each recipient's balance rose by exactly the amount on the board | pass | kofi +0.00571, june +0.02285, ravi +0.05 |
| 54 | the money came out of the DAO's own account | pass | 6.37659 -> 6.29802, paid 0.07857 |
| 55 | the round's books match: filed equals paid equals what left the treasury | pass | 0.07857 |
| 56 | a settled payout has nothing left to settle | [pass](https://testnet.nearblocks.io/txns/2sSY2M6JenLQBrznQJ9sVAo31eETJpCiPWmMYrKYTWG9) | ERR_SETTLED: this payout has nothing left to settle |
| 57 | each payout is announced in a post by the contract | pass | 💸 @kofi.lantern-guild.testnet was paid 0.0057 NEAR by @lantern-guild.sputnikv2.testnet for applause from 2 me |
| 58 | a record is the sum of its lines: every clap traces to a member, a round and a note | pass | 13 claps over 10 lines |
| 59 | a member who is not a steward cannot pause the stage | [pass](https://testnet.nearblocks.io/txns/5qBVcbv5QPxGAG7R9xScHmr9tGg9QxkGvuNCgwDMmo2S) | ERR_NOT_A_STEWARD: only members of the stage's steward roles can pause it |
| 60 | a paused stage takes no applause | [pass](https://testnet.nearblocks.io/txns/Em7vmVC15LG7j7JsLRHvxfJc2ykxBL6rLCx5MpJbWkme) | ERR_PAUSED: a steward paused this stage; the DAO can resume it |
| 61 | a paused stage files no payouts | [pass](https://testnet.nearblocks.io/txns/HjyiGkksUmZ5ecYvmWcHoXKqd3o3bpciwfY4coAm2miM) | ERR_PAUSED: a steward paused this stage; the DAO can resume it |
| 62 | a steward cannot lift the pause: only the DAO can | [pass](https://testnet.nearblocks.io/txns/4SyVEUmyYqjUZ2zGu1v1xDsWPvqyxv8teALJGgaAMV89) | ERR_NO_STAGE: that DAO has not opened a stage |
| 63 | any one steward can pause the stage | [pass](https://testnet.nearblocks.io/txns/FnL8jbGQu3bAXMvSttqCcgXCYV2V1XvRCuDQVeJxvoLx) | by diego |
| 64 | the DAO resumes it with an ordinary proposal | [pass](https://testnet.nearblocks.io/txns/3dYFvtupReVvUZHmGYE2jpNvFRMXC6WDXtjUnrXNBmeE) | proposal #37 |
| 65 | kofi's second small payout is voted through without anyone signing | [pass](https://testnet.nearblocks.io/txns/6wFyHXKqNq9kdtuvRYV5pH6M7L7DGo5ZFWaeAXranWDb) | 22.22 Tgas |
| 66 | a payout the council votes down settles as Rejected, and nothing is paid | [pass](https://testnet.nearblocks.io/txns/KRgDKs8B5GPi4Co5o9vNmd49CKCEVMvJdFUAkz47p71) | proposal #39 |
| 67 | the DAO hands the proposal bond back to the stage's own account | pass | +0.01 NEAR |
| 68 | after two paid rounds and three different backers, kofi is trusted | [pass](https://testnet.nearblocks.io/txns/BaTgFPevtnpFd5QUR6BjMwNUzzWiFshTd31ovLpkMmA6) | 5 paid rounds, 6 backers |
| 69 | earned trust: the same amount is Auto for a trusted recipient and Cosign for a newcomer | pass | 0.03673 NEAR each: kofi Auto, diego Cosign |
| 70 | the trusted recipient's payout goes straight through, the newcomer's waits for a steward | [pass](https://testnet.nearblocks.io/txns/dwm6Zi4FkQwZ4fe4NyeipXM2DLnu9tB71m1LS5AnAPg) | kofi Voted, diego Filed |
| 71 | a steward cannot co-sign their own payout | [pass](https://testnet.nearblocks.io/txns/BfcNf6JfBqCM4pXA4urLVqdZX56ztKSzJQiRQrvjjdsQ) | ERR_OWN_PAYOUT: a steward cannot co-sign their own payout |
| 72 | a payout the council removes settles as Removed, proved by the DAO's own empty answer | [pass](https://testnet.nearblocks.io/txns/EPkE17of5Bia9jABf3iagYkUsLYyg5mbUnbgDaSgzJfu) | proposal #41 is gone |
| 73 | a transfer that bounces is never recorded as paid | [pass](https://testnet.nearblocks.io/txns/BD6sesYedJFNXQT24rtYnpLwjbVpZDiQXe9heTpiXZKu) | DAO proposal #42 is Failed |
| 74 | the trusted recipient's payout settles as Paid | [pass](https://testnet.nearblocks.io/txns/Bf6x91xeBbQ3JZPYRw6iX1ZXK6Ed78S7j9sPwuXn77i) |  |
| 75 | refused payouts leave the round's books: only live claims count as filed | pass | paid 0.03673, filed 0.04489 |
| 76 | a member can name 10 different people in a round and take every clap back | pass | 10 named, 0 claps in use |
| 77 | an eleventh person in the same round is refused, even with every clap free again | [pass](https://testnet.nearblocks.io/txns/85bZgRHJJD8zNc6PyF2fxjNXfwEwukS6FLfXmZeDzhmV) | ERR_TOO_MANY_PEOPLE: you have already applauded as many different people this round as you |
| 78 | applauding someone already named this round is still allowed | [pass](https://testnet.nearblocks.io/txns/Gws14ekQcTgp27ugpJqMCoGaFjatMNSpeXzrAE2agnnV) | 2 claps |
| 79 | only the DAO can change its stage | [pass](https://testnet.nearblocks.io/txns/BEVQcvLuwv3QNJMHHy4Rq3pVyp9wrBbRTy7xT9KJKMhE) | ERR_NO_STAGE: that DAO has not opened a stage |
| 80 | the stage lists every round that had applause | pass | 8 rounds |
| 81 | members never attach a deposit to applaud: storage is charged to the stage's prepaid balance | pass | 40 entries stored, 0.6067 NEAR left prepaid |

## A second DAO, installed from scratch by a fresh account

The output of `node scripts/try.mjs ovation-judge.testnet`, unedited. The account was new, held 6.95 test NEAR, and had no connection to the demo DAO. It created its own Sputnik DAO, installed Ovation with two proposals, and its outsider was paid.

```text
Ovation, on a DAO of your own
  you          ovation-judge.testnet
  contract     v1.ovation-hq.testnet
  your DAO     ovt-ovationjudge-ayw9r.sputnikv2.testnet

1. Three named accounts under yours
   ana.ovation-judge.testnet (a member) already there
   ben.ovation-judge.testnet (a member) already there
   cy.ovation-judge.testnet (not a member) already there

2. A Sputnik DAO with you as its council
   created https://testnet.nearblocks.io/txns/6zGY6yrQheb6NsGr3mZ3DKVJ396ULdQQ2gaUNXhrscZ
   sent 0.4 NEAR to its treasury https://testnet.nearblocks.io/txns/Dx4soKAFsmnHvYyur3SYLXup3AMnt7USZLWo3iixTPcB

3. You pass the two proposals that install Ovation
   proposal #0: role "ovation" holding only ovt-ovationjudge-ayw-2cd7.v1.ovation-hq.testnet, with transfer:AddProposal, transfer:VoteApprove, transfer:Finalize https://testnet.nearblocks.io/txns/7DujAt5ee4zLZyhwr2fj6Z5UqwangE59cNKpyAEbpKTu
   proposal #1: stage opened, 0.05 NEAR per one-minute round https://testnet.nearblocks.io/txns/CpVvJw2foot8gHw9iZsgNHtA4hUsatvRepvq38hNypaU
   your stage's own account ovt-ovationjudge-ayw-2cd7.v1.ovation-hq.testnet exists with 0.0471 NEAR for bonds and 0 access keys
   the contract read your DAO's policy: 3 may applaud (ana, ben, ovation-judge), and your stage's account can file and approve small transfers, and nothing else

4. Applause
   ovation-judge gave cy 1 clap: "Showed up every week" https://testnet.nearblocks.io/txns/4KTY4HbLsahd1sxHWN2UCQz2JFWiGENuPxAKbLsyxpaM
   ben gave cy 2 claps: "Wrote the docs everyone links to" https://testnet.nearblocks.io/txns/4ZefJVQb4fkRdDUjY6UDXmp4m1xVHRvW7a92WUYtfkCb
   ana gave cy 2 claps: "Fixed the build on a Sunday" https://testnet.nearblocks.io/txns/AjxXq6HxPHBpkVsdpRN3zEoXAzLjE2syU4ki3CGyYaeq
   ana tried to applaud themselves: ERR_SELF: you cannot applaud yourself
   round 0: cy has 5 claps from 3 members, worth 0.05 NEAR, sign-off: Auto

5. Your stage's posts
   author ovt-ovationjudge-ayw-2cd7.v1.ovation-hq.testnet, written to social.testnet:
     👏 @cy.ovation-judge.testnet got 1 clap from @ovation-judge.testnet at Try it.
     “Showed up every week”
     Round 0 of @ovt-ovationjudge-ayw9r.sputnikv2.testnet #ovation
   https://kv.test.fastnear.com/v0/latest/social.testnet/ovt-ovationjudge-ayw-2cd7.v1.ovation-hq.testnet/post%2F1794412707549

6. The round closes, and one call files the payout and votes for it
   waiting 41 s for round 0 to close
   claim returned "Voted" for 22.09 Tgas https://testnet.nearblocks.io/txns/J829iUsVkzvscPd1tmx3psuUjaomAcUkYiLkXZ4UKB7J
   on your DAO it is proposal #2, a Transfer of 0.05 NEAR to cy.ovation-judge.testnet
   votes on it: {"ovt-ovationjudge-ayw-2cd7.v1.ovation-hq.testnet":"Approve"}

7. Your DAO pays
   settle says: Approved https://testnet.nearblocks.io/txns/EMBPXwq2DDJkKvpLxtaARq1yNffTofGQZofx2MSzc53d
   settle says: Paid https://testnet.nearblocks.io/txns/27jSM4YsgS8imHJAS7AneHm1vvf4h4etJZQqC2R72yVE
   cy.ovation-judge.testnet held 0.2 NEAR and now holds 0.25: +0.05, exactly the amount on the board: true
   their record: 5 claps from 3 different members, paid in 1 round, trusted: true

Done. Look for yourself:
  your DAO      https://testnet.nearblocks.io/address/ovt-ovationjudge-ayw9r.sputnikv2.testnet
  your stage    https://testnet.nearblocks.io/address/ovt-ovationjudge-ayw-2cd7.v1.ovation-hq.testnet
  the recipient https://testnet.nearblocks.io/address/cy.ovation-judge.testnet
  the contract  https://testnet.nearblocks.io/address/v1.ovation-hq.testnet
To uninstall, pass one proposal of kind ChangePolicyRemoveRole with role "ovation".
```

## Not exercised on testnet

- A payout proposal that expires and is finalized by the stage's own account. The demo DAO's proposal period is 7 days. The rule is unit-tested in `contract/rules/src/claims.rs`.
- A stage that pays a NEP-141 token instead of NEAR.
- A vote that fails because the treasury cannot cover the payout, then succeeds on retry.
- near.social itself, which indexes mainnet only.

## Development notes

- The contract account's state was wiped twice during development, when its storage layout changed: once for stage numbers, and once for version 1.1.0, which gave each stage its own account after the security review. The wipe used methods that existed only in one-off builds; they are not in this repository or in the deployed code, and the second wipe deleted every stored key of the earlier versions. The DAO's own history keeps the proposals of those earlier runs.

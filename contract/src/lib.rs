//! Ovation: applause that pays, on Sputnik DAO.
//!
//! A DAO opens a "stage" with one proposal: a budget per round, which of its roles may
//! applaud, and how large a payout may go through without the council. Members then applaud
//! whoever did good work. When a round ends, breadth of applause splits that round's budget,
//! and each recipient claims their share as an ordinary Transfer proposal on the DAO.
//!
//! Each stage has its own account under this contract, for example
//! `lantern-guild-3fa9.v1.ovation-hq.testnet`, running the tiny contract in `../agent`. That
//! account, not this one, is what the DAO's role holds. It files the stage's payout
//! proposals, pays their bonds from its own balance and gets them back, casts the stage's
//! votes, and writes the stage's near.social posts. It has no keys: only this contract can make
//! it act. So the NEAR behind one stage is held apart from every other stage's, and a DAO that
//! lies in its answers can only ever spend its own.
//!
//! What this contract can and cannot do:
//!
//! - It never holds a DAO's money. Payouts are Transfer proposals that the DAO executes.
//! - A stage's power in its DAO is the role the council gives the stage's account, limited to
//!   transfers. It votes only on proposals it filed itself, and only when the size of the
//!   payout allows it.
//! - Who may applaud is whoever the DAO holds in the named roles, copied from the DAO's policy
//!   whenever anyone calls `sync_members`.
//! - It writes every applause and every payout to near.social as a post by the stage's
//!   account, because near.social attributes a write to the account that made the call.
//!
//! The rules themselves (scores, amounts, tiers, wording, policy reading, payout states) are
//! pure functions in the `ovation-rules` crate, each with unit tests. This file gathers facts
//! from storage, asks those functions, and stores or sends what they answer.

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use ovation_rules::claims::{self, Held, Step};
use ovation_rules::config::{check_config, ConfigFacts};
use ovation_rules::gates::{self, ApplaudFacts, ClaimFacts, CosignFacts, Tier, VoidFacts, VoteFacts};
use ovation_rules::math::{self, Tally};
use ovation_rules::policy::read_policy;
use ovation_rules::rounds::{self, Window};
use ovation_rules::text;

const VERSION: &str = "1.1.0";

/// The contract every stage's own account runs. Built from `../agent`; 1.4 KB.
const AGENT_WASM: &[u8] = include_bytes!("../agent/agent.wasm");

// Gas given to each cross-contract step. Measured on testnet: a claim that files a NEAR
// payout and votes on it burns about 25 Tgas in total.
const GAS_HOP: Gas = Gas::from_tgas(5);
const GAS_GET_POLICY: Gas = Gas::from_tgas(10);
const GAS_ON_POLICY: Gas = Gas::from_tgas(40);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(45);
const GAS_ON_VOTED: Gas = Gas::from_tgas(5);
/// Its own work, then possibly a vote through the stage's account and that vote's callback.
const GAS_ON_FILED: Gas = Gas::from_tgas(15 + 5 + 45 + 5);
const GAS_GET_PROPOSALS: Gas = Gas::from_tgas(15);
const GAS_FINALIZE: Gas = Gas::from_tgas(30);
const GAS_ON_FINALIZED: Gas = Gas::from_tgas(5);
/// Its own work, then either a post or a finalize, each through the stage's account.
const GAS_ON_SETTLE: Gas = Gas::from_tgas(15 + 5 + 30 + 5);
const GAS_ON_AGENT: Gas = Gas::from_tgas(15);

// A caller cannot starve a step of gas to make it look like the DAO said no: each entry
// point refuses to start without enough for the whole chain.
const MIN_GAS_SYNC: Gas = Gas::from_tgas(60);
const MIN_GAS_CLAIM: Gas = Gas::from_tgas(110);
const MIN_GAS_COSIGN: Gas = Gas::from_tgas(70);
const MIN_GAS_SETTLE: Gas = Gas::from_tgas(80);

const MAX_MEMBERS: usize = 300;
const MAX_POLICY_BYTES: usize = 200_000;
const MAX_PROPOSAL_BYTES: usize = 65_536;
/// near.social accepts 300 new posts per account per day. Each stage posts from its own
/// account and stays under that.
const DAILY_POSTS: u32 = 250;
const PAGE_MAX: u32 = 100;
const NS_PER_SEC: u64 = 1_000_000_000;
const NS_PER_MS: u64 = 1_000_000;
const DAY_MS: u64 = 86_400_000;
/// A stage keeps at least this much here for its own storage.
const MIN_STAGE_STORAGE: u128 = 50_000_000_000_000_000_000_000;
/// Until the DAO answers, a claim's proposal id holds this, so the record never grows later.
const NO_PROPOSAL: u64 = u64::MAX;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    StageNo,
    StageIds,
    Stages,
    Members,
    Rounds,
    Applause,
    RoundLog,
    Tallies,
    RoundRecipients,
    Spent,
    Pairs,
    Records,
    RecordLines,
    StageRounds,
}

/// What a DAO sets when it opens a stage. Amounts are in the smallest unit of the token.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StageConfig {
    /// Display name used in posts and proposal titles, for example "Lantern Guild".
    pub label: String,
    /// The token paid out. `null` pays NEAR. Cannot be changed later.
    pub token_id: Option<AccountId>,
    pub token_symbol: String,
    pub token_decimals: u8,
    /// The most a round can pay out in total.
    pub round_budget: U128,
    /// Length of a round. Cannot be changed later.
    pub round_secs: u32,
    /// After a round ends, how long stewards have to void applause before claims open.
    pub review_secs: u32,
    /// How long claims stay open after the review. Unclaimed money never leaves the treasury.
    pub claim_secs: u32,
    /// Claps each member may give per round.
    pub claps_per_round: u16,
    /// DAO roles whose members may applaud.
    pub clapper_roles: Vec<String>,
    /// DAO roles whose members may void applause, co-sign payouts and pause the stage.
    pub steward_roles: Vec<String>,
    /// How many different members must applaud someone before they can be paid.
    pub min_backers: u16,
    /// The largest share of a round's budget one recipient can take, in basis points.
    pub max_share_bps: u16,
    /// Amounts below this cannot be claimed.
    pub min_payout: U128,
    /// Up to this amount, anyone's payout is approved by the contract alone.
    pub auto_limit_new: U128,
    /// Up to this amount, a trusted recipient's payout is approved by the contract alone.
    pub auto_limit_trusted: U128,
    /// Up to this amount, one steward's co-signature is enough. Above it, the council votes.
    pub cosign_limit: U128,
    /// At most this much of a round is paid with no sign-off at all. Past it, payouts that
    /// would have gone through alone wait for a steward.
    pub auto_round_cap: U128,
    /// Paid rounds a recipient needs to count as trusted.
    pub trusted_after_rounds: u16,
    /// Different members who must have applauded a recipient, ever, to count as trusted.
    pub trusted_after_backers: u16,
    /// Publish each applause and payout as a near.social post.
    pub post_to_social: bool,
}

#[near(serializers = [borsh])]
pub struct Stage {
    config: StageConfig,
    /// The stage's own account: the one the DAO's role holds.
    agent: AccountId,
    created_ns: u64,
    paused: bool,
    paused_by: Option<AccountId>,
    /// NEAR prepaid for this stage's storage in this contract. Only deposits and storage this
    /// stage frees add to it. Bonds are paid from the stage's own account, never from here.
    storage_balance: u128,
    // Read from the DAO's policy at the last sync.
    synced_ns: u64,
    bond: u128,
    period_ns: u64,
    role: Option<String>,
    can_add: bool,
    can_approve: bool,
    can_finalize: bool,
    solo: bool,
    shared: bool,
    wide: bool,
    skipped_roles: Vec<String>,
    missing_roles: Vec<String>,
    // Running totals.
    /// Rounds that have had applause.
    rounds: u32,
    entries: u64,
    claps: u64,
    paid: u128,
    payouts: u32,
    // The stage account's near.social posts.
    last_post_id: u64,
    post_day: u64,
    posts_today: u32,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Members {
    /// Sorted, so membership is a binary search.
    clappers: Vec<AccountId>,
    stewards: Vec<AccountId>,
}

/// A round keeps a copy of the rules it started under, so a later change to the stage cannot
/// move the goalposts of a round already in play.
#[near(serializers = [borsh])]
pub struct Round {
    budget: u128,
    review_ns: u64,
    claim_ns: u64,
    claps_per_round: u16,
    min_backers: u16,
    max_share_bps: u16,
    min_payout: u128,
    auto_limit_new: u128,
    auto_limit_trusted: u128,
    cosign_limit: u128,
    auto_cap: u128,
    trusted_after_rounds: u16,
    trusted_after_backers: u16,
    /// Sum of the scores of every recipient with enough backers.
    eligible: u128,
    claps: u32,
    entries: u32,
    recipients: u32,
    voided: u32,
    /// Sum of the amounts of claims that are filed and not finally refused.
    filed: u128,
    /// The part of `filed` that needs no sign-off.
    auto_filed: u128,
    paid: u128,
    claims: u32,
}

#[near(serializers = [borsh])]
pub struct Applause {
    claps: u16,
    note: String,
    /// A near.social post this applause is for, as `account/post_id`.
    quote: Option<String>,
    /// Id of the stage's near.social post about this applause. 0 if none was written. Kept when
    /// the applause is withdrawn, so giving it again edits the same post and notifies nobody twice.
    post_id: u64,
    at_ns: u64,
    /// Set when a steward struck it out: who, why, and how many claps it had.
    struck: Option<(AccountId, String, u16)>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimState {
    /// add_proposal is in flight.
    Filing,
    /// On the DAO as a proposal. Not read as approved.
    Filed,
    /// act_proposal is in flight.
    Voting,
    /// Read as approved. Counts as paid once that has held for 15 seconds.
    Approved,
    /// Approved, and the transfer bounced. The DAO can retry it.
    Failed,
    Paid,
    Rejected,
    Expired,
    Removed,
    /// The DAO took the bond and did not answer with a proposal number. Nothing more is done
    /// with this payout, so it can never be filed twice.
    Unanswered,
}

impl ClaimState {
    fn as_str(&self) -> &'static str {
        match self {
            ClaimState::Filing => "Filing",
            ClaimState::Filed => "Filed",
            ClaimState::Voting => "Voting",
            ClaimState::Approved => "Approved",
            ClaimState::Failed => "Failed",
            ClaimState::Paid => "Paid",
            ClaimState::Rejected => "Rejected",
            ClaimState::Expired => "Expired",
            ClaimState::Removed => "Removed",
            ClaimState::Unanswered => "Unanswered",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Claim {
    amount: u128,
    /// 0 Auto, 1 Cosign, 2 Council.
    tier: u8,
    state: ClaimState,
    /// `NO_PROPOSAL` until the DAO answers.
    proposal_id: u64,
    /// The stage's account voted for it.
    voted: bool,
    filed_ns: u64,
    approved_ns: u64,
    cosigner: Option<AccountId>,
    backers: u16,
    claps: u32,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct RecipientRound {
    root_sum: u64,
    backers: u16,
    claps: u32,
    claim: Option<Claim>,
}

impl RecipientRound {
    fn tally(&self) -> Tally {
        Tally { root_sum: self.root_sum, backers: self.backers, claps: self.claps }
    }
    fn set(&mut self, t: Tally) {
        self.root_sum = t.root_sum;
        self.backers = t.backers;
        self.claps = t.claps;
    }
}

/// An account's standing in one DAO. `claps_received` and `lines` are exactly what
/// `list_record_lines` returns; `rounds_paid` and `paid` follow from the claims it lists.
#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Record {
    /// Different members who hold, or held until the round closed, applause for this account.
    backers: u32,
    rounds_applauded: u32,
    rounds_paid: u32,
    claps_received: u64,
    claps_given: u64,
    paid: u128,
    lines: u32,
}

// ---- What views return ----

#[near(serializers = [json])]
pub struct StageView {
    pub dao: AccountId,
    /// The stage's own account. The DAO's role must hold this one.
    pub agent: AccountId,
    pub config: StageConfig,
    pub created_ms: u64,
    pub round_now: u32,
    pub paused: bool,
    pub paused_by: Option<AccountId>,
    pub storage_balance: U128,
    pub synced_ms: u64,
    pub bond: U128,
    pub proposal_period_secs: u64,
    /// The DAO role that holds the stage's account.
    pub role: Option<String>,
    pub can_add: bool,
    pub can_approve: bool,
    pub can_finalize: bool,
    /// The stage account's single vote passes a transfer.
    pub solo: bool,
    /// Other accounts sit in the stage account's role.
    pub shared: bool,
    /// The role holds more than the three transfer permissions a stage needs.
    pub wide: bool,
    /// The DAO's policy lets the stage file a payout and pass a small one alone.
    pub ready: bool,
    pub skipped_roles: Vec<String>,
    pub missing_roles: Vec<String>,
    pub clappers: Vec<AccountId>,
    pub stewards: Vec<AccountId>,
    /// Rounds that have had applause. `list_rounds` pages through them.
    pub rounds: u32,
    pub entries: u64,
    pub claps: u64,
    pub paid: U128,
    pub payouts: u32,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub round: u32,
    /// False until someone applauds in it.
    pub exists: bool,
    pub phase: String,
    pub starts_ms: u64,
    pub ends_ms: u64,
    pub review_ends_ms: u64,
    pub claim_ends_ms: u64,
    pub budget: U128,
    pub eligible: U128,
    pub claps: u32,
    pub entries: u32,
    pub recipients: u32,
    pub voided: u32,
    pub filed: U128,
    pub auto_filed: U128,
    pub paid: U128,
    pub claims: u32,
    pub claps_per_round: u16,
    pub min_backers: u16,
    pub max_share_bps: u16,
    pub min_payout: U128,
    pub auto_limit_new: U128,
    pub auto_limit_trusted: U128,
    pub cosign_limit: U128,
    pub auto_cap: U128,
    pub trusted_after_rounds: u16,
    pub trusted_after_backers: u16,
}

#[near(serializers = [json])]
pub struct ApplauseView {
    pub round: u32,
    pub from: AccountId,
    pub to: AccountId,
    pub claps: u16,
    pub note: String,
    pub quote: Option<String>,
    /// The stage's near.social post about it, while the applause stands.
    pub post_id: Option<u64>,
    pub at_ms: u64,
    pub voided: bool,
    pub voided_by: Option<AccountId>,
    pub void_reason: Option<String>,
    pub voided_claps: u16,
}

#[near(serializers = [json])]
pub struct ClaimView {
    pub amount: U128,
    pub tier: String,
    pub state: String,
    pub proposal_id: Option<u64>,
    pub voted: bool,
    pub filed_ms: u64,
    pub approved_ms: u64,
    pub cosigner: Option<AccountId>,
}

#[near(serializers = [json])]
pub struct StandingView {
    pub account: AccountId,
    pub claps: u32,
    pub backers: u16,
    /// (sum of sqrt(claps per member))^2, scaled by 10^12.
    pub score: U128,
    pub eligible: bool,
    /// What this account could claim if the round froze now.
    pub amount: U128,
    pub trusted: bool,
    pub tier: String,
    pub claim: Option<ClaimView>,
}

#[near(serializers = [json])]
pub struct RecordView {
    pub account: AccountId,
    pub trusted: bool,
    pub backers: u32,
    pub rounds_applauded: u32,
    pub rounds_paid: u32,
    pub claps_received: u64,
    pub claps_given: u64,
    pub paid: U128,
    pub lines: u32,
    pub trusted_after_rounds: u16,
    pub trusted_after_backers: u16,
}

#[near(serializers = [json])]
pub struct MemberView {
    pub account: AccountId,
    pub is_clapper: bool,
    pub is_steward: bool,
    pub round: u32,
    pub claps_used: u32,
    pub claps_left: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ovation {
    /// The account near.social data is written to: `social` on mainnet.
    social: AccountId,
    /// Every stored key starts with a stage's number instead of its DAO's full account id,
    /// which keeps each record some thirty bytes smaller.
    stage_no: LookupMap<AccountId, u32>,
    /// The DAO of each stage, by stage number.
    stage_ids: Vector<AccountId>,
    stages: LookupMap<u32, Stage>,
    members: LookupMap<u32, Members>,
    /// (stage, round)
    rounds: LookupMap<(u32, u32), Round>,
    /// (stage, index) -> round number, in the order rounds first got applause.
    stage_rounds: LookupMap<(u32, u32), u32>,
    /// (stage, round, from, to)
    applause: LookupMap<(u32, u32, AccountId, AccountId), Applause>,
    /// (stage, round, index) -> (from, to), in the order applause first arrived.
    round_log: LookupMap<(u32, u32, u32), (AccountId, AccountId)>,
    /// (stage, round, to)
    tallies: LookupMap<(u32, u32, AccountId), RecipientRound>,
    /// (stage, round, index) -> recipient
    round_recipients: LookupMap<(u32, u32, u32), AccountId>,
    /// (stage, round, from) -> (claps used, different people applauded)
    spent: LookupMap<(u32, u32, AccountId), (u32, u32)>,
    /// (stage, from, to) -> rounds in which `from` holds applause for `to`
    pairs: LookupMap<(u32, AccountId, AccountId), u32>,
    /// (stage, account)
    records: LookupMap<(u32, AccountId), Record>,
    /// (stage, to, index) -> (round, from): every applause an account ever received.
    record_lines: LookupMap<(u32, AccountId, u32), (u32, AccountId)>,
}

fn fail(msg: &str) -> ! {
    env::panic_str(msg)
}

fn tier_from(code: u8) -> Tier {
    match code {
        0 => Tier::Auto,
        1 => Tier::Cosign,
        _ => Tier::Council,
    }
}

fn tier_code(t: Tier) -> u8 {
    match t {
        Tier::Auto => 0,
        Tier::Cosign => 1,
        Tier::Council => 2,
    }
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "ovation", "version": VERSION, "event": event, "data": [data] })
    ));
}

fn check(cfg: &StageConfig) {
    let facts = ConfigFacts {
        round_budget: cfg.round_budget.0,
        min_payout: cfg.min_payout.0,
        auto_limit_new: cfg.auto_limit_new.0,
        auto_limit_trusted: cfg.auto_limit_trusted.0,
        cosign_limit: cfg.cosign_limit.0,
        auto_round_cap: cfg.auto_round_cap.0,
        round_secs: cfg.round_secs,
        review_secs: cfg.review_secs,
        claim_secs: cfg.claim_secs,
        claps_per_round: cfg.claps_per_round,
        min_backers: cfg.min_backers,
        max_share_bps: cfg.max_share_bps,
        clapper_roles: &cfg.clapper_roles,
        steward_roles: &cfg.steward_roles,
        label: &cfg.label,
        token_symbol: &cfg.token_symbol,
        token_decimals: cfg.token_decimals,
    };
    if let Err(e) = check_config(&facts) {
        fail(&e);
    }
    if cfg.token_id.is_none() && (cfg.token_symbol != "NEAR" || cfg.token_decimals != 24) {
        fail("ERR_CONFIG: a stage that pays NEAR must use symbol NEAR and 24 decimals");
    }
}

/// The Transfer kind exactly as Sputnik expects it, for both add_proposal and act_proposal.
fn transfer_kind(cfg: &StageConfig, to: &AccountId, amount: u128) -> Value {
    json!({
        "Transfer": {
            "token_id": cfg.token_id.as_ref().map(|t| t.as_str()).unwrap_or(""),
            "receiver_id": to,
            "amount": amount.to_string(),
            "msg": null,
        }
    })
}

/// What a stage's account needs for itself: its code and the account record.
fn agent_storage_cost() -> u128 {
    (AGENT_WASM.len() as u128 + 300) * env::storage_byte_cost().as_yoctonear()
}

/// The packed arguments of the stage account's `call` method.
fn pack_call(receiver: &str, method: &str, deposit: u128, gas: Gas, args: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(36 + receiver.len() + method.len() + args.len());
    v.extend_from_slice(&(receiver.len() as u32).to_le_bytes());
    v.extend_from_slice(receiver.as_bytes());
    v.extend_from_slice(&(method.len() as u32).to_le_bytes());
    v.extend_from_slice(method.as_bytes());
    v.extend_from_slice(&deposit.to_le_bytes());
    v.extend_from_slice(&gas.as_gas().to_le_bytes());
    v.extend_from_slice(args);
    v
}

fn new_round(cfg: &StageConfig) -> Round {
    Round {
        budget: cfg.round_budget.0,
        review_ns: cfg.review_secs as u64 * NS_PER_SEC,
        claim_ns: cfg.claim_secs as u64 * NS_PER_SEC,
        claps_per_round: cfg.claps_per_round,
        min_backers: cfg.min_backers,
        max_share_bps: cfg.max_share_bps,
        min_payout: cfg.min_payout.0,
        auto_limit_new: cfg.auto_limit_new.0,
        auto_limit_trusted: cfg.auto_limit_trusted.0,
        cosign_limit: cfg.cosign_limit.0,
        auto_cap: cfg.auto_round_cap.0,
        trusted_after_rounds: cfg.trusted_after_rounds,
        trusted_after_backers: cfg.trusted_after_backers,
        eligible: 0,
        claps: 0,
        entries: 0,
        recipients: 0,
        voided: 0,
        filed: 0,
        auto_filed: 0,
        paid: 0,
        claims: 0,
    }
}

/// Take a claim's amount back out of a round's books, when the DAO finally refuses it.
fn release(r: &mut Round, c: &Claim) {
    r.filed -= c.amount;
    if tier_from(c.tier) == Tier::Auto {
        r.auto_filed = r.auto_filed.saturating_sub(c.amount);
    }
}

#[near]
impl Ovation {
    /// `social` is the account near.social data is written to: `social` on mainnet,
    /// `social.testnet` on testnet. Only this account itself can initialise the contract, so
    /// nobody can get in between the deploy and the init.
    #[init]
    pub fn new(social: AccountId) -> Self {
        require!(env::predecessor_account_id() == env::current_account_id(), "ERR_INIT: only the contract account can initialise it");
        Self {
            social,
            stage_no: LookupMap::new(Key::StageNo),
            stage_ids: Vector::new(Key::StageIds),
            stages: LookupMap::new(Key::Stages),
            members: LookupMap::new(Key::Members),
            rounds: LookupMap::new(Key::Rounds),
            stage_rounds: LookupMap::new(Key::StageRounds),
            applause: LookupMap::new(Key::Applause),
            round_log: LookupMap::new(Key::RoundLog),
            tallies: LookupMap::new(Key::Tallies),
            round_recipients: LookupMap::new(Key::RoundRecipients),
            spent: LookupMap::new(Key::Spent),
            pairs: LookupMap::new(Key::Pairs),
            records: LookupMap::new(Key::Records),
            record_lines: LookupMap::new(Key::RecordLines),
        }
    }

    // ------------------------------------------------------------------
    // Called by a DAO, through a FunctionCall proposal its council passed
    // ------------------------------------------------------------------

    /// Open a stage for the calling DAO and create the stage's own account.
    ///
    /// Of the attached deposit, `bonds` goes to the stage's account to pay the bonds of its
    /// payout proposals, a little more pays for that account's own storage, and the rest stays
    /// here for the stage's storage. Reads the DAO's policy straight away.
    #[payable]
    pub fn open_stage(&mut self, config: StageConfig, bonds: U128) -> Promise {
        let dao = env::predecessor_account_id();
        require!(self.stage_no.get(&dao).is_none(), "ERR_EXISTS: this DAO already has a stage; use update_stage");
        check(&config);
        let agent = self.agent_for(dao.clone());
        let to_agent = bonds.0 + agent_storage_cost();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= to_agent + MIN_STAGE_STORAGE,
            "ERR_DEPOSIT: attach the bonds, the stage account's storage and at least 0.05 NEAR for the stage's storage"
        );
        let before = env::storage_usage();
        let no = self.stage_ids.len() as u32;
        let mut stage = Stage {
            config,
            agent: agent.clone(),
            created_ns: env::block_timestamp(),
            paused: false,
            paused_by: None,
            storage_balance: deposit - to_agent,
            synced_ns: 0,
            bond: 0,
            period_ns: 0,
            role: None,
            can_add: false,
            can_approve: false,
            can_finalize: false,
            solo: false,
            shared: false,
            wide: false,
            skipped_roles: vec![],
            missing_roles: vec![],
            rounds: 0,
            entries: 0,
            claps: 0,
            paid: 0,
            payouts: 0,
            last_post_id: 0,
            post_day: 0,
            posts_today: 0,
        };
        self.stage_no.insert(&dao, &no);
        self.stage_ids.push(&dao);
        self.members.insert(&no, &Members::default());
        self.save_stage(no, &mut stage, before);
        emit(
            "stage_opened",
            json!({ "dao": dao, "agent": agent, "label": stage.config.label, "round_budget": stage.config.round_budget, "bonds": bonds }),
        );
        Promise::new(agent)
            .create_account()
            .transfer(NearToken::from_yoctonear(to_agent))
            .deploy_contract(AGENT_WASM.to_vec())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_AGENT).on_agent(dao.clone(), U128(to_agent)))
            .detach();
        self.read_policy_of(dao)
    }

    /// Change the stage's rules. The round length and the token cannot change. Rounds that
    /// already have applause keep the rules they started under.
    pub fn update_stage(&mut self, config: StageConfig) -> Promise {
        let dao = env::predecessor_account_id();
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        check(&config);
        require!(config.round_secs == stage.config.round_secs, "ERR_FIXED: round_secs cannot change");
        require!(
            config.token_id == stage.config.token_id && config.token_decimals == stage.config.token_decimals,
            "ERR_FIXED: the token cannot change"
        );
        stage.config = config;
        self.save_stage(no, &mut stage, before);
        self.post_profile(&stage, &dao);
        emit("stage_updated", json!({ "dao": dao }));
        self.read_policy_of(dao)
    }

    /// Lift a steward's pause. Only the DAO itself can, so it takes a council vote.
    pub fn resume_stage(&mut self) {
        let dao = env::predecessor_account_id();
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        require!(stage.paused, "ERR_NOT_PAUSED: the stage is not paused");
        stage.paused = false;
        stage.paused_by = None;
        self.save_stage(no, &mut stage, before);
        emit("stage_resumed", json!({ "dao": dao }));
    }

    /// Take back NEAR prepaid here for storage that the stage is not using.
    pub fn withdraw_storage(&mut self, amount: U128) -> Promise {
        let dao = env::predecessor_account_id();
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        require!(amount.0 > 0 && amount.0 <= stage.storage_balance, "ERR_AMOUNT: more than the stage has prepaid");
        stage.storage_balance -= amount.0;
        self.save_stage(no, &mut stage, before);
        Promise::new(dao).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Take NEAR back from the stage's own account, for example bonds the DAO has returned.
    /// The account keeps what its own storage needs.
    pub fn withdraw_bonds(&mut self, amount: U128) -> Promise {
        let dao = env::predecessor_account_id();
        let (_, stage) = self.stage(&dao);
        require!(amount.0 > 0, "ERR_AMOUNT: say how much");
        let mut args = Vec::with_capacity(24 + dao.len());
        args.extend_from_slice(&(dao.len() as u32).to_le_bytes());
        args.extend_from_slice(dao.as_bytes());
        args.extend_from_slice(&amount.0.to_le_bytes());
        Promise::new(stage.agent).function_call("send", args, NearToken::from_yoctonear(0), GAS_HOP)
    }

    // ------------------------------------------------------------------
    // Called by anyone
    // ------------------------------------------------------------------

    /// Add NEAR to a stage's prepaid storage here. Members never pay to applaud. To add NEAR
    /// for bonds, send it to the stage's own account instead.
    #[payable]
    pub fn fund_stage(&mut self, dao: AccountId) -> U128 {
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        stage.storage_balance += env::attached_deposit().as_yoctonear();
        self.save_stage(no, &mut stage, before);
        U128(stage.storage_balance)
    }

    /// Re-read the DAO's policy: who is in the stage's roles, the proposal bond and period,
    /// and what the DAO lets the stage's account do. Call it after the DAO changes its members.
    pub fn sync_members(&mut self, dao: AccountId) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_SYNC, "ERR_GAS: attach at least 60 Tgas");
        let _ = self.stage(&dao);
        self.read_policy_of(dao)
    }

    /// File the payout an account earned in a finished round, as a Transfer proposal on the
    /// DAO. A small payout is voted for in the same call. Anyone may call it for anyone: the
    /// money can only go to the account that earned it.
    ///
    /// Calling it again for a payout already on the DAO casts the stage's vote if that vote is
    /// still owed: the vote at filing did not land, or a payout waiting for a co-signature no
    /// longer needs one because its recipient has earned trust since.
    pub fn claim(&mut self, dao: AccountId, round: u32, account: Option<AccountId>) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_CLAIM, "ERR_GAS: attach at least 110 Tgas");
        let account = account.unwrap_or_else(env::predecessor_account_id);
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        let rkey = (no, round);
        let mut r = self.rounds.get(&rkey).unwrap_or_else(|| fail("ERR_NO_APPLAUSE: nobody was applauded in that round"));
        let tkey = (no, round, account.clone());
        let mut tally = self.tallies.get(&tkey).unwrap_or_else(|| fail("ERR_NO_APPLAUSE: that account was not applauded in that round"));
        let now = env::block_timestamp();
        let record = self.records.get(&(no, account.clone())).unwrap_or_default();
        let trusted = gates::is_trusted(record.rounds_paid, record.backers, r.trusted_after_rounds, r.trusted_after_backers);

        if let Some(mut c) = tally.claim.clone() {
            let waiting = c.state == ClaimState::Filed && !c.voted;
            if waiting && tier_from(c.tier) == Tier::Cosign && c.cosigner.is_none() {
                let left = r.auto_cap.saturating_sub(r.auto_filed);
                if gates::tier_capped(c.amount, trusted, r.auto_limit_new, r.auto_limit_trusted, r.cosign_limit, left) == Tier::Auto {
                    c.tier = tier_code(Tier::Auto);
                    r.auto_filed += c.amount;
                    emit("claim_upgraded", json!({ "dao": dao, "round": round, "account": account, "tier": "Auto" }));
                }
            }
            let facts = VoteFacts {
                paused: stage.paused,
                waiting,
                signed_off: tier_from(c.tier) == Tier::Auto || c.cosigner.is_some(),
                expired: claims::vote_expired(c.filed_ns, stage.period_ns, now),
                can_vote: stage.can_approve && stage.solo,
            };
            if let Err(e) = gates::vote_gate(&facts) {
                fail(e);
            }
            c.state = ClaimState::Voting;
            tally.claim = Some(c.clone());
            self.tallies.insert(&tkey, &tally);
            self.rounds.insert(&rkey, &r);
            self.save_stage(no, &mut stage, before);
            return self.vote(&stage, &dao, round, &account, &c);
        }

        let part = math::eligible_part(&tally.tally(), r.min_backers);
        let amount = math::payout(r.budget, part, r.eligible, r.max_share_bps);
        let w = self.window(&stage, &r, round);
        let facts = ClaimFacts {
            paused: stage.paused,
            phase: rounds::phase(now, &w),
            already_claimed: false,
            backers: tally.backers,
            min_backers: r.min_backers,
            amount,
            min_payout: r.min_payout,
            filed: r.filed,
            budget: r.budget,
            synced: stage.synced_ns > 0,
            can_file: stage.can_add,
        };
        if let Err(e) = gates::claim_gate(&facts) {
            fail(e);
        }
        let left = r.auto_cap.saturating_sub(r.auto_filed);
        let tier = gates::tier_capped(amount, trusted, r.auto_limit_new, r.auto_limit_trusted, r.cosign_limit, left);
        tally.claim = Some(Claim {
            amount,
            tier: tier_code(tier),
            state: ClaimState::Filing,
            proposal_id: NO_PROPOSAL,
            voted: false,
            filed_ns: now,
            approved_ns: 0,
            cosigner: None,
            backers: tally.backers,
            claps: tally.claps,
        });
        r.filed += amount;
        if tier == Tier::Auto {
            r.auto_filed += amount;
        }
        r.claims += 1;
        self.tallies.insert(&tkey, &tally);
        self.rounds.insert(&rkey, &r);
        self.save_stage(no, &mut stage, before);

        let description = text::payout_description(&text::PayoutLine {
            to: account.as_str(),
            amount,
            decimals: stage.config.token_decimals,
            symbol: &stage.config.token_symbol,
            backers: tally.backers,
            claps: tally.claps,
            label: &stage.config.label,
            round,
            tier: tier.as_str(),
        });
        let args = json!({
            "proposal": { "description": description, "kind": transfer_kind(&stage.config, &account, amount) }
        });
        self.agent_call(&stage, &dao, "add_proposal", args.to_string().as_bytes(), stage.bond, GAS_ADD_PROPOSAL)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_FILED).on_filed(dao, round, account))
    }

    /// Look at the DAO's proposal for a payout and record what happened to it. Anyone may
    /// call it. A payout counts as paid only after the DAO's proposal has been read as
    /// approved twice, at least 15 seconds apart, because Sputnik marks a proposal approved
    /// before the transfer has run.
    pub fn settle(&mut self, dao: AccountId, round: u32, account: AccountId) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_SETTLE, "ERR_GAS: attach at least 80 Tgas");
        let (no, _) = self.stage(&dao);
        let tally = self
            .tallies
            .get(&(no, round, account.clone()))
            .unwrap_or_else(|| fail("ERR_NO_CLAIM: nothing was filed for that account in that round"));
        let claim = tally.claim.unwrap_or_else(|| fail("ERR_NO_CLAIM: nothing was filed for that account in that round"));
        require!(
            matches!(claim.state, ClaimState::Filed | ClaimState::Voting | ClaimState::Approved | ClaimState::Failed),
            "ERR_SETTLED: this payout has nothing left to settle"
        );
        require!(claim.proposal_id != NO_PROPOSAL, "ERR_NO_PROPOSAL: the payout has no proposal yet");
        Promise::new(dao.clone())
            .function_call(
                "get_proposals",
                json!({ "from_index": claim.proposal_id, "limit": 1 }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_GET_PROPOSALS,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_SETTLE).on_settle(dao, round, account))
    }

    // ------------------------------------------------------------------
    // Called by members of the DAO's roles
    // ------------------------------------------------------------------

    /// Applaud someone's work in the round that is open now.
    ///
    /// Sets the number of claps the caller holds on `to` for this round: call it again to
    /// change it, or with 0 to take it back. `note` says what the applause is for. `quote`
    /// can name a near.social post (`account/post_id`) by the recipient or the giver that
    /// shows the work.
    pub fn applaud(&mut self, dao: AccountId, to: AccountId, claps: u16, note: Option<String>, quote: Option<String>) -> ApplauseView {
        let before = env::storage_usage();
        let from = env::predecessor_account_id();
        let (no, mut stage) = self.stage(&dao);
        let members = self.members.get(&no).unwrap_or_default();
        let now = env::block_timestamp();
        let round = rounds::round_at(stage.created_ns, stage.config.round_secs as u64 * NS_PER_SEC, now);
        let rkey = (no, round);
        let stored = self.rounds.get(&rkey);
        let allowance = stored.as_ref().map(|r| r.claps_per_round).unwrap_or(stage.config.claps_per_round) as u32;
        let akey = (no, round, from.clone(), to.clone());
        let existing = self.applause.get(&akey);
        let skey = (no, round, from.clone());
        let (spent, people) = self.spent.get(&skey).unwrap_or((0, 0));
        let old = existing.as_ref().map(|a| a.claps as u32).unwrap_or(0);
        let new = claps as u32;

        let facts = ApplaudFacts {
            paused: stage.paused,
            is_clapper: members.clappers.binary_search(&from).is_ok(),
            to_self: to == from,
            to_system: to == dao || to == env::current_account_id() || to == stage.agent,
            claps: new,
            old_claps: old,
            voided: existing.as_ref().map(|a| a.struck.is_some()).unwrap_or(false),
            new_entry: existing.is_none(),
            spent,
            allowance,
            people,
        };
        if let Err(e) = gates::applaud_gate(&facts) {
            fail(e);
        }
        let note = text::clean_note(&note.unwrap_or_default(), text::NOTE_MAX_CHARS).unwrap_or_else(|e| fail(e));
        if let Some(q) = &quote {
            require!(text::valid_post_ref(q), "ERR_QUOTE: quote must be a near.social post, written account/post_id");
            let author = text::post_author(q).unwrap_or("");
            require!(author == to.as_str() || author == from.as_str(), "ERR_QUOTE: quote a post by the person you applaud, or your own");
        }

        // The round is created by its first applause, with a copy of today's rules.
        if stored.is_none() {
            self.stage_rounds.insert(&(no, stage.rounds), &round);
            stage.rounds += 1;
        }
        let mut r = stored.unwrap_or_else(|| new_round(&stage.config));

        let reckey = (no, to.clone());
        let mut record = self.records.get(&reckey).unwrap_or_default();
        let tkey = (no, round, to.clone());
        let mut tally = match self.tallies.get(&tkey) {
            Some(t) => t,
            None => {
                self.round_recipients.insert(&(no, round, r.recipients), &to);
                r.recipients += 1;
                record.rounds_applauded += 1;
                RecipientRound::default()
            }
        };

        self.retally(&mut r, &mut tally, old, new);
        self.spent.insert(&skey, &(spent - old + new, people + existing.is_none() as u32));
        self.move_pair(no, &from, &to, old, new, &mut record);
        record.claps_received = record.claps_received + new as u64 - old as u64;

        let mut entry = match existing {
            Some(a) => a,
            None => {
                self.round_log.insert(&(no, round, r.entries), &(from.clone(), to.clone()));
                r.entries += 1;
                self.record_lines.insert(&(no, to.clone(), record.lines), &(round, from.clone()));
                record.lines += 1;
                stage.entries += 1;
                Applause { claps: 0, note: String::new(), quote: None, post_id: 0, at_ns: now, struck: None }
            }
        };
        entry.claps = claps;
        entry.note = note;
        entry.quote = quote;
        entry.at_ns = now;
        stage.claps = stage.claps + new as u64 - old as u64;

        if stage.config.post_to_social {
            if new > 0 {
                if entry.post_id == 0 && self.may_post(&mut stage) {
                    entry.post_id = Self::next_post_id(&mut stage);
                }
                if entry.post_id != 0 {
                    let mut post = json!({
                        "text": text::applause_post(&text::ApplauseLine {
                            to: to.as_str(),
                            from: from.as_str(),
                            claps: new,
                            note: &entry.note,
                            label: &stage.config.label,
                            dao: dao.as_str(),
                            round,
                        })
                    });
                    if let Some(q) = &entry.quote {
                        post["quote"] = json!(q);
                    }
                    self.post(&stage, format!("post/{}", entry.post_id), post);
                }
            } else if entry.post_id != 0 {
                self.post(&stage, format!("post/{}", entry.post_id), Value::Null);
            }
        }

        self.applause.insert(&akey, &entry);
        self.tallies.insert(&tkey, &tally);
        self.rounds.insert(&rkey, &r);
        self.records.insert(&reckey, &record);
        let fkey = (no, from.clone());
        let mut giver = self.records.get(&fkey).unwrap_or_default();
        giver.claps_given = giver.claps_given + new as u64 - old as u64;
        self.records.insert(&fkey, &giver);
        self.save_stage(no, &mut stage, before);

        emit(
            "applause",
            json!({ "dao": dao, "round": round, "from": from, "to": to, "claps": claps, "note": entry.note, "post_id": entry.post_id }),
        );
        applause_view(round, from, to, &entry)
    }

    /// Strike out an applause, during its round or the review window after it. The claps are
    /// not returned to the member who gave them. The reason is public.
    pub fn void_applause(&mut self, dao: AccountId, round: u32, from: AccountId, to: AccountId, reason: String) {
        let before = env::storage_usage();
        let steward = env::predecessor_account_id();
        let (no, mut stage) = self.stage(&dao);
        let members = self.members.get(&no).unwrap_or_default();
        let rkey = (no, round);
        let mut r = self.rounds.get(&rkey).unwrap_or_else(|| fail("ERR_NO_APPLAUSE: there is no such applause in this round"));
        let akey = (no, round, from.clone(), to.clone());
        let existing = self.applause.get(&akey);
        let w = self.window(&stage, &r, round);
        let facts = VoidFacts {
            is_steward: members.stewards.binary_search(&steward).is_ok(),
            phase: rounds::phase(env::block_timestamp(), &w),
            exists: existing.is_some(),
            voided: existing.as_ref().map(|a| a.struck.is_some()).unwrap_or(false),
            claps: existing.as_ref().map(|a| a.claps as u32).unwrap_or(0),
        };
        if let Err(e) = gates::void_gate(&facts) {
            fail(e);
        }
        let reason = text::clean_note(&reason, text::REASON_MAX_CHARS).unwrap_or_else(|e| fail(e));
        require!(!reason.is_empty(), "ERR_REASON: say why this applause is struck out");
        let mut entry = existing.unwrap();
        let old = entry.claps as u32;

        let tkey = (no, round, to.clone());
        let mut tally = self.tallies.get(&tkey).unwrap();
        self.retally(&mut r, &mut tally, old, 0);
        r.voided += 1;
        let reckey = (no, to.clone());
        let mut record = self.records.get(&reckey).unwrap_or_default();
        self.move_pair(no, &from, &to, old, 0, &mut record);
        record.claps_received -= old as u64;
        stage.claps -= old as u64;

        if entry.post_id != 0 {
            self.post(&stage, format!("post/{}", entry.post_id), Value::Null);
        }
        entry.struck = Some((steward.clone(), reason.clone(), entry.claps));
        entry.claps = 0;

        self.applause.insert(&akey, &entry);
        self.tallies.insert(&tkey, &tally);
        self.rounds.insert(&rkey, &r);
        self.records.insert(&reckey, &record);
        self.save_stage(no, &mut stage, before);
        emit(
            "applause_voided",
            json!({ "dao": dao, "round": round, "from": from, "to": to, "claps": old, "by": steward, "reason": reason }),
        );
    }

    /// Co-sign a mid-size payout. One steward is enough. It cannot be the recipient, or a
    /// steward who applauded the recipient in that round. The stage's account then votes.
    pub fn cosign(&mut self, dao: AccountId, round: u32, account: AccountId) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_COSIGN, "ERR_GAS: attach at least 70 Tgas");
        let before = env::storage_usage();
        let steward = env::predecessor_account_id();
        let (no, mut stage) = self.stage(&dao);
        let members = self.members.get(&no).unwrap_or_default();
        let tkey = (no, round, account.clone());
        let mut tally = self.tallies.get(&tkey).unwrap_or_else(|| fail("ERR_NO_CLAIM: nothing was filed for that account in that round"));
        let mut claim = tally.claim.clone().unwrap_or_else(|| fail("ERR_NO_CLAIM: nothing was filed for that account in that round"));
        let facts = CosignFacts {
            paused: stage.paused,
            is_steward: members.stewards.binary_search(&steward).is_ok(),
            is_recipient: steward == account,
            applauded: self.applause.get(&(no, round, steward.clone(), account.clone())).is_some(),
            tier: tier_from(claim.tier),
            waiting: claim.state == ClaimState::Filed && !claim.voted && claim.cosigner.is_none(),
            expired: claims::vote_expired(claim.filed_ns, stage.period_ns, env::block_timestamp()),
            can_vote: stage.can_approve && stage.solo,
        };
        if let Err(e) = gates::cosign_gate(&facts) {
            fail(e);
        }
        claim.cosigner = Some(steward.clone());
        claim.state = ClaimState::Voting;
        tally.claim = Some(claim.clone());
        self.tallies.insert(&tkey, &tally);
        self.save_stage(no, &mut stage, before);
        emit("claim_cosigned", json!({ "dao": dao, "round": round, "account": account, "by": steward }));
        self.vote(&stage, &dao, round, &account, &claim)
    }

    /// Stop applause, claims and co-signing on a stage. Any steward can. Only the DAO can
    /// resume it.
    pub fn pause_stage(&mut self, dao: AccountId) {
        let before = env::storage_usage();
        let steward = env::predecessor_account_id();
        let (no, mut stage) = self.stage(&dao);
        let members = self.members.get(&no).unwrap_or_default();
        require!(
            members.stewards.binary_search(&steward).is_ok(),
            "ERR_NOT_A_STEWARD: only members of the stage's steward roles can pause it"
        );
        require!(!stage.paused, "ERR_PAUSED: already paused");
        stage.paused = true;
        stage.paused_by = Some(steward.clone());
        self.save_stage(no, &mut stage, before);
        emit("stage_paused", json!({ "dao": dao, "by": steward }));
    }

    // ------------------------------------------------------------------
    // Callbacks
    // ------------------------------------------------------------------

    /// The stage's account has been created, or could not be.
    #[private]
    pub fn on_agent(&mut self, dao: AccountId, amount: U128) -> bool {
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        let created = near_sdk::is_promise_success();
        if !created {
            // The runtime sent the NEAR back to this contract when the creation failed, so it
            // goes back to the stage. If an account of that name exists already, it is one
            // this contract made before, and the stage uses it as it is.
            stage.storage_balance += amount.0;
            self.save_stage_lenient(no, &mut stage, before);
        }
        self.post_profile(&stage, &dao);
        emit("stage_account", json!({ "dao": dao, "agent": stage.agent, "created": created }));
        created
    }

    #[private]
    pub fn on_policy(&mut self, dao: AccountId) -> bool {
        let Ok(bytes) = env::promise_result_checked(0, MAX_POLICY_BYTES) else {
            env::log_str("The DAO's policy could not be read. Nothing changed.");
            return false;
        };
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        let json = String::from_utf8(bytes).unwrap_or_default();
        let facts = match read_policy(
            &json,
            stage.agent.as_str(),
            dao.as_str(),
            &stage.config.clapper_roles,
            &stage.config.steward_roles,
            MAX_MEMBERS,
        ) {
            Ok(f) => f,
            Err(e) => {
                env::log_str(&format!("{e}. Nothing changed."));
                return false;
            }
        };
        let to_ids = |names: &[String]| -> Vec<AccountId> { names.iter().filter_map(|n| n.parse().ok()).collect() };
        let members = Members { clappers: to_ids(&facts.clappers), stewards: to_ids(&facts.stewards) };
        stage.synced_ns = env::block_timestamp();
        stage.bond = facts.bond;
        stage.period_ns = facts.period_ns;
        stage.role = facts.role;
        stage.can_add = facts.can_add;
        stage.can_approve = facts.can_approve;
        stage.can_finalize = facts.can_finalize;
        stage.solo = facts.solo;
        stage.shared = facts.shared;
        stage.wide = facts.wide;
        stage.skipped_roles = facts.skipped_roles;
        stage.missing_roles = facts.missing_roles;
        emit(
            "members_synced",
            json!({ "dao": dao, "clappers": members.clappers.len(), "stewards": members.stewards.len(), "bond": U128(stage.bond) }),
        );
        self.members.insert(&no, &members);
        // Strict: a policy the stage cannot pay to store is not stored. The panic undoes this
        // callback, so the old member list stays.
        self.save_stage(no, &mut stage, before);
        true
    }

    #[private]
    pub fn on_filed(&mut self, dao: AccountId, round: u32, account: AccountId) -> PromiseOrValue<String> {
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        let tkey = (no, round, account.clone());
        let mut tally = self.tallies.get(&tkey).unwrap();
        let mut claim = tally.claim.clone().unwrap();
        if claim.state != ClaimState::Filing {
            return PromiseOrValue::Value(claim.state.as_str().to_string());
        }
        let rkey = (no, round);
        let mut r = self.rounds.get(&rkey).unwrap();
        let answer = env::promise_result_checked(0, 64);
        if let Err(PromiseError::Failed) = answer {
            // Nothing was filed. Either the stage's account could not pay the bond, or the DAO
            // refused the proposal and the runtime sent the bond back to the stage's account.
            release(&mut r, &claim);
            r.claims -= 1;
            self.rounds.insert(&rkey, &r);
            tally.claim = None;
            self.tallies.insert(&tkey, &tally);
            self.save_stage_lenient(no, &mut stage, before);
            env::log_str("The DAO did not take the proposal, or the stage's account could not pay its bond. Nothing was filed; the claim can be tried again.");
            return PromiseOrValue::Value("NotFiled".to_string());
        }
        let id: Option<u64> = answer.ok().and_then(|b| serde_json::from_slice(&b).ok());
        let Some(id) = id else {
            // The DAO kept the bond and gave no proposal number. A proposal may exist, so this
            // payout stays reserved and is never filed again.
            claim.state = ClaimState::Unanswered;
            tally.claim = Some(claim);
            self.tallies.insert(&tkey, &tally);
            self.save_stage_lenient(no, &mut stage, before);
            emit("claim_unanswered", json!({ "dao": dao, "round": round, "account": account }));
            return PromiseOrValue::Value("Unanswered".to_string());
        };
        claim.proposal_id = id;
        let tier = tier_from(claim.tier);
        let vote_now = tier == Tier::Auto && stage.can_approve && stage.solo && !stage.paused;
        claim.state = if vote_now { ClaimState::Voting } else { ClaimState::Filed };
        tally.claim = Some(claim.clone());
        self.tallies.insert(&tkey, &tally);
        self.save_stage_lenient(no, &mut stage, before);
        emit(
            "claim_filed",
            json!({ "dao": dao, "round": round, "account": account, "amount": U128(claim.amount), "tier": tier.as_str(), "proposal_id": id }),
        );
        if vote_now {
            PromiseOrValue::Promise(self.vote(&stage, &dao, round, &account, &claim))
        } else {
            PromiseOrValue::Value(claim.state.as_str().to_string())
        }
    }

    #[private]
    pub fn on_voted(&mut self, dao: AccountId, round: u32, account: AccountId) -> String {
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        let tkey = (no, round, account.clone());
        let mut tally = self.tallies.get(&tkey).unwrap();
        let mut claim = tally.claim.clone().unwrap();
        if claim.state != ClaimState::Voting {
            return claim.state.as_str().to_string();
        }
        // A vote Sputnik accepts has not necessarily passed the proposal, so the claim goes
        // back to Filed either way, and `settle` reads what the DAO decided.
        claim.state = ClaimState::Filed;
        let landed = near_sdk::is_promise_success();
        if landed {
            claim.voted = true;
            emit("claim_voted", json!({ "dao": dao, "round": round, "account": account, "proposal_id": claim.proposal_id, "cosigner": claim.cosigner }));
        } else {
            env::log_str("The DAO did not take the vote, for example because the treasury cannot cover the payout yet. The proposal is still open; calling claim again retries the vote.");
        }
        tally.claim = Some(claim);
        self.tallies.insert(&tkey, &tally);
        self.save_stage_lenient(no, &mut stage, before);
        if landed { "Voted" } else { "Filed" }.to_string()
    }

    #[private]
    pub fn on_settle(&mut self, dao: AccountId, round: u32, account: AccountId) -> PromiseOrValue<String> {
        let Ok(bytes) = env::promise_result_checked(0, MAX_PROPOSAL_BYTES) else {
            env::log_str("The DAO's proposal could not be read. Nothing changed.");
            return PromiseOrValue::Value("Unchanged".to_string());
        };
        let before = env::storage_usage();
        let (no, mut stage) = self.stage(&dao);
        let tkey = (no, round, account.clone());
        let mut tally = self.tallies.get(&tkey).unwrap();
        let mut claim = tally.claim.clone().unwrap();
        let held = match claim.state {
            ClaimState::Filed | ClaimState::Voting => Held::Filed,
            ClaimState::Approved => Held::Approved { since_ns: claim.approved_ns },
            ClaimState::Failed => Held::Failed,
            other => return PromiseOrValue::Value(other.as_str().to_string()),
        };
        let id = claim.proposal_id;
        let now = env::block_timestamp();
        let seen = match claims::read_proposal(
            &String::from_utf8(bytes).unwrap_or_default(),
            &claims::Expected {
                id,
                proposer: stage.agent.as_str(),
                receiver: account.as_str(),
                amount: claim.amount,
                token: stage.config.token_id.as_ref().map(|t| t.as_str()).unwrap_or(""),
                now_ns: now,
                period_ns: stage.period_ns,
            },
        ) {
            Ok(s) => s,
            Err(e) => {
                env::log_str(&format!("{e}. Nothing changed."));
                return PromiseOrValue::Value("Unchanged".to_string());
            }
        };
        let rkey = (no, round);
        let mut r = self.rounds.get(&rkey).unwrap();
        match claims::settle_step(held, seen, now) {
            Step::Stay => return PromiseOrValue::Value(claim.state.as_str().to_string()),
            Step::MarkApproved => {
                claim.state = ClaimState::Approved;
                claim.approved_ns = now;
            }
            Step::BackToFiled => claim.state = ClaimState::Filed,
            Step::Failed => claim.state = ClaimState::Failed,
            Step::Paid => {
                claim.state = ClaimState::Paid;
                r.paid += claim.amount;
                stage.paid += claim.amount;
                stage.payouts += 1;
                let reckey = (no, account.clone());
                let mut record = self.records.get(&reckey).unwrap_or_default();
                record.rounds_paid += 1;
                record.paid += claim.amount;
                self.records.insert(&reckey, &record);
                if stage.config.post_to_social && self.may_post(&mut stage) {
                    let post_id = Self::next_post_id(&mut stage);
                    let post = json!({
                        "text": text::paid_post(&text::PaidLine {
                            to: account.as_str(),
                            amount: claim.amount,
                            decimals: stage.config.token_decimals,
                            symbol: &stage.config.token_symbol,
                            backers: claim.backers,
                            label: &stage.config.label,
                            dao: dao.as_str(),
                            round,
                            proposal_id: id,
                        })
                    });
                    self.post(&stage, format!("post/{post_id}"), post);
                }
            }
            Step::Rejected => {
                claim.state = ClaimState::Rejected;
                release(&mut r, &claim);
            }
            Step::Expired => {
                claim.state = ClaimState::Expired;
                release(&mut r, &claim);
            }
            Step::Removed => {
                claim.state = ClaimState::Removed;
                release(&mut r, &claim);
            }
            Step::Finalize => {
                if !stage.can_finalize {
                    env::log_str("The proposal is past its deadline. The stage's role lacks transfer:Finalize, so a council member has to finalize it.");
                    return PromiseOrValue::Value(claim.state.as_str().to_string());
                }
                let args = json!({ "id": id, "action": "Finalize", "proposal": transfer_kind(&stage.config, &account, claim.amount) });
                return PromiseOrValue::Promise(
                    self.agent_call(&stage, &dao, "act_proposal", args.to_string().as_bytes(), 0, GAS_FINALIZE)
                        .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_FINALIZED).on_finalized(dao, round, account)),
                );
            }
        }
        tally.claim = Some(claim.clone());
        self.tallies.insert(&tkey, &tally);
        self.rounds.insert(&rkey, &r);
        self.save_stage_lenient(no, &mut stage, before);
        emit(
            "claim_settled",
            json!({ "dao": dao, "round": round, "account": account, "state": claim.state.as_str(), "amount": U128(claim.amount), "proposal_id": id }),
        );
        PromiseOrValue::Value(claim.state.as_str().to_string())
    }

    /// Finalizing does not decide anything here: the next `settle` reads what the DAO
    /// recorded, which is Expired, or Approved if the DAO's policy has changed since.
    #[private]
    pub fn on_finalized(&mut self, dao: AccountId, round: u32, account: AccountId) -> String {
        let ok = near_sdk::is_promise_success();
        emit("claim_finalized", json!({ "dao": dao, "round": round, "account": account, "ok": ok }));
        if ok { "Finalized" } else { "NotFinalized" }.to_string()
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn version(&self) -> String {
        VERSION.to_string()
    }

    /// The account near.social data is written to.
    pub fn get_social_account(&self) -> AccountId {
        self.social.clone()
    }

    /// The name of the account a DAO's stage has, or will have once it opens one. The DAO's
    /// role must hold this account.
    pub fn agent_for(&self, dao: AccountId) -> AccountId {
        let digest = env::sha256(dao.as_bytes());
        text::agent_account(dao.as_str(), env::current_account_id().as_str(), &digest)
            .parse()
            .unwrap_or_else(|_| fail("ERR_NAME: no valid stage account name for that DAO"))
    }

    pub fn count_stages(&self) -> u64 {
        self.stage_ids.len()
    }

    pub fn list_stages(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<AccountId> {
        let from = from_index.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(50).min(PAGE_MAX) as u64).min(self.stage_ids.len());
        (from..to).filter_map(|i| self.stage_ids.get(i)).collect()
    }

    pub fn get_stage(&self, dao: AccountId) -> Option<StageView> {
        let no = self.stage_no.get(&dao)?;
        let s = self.stages.get(&no)?;
        let m = self.members.get(&no).unwrap_or_default();
        let round_now = rounds::round_at(s.created_ns, s.config.round_secs as u64 * NS_PER_SEC, env::block_timestamp());
        Some(StageView {
            dao,
            agent: s.agent,
            created_ms: s.created_ns / NS_PER_MS,
            round_now,
            paused: s.paused,
            paused_by: s.paused_by,
            storage_balance: U128(s.storage_balance),
            synced_ms: s.synced_ns / NS_PER_MS,
            bond: U128(s.bond),
            proposal_period_secs: s.period_ns / NS_PER_SEC,
            role: s.role,
            can_add: s.can_add,
            can_approve: s.can_approve,
            can_finalize: s.can_finalize,
            solo: s.solo,
            shared: s.shared,
            wide: s.wide,
            ready: s.can_add && s.can_approve && s.solo,
            skipped_roles: s.skipped_roles,
            missing_roles: s.missing_roles,
            clappers: m.clappers,
            stewards: m.stewards,
            rounds: s.rounds,
            entries: s.entries,
            claps: s.claps,
            paid: U128(s.paid),
            payouts: s.payouts,
            config: s.config,
        })
    }

    /// A round's clock, rules and totals. `round` defaults to the one open now.
    pub fn get_round(&self, dao: AccountId, round: Option<u32>) -> Option<RoundView> {
        let no = self.stage_no.get(&dao)?;
        let s = self.stages.get(&no)?;
        let now = env::block_timestamp();
        let round = round.unwrap_or_else(|| rounds::round_at(s.created_ns, s.config.round_secs as u64 * NS_PER_SEC, now));
        let stored = self.rounds.get(&(no, round));
        let exists = stored.is_some();
        let r = stored.unwrap_or_else(|| new_round(&s.config));
        let w = self.window(&s, &r, round);
        Some(RoundView {
            round,
            exists,
            phase: rounds::phase(now, &w).as_str().to_string(),
            starts_ms: w.starts_ns / NS_PER_MS,
            ends_ms: w.ends_ns / NS_PER_MS,
            review_ends_ms: w.review_ends_ns / NS_PER_MS,
            claim_ends_ms: w.claim_ends_ns / NS_PER_MS,
            budget: U128(r.budget),
            eligible: U128(r.eligible),
            claps: r.claps,
            entries: r.entries,
            recipients: r.recipients,
            voided: r.voided,
            filed: U128(r.filed),
            auto_filed: U128(r.auto_filed),
            paid: U128(r.paid),
            claims: r.claims,
            claps_per_round: r.claps_per_round,
            min_backers: r.min_backers,
            max_share_bps: r.max_share_bps,
            min_payout: U128(r.min_payout),
            auto_limit_new: U128(r.auto_limit_new),
            auto_limit_trusted: U128(r.auto_limit_trusted),
            cosign_limit: U128(r.cosign_limit),
            auto_cap: U128(r.auto_cap),
            trusted_after_rounds: r.trusted_after_rounds,
            trusted_after_backers: r.trusted_after_backers,
        })
    }

    /// The rounds that have had applause, oldest first. `from_index` counts those rounds,
    /// not round numbers: quiet rounds are never stored.
    pub fn list_rounds(&self, dao: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<RoundView> {
        let Some(no) = self.stage_no.get(&dao) else { return vec![] };
        let Some(s) = self.stages.get(&no) else { return vec![] };
        let from = from_index.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(50).min(PAGE_MAX)).min(s.rounds);
        (from..to)
            .filter_map(|i| {
                let round = self.stage_rounds.get(&(no, i))?;
                self.get_round(dao.clone(), Some(round))
            })
            .collect()
    }

    /// Every applause in a round, in the order it first arrived.
    pub fn list_applause(&self, dao: AccountId, round: u32, from_index: Option<u32>, limit: Option<u32>) -> Vec<ApplauseView> {
        let Some(no) = self.stage_no.get(&dao) else { return vec![] };
        let Some(r) = self.rounds.get(&(no, round)) else { return vec![] };
        let from = from_index.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(50).min(PAGE_MAX)).min(r.entries);
        (from..to)
            .filter_map(|i| {
                let (giver, recipient) = self.round_log.get(&(no, round, i))?;
                let a = self.applause.get(&(no, round, giver.clone(), recipient.clone()))?;
                Some(applause_view(round, giver, recipient, &a))
            })
            .collect()
    }

    /// Who was applauded in a round, with their score, the amount it earns and its payout.
    pub fn list_standings(&self, dao: AccountId, round: u32, from_index: Option<u32>, limit: Option<u32>) -> Vec<StandingView> {
        let Some(no) = self.stage_no.get(&dao) else { return vec![] };
        let Some(r) = self.rounds.get(&(no, round)) else { return vec![] };
        let from = from_index.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(50).min(PAGE_MAX)).min(r.recipients);
        (from..to)
            .filter_map(|i| {
                let account = self.round_recipients.get(&(no, round, i))?;
                self.standing(no, &r, round, account)
            })
            .collect()
    }

    pub fn get_standing(&self, dao: AccountId, round: u32, account: AccountId) -> Option<StandingView> {
        let no = self.stage_no.get(&dao)?;
        let r = self.rounds.get(&(no, round))?;
        self.standing(no, &r, round, account)
    }

    /// An account's standing in a DAO. `trusted` is what raises their no-signature limit.
    pub fn get_record(&self, dao: AccountId, account: AccountId) -> Option<RecordView> {
        let no = self.stage_no.get(&dao)?;
        let s = self.stages.get(&no)?;
        let rec = self.records.get(&(no, account.clone())).unwrap_or_default();
        Some(RecordView {
            trusted: gates::is_trusted(rec.rounds_paid, rec.backers, s.config.trusted_after_rounds, s.config.trusted_after_backers),
            account,
            backers: rec.backers,
            rounds_applauded: rec.rounds_applauded,
            rounds_paid: rec.rounds_paid,
            claps_received: rec.claps_received,
            claps_given: rec.claps_given,
            paid: U128(rec.paid),
            lines: rec.lines,
            trusted_after_rounds: s.config.trusted_after_rounds,
            trusted_after_backers: s.config.trusted_after_backers,
        })
    }

    /// Every applause an account ever received in a DAO: the entries its record is made of.
    pub fn list_record_lines(&self, dao: AccountId, account: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<ApplauseView> {
        let Some(no) = self.stage_no.get(&dao) else { return vec![] };
        let rec = self.records.get(&(no, account.clone())).unwrap_or_default();
        let from = from_index.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(50).min(PAGE_MAX)).min(rec.lines);
        (from..to)
            .filter_map(|i| {
                let (round, giver) = self.record_lines.get(&(no, account.clone(), i))?;
                let a = self.applause.get(&(no, round, giver.clone(), account.clone()))?;
                Some(applause_view(round, giver, account.clone(), &a))
            })
            .collect()
    }

    /// Whether an account may applaud or oversee, and how many claps it has left this round.
    pub fn get_member(&self, dao: AccountId, account: AccountId) -> Option<MemberView> {
        let no = self.stage_no.get(&dao)?;
        let s = self.stages.get(&no)?;
        let m = self.members.get(&no).unwrap_or_default();
        let round = rounds::round_at(s.created_ns, s.config.round_secs as u64 * NS_PER_SEC, env::block_timestamp());
        let allowance = self.rounds.get(&(no, round)).map(|r| r.claps_per_round).unwrap_or(s.config.claps_per_round) as u32;
        let (used, _) = self.spent.get(&(no, round, account.clone())).unwrap_or((0, 0));
        let is_clapper = m.clappers.binary_search(&account).is_ok();
        Some(MemberView {
            is_clapper,
            is_steward: m.stewards.binary_search(&account).is_ok(),
            account,
            round,
            claps_used: used,
            claps_left: if is_clapper && !s.paused { allowance.saturating_sub(used) } else { 0 },
        })
    }
}

fn applause_view(round: u32, from: AccountId, to: AccountId, a: &Applause) -> ApplauseView {
    ApplauseView {
        round,
        from,
        to,
        claps: a.claps,
        note: a.note.clone(),
        quote: a.quote.clone(),
        post_id: if a.post_id == 0 || a.claps == 0 { None } else { Some(a.post_id) },
        at_ms: a.at_ns / NS_PER_MS,
        voided: a.struck.is_some(),
        voided_by: a.struck.as_ref().map(|s| s.0.clone()),
        void_reason: a.struck.as_ref().map(|s| s.1.clone()),
        voided_claps: a.struck.as_ref().map(|s| s.2).unwrap_or(0),
    }
}

impl Ovation {
    /// A DAO's stage and its number.
    fn stage(&self, dao: &AccountId) -> (u32, Stage) {
        let no = self.stage_no.get(dao).unwrap_or_else(|| fail("ERR_NO_STAGE: that DAO has not opened a stage"));
        (no, self.stages.get(&no).unwrap())
    }

    /// Store the stage and charge it for the storage this call added, or credit what it freed.
    fn save_stage(&mut self, no: u32, stage: &mut Stage, before: u64) {
        self.stages.insert(&no, stage);
        let after = env::storage_usage();
        let byte = env::storage_byte_cost().as_yoctonear();
        if after >= before {
            let cost = (after - before) as u128 * byte;
            require!(
                stage.storage_balance >= cost,
                "ERR_STORAGE: the stage's prepaid storage is used up; anyone can add NEAR with fund_stage"
            );
            stage.storage_balance -= cost;
        } else {
            stage.storage_balance += (before - after) as u128 * byte;
        }
        self.stages.insert(&no, stage);
    }

    /// The same, for callbacks, which must record what the DAO answered even when the stage
    /// is short. Callbacks are written so they add no storage, so the shortfall is at most a
    /// few bytes.
    fn save_stage_lenient(&mut self, no: u32, stage: &mut Stage, before: u64) {
        self.stages.insert(&no, stage);
        let after = env::storage_usage();
        let byte = env::storage_byte_cost().as_yoctonear();
        if after >= before {
            stage.storage_balance = stage.storage_balance.saturating_sub((after - before) as u128 * byte);
        } else {
            stage.storage_balance += (before - after) as u128 * byte;
        }
        self.stages.insert(&no, stage);
    }

    fn window(&self, s: &Stage, r: &Round, round: u32) -> Window {
        rounds::window(s.created_ns, s.config.round_secs as u64 * NS_PER_SEC, r.review_ns, r.claim_ns, round)
    }

    /// Change one member's claps for one recipient and keep the round's eligible total exact.
    fn retally(&self, r: &mut Round, tally: &mut RecipientRound, old: u32, new: u32) {
        let before = math::eligible_part(&tally.tally(), r.min_backers);
        let next = math::retally(&tally.tally(), old, new).unwrap_or_else(|| fail("ERR_TALLY: the tally does not hold that applause"));
        tally.set(next);
        let after = math::eligible_part(&next, r.min_backers);
        r.eligible = r.eligible - before + after;
        r.claps = r.claps - old + new;
    }

    /// Keep the count of different members behind an account exact as applause comes and goes.
    fn move_pair(&mut self, no: u32, from: &AccountId, to: &AccountId, old: u32, new: u32, record: &mut Record) {
        if (old > 0) == (new > 0) {
            return;
        }
        let key = (no, from.clone(), to.clone());
        let n = self.pairs.get(&key).unwrap_or(0);
        if new > 0 {
            if n == 0 {
                record.backers += 1;
            }
            self.pairs.insert(&key, &(n + 1));
        } else {
            let left = n.saturating_sub(1);
            if left == 0 {
                self.pairs.remove(&key);
                if n > 0 {
                    record.backers = record.backers.saturating_sub(1);
                }
            } else {
                self.pairs.insert(&key, &left);
            }
        }
    }

    fn read_policy_of(&self, dao: AccountId) -> Promise {
        Promise::new(dao.clone())
            .function_call("get_policy", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_GET_POLICY)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_POLICY).on_policy(dao))
    }

    /// Have the stage's account make one call, with a deposit from its own balance. The
    /// promise resolves to that call's result.
    fn agent_call(&self, stage: &Stage, receiver: &AccountId, method: &str, args: &[u8], deposit: u128, gas: Gas) -> Promise {
        let packed = pack_call(receiver.as_str(), method, deposit, gas, args);
        Promise::new(stage.agent.clone()).function_call("call", packed, NearToken::from_yoctonear(0), gas.saturating_add(GAS_HOP))
    }

    /// The stage's account casts its approve vote on a proposal it filed.
    fn vote(&self, stage: &Stage, dao: &AccountId, round: u32, account: &AccountId, claim: &Claim) -> Promise {
        require!(claim.proposal_id != NO_PROPOSAL, "ERR_NO_PROPOSAL: the payout has no proposal yet");
        let args = json!({ "id": claim.proposal_id, "action": "VoteApprove", "proposal": transfer_kind(&stage.config, account, claim.amount) });
        self.agent_call(stage, dao, "act_proposal", args.to_string().as_bytes(), 0, GAS_ACT_PROPOSAL)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VOTED).on_voted(dao.clone(), round, account.clone()))
    }

    /// Whether another new post fits under near.social's daily limit for this stage's
    /// account. Counts it if so.
    fn may_post(&self, stage: &mut Stage) -> bool {
        let day = env::block_timestamp_ms() / DAY_MS;
        if day != stage.post_day {
            stage.post_day = day;
            stage.posts_today = 0;
        }
        if stage.posts_today >= DAILY_POSTS {
            return false;
        }
        stage.posts_today += 1;
        true
    }

    /// near.social asks for the current time in milliseconds as a post id, never reused by the
    /// same author.
    fn next_post_id(stage: &mut Stage) -> u64 {
        let id = env::block_timestamp_ms().max(stage.last_post_id + 1);
        stage.last_post_id = id;
        id
    }

    /// Write one key to near.social as the stage's account. The write goes to an account with
    /// no contract, so its receipt always fails and the data is indexed anyway: that is how
    /// near.social works. It is sent with 1 gas and nothing waits for it.
    fn post(&self, stage: &Stage, key: String, value: Value) {
        let mut args = serde_json::Map::new();
        args.insert(key, value);
        self.write_social(stage, Value::Object(args));
    }

    fn write_social(&self, stage: &Stage, args: Value) {
        let packed = pack_call(self.social.as_str(), "__fastdata_kv", 0, Gas::from_gas(1), args.to_string().as_bytes());
        Promise::new(stage.agent.clone()).function_call("call", packed, NearToken::from_yoctonear(0), GAS_HOP).detach();
    }

    /// The stage account's near.social profile. The bio says it is automated.
    fn post_profile(&self, stage: &Stage, dao: &AccountId) {
        self.write_social(
            stage,
            json!({ "profile/name": stage.config.label, "profile/about": text::profile_about(dao.as_str()) }),
        );
    }

    fn standing(&self, no: u32, r: &Round, round: u32, account: AccountId) -> Option<StandingView> {
        let t = self.tallies.get(&(no, round, account.clone()))?;
        let part = math::eligible_part(&t.tally(), r.min_backers);
        let amount = math::payout(r.budget, part, r.eligible, r.max_share_bps);
        let rec = self.records.get(&(no, account.clone())).unwrap_or_default();
        let trusted = gates::is_trusted(rec.rounds_paid, rec.backers, r.trusted_after_rounds, r.trusted_after_backers);
        let tier = match &t.claim {
            Some(c) => tier_from(c.tier),
            None => {
                let left = r.auto_cap.saturating_sub(r.auto_filed);
                gates::tier_capped(amount, trusted, r.auto_limit_new, r.auto_limit_trusted, r.cosign_limit, left)
            }
        };
        Some(StandingView {
            account,
            claps: t.claps,
            backers: t.backers,
            score: U128(math::score(t.root_sum)),
            eligible: part > 0,
            amount: U128(t.claim.as_ref().map(|c| c.amount).unwrap_or(amount)),
            trusted,
            tier: tier.as_str().to_string(),
            claim: t.claim.as_ref().map(|c| ClaimView {
                amount: U128(c.amount),
                tier: tier_from(c.tier).as_str().to_string(),
                state: c.state.as_str().to_string(),
                proposal_id: if c.proposal_id == NO_PROPOSAL { None } else { Some(c.proposal_id) },
                voted: c.voted,
                filed_ms: c.filed_ns / NS_PER_MS,
                approved_ms: c.approved_ns / NS_PER_MS,
                cosigner: c.cosigner.clone(),
            }),
        })
    }
}

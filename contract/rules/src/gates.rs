//! Who may do what, and when. Each gate takes plain facts and answers yes or gives the reason.
//! The contract gathers the facts from storage and panics with the reason.

use crate::rounds::Phase;

/// Who signs off a payout, decided by its size and the recipient's record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// The contract approves it alone.
    Auto,
    /// One steward must co-sign, then the contract approves it.
    Cosign,
    /// A normal DAO proposal. The stage's account files it and never votes on it.
    Council,
}

impl Tier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::Auto => "Auto",
            Tier::Cosign => "Cosign",
            Tier::Council => "Council",
        }
    }
}

/// A recipient is trusted once they have been paid in enough rounds and applauded by enough
/// different members over their whole record.
pub fn is_trusted(rounds_paid: u32, backers: u32, need_rounds: u16, need_backers: u16) -> bool {
    rounds_paid >= need_rounds as u32 && backers >= need_backers as u32
}

pub fn tier(amount: u128, trusted: bool, auto_new: u128, auto_trusted: u128, cosign_limit: u128) -> Tier {
    let auto = if trusted { auto_trusted.max(auto_new) } else { auto_new };
    if amount <= auto {
        Tier::Auto
    } else if amount <= cosign_limit {
        Tier::Cosign
    } else {
        Tier::Council
    }
}

/// The tier, after the round's cap on what may go out with no sign-off at all. `auto_left` is
/// how much of that cap is still unused. A payout that would pass it needs a steward instead.
pub fn tier_capped(amount: u128, trusted: bool, auto_new: u128, auto_trusted: u128, cosign_limit: u128, auto_left: u128) -> Tier {
    match tier(amount, trusted, auto_new, auto_trusted, cosign_limit) {
        Tier::Auto if amount > auto_left => Tier::Cosign,
        t => t,
    }
}

pub struct ApplaudFacts {
    pub paused: bool,
    pub is_clapper: bool,
    /// The recipient is the member themselves.
    pub to_self: bool,
    /// The recipient is the DAO or this contract.
    pub to_system: bool,
    /// Claps asked for this recipient.
    pub claps: u32,
    /// Claps this member already holds on this recipient in this round.
    pub old_claps: u32,
    /// The existing applause was struck out by a steward.
    pub voided: bool,
    /// This member has not applauded this recipient in this round before.
    pub new_entry: bool,
    /// Claps this member has used in this round, on everyone.
    pub spent: u32,
    pub allowance: u32,
    /// How many different people this member has applauded this round, counting applause
    /// they later took back.
    pub people: u32,
}

pub fn applaud_gate(f: &ApplaudFacts) -> Result<(), &'static str> {
    if f.paused {
        return Err("ERR_PAUSED: a steward paused this stage; the DAO can resume it");
    }
    if !f.is_clapper {
        return Err("ERR_NOT_A_MEMBER: only members of the stage's roles can applaud; call sync_members if the DAO just added you");
    }
    if f.to_self {
        return Err("ERR_SELF: you cannot applaud yourself");
    }
    if f.to_system {
        return Err("ERR_RECIPIENT: the DAO and this contract cannot be applauded");
    }
    if f.voided {
        return Err("ERR_VOIDED: a steward struck out this applause; it cannot be changed this round");
    }
    if f.claps == 0 && f.old_claps == 0 {
        return Err("ERR_NOTHING: there is no applause to withdraw");
    }
    // Every new recipient costs the stage storage, and taking applause back does not free it.
    // So a member can name at most as many people per round as they have claps, which stops
    // anyone from running the stage out of storage by applauding and withdrawing in a loop.
    if f.new_entry && f.people >= f.allowance {
        return Err("ERR_TOO_MANY_PEOPLE: you have already applauded as many different people this round as you have claps");
    }
    let after = f.spent.saturating_sub(f.old_claps).saturating_add(f.claps);
    if after > f.allowance {
        return Err("ERR_ALLOWANCE: not enough claps left this round");
    }
    Ok(())
}

pub struct VoidFacts {
    pub is_steward: bool,
    pub phase: Phase,
    pub exists: bool,
    pub voided: bool,
    pub claps: u32,
}

pub fn void_gate(f: &VoidFacts) -> Result<(), &'static str> {
    if !f.is_steward {
        return Err("ERR_NOT_A_STEWARD: only members of the stage's steward roles can void applause");
    }
    if !matches!(f.phase, Phase::Open | Phase::Review) {
        return Err("ERR_TOO_LATE: applause can be voided only until the review window ends");
    }
    if !f.exists || f.claps == 0 {
        return Err("ERR_NO_APPLAUSE: there is no such applause in this round");
    }
    if f.voided {
        return Err("ERR_VOIDED: already struck out");
    }
    Ok(())
}

pub struct ClaimFacts {
    pub paused: bool,
    pub phase: Phase,
    pub already_claimed: bool,
    pub backers: u16,
    pub min_backers: u16,
    pub amount: u128,
    pub min_payout: u128,
    /// Sum already filed for this round, before this claim.
    pub filed: u128,
    pub budget: u128,
    /// The stage has read the DAO's policy at least once.
    pub synced: bool,
    /// The DAO's policy gives this contract what it needs to file a transfer.
    pub can_file: bool,
}

pub fn claim_gate(f: &ClaimFacts) -> Result<(), &'static str> {
    if f.paused {
        return Err("ERR_PAUSED: a steward paused this stage; the DAO can resume it");
    }
    match f.phase {
        Phase::Upcoming | Phase::Open => return Err("ERR_ROUND_OPEN: this round has not ended"),
        Phase::Review => return Err("ERR_IN_REVIEW: claims open when the review window ends"),
        Phase::Closed => return Err("ERR_CLAIM_CLOSED: the claim window for this round has ended; the money stayed in the treasury"),
        Phase::Claimable => {}
    }
    if f.already_claimed {
        return Err("ERR_CLAIMED: this payout was already filed");
    }
    if f.backers == 0 || f.backers < f.min_backers {
        return Err("ERR_TOO_FEW_BACKERS: not enough different members applauded this account in this round");
    }
    if f.amount == 0 || f.amount < f.min_payout {
        return Err("ERR_TOO_SMALL: the amount is below the stage's minimum payout");
    }
    if f.filed.checked_add(f.amount).map_or(true, |t| t > f.budget) {
        return Err("ERR_OVER_BUDGET: this would take the round over its budget");
    }
    if !f.synced {
        return Err("ERR_NOT_SYNCED: call sync_members first so the contract knows the DAO's bond");
    }
    if !f.can_file {
        return Err("ERR_NO_ROLE: the DAO's policy does not let this contract file a transfer");
    }
    Ok(())
}

pub struct CosignFacts {
    pub paused: bool,
    pub is_steward: bool,
    pub is_recipient: bool,
    /// The steward applauded this recipient in this round, so has a stake in the payout.
    pub applauded: bool,
    pub tier: Tier,
    /// The claim is filed on the DAO, nobody has co-signed it and the contract has not voted.
    pub waiting: bool,
    /// The DAO's voting period for the proposal is over, or about to be.
    pub expired: bool,
    /// The DAO's policy lets the stage's account pass a transfer with its single vote.
    pub can_vote: bool,
}

pub fn cosign_gate(f: &CosignFacts) -> Result<(), &'static str> {
    if f.paused {
        return Err("ERR_PAUSED: a steward paused this stage; the DAO can resume it");
    }
    if !f.is_steward {
        return Err("ERR_NOT_A_STEWARD: only members of the stage's steward roles can co-sign");
    }
    if f.tier != Tier::Cosign {
        return Err("ERR_WRONG_TIER: only mid-size payouts take a co-signature");
    }
    if f.is_recipient {
        return Err("ERR_OWN_PAYOUT: a steward cannot co-sign their own payout");
    }
    if f.applauded {
        return Err("ERR_CONFLICT: a steward who applauded this account in this round cannot co-sign the payout");
    }
    if !f.waiting {
        return Err("ERR_NOT_WAITING: this payout is not waiting for a co-signature");
    }
    if f.expired {
        return Err("ERR_EXPIRED: the DAO's voting period for this payout is over; settle it instead");
    }
    if !f.can_vote {
        return Err("ERR_NO_ROLE: the DAO's policy does not let the stage's account pass a transfer alone");
    }
    Ok(())
}

/// Whether the contract may cast its vote on a payout already on the DAO: when the vote at
/// filing did not land, or a payout waiting for a co-signature no longer needs one.
pub struct VoteFacts {
    pub paused: bool,
    /// Filed, not voted on by the contract.
    pub waiting: bool,
    /// Auto, or Cosign with a co-signature.
    pub signed_off: bool,
    pub expired: bool,
    pub can_vote: bool,
}

pub fn vote_gate(f: &VoteFacts) -> Result<(), &'static str> {
    if f.paused {
        return Err("ERR_PAUSED: a steward paused this stage; the DAO can resume it");
    }
    if !f.waiting {
        return Err("ERR_CLAIMED: this payout was already filed");
    }
    if !f.signed_off {
        return Err("ERR_CLAIMED: this payout was already filed and waits for its sign-off");
    }
    if f.expired {
        return Err("ERR_EXPIRED: the DAO's voting period for this payout is over; settle it instead");
    }
    if !f.can_vote {
        return Err("ERR_NO_ROLE: the DAO's policy does not let the stage's account pass a transfer alone");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_follow_the_amount_and_the_record() {
        let (new, trusted, cosign) = (20, 50, 70);
        assert_eq!(tier(0, false, new, trusted, cosign), Tier::Auto);
        assert_eq!(tier(20, false, new, trusted, cosign), Tier::Auto);
        assert_eq!(tier(21, false, new, trusted, cosign), Tier::Cosign);
        assert_eq!(tier(21, true, new, trusted, cosign), Tier::Auto);
        assert_eq!(tier(50, true, new, trusted, cosign), Tier::Auto);
        assert_eq!(tier(51, true, new, trusted, cosign), Tier::Cosign);
        assert_eq!(tier(70, true, new, trusted, cosign), Tier::Cosign);
        assert_eq!(tier(71, true, new, trusted, cosign), Tier::Council);
        assert_eq!(tier(71, false, new, trusted, cosign), Tier::Council);
    }

    #[test]
    fn the_round_cap_turns_no_sign_off_into_a_co_signature() {
        let (new, trusted, cosign) = (20, 50, 70);
        assert_eq!(tier_capped(15, false, new, trusted, cosign, 100), Tier::Auto);
        assert_eq!(tier_capped(15, false, new, trusted, cosign, 15), Tier::Auto);
        assert_eq!(tier_capped(15, false, new, trusted, cosign, 14), Tier::Cosign);
        assert_eq!(tier_capped(40, true, new, trusted, cosign, 0), Tier::Cosign);
        // the cap never touches payouts that need people anyway
        assert_eq!(tier_capped(60, false, new, trusted, cosign, 0), Tier::Cosign);
        assert_eq!(tier_capped(80, true, new, trusted, cosign, 1000), Tier::Council);
    }

    #[test]
    fn a_trusted_limit_below_the_newcomer_limit_never_lowers_anyone() {
        assert_eq!(tier(30, true, 40, 10, 100), Tier::Auto);
    }

    #[test]
    fn no_cosign_tier_when_the_limits_meet() {
        assert_eq!(tier(51, true, 20, 50, 50), Tier::Council);
        assert_eq!(tier(21, false, 20, 50, 20), Tier::Council);
    }

    #[test]
    fn trust_needs_both_paid_rounds_and_breadth() {
        assert!(!is_trusted(1, 9, 2, 3));
        assert!(!is_trusted(5, 2, 2, 3));
        assert!(is_trusted(2, 3, 2, 3));
        assert!(is_trusted(0, 0, 0, 0));
    }

    fn applaud() -> ApplaudFacts {
        ApplaudFacts {
            paused: false,
            is_clapper: true,
            to_self: false,
            to_system: false,
            claps: 3,
            old_claps: 0,
            voided: false,
            new_entry: true,
            spent: 0,
            allowance: 10,
            people: 0,
        }
    }

    #[test]
    fn applause_is_refused_for_each_reason() {
        assert!(applaud_gate(&applaud()).is_ok());
        let err = |f: ApplaudFacts| applaud_gate(&f).unwrap_err().split(':').next().unwrap().to_string();
        assert_eq!(err(ApplaudFacts { paused: true, ..applaud() }), "ERR_PAUSED");
        assert_eq!(err(ApplaudFacts { is_clapper: false, ..applaud() }), "ERR_NOT_A_MEMBER");
        assert_eq!(err(ApplaudFacts { to_self: true, ..applaud() }), "ERR_SELF");
        assert_eq!(err(ApplaudFacts { to_system: true, ..applaud() }), "ERR_RECIPIENT");
        assert_eq!(err(ApplaudFacts { voided: true, ..applaud() }), "ERR_VOIDED");
        assert_eq!(err(ApplaudFacts { claps: 0, ..applaud() }), "ERR_NOTHING");
        assert_eq!(err(ApplaudFacts { claps: 11, ..applaud() }), "ERR_ALLOWANCE");
        assert_eq!(err(ApplaudFacts { spent: 8, ..applaud() }), "ERR_ALLOWANCE");
        assert_eq!(err(ApplaudFacts { people: 10, ..applaud() }), "ERR_TOO_MANY_PEOPLE");
    }

    #[test]
    fn a_member_cannot_cycle_through_endless_recipients() {
        // ten people named already, all withdrawn: no claps spent, and still no eleventh person
        let f = ApplaudFacts { people: 10, spent: 0, claps: 1, ..applaud() };
        assert!(applaud_gate(&f).is_err());
        // changing applause for someone already named is still fine
        let g = ApplaudFacts { people: 10, spent: 0, claps: 1, new_entry: false, ..applaud() };
        assert!(applaud_gate(&g).is_ok());
        assert!(applaud_gate(&ApplaudFacts { people: 9, ..applaud() }).is_ok());
    }

    #[test]
    fn changing_applause_only_counts_the_difference() {
        // 8 spent, 5 of them on this recipient: moving to 7 uses 10, moving to 8 uses 11
        let held = ApplaudFacts { new_entry: false, people: 3, ..applaud() };
        assert!(applaud_gate(&ApplaudFacts { spent: 8, old_claps: 5, claps: 7, ..held }).is_ok());
        assert!(applaud_gate(&ApplaudFacts { spent: 8, old_claps: 5, claps: 8, ..held }).is_err());
        // withdrawing is always allowed
        assert!(applaud_gate(&ApplaudFacts { spent: 10, old_claps: 5, claps: 0, ..held }).is_ok());
    }

    #[test]
    fn stewards_can_void_until_review_ends_and_not_after() {
        let ok = |phase| VoidFacts { is_steward: true, phase, exists: true, voided: false, claps: 2 };
        assert!(void_gate(&ok(Phase::Open)).is_ok());
        assert!(void_gate(&ok(Phase::Review)).is_ok());
        assert!(void_gate(&ok(Phase::Claimable)).is_err());
        assert!(void_gate(&ok(Phase::Closed)).is_err());
        assert!(void_gate(&VoidFacts { is_steward: false, ..ok(Phase::Open) }).is_err());
        assert!(void_gate(&VoidFacts { exists: false, ..ok(Phase::Open) }).is_err());
        assert!(void_gate(&VoidFacts { voided: true, ..ok(Phase::Open) }).is_err());
        assert!(void_gate(&VoidFacts { claps: 0, ..ok(Phase::Open) }).is_err());
    }

    fn claim() -> ClaimFacts {
        ClaimFacts {
            paused: false,
            phase: Phase::Claimable,
            already_claimed: false,
            backers: 2,
            min_backers: 2,
            amount: 30,
            min_payout: 10,
            filed: 60,
            budget: 100,
            synced: true,
            can_file: true,
        }
    }

    #[test]
    fn a_claim_is_refused_for_each_reason() {
        assert!(claim_gate(&claim()).is_ok());
        let err = |f: ClaimFacts| claim_gate(&f).unwrap_err().split(':').next().unwrap().to_string();
        assert_eq!(err(ClaimFacts { paused: true, ..claim() }), "ERR_PAUSED");
        assert_eq!(err(ClaimFacts { phase: Phase::Open, ..claim() }), "ERR_ROUND_OPEN");
        assert_eq!(err(ClaimFacts { phase: Phase::Review, ..claim() }), "ERR_IN_REVIEW");
        assert_eq!(err(ClaimFacts { phase: Phase::Closed, ..claim() }), "ERR_CLAIM_CLOSED");
        assert_eq!(err(ClaimFacts { already_claimed: true, ..claim() }), "ERR_CLAIMED");
        assert_eq!(err(ClaimFacts { backers: 1, ..claim() }), "ERR_TOO_FEW_BACKERS");
        assert_eq!(err(ClaimFacts { backers: 0, min_backers: 0, ..claim() }), "ERR_TOO_FEW_BACKERS");
        assert_eq!(err(ClaimFacts { amount: 9, ..claim() }), "ERR_TOO_SMALL");
        assert_eq!(err(ClaimFacts { amount: 0, min_payout: 0, ..claim() }), "ERR_TOO_SMALL");
        assert_eq!(err(ClaimFacts { filed: 71, ..claim() }), "ERR_OVER_BUDGET");
        assert_eq!(err(ClaimFacts { filed: u128::MAX, ..claim() }), "ERR_OVER_BUDGET");
        assert_eq!(err(ClaimFacts { synced: false, ..claim() }), "ERR_NOT_SYNCED");
        assert_eq!(err(ClaimFacts { can_file: false, ..claim() }), "ERR_NO_ROLE");
    }

    #[test]
    fn a_claim_that_lands_exactly_on_the_budget_passes() {
        assert!(claim_gate(&ClaimFacts { filed: 70, ..claim() }).is_ok());
    }

    #[test]
    fn a_co_signature_must_come_from_a_steward_with_no_stake() {
        let ok = CosignFacts { paused: false, is_steward: true, is_recipient: false, applauded: false, tier: Tier::Cosign, waiting: true, expired: false, can_vote: true };
        assert!(cosign_gate(&ok).is_ok());
        let err = |f: CosignFacts| cosign_gate(&f).unwrap_err().split(':').next().unwrap().to_string();
        assert_eq!(err(CosignFacts { is_recipient: true, ..ok }), "ERR_OWN_PAYOUT");
        assert_eq!(err(CosignFacts { applauded: true, ..ok }), "ERR_CONFLICT");
        assert_eq!(err(CosignFacts { is_steward: false, ..ok }), "ERR_NOT_A_STEWARD");
        assert_eq!(err(CosignFacts { tier: Tier::Council, ..ok }), "ERR_WRONG_TIER");
        assert_eq!(err(CosignFacts { tier: Tier::Auto, ..ok }), "ERR_WRONG_TIER");
        // a large payout is refused for its size before anything else about the steward
        assert_eq!(err(CosignFacts { tier: Tier::Council, applauded: true, is_recipient: true, ..ok }), "ERR_WRONG_TIER");
        assert_eq!(err(CosignFacts { waiting: false, ..ok }), "ERR_NOT_WAITING");
        assert_eq!(err(CosignFacts { paused: true, ..ok }), "ERR_PAUSED");
        assert_eq!(err(CosignFacts { expired: true, ..ok }), "ERR_EXPIRED");
        assert_eq!(err(CosignFacts { can_vote: false, ..ok }), "ERR_NO_ROLE");
    }

    #[test]
    fn a_vote_is_retried_only_when_it_is_still_owed() {
        let ok = VoteFacts { paused: false, waiting: true, signed_off: true, expired: false, can_vote: true };
        assert!(vote_gate(&ok).is_ok());
        let err = |f: VoteFacts| vote_gate(&f).unwrap_err().split(':').next().unwrap().to_string();
        assert_eq!(err(VoteFacts { waiting: false, ..ok }), "ERR_CLAIMED");
        assert_eq!(err(VoteFacts { signed_off: false, ..ok }), "ERR_CLAIMED");
        assert_eq!(err(VoteFacts { paused: true, ..ok }), "ERR_PAUSED");
        // a paused stage answers the same for every claim, filed or not
        assert_eq!(err(VoteFacts { paused: true, waiting: false, ..ok }), "ERR_PAUSED");
        assert_eq!(err(VoteFacts { expired: true, ..ok }), "ERR_EXPIRED");
        assert_eq!(err(VoteFacts { can_vote: false, ..ok }), "ERR_NO_ROLE");
    }
}

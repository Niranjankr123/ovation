//! Following a payout after it has been filed on the DAO.
//!
//! The money is moved by the DAO, never by Ovation, so Ovation learns what happened only by
//! reading the DAO's proposal. Three things make that less simple than it sounds:
//!
//! 1. Sputnik marks a proposal `Approved` before the transfer has actually run. The transfer
//!    is a later receipt that can still fail, after which the status becomes `Failed`. So
//!    `Approved` has to be read twice, some seconds apart, before a claim counts as paid.
//! 2. A vote that Sputnik accepts has not necessarily passed the proposal: the proposal may
//!    need more votes, or its period may have run out. So a vote is never taken as a sighting
//!    of `Approved`. Only reading the proposal is.
//! 3. A proposal removed as spam is deleted, and reading a deleted proposal fails exactly like
//!    a read that ran out of gas. So Ovation reads with `get_proposals(from_index, limit: 1)`,
//!    which answers with an empty list for a deleted proposal. A failed read changes nothing.

use serde_json::Value;

/// How long `Approved` must hold before the claim counts as paid.
pub const CONFIRM_NS: u64 = 15_000_000_000;

/// Stop voting this long before the DAO's voting period ends, so a vote never lands on a
/// proposal that has just expired.
pub const VOTE_MARGIN_NS: u64 = 120_000_000_000;

/// Whether the contract should still vote on a proposal filed at `filed_ns`.
pub fn vote_expired(filed_ns: u64, period_ns: u64, now_ns: u64) -> bool {
    now_ns.saturating_add(VOTE_MARGIN_NS) >= filed_ns.saturating_add(period_ns)
}

/// Where Ovation's own record of a claim stands while it can still change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    /// Filed on the DAO. Ovation has not read it as approved.
    Filed,
    /// Read as approved at `since_ns`.
    Approved { since_ns: u64 },
    /// The DAO approved it and the transfer bounced.
    Failed,
}

/// What the DAO's proposal says right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    /// The proposal no longer exists: it was removed.
    Missing,
    InProgress { expired: bool },
    Approved,
    Rejected,
    Removed,
    Expired,
    Moved,
    /// The transfer bounced. Once the proposal's period is over, finalizing it returns the
    /// bond instead of trying the transfer again.
    Failed { expired: bool },
}

/// What to do with the claim after a look at the DAO.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing to record yet.
    Stay,
    /// First sight of `Approved`: start the confirmation clock.
    MarkApproved,
    /// Ovation thought it was approved and the DAO says it is still open.
    BackToFiled,
    /// Final: the DAO paid.
    Paid,
    /// Final: the council voted it down.
    Rejected,
    /// Final: nobody decided in time.
    Expired,
    /// Final: removed as spam.
    Removed,
    /// The transfer bounced. The DAO can retry it, so this is not final.
    Failed,
    /// Past its deadline and not final: ask the DAO to finalize it, which returns the bond to
    /// the stage's account. The next look records the outcome.
    Finalize,
}

pub fn settle_step(held: Held, seen: Seen, now_ns: u64) -> Step {
    match seen {
        Seen::Missing | Seen::Removed | Seen::Moved => Step::Removed,
        Seen::Rejected => Step::Rejected,
        Seen::Expired => Step::Expired,
        Seen::Failed { expired: true } | Seen::InProgress { expired: true } => Step::Finalize,
        Seen::Failed { expired: false } => match held {
            Held::Failed => Step::Stay,
            _ => Step::Failed,
        },
        Seen::InProgress { expired: false } => match held {
            Held::Filed => Step::Stay,
            Held::Approved { .. } | Held::Failed => Step::BackToFiled,
        },
        Seen::Approved => match held {
            Held::Approved { since_ns } if now_ns >= since_ns.saturating_add(CONFIRM_NS) => Step::Paid,
            Held::Approved { .. } => Step::Stay,
            Held::Filed | Held::Failed => Step::MarkApproved,
        },
    }
}

pub struct Expected<'a> {
    pub id: u64,
    pub proposer: &'a str,
    pub receiver: &'a str,
    pub amount: u128,
    /// Empty for NEAR, otherwise the token contract.
    pub token: &'a str,
    pub now_ns: u64,
    pub period_ns: u64,
}

/// Read the answer of `get_proposals({from_index: id, limit: 1})`.
///
/// An empty list means the proposal was removed. A proposal that is there must be the one
/// Ovation filed: same id, filed by the stage's account, a Transfer of the same amount to the
/// same account. Anything else is an error and changes nothing.
pub fn read_proposal(json: &str, want: &Expected) -> Result<Seen, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| "ERR_READ: the DAO's answer is not JSON".to_string())?;
    let list = v.as_array().ok_or("ERR_READ: the DAO's answer is not a list")?;
    let Some(p) = list.first() else {
        return Ok(Seen::Missing);
    };
    if p.get("id").and_then(Value::as_u64) != Some(want.id) {
        return Ok(Seen::Missing);
    }
    if p.get("proposer").and_then(Value::as_str) != Some(want.proposer) {
        return Err("ERR_MISMATCH: that proposal was not filed by this stage".into());
    }
    let t = p.get("kind").and_then(|k| k.get("Transfer")).ok_or("ERR_MISMATCH: that proposal is not a transfer")?;
    let amount: Option<u128> = t.get("amount").and_then(Value::as_str).and_then(|s| s.parse().ok());
    if t.get("receiver_id").and_then(Value::as_str) != Some(want.receiver)
        || amount != Some(want.amount)
        || t.get("token_id").and_then(Value::as_str) != Some(want.token)
    {
        return Err("ERR_MISMATCH: that proposal pays a different amount or account".into());
    }
    let status = p.get("status").and_then(Value::as_str).ok_or("ERR_READ: the proposal has no status")?;
    let expired = || -> Result<bool, String> {
        let submitted: u64 = p
            .get("submission_time")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok())
            .ok_or("ERR_READ: the proposal has no submission time")?;
        Ok(submitted.saturating_add(want.period_ns) < want.now_ns)
    };
    Ok(match status {
        "InProgress" => Seen::InProgress { expired: expired()? },
        "Approved" => Seen::Approved,
        "Rejected" => Seen::Rejected,
        "Removed" => Seen::Removed,
        "Expired" => Seen::Expired,
        "Moved" => Seen::Moved,
        "Failed" => Seen::Failed { expired: expired()? },
        other => return Err(format!("ERR_READ: unknown proposal status {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000_000;

    #[test]
    fn approved_must_hold_before_it_counts_as_paid() {
        let t0 = 1000 * S;
        assert_eq!(settle_step(Held::Filed, Seen::Approved, t0), Step::MarkApproved);
        assert_eq!(settle_step(Held::Approved { since_ns: t0 }, Seen::Approved, t0 + 14 * S), Step::Stay);
        assert_eq!(settle_step(Held::Approved { since_ns: t0 }, Seen::Approved, t0 + 15 * S), Step::Paid);
        assert_eq!(settle_step(Held::Approved { since_ns: t0 }, Seen::Approved, u64::MAX), Step::Paid);
        // a clock at the end of time saturates instead of wrapping round to "long ago"
        assert_eq!(settle_step(Held::Approved { since_ns: u64::MAX - 1 }, Seen::Approved, u64::MAX - 1), Step::Stay);
    }

    #[test]
    fn a_bounced_transfer_is_never_recorded_as_paid() {
        let t0 = 1000 * S;
        assert_eq!(settle_step(Held::Approved { since_ns: t0 }, Seen::Failed { expired: false }, t0 + 60 * S), Step::Failed);
        assert_eq!(settle_step(Held::Failed, Seen::Failed { expired: false }, t0), Step::Stay);
        // the DAO retried and it went through: the clock starts again
        assert_eq!(settle_step(Held::Failed, Seen::Approved, t0 + 90 * S), Step::MarkApproved);
        assert_eq!(settle_step(Held::Filed, Seen::Failed { expired: false }, t0), Step::Failed);
    }

    #[test]
    fn a_bounced_transfer_past_its_period_is_finalized_so_the_bond_comes_back() {
        for held in [Held::Filed, Held::Approved { since_ns: 5 }, Held::Failed] {
            assert_eq!(settle_step(held, Seen::Failed { expired: true }, 10), Step::Finalize);
        }
    }

    #[test]
    fn removal_rejection_and_expiry_are_final() {
        for held in [Held::Filed, Held::Approved { since_ns: 5 }, Held::Failed] {
            assert_eq!(settle_step(held, Seen::Missing, 10), Step::Removed);
            assert_eq!(settle_step(held, Seen::Removed, 10), Step::Removed);
            assert_eq!(settle_step(held, Seen::Moved, 10), Step::Removed);
            assert_eq!(settle_step(held, Seen::Rejected, 10), Step::Rejected);
            assert_eq!(settle_step(held, Seen::Expired, 10), Step::Expired);
            assert_eq!(settle_step(held, Seen::InProgress { expired: true }, 10), Step::Finalize);
        }
    }

    #[test]
    fn an_open_proposal_waits_or_steps_back() {
        assert_eq!(settle_step(Held::Filed, Seen::InProgress { expired: false }, 10), Step::Stay);
        assert_eq!(settle_step(Held::Approved { since_ns: 5 }, Seen::InProgress { expired: false }, 10), Step::BackToFiled);
        assert_eq!(settle_step(Held::Failed, Seen::InProgress { expired: false }, 10), Step::BackToFiled);
    }

    #[test]
    fn votes_stop_before_the_period_ends() {
        let filed = 1000 * S;
        let period = 7 * 86_400 * S;
        assert!(!vote_expired(filed, period, filed));
        assert!(!vote_expired(filed, period, filed + period - VOTE_MARGIN_NS - 1));
        assert!(vote_expired(filed, period, filed + period - VOTE_MARGIN_NS));
        assert!(vote_expired(filed, period, filed + period + 1));
        // a period shorter than the margin never takes a vote
        assert!(vote_expired(filed, 60 * S, filed));
        assert!(vote_expired(u64::MAX - 5, period, u64::MAX - 5));
    }

    const ME: &str = "lantern-guild-3fa9.v1.ovation.testnet";

    fn want(id: u64) -> Expected<'static> {
        Expected { id, proposer: ME, receiver: "bob.t", amount: 37_500, token: "", now_ns: 5_000, period_ns: 1_000 }
    }

    fn proposal(id: u64, status: &str, submitted: u64) -> String {
        format!(
            r#"[{{"id":{id},"proposer":"{ME}","description":"x","kind":{{"Transfer":{{"token_id":"","receiver_id":"bob.t","amount":"37500","msg":null}}}},"status":"{status}","vote_counts":{{}},"votes":{{}},"submission_time":"{submitted}"}}]"#
        )
    }

    #[test]
    fn reads_each_status() {
        assert_eq!(read_proposal(&proposal(7, "Approved", 1), &want(7)), Ok(Seen::Approved));
        assert_eq!(read_proposal(&proposal(7, "Rejected", 1), &want(7)), Ok(Seen::Rejected));
        assert_eq!(read_proposal(&proposal(7, "Removed", 1), &want(7)), Ok(Seen::Removed));
        assert_eq!(read_proposal(&proposal(7, "Expired", 1), &want(7)), Ok(Seen::Expired));
        assert_eq!(read_proposal(&proposal(7, "Moved", 1), &want(7)), Ok(Seen::Moved));
        assert_eq!(read_proposal(&proposal(7, "Failed", 4500), &want(7)), Ok(Seen::Failed { expired: false }));
        assert_eq!(read_proposal(&proposal(7, "Failed", 1), &want(7)), Ok(Seen::Failed { expired: true }));
        assert!(read_proposal(&proposal(7, "Dancing", 1), &want(7)).is_err());
    }

    #[test]
    fn an_open_proposal_expires_only_after_its_period() {
        // submitted 4000, period 1000, now 5000: the deadline is exactly now, not yet past it
        assert_eq!(read_proposal(&proposal(7, "InProgress", 4000), &want(7)), Ok(Seen::InProgress { expired: false }));
        assert_eq!(read_proposal(&proposal(7, "InProgress", 3999), &want(7)), Ok(Seen::InProgress { expired: true }));
    }

    #[test]
    fn an_empty_list_or_another_id_means_removed() {
        assert_eq!(read_proposal("[]", &want(7)), Ok(Seen::Missing));
        assert_eq!(read_proposal(&proposal(8, "Approved", 1), &want(7)), Ok(Seen::Missing));
    }

    #[test]
    fn a_proposal_that_does_not_match_the_claim_changes_nothing() {
        let other_proposer = proposal(7, "Approved", 1).replace(ME, "mallory.t");
        assert!(read_proposal(&other_proposer, &want(7)).is_err());
        let other_receiver = proposal(7, "Approved", 1).replace("bob.t", "mallory.t");
        assert!(read_proposal(&other_receiver, &want(7)).is_err());
        let other_amount = proposal(7, "Approved", 1).replace("37500", "37501");
        assert!(read_proposal(&other_amount, &want(7)).is_err());
        let other_token = proposal(7, "Approved", 1).replace(r#""token_id":"""#, r#""token_id":"usdc.t""#);
        assert!(read_proposal(&other_token, &want(7)).is_err());
        let not_transfer = r#"[{"id":7,"proposer":"lantern-guild-3fa9.v1.ovation.testnet","kind":"Vote","status":"Approved","submission_time":"1"}]"#;
        assert!(read_proposal(not_transfer, &want(7)).is_err());
        assert!(read_proposal("nonsense", &want(7)).is_err());
        assert!(read_proposal("{}", &want(7)).is_err());
    }
}

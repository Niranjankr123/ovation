//! Rounds are fixed-length windows counted from the moment a stage opens. Nothing has to be
//! called to start or end one: the clock decides.

/// The four timestamps that bound a round, in nanoseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub starts_ns: u64,
    /// Applause closes here.
    pub ends_ns: u64,
    /// Stewards can void applause until here. Claims open here.
    pub review_ends_ns: u64,
    /// Claims close here. What is unclaimed never left the treasury.
    pub claim_ends_ns: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Upcoming,
    /// Members can applaud.
    Open,
    /// Applause is frozen. Stewards can still void it.
    Review,
    /// Recipients can claim.
    Claimable,
    Closed,
}

impl Phase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Upcoming => "Upcoming",
            Phase::Open => "Open",
            Phase::Review => "Review",
            Phase::Claimable => "Claimable",
            Phase::Closed => "Closed",
        }
    }
}

/// The round that is open at `now_ns`. Rounds are numbered from 0.
pub fn round_at(created_ns: u64, round_ns: u64, now_ns: u64) -> u32 {
    if round_ns == 0 || now_ns <= created_ns {
        return 0;
    }
    let r = (now_ns - created_ns) / round_ns;
    r.min(u32::MAX as u64) as u32
}

pub fn window(created_ns: u64, round_ns: u64, review_ns: u64, claim_ns: u64, round: u32) -> Window {
    let starts_ns = created_ns.saturating_add(round_ns.saturating_mul(round as u64));
    let ends_ns = starts_ns.saturating_add(round_ns);
    let review_ends_ns = ends_ns.saturating_add(review_ns);
    let claim_ends_ns = review_ends_ns.saturating_add(claim_ns);
    Window { starts_ns, ends_ns, review_ends_ns, claim_ends_ns }
}

pub fn phase(now_ns: u64, w: &Window) -> Phase {
    if now_ns < w.starts_ns {
        Phase::Upcoming
    } else if now_ns < w.ends_ns {
        Phase::Open
    } else if now_ns < w.review_ends_ns {
        Phase::Review
    } else if now_ns < w.claim_ends_ns {
        Phase::Claimable
    } else {
        Phase::Closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000_000;

    #[test]
    fn rounds_tile_time_with_no_gaps_or_overlaps() {
        let created = 1_700_000_000 * S;
        let len = 120 * S;
        assert_eq!(round_at(created, len, created), 0);
        assert_eq!(round_at(created, len, created - 5), 0);
        assert_eq!(round_at(created, len, created + len - 1), 0);
        assert_eq!(round_at(created, len, created + len), 1);
        assert_eq!(round_at(created, len, created + 7 * len + 3), 7);
        for r in 0..50u32 {
            let w = window(created, len, 30 * S, 600 * S, r);
            let next = window(created, len, 30 * S, 600 * S, r + 1);
            assert_eq!(w.ends_ns, next.starts_ns);
            assert_eq!(round_at(created, len, w.starts_ns), r);
            assert_eq!(round_at(created, len, w.ends_ns - 1), r);
        }
    }

    #[test]
    fn a_round_moves_through_its_phases_in_order() {
        let w = window(1000 * S, 100 * S, 20 * S, 50 * S, 3);
        assert_eq!(w.starts_ns, 1300 * S);
        assert_eq!(w.ends_ns, 1400 * S);
        assert_eq!(w.review_ends_ns, 1420 * S);
        assert_eq!(w.claim_ends_ns, 1470 * S);
        assert_eq!(phase(1299 * S, &w), Phase::Upcoming);
        assert_eq!(phase(1300 * S, &w), Phase::Open);
        assert_eq!(phase(1400 * S - 1, &w), Phase::Open);
        assert_eq!(phase(1400 * S, &w), Phase::Review);
        assert_eq!(phase(1420 * S - 1, &w), Phase::Review);
        assert_eq!(phase(1420 * S, &w), Phase::Claimable);
        assert_eq!(phase(1470 * S - 1, &w), Phase::Claimable);
        assert_eq!(phase(1470 * S, &w), Phase::Closed);
    }

    #[test]
    fn a_round_with_no_review_opens_claims_the_moment_it_ends() {
        let w = window(0, 60 * S, 0, 60 * S, 0);
        assert_eq!(phase(60 * S, &w), Phase::Claimable);
    }

    #[test]
    fn far_future_times_do_not_overflow() {
        let w = window(u64::MAX - 10, u64::MAX, u64::MAX, u64::MAX, u32::MAX);
        assert_eq!(w.claim_ends_ns, u64::MAX);
        assert_eq!(round_at(0, 1, u64::MAX), u32::MAX);
        assert_eq!(round_at(5, 0, 100), 0);
    }
}

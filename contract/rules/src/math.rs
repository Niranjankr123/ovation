//! The ovation formula, in integers.
//!
//! A recipient's score for a round is `(sum over members of sqrt(claps from that member))^2`.
//! Ten members giving one clap each score 100. One member giving ten claps scores 10.
//! Breadth of applause counts for more than volume, which is what makes two friends trading
//! claps a poor way to take a budget.

/// Square roots are kept to six decimal places.
pub const ROOT_SCALE: u128 = 1_000_000;

/// Largest whole number whose square is not above `n`.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Start at or above the true root, then Newton's method only ever moves down.
    let bits = 128 - n.leading_zeros();
    let mut x: u128 = 1u128 << ((bits + 1) / 2);
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// `sqrt(claps)` scaled by `ROOT_SCALE`, rounded down.
pub fn root(claps: u32) -> u64 {
    isqrt(claps as u128 * ROOT_SCALE * ROOT_SCALE) as u64
}

/// The ovation score for a stored sum of roots. Scaled by `ROOT_SCALE` squared.
pub fn score(root_sum: u64) -> u128 {
    (root_sum as u128) * (root_sum as u128)
}

/// `floor(a * b / c)` without overflow in the middle. `None` if `c` is zero or the answer
/// does not fit in 128 bits.
pub fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let (hi, lo) = widening_mul(a, b);
    if hi >= c {
        return None;
    }
    // Long division of the 256-bit product by c, one bit at a time. `rem` stays below c.
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        if carry == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            q |= 1u128 << i;
        }
    }
    Some(q)
}

/// The full 256-bit product of two 128-bit numbers, as (high, low).
pub fn widening_mul(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = (1u128 << 64) - 1;
    let (a1, a0) = (a >> 64, a & M);
    let (b1, b0) = (b >> 64, b & M);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// One recipient's running totals inside one round.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Tally {
    /// Sum of `root(claps)` over every member who applauded this recipient.
    pub root_sum: u64,
    /// How many different members applauded them.
    pub backers: u16,
    /// Plain count of claps received.
    pub claps: u32,
}

/// Replace one member's applause for this recipient: `old` claps become `new`.
/// `None` if the tally could not have held `old` in the first place.
pub fn retally(t: &Tally, old: u32, new: u32) -> Option<Tally> {
    let root_sum = t.root_sum.checked_sub(root(old))?.checked_add(root(new))?;
    let mut backers = t.backers;
    if old > 0 {
        backers = backers.checked_sub(1)?;
    }
    if new > 0 {
        backers = backers.checked_add(1)?;
    }
    let claps = t.claps.checked_sub(old)?.checked_add(new)?;
    Some(Tally { root_sum, backers, claps })
}

/// What this recipient adds to the round's eligible total: their score, or nothing while
/// fewer than `min_backers` different members have applauded them.
pub fn eligible_part(t: &Tally, min_backers: u16) -> u128 {
    if t.backers > 0 && t.backers >= min_backers {
        score(t.root_sum)
    } else {
        0
    }
}

/// The amount a recipient may claim from a round.
///
/// Pro rata by score among eligible recipients, never above `max_share_bps` of the budget.
/// Everything rounds down, so the amounts of a round can never add up to more than its budget.
pub fn payout(budget: u128, part: u128, eligible_total: u128, max_share_bps: u16) -> u128 {
    if part == 0 || eligible_total == 0 || part > eligible_total {
        return 0;
    }
    let pro_rata = mul_div(budget, part, eligible_total).unwrap_or(0);
    let cap = mul_div(budget, max_share_bps.min(10_000) as u128, 10_000).unwrap_or(0);
    pro_rata.min(cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_is_exact_at_and_around_squares() {
        for n in 0u128..2000 {
            let r = isqrt(n);
            assert!(r * r <= n, "isqrt({n}) too big");
            assert!((r + 1) * (r + 1) > n, "isqrt({n}) too small");
        }
        for k in [1u128 << 20, (1 << 40) + 7, (1 << 63) - 1, u64::MAX as u128] {
            assert_eq!(isqrt(k * k), k);
            assert_eq!(isqrt(k * k - 1), k - 1);
            assert_eq!(isqrt(k * k + 1), k);
        }
        assert_eq!(isqrt(u128::MAX), (1u128 << 64) - 1);
    }

    #[test]
    fn root_of_perfect_squares_has_no_rounding() {
        assert_eq!(root(0), 0);
        assert_eq!(root(1), 1_000_000);
        assert_eq!(root(4), 2_000_000);
        assert_eq!(root(9), 3_000_000);
        assert_eq!(root(100), 10_000_000);
        // sqrt(2) = 1.41421356...
        assert_eq!(root(2), 1_414_213);
        assert_eq!(root(10), 3_162_277);
    }

    #[test]
    fn mul_div_matches_plain_arithmetic_when_small() {
        for a in [0u128, 1, 7, 1000, 123_456_789] {
            for b in [0u128, 1, 3, 999, 987_654_321] {
                for c in [1u128, 2, 7, 1000, 1_000_000_007] {
                    assert_eq!(mul_div(a, b, c), Some(a * b / c));
                }
            }
        }
    }

    #[test]
    fn mul_div_survives_products_past_128_bits() {
        // (2^127) * 6 / 3 = 2^128, which does not fit.
        assert_eq!(mul_div(1 << 127, 6, 3), None);
        // (2^127) * 6 / 4 = 3 * 2^126
        assert_eq!(mul_div(1 << 127, 6, 4), Some(3u128 << 126));
        // max * max / max = max
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        // a realistic one: 1e30 yocto * 4e20 score / 3e22 total
        let got = mul_div(10u128.pow(30), 4 * 10u128.pow(20), 3 * 10u128.pow(22)).unwrap();
        assert_eq!(got, 13_333_333_333_333_333_333_333_333_333);
        assert_eq!(mul_div(5, 5, 0), None);
    }

    /// q*c + r must rebuild the 256-bit product, with r < c. Checked over a spread of inputs.
    #[test]
    fn mul_div_quotient_and_remainder_rebuild_the_product() {
        let mut seed: u128 = 0x9E37_79B9_7F4A_7C15_F39C_C060_5CED_C835;
        let mut next = || {
            // xorshift, good enough to spread bits around
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut checked = 0;
        for _ in 0..20_000 {
            let a = next() >> (next() % 100);
            let b = next() >> (next() % 100);
            let c = (next() >> (next() % 100)).max(1);
            let Some(q) = mul_div(a, b, c) else { continue };
            let (ph, pl) = widening_mul(a, b);
            let (qh, ql) = widening_mul(q, c);
            // remainder = product - q*c, must be below c and non-negative
            let (rl, borrow) = pl.overflowing_sub(ql);
            let rh = ph.wrapping_sub(qh).wrapping_sub(borrow as u128);
            assert_eq!(rh, 0, "remainder spilled into the high half");
            assert!(rl < c, "remainder not below divisor");
            checked += 1;
        }
        assert!(checked > 5_000, "too few cases fit: {checked}");
    }

    #[test]
    fn breadth_beats_volume() {
        // ten members, one clap each
        let mut broad = Tally::default();
        for _ in 0..10 {
            broad = retally(&broad, 0, 1).unwrap();
        }
        // one member, ten claps
        let deep = retally(&Tally::default(), 0, 10).unwrap();
        assert_eq!(broad.claps, deep.claps);
        assert_eq!(score(broad.root_sum), 100 * ROOT_SCALE * ROOT_SCALE);
        // sqrt(10)^2 is 10, less the rounding of the root
        let deep_score = score(deep.root_sum);
        assert!(deep_score <= 10 * ROOT_SCALE * ROOT_SCALE);
        assert!(deep_score > 9_999_990 * ROOT_SCALE);
        assert!(score(broad.root_sum) > 9 * deep_score);
    }

    #[test]
    fn splitting_the_same_claps_across_more_members_never_lowers_a_score() {
        // 12 claps from k members, as evenly as whole claps allow
        let mut last = 0u128;
        for k in 1..=12u32 {
            let mut t = Tally::default();
            let base = 12 / k;
            let extra = 12 % k;
            for i in 0..k {
                let c = base + if i < extra { 1 } else { 0 };
                t = retally(&t, 0, c).unwrap();
            }
            assert_eq!(t.claps, 12);
            let s = score(t.root_sum);
            assert!(s >= last, "k={k} lowered the score");
            last = s;
        }
    }

    #[test]
    fn retally_is_reversible_and_refuses_impossible_changes() {
        let t0 = Tally::default();
        let t1 = retally(&t0, 0, 3).unwrap();
        let t2 = retally(&t1, 0, 5).unwrap();
        assert_eq!(t2, Tally { root_sum: root(3) + root(5), backers: 2, claps: 8 });
        let t3 = retally(&t2, 3, 1).unwrap();
        assert_eq!(t3, Tally { root_sum: root(1) + root(5), backers: 2, claps: 6 });
        let t4 = retally(&t3, 1, 0).unwrap();
        let t5 = retally(&t4, 5, 0).unwrap();
        assert_eq!(t5, t0);
        // cannot take away applause that was never there
        assert_eq!(retally(&t0, 2, 0), None);
        assert_eq!(retally(&t1, 4, 0), None);
    }

    #[test]
    fn a_recipient_below_min_backers_adds_nothing() {
        let one = retally(&Tally::default(), 0, 5).unwrap();
        assert_eq!(eligible_part(&one, 2), 0);
        assert_eq!(eligible_part(&one, 1), score(one.root_sum));
        let two = retally(&one, 0, 1).unwrap();
        assert_eq!(eligible_part(&two, 2), score(two.root_sum));
        assert_eq!(eligible_part(&Tally::default(), 0), 0);
    }

    #[test]
    fn payouts_never_exceed_the_budget() {
        let budget = 1_000_000_000_000_000_000_000_000u128; // 1 NEAR
        let tallies = [
            [1u32, 1, 1, 1].as_slice(),
            [10].as_slice(),
            [2, 3].as_slice(),
            [1, 1, 1, 1, 1, 1, 1].as_slice(),
            [5, 5, 5].as_slice(),
        ];
        let parts: Vec<u128> = tallies
            .iter()
            .map(|claps| {
                let mut t = Tally::default();
                for c in claps.iter() {
                    t = retally(&t, 0, *c).unwrap();
                }
                eligible_part(&t, 1)
            })
            .collect();
        let total: u128 = parts.iter().sum();
        for cap in [10_000u16, 5_000, 2_500, 1] {
            let paid: u128 = parts.iter().map(|p| payout(budget, *p, total, cap)).sum();
            assert!(paid <= budget, "cap {cap}: paid {paid} over budget");
            for p in &parts {
                assert!(payout(budget, *p, total, cap) <= budget / 10_000 * cap as u128 + 1);
            }
        }
        // uncapped, rounding loses at most one unit per recipient
        let paid: u128 = parts.iter().map(|p| payout(budget, *p, total, 10_000)).sum();
        assert!(budget - paid < parts.len() as u128);
    }

    #[test]
    fn payout_handles_tokens_with_few_decimals() {
        // 100 USDC (6 decimals) split between scores far larger than the budget itself
        let budget = 100_000_000u128;
        let a = score(root(1) * 4); // four members, one clap each
        let b = score(root(9)); // one member, nine claps
        let total = a + b;
        let pa = payout(budget, a, total, 10_000);
        let pb = payout(budget, b, total, 10_000);
        assert_eq!(pa, 64_000_000); // 16 / 25
        assert_eq!(pb, 36_000_000); // 9 / 25
    }

    #[test]
    fn payout_is_zero_when_nothing_is_eligible() {
        assert_eq!(payout(1000, 0, 10, 10_000), 0);
        assert_eq!(payout(1000, 5, 0, 10_000), 0);
        assert_eq!(payout(1000, 11, 10, 10_000), 0);
        assert_eq!(payout(0, 5, 10, 10_000), 0);
    }
}

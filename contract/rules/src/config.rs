//! What a DAO is allowed to set when it opens a stage.

use crate::text::valid_label;

pub const MIN_ROUND_SECS: u32 = 60;
pub const MAX_ROUND_SECS: u32 = 366 * 86_400;
pub const MAX_REVIEW_SECS: u32 = 30 * 86_400;
pub const MIN_CLAIM_SECS: u32 = 60;
pub const MAX_CLAIM_SECS: u32 = 366 * 86_400;
pub const MAX_CLAPS_PER_ROUND: u16 = 1000;
pub const MAX_MIN_BACKERS: u16 = 50;
pub const MAX_ROLES: usize = 8;
pub const MAX_ROLE_NAME_CHARS: usize = 64;

pub struct ConfigFacts<'a> {
    pub round_budget: u128,
    pub min_payout: u128,
    pub auto_limit_new: u128,
    pub auto_limit_trusted: u128,
    pub cosign_limit: u128,
    pub auto_round_cap: u128,
    pub round_secs: u32,
    pub review_secs: u32,
    pub claim_secs: u32,
    pub claps_per_round: u16,
    pub min_backers: u16,
    pub max_share_bps: u16,
    pub clapper_roles: &'a [String],
    pub steward_roles: &'a [String],
    pub label: &'a str,
    pub token_symbol: &'a str,
    pub token_decimals: u8,
}

pub fn check_config(c: &ConfigFacts) -> Result<(), String> {
    if c.round_budget == 0 {
        return Err("ERR_CONFIG: round_budget must be above zero".into());
    }
    if c.round_secs < MIN_ROUND_SECS || c.round_secs > MAX_ROUND_SECS {
        return Err(format!("ERR_CONFIG: round_secs must be {MIN_ROUND_SECS} to {MAX_ROUND_SECS}"));
    }
    if c.review_secs > MAX_REVIEW_SECS {
        return Err(format!("ERR_CONFIG: review_secs must be at most {MAX_REVIEW_SECS}"));
    }
    if c.claim_secs < MIN_CLAIM_SECS || c.claim_secs > MAX_CLAIM_SECS {
        return Err(format!("ERR_CONFIG: claim_secs must be {MIN_CLAIM_SECS} to {MAX_CLAIM_SECS}"));
    }
    if c.claps_per_round == 0 || c.claps_per_round > MAX_CLAPS_PER_ROUND {
        return Err(format!("ERR_CONFIG: claps_per_round must be 1 to {MAX_CLAPS_PER_ROUND}"));
    }
    if c.min_backers == 0 || c.min_backers > MAX_MIN_BACKERS {
        return Err(format!("ERR_CONFIG: min_backers must be 1 to {MAX_MIN_BACKERS}"));
    }
    if c.max_share_bps == 0 || c.max_share_bps > 10_000 {
        return Err("ERR_CONFIG: max_share_bps must be 1 to 10000".into());
    }
    if c.auto_limit_new > c.auto_limit_trusted {
        return Err("ERR_CONFIG: auto_limit_new cannot be above auto_limit_trusted".into());
    }
    if c.auto_limit_trusted > c.cosign_limit {
        return Err("ERR_CONFIG: auto_limit_trusted cannot be above cosign_limit".into());
    }
    if c.auto_round_cap > c.round_budget {
        return Err("ERR_CONFIG: auto_round_cap cannot be above round_budget".into());
    }
    if c.min_payout > c.round_budget {
        return Err("ERR_CONFIG: min_payout cannot be above round_budget".into());
    }
    check_roles("clapper_roles", c.clapper_roles)?;
    check_roles("steward_roles", c.steward_roles)?;
    if !valid_label(c.label) {
        return Err("ERR_CONFIG: label must be 1 to 40 characters of plain words: letters, digits, spaces and - ' & , . ( )".into());
    }
    let sym_ok = !c.token_symbol.is_empty()
        && c.token_symbol.len() <= 12
        && c.token_symbol.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if !sym_ok {
        return Err("ERR_CONFIG: token_symbol must be 1 to 12 letters or digits".into());
    }
    if c.token_decimals > 24 {
        return Err("ERR_CONFIG: token_decimals must be at most 24".into());
    }
    Ok(())
}

fn check_roles(field: &str, roles: &[String]) -> Result<(), String> {
    if roles.is_empty() || roles.len() > MAX_ROLES {
        return Err(format!("ERR_CONFIG: {field} must name 1 to {MAX_ROLES} DAO roles"));
    }
    for (i, r) in roles.iter().enumerate() {
        if r.is_empty() || r.chars().count() > MAX_ROLE_NAME_CHARS {
            return Err(format!("ERR_CONFIG: a name in {field} is empty or too long"));
        }
        if roles[..i].contains(r) {
            return Err(format!("ERR_CONFIG: {field} names a role twice"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roles(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn good<'a>(clappers: &'a [String], stewards: &'a [String]) -> ConfigFacts<'a> {
        ConfigFacts {
            round_budget: 1000,
            min_payout: 1,
            auto_limit_new: 20,
            auto_limit_trusted: 50,
            cosign_limit: 70,
            auto_round_cap: 600,
            round_secs: 14 * 86_400,
            review_secs: 2 * 86_400,
            claim_secs: 30 * 86_400,
            claps_per_round: 10,
            min_backers: 2,
            max_share_bps: 4000,
            clapper_roles: clappers,
            steward_roles: stewards,
            label: "Lantern Guild",
            token_symbol: "NEAR",
            token_decimals: 24,
        }
    }

    #[test]
    fn a_sensible_config_passes() {
        let (c, s) = (roles(&["council", "members"]), roles(&["council"]));
        assert_eq!(check_config(&good(&c, &s)), Ok(()));
    }

    #[test]
    fn each_bound_is_enforced() {
        let (c, s) = (roles(&["members"]), roles(&["council"]));
        let bad = |f: &dyn Fn(&mut ConfigFacts)| {
            let mut cfg = good(&c, &s);
            f(&mut cfg);
            check_config(&cfg).is_err()
        };
        assert!(bad(&|x| x.round_budget = 0));
        assert!(bad(&|x| x.round_secs = 59));
        assert!(bad(&|x| x.round_secs = MAX_ROUND_SECS + 1));
        assert!(bad(&|x| x.review_secs = MAX_REVIEW_SECS + 1));
        assert!(bad(&|x| x.claim_secs = 59));
        assert!(bad(&|x| x.claps_per_round = 0));
        assert!(bad(&|x| x.claps_per_round = 1001));
        assert!(bad(&|x| x.min_backers = 0));
        assert!(bad(&|x| x.min_backers = 51));
        assert!(bad(&|x| x.max_share_bps = 0));
        assert!(bad(&|x| x.max_share_bps = 10_001));
        assert!(bad(&|x| x.auto_limit_new = 51));
        assert!(bad(&|x| x.auto_limit_trusted = 71));
        assert!(bad(&|x| x.auto_round_cap = 1001));
        assert!(bad(&|x| x.min_payout = 1001));
        assert!(bad(&|x| x.label = "bad @label"));
        assert!(bad(&|x| x.label = "Claim at evil.example"));
        assert!(bad(&|x| x.token_symbol = ""));
        assert!(bad(&|x| x.token_symbol = "has space"));
        assert!(bad(&|x| x.token_decimals = 25));
    }

    #[test]
    fn limits_may_be_equal_and_zero() {
        let (c, s) = (roles(&["members"]), roles(&["council"]));
        let mut cfg = good(&c, &s);
        cfg.auto_limit_new = 0;
        cfg.auto_limit_trusted = 0;
        cfg.cosign_limit = 0;
        cfg.auto_round_cap = 0;
        cfg.review_secs = 0;
        assert_eq!(check_config(&cfg), Ok(()));
    }

    #[test]
    fn role_lists_must_be_present_short_and_distinct() {
        let s = roles(&["council"]);
        let empty: Vec<String> = vec![];
        assert!(check_config(&good(&empty, &s)).is_err());
        let dup = roles(&["a", "a"]);
        assert!(check_config(&good(&dup, &s)).is_err());
        let many = roles(&["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
        assert!(check_config(&good(&many, &s)).is_err());
        let blank = roles(&[""]);
        assert!(check_config(&good(&s, &blank)).is_err());
    }
}

//! Reading a Sputnik DAO's policy.
//!
//! Ovation keeps no member list of its own. Who may applaud and who may oversee is whoever
//! the DAO already holds in the roles it named. This module turns the JSON that the DAO's
//! `get_policy` returns into those two lists, the DAO's proposal bond and period, and a
//! check of what the DAO's policy lets this contract do.

use crate::text::valid_account_id;
use serde_json::Value;

/// The only three permissions Ovation needs.
pub const NEEDED: [&str; 3] = ["transfer:AddProposal", "transfer:VoteApprove", "transfer:Finalize"];

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct PolicyFacts {
    /// Accounts that may applaud, sorted, without the DAO or this contract.
    pub clappers: Vec<String>,
    /// Accounts that may void, co-sign and pause, sorted.
    pub stewards: Vec<String>,
    /// What the DAO asks to be attached to a new proposal, in yoctoNEAR.
    pub bond: u128,
    /// How long a proposal stays open, in nanoseconds.
    pub period_ns: u64,
    /// The DAO role that holds this contract, if any.
    pub role: Option<String>,
    pub can_add: bool,
    pub can_approve: bool,
    pub can_finalize: bool,
    /// This contract's single vote passes a transfer.
    pub solo: bool,
    /// Other accounts share the contract's role.
    pub shared: bool,
    /// The contract's role holds permissions beyond the three it needs.
    pub wide: bool,
    /// Roles the stage named that are not a fixed group of accounts, so were not read.
    pub skipped_roles: Vec<String>,
    /// Roles the stage named that the DAO does not have.
    pub missing_roles: Vec<String>,
}

fn has(perms: &[&str], kind: &str, action: &str) -> bool {
    perms.iter().any(|p| {
        *p == format!("{kind}:{action}") || *p == format!("{kind}:*") || *p == format!("*:{action}") || *p == "*:*"
    })
}

fn as_u128(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64().map(|x| x as u128),
        _ => None,
    }
}

/// The number of approve votes one role needs to pass a transfer, as Sputnik computes it.
/// `None` when the role votes by token weight, which a contract's single vote cannot meet.
fn approve_threshold(role: &Value, default_policy: &Value, group_size: u128) -> Option<u128> {
    let vp = role.get("vote_policy").and_then(|m| m.get("transfer")).unwrap_or(default_policy);
    if vp.get("weight_kind").and_then(Value::as_str) != Some("RoleWeight") {
        return None;
    }
    let quorum = vp.get("quorum").and_then(as_u128).unwrap_or(0);
    let weight = match vp.get("threshold")? {
        Value::Array(a) if a.len() == 2 => {
            let num = a[0].as_u64()? as u128;
            let den = a[1].as_u64()? as u128;
            if den == 0 {
                return None;
            }
            (num * group_size / den + 1).min(group_size)
        }
        other => as_u128(other)?.min(group_size),
    };
    Some(quorum.max(weight))
}

/// Read `get_policy` for a stage of `dao` run by the contract `me`.
pub fn read_policy(
    json: &str,
    me: &str,
    dao: &str,
    clapper_roles: &[String],
    steward_roles: &[String],
    max_members: usize,
) -> Result<PolicyFacts, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| "ERR_POLICY: the DAO's policy is not JSON".to_string())?;
    let roles = v.get("roles").and_then(Value::as_array).ok_or("ERR_POLICY: the DAO's policy has no roles")?;
    let default_policy = v.get("default_vote_policy").cloned().unwrap_or(Value::Null);

    let mut f = PolicyFacts {
        bond: v.get("proposal_bond").and_then(as_u128).ok_or("ERR_POLICY: no proposal_bond")?,
        period_ns: v
            .get("proposal_period")
            .and_then(as_u128)
            .and_then(|p| u64::try_from(p).ok())
            .ok_or("ERR_POLICY: no proposal_period")?,
        ..Default::default()
    };

    let mut seen_names: Vec<&str> = Vec::new();
    for role in roles {
        let name = role.get("name").and_then(Value::as_str).unwrap_or("");
        seen_names.push(name);
        let group: Option<Vec<&str>> = role
            .get("kind")
            .and_then(|k| k.get("Group"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect());
        let wanted_clap = clapper_roles.iter().any(|r| r == name);
        let wanted_steward = steward_roles.iter().any(|r| r == name);

        let Some(group) = group else {
            if wanted_clap || wanted_steward {
                f.skipped_roles.push(name.to_string());
            }
            continue;
        };

        for a in &group {
            if !valid_account_id(a) || *a == me || *a == dao {
                continue;
            }
            if wanted_clap {
                f.clappers.push((*a).to_string());
            }
            if wanted_steward {
                f.stewards.push((*a).to_string());
            }
        }

        if group.contains(&me) {
            let perms: Vec<&str> = role
                .get("permissions")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let add = has(&perms, "transfer", "AddProposal");
            let approve = has(&perms, "transfer", "VoteApprove");
            f.can_add |= add;
            f.can_finalize |= has(&perms, "transfer", "Finalize");
            if approve {
                f.can_approve = true;
                if approve_threshold(role, &default_policy, group.len() as u128) == Some(1) {
                    f.solo = true;
                }
            }
            if f.role.is_none() || approve {
                f.role = Some(name.to_string());
            }
            f.shared |= group.len() > 1;
            f.wide |= perms.iter().any(|p| !NEEDED.contains(p));
        }
    }

    for r in clapper_roles.iter().chain(steward_roles.iter()) {
        if !seen_names.contains(&r.as_str()) && !f.missing_roles.contains(r) {
            f.missing_roles.push(r.clone());
        }
    }
    f.skipped_roles.sort();
    f.skipped_roles.dedup();
    f.clappers.sort();
    f.clappers.dedup();
    f.stewards.sort();
    f.stewards.dedup();
    if f.clappers.len() > max_members || f.stewards.len() > max_members {
        return Err(format!("ERR_POLICY: more than {max_members} accounts in the stage's roles"));
    }
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "v1.ovation.testnet";
    const DAO: &str = "lantern.sputnikv2.testnet";

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// The shape Sputnik 2.3.1 returns on testnet, with an Ovation role installed.
    fn policy() -> String {
        r#"{
          "roles": [
            {"name":"council","kind":{"Group":["asha.t","diego.t","mei.t"]},
             "permissions":["*:AddProposal","*:VoteApprove","*:VoteReject","*:VoteRemove","*:Finalize"],"vote_policy":{}},
            {"name":"members","kind":{"Group":["noor.t","kofi.t","asha.t","v1.ovation.testnet","lantern.sputnikv2.testnet","Bad Name"]},
             "permissions":[],"vote_policy":{}},
            {"name":"all","kind":"Everyone","permissions":["transfer:AddProposal"],"vote_policy":{}},
            {"name":"ovation","kind":{"Group":["v1.ovation.testnet"]},
             "permissions":["transfer:AddProposal","transfer:VoteApprove","transfer:Finalize"],
             "vote_policy":{"transfer":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,1]}}}
          ],
          "default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]},
          "proposal_bond":"10000000000000000000000",
          "proposal_period":"604800000000000",
          "bounty_bond":"10000000000000000000000",
          "bounty_forgiveness_period":"86400000000000"
        }"#
        .to_string()
    }

    #[test]
    fn reads_members_bond_and_period() {
        let f = read_policy(&policy(), ME, DAO, &names(&["council", "members"]), &names(&["council"]), 100).unwrap();
        assert_eq!(f.clappers, names(&["asha.t", "diego.t", "kofi.t", "mei.t", "noor.t"]));
        assert_eq!(f.stewards, names(&["asha.t", "diego.t", "mei.t"]));
        assert_eq!(f.bond, 10_000_000_000_000_000_000_000);
        assert_eq!(f.period_ns, 604_800_000_000_000);
        assert!(f.missing_roles.is_empty());
        assert!(f.skipped_roles.is_empty());
    }

    #[test]
    fn sees_that_the_contract_can_file_and_pass_a_transfer_alone() {
        let f = read_policy(&policy(), ME, DAO, &names(&["members"]), &names(&["council"]), 100).unwrap();
        assert_eq!(f.role.as_deref(), Some("ovation"));
        assert!(f.can_add && f.can_approve && f.can_finalize && f.solo);
        // the contract also sits in "members", which shares that role with people
        assert!(f.shared);
        assert!(!f.wide);
    }

    #[test]
    fn a_dao_without_the_role_gives_the_contract_nothing() {
        let p = policy().replace("\"v1.ovation.testnet\"", "\"someone.else\"");
        let f = read_policy(&p, ME, DAO, &names(&["members"]), &names(&["council"]), 100).unwrap();
        assert_eq!(f.role, None);
        assert!(!f.can_add && !f.can_approve && !f.can_finalize && !f.solo && !f.shared && !f.wide);
    }

    #[test]
    fn a_two_account_role_at_half_cannot_pass_alone() {
        let p = policy()
            .replace(r#"{"Group":["v1.ovation.testnet"]}"#, r#"{"Group":["v1.ovation.testnet","other.t"]}"#)
            .replace(r#""threshold":[1,1]}}}"#, r#""threshold":[1,2]}}}"#);
        let f = read_policy(&p, ME, DAO, &names(&["council"]), &names(&["council"]), 100).unwrap();
        assert!(f.can_approve);
        assert!(!f.solo, "two members at 1/2 need two votes");
        assert!(f.shared);
    }

    #[test]
    fn solo_follows_the_default_policy_when_the_role_has_none() {
        let p = policy().replace(
            r#""vote_policy":{"transfer":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,1]}}"#,
            r#""vote_policy":{}"#,
        );
        let f = read_policy(&p, ME, DAO, &names(&["council"]), &names(&["council"]), 100).unwrap();
        // one member at the default 1/2: min(1*1/2 + 1, 1) = 1
        assert!(f.solo);
        let q = p.replace(r#""default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0""#, r#""default_vote_policy":{"weight_kind":"RoleWeight","quorum":"2""#);
        assert!(!read_policy(&q, ME, DAO, &names(&["council"]), &names(&["council"]), 100).unwrap().solo);
        let t = p.replace(r#""default_vote_policy":{"weight_kind":"RoleWeight""#, r#""default_vote_policy":{"weight_kind":"TokenWeight""#);
        assert!(!read_policy(&t, ME, DAO, &names(&["council"]), &names(&["council"]), 100).unwrap().solo);
    }

    #[test]
    fn a_wide_role_is_flagged() {
        let p = policy().replace(r#""transfer:AddProposal","transfer:VoteApprove","transfer:Finalize"]"#, r#""*:*"]"#);
        let f = read_policy(&p, ME, DAO, &names(&["council"]), &names(&["council"]), 100).unwrap();
        assert!(f.can_add && f.can_approve && f.can_finalize);
        assert!(f.wide);
    }

    #[test]
    fn open_and_missing_roles_are_reported_not_read() {
        let f = read_policy(&policy(), ME, DAO, &names(&["all", "ghosts", "council"]), &names(&["nobody"]), 100).unwrap();
        assert_eq!(f.skipped_roles, names(&["all"]));
        assert_eq!(f.missing_roles, names(&["ghosts", "nobody"]));
        assert_eq!(f.clappers, names(&["asha.t", "diego.t", "mei.t"]));
        assert!(f.stewards.is_empty());
    }

    #[test]
    fn refuses_oversized_roles_and_broken_json() {
        assert!(read_policy(&policy(), ME, DAO, &names(&["council"]), &names(&["council"]), 2).is_err());
        assert!(read_policy("not json", ME, DAO, &names(&["council"]), &names(&["council"]), 100).is_err());
        assert!(read_policy("{}", ME, DAO, &names(&["council"]), &names(&["council"]), 100).is_err());
        assert!(read_policy(r#"{"roles":[]}"#, ME, DAO, &names(&["council"]), &names(&["council"]), 100).is_err());
    }

    #[test]
    fn weight_thresholds_are_read_too() {
        let p = policy().replace(r#""threshold":[1,1]}}}"#, r#""threshold":"1"}}}"#);
        assert!(read_policy(&p, ME, DAO, &names(&["council"]), &names(&["council"]), 100).unwrap().solo);
        let p2 = policy().replace(r#""threshold":[1,1]}}}"#, r#""threshold":"3"}}}"#);
        // a weight above the group size is capped at the group size, which is 1
        assert!(read_policy(&p2, ME, DAO, &names(&["council"]), &names(&["council"]), 100).unwrap().solo);
    }
}

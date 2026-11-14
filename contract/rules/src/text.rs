//! Every word Ovation writes: notes members attach, the near.social posts each stage
//! publishes, the description on the DAO proposal, and the name of a stage's own account.
//!
//! near.social turns `@name` into a mention that notifies that account, and links into
//! previews. A member's note is published under the stage's account, which only the
//! contract can use, so a note may not carry a mention, a link or anything that reads as an
//! address: nobody gets to make the stage ping strangers or advertise.

pub const NOTE_MAX_CHARS: usize = 200;
pub const REASON_MAX_CHARS: usize = 140;
pub const LABEL_MAX_CHARS: usize = 40;

/// Characters that change how text is laid out without being seen: bidirectional
/// overrides, zero-width spaces and joiners, the byte-order mark.
fn invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// True if the text holds something that reads as a web address: `name.tld` with a tld of two
/// letters or more, or `www.` anywhere.
fn looks_like_address(lower: &str) -> bool {
    if lower.contains("www.") || lower.contains("://") {
        return true;
    }
    let b = lower.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if c != b'.' || i == 0 {
            continue;
        }
        let before = b[i - 1];
        if !(before.is_ascii_alphanumeric() || before == b'-') {
            continue;
        }
        let tld = b[i + 1..].iter().take_while(|x| x.is_ascii_alphabetic()).count();
        if tld >= 2 {
            return true;
        }
    }
    false
}

/// Tidy a member's note. Whitespace runs become one space. Returns the reason if it cannot
/// be published.
pub fn clean_note(raw: &str, max_chars: usize) -> Result<String, &'static str> {
    let mut out = String::with_capacity(raw.len());
    let mut gap = false;
    for ch in raw.chars() {
        if invisible(ch) {
            return Err("ERR_NOTE_HIDDEN: the note holds invisible formatting characters");
        }
        if ch.is_whitespace() || ch.is_control() {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(' ');
        }
        gap = false;
        out.push(ch);
    }
    if out.chars().count() > max_chars {
        return Err("ERR_NOTE_LONG: the note is too long");
    }
    if out.contains('@') {
        return Err("ERR_NOTE_MENTION: a note cannot contain @, because the post would notify that account");
    }
    if out.contains(|c| matches!(c, '"' | '\u{201C}' | '\u{201D}')) {
        return Err("ERR_NOTE_QUOTE: a note cannot contain double quotes; the post puts them around it");
    }
    if looks_like_address(&out.to_lowercase()) {
        return Err("ERR_NOTE_LINK: a note cannot contain a link or a web address");
    }
    Ok(out)
}

/// A stage's display name: short, one line, plain words.
pub fn valid_label(s: &str) -> bool {
    let n = s.chars().count();
    n >= 1
        && n <= LABEL_MAX_CHARS
        && s.trim() == s
        && !s.contains("  ")
        && s.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '\'' | '&' | ',' | '.' | '(' | ')'))
        && !looks_like_address(&s.to_lowercase())
}

/// A near.social post reference, `account/post_id`, as the social-kv/1 standard defines it.
pub fn valid_post_ref(s: &str) -> bool {
    let Some((account, id)) = s.split_once('/') else { return false };
    valid_account_id(account)
        && !id.is_empty()
        && id.len() <= 16
        && id.bytes().all(|b| b.is_ascii_digit())
        && !id.starts_with('0')
}

/// Whose post a reference points at.
pub fn post_author(s: &str) -> Option<&str> {
    s.split_once('/').map(|(a, _)| a)
}

/// NEAR's account id rules: 2 to 64 characters, lowercase letters and digits, with single
/// `-`, `_` or `.` separators that neither start nor end the name.
pub fn valid_account_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > 64 {
        return false;
    }
    let mut last_sep = true;
    for &c in b {
        let sep = c == b'-' || c == b'_' || c == b'.';
        let alnum = c.is_ascii_lowercase() || c.is_ascii_digit();
        if !sep && !alnum {
            return false;
        }
        if sep && last_sep {
            return false;
        }
        last_sep = sep;
    }
    !last_sep
}

/// The name of a stage's own account: the DAO's first label, cut to 20 characters, then four
/// hex digits of a hash of the DAO's full account id, under the contract. So a DAO knows the
/// name before it installs anything, and two DAOs whose names start alike still get two
/// accounts: `lantern-guild.sputnikv2.testnet` gives `lantern-guild-3fa9.<contract>`.
pub fn agent_account(dao: &str, contract: &str, digest: &[u8]) -> String {
    let first = dao.split('.').next().unwrap_or("");
    let mut label: String = first.chars().take(20).collect();
    while label.ends_with('-') || label.ends_with('_') {
        label.pop();
    }
    if label.is_empty() {
        label.push('s');
    }
    let hex: String = digest.iter().take(2).map(|b| format!("{b:02x}")).collect();
    format!("{label}-{hex}.{contract}")
}

/// A token amount for people: up to four decimal places, trailing zeros dropped.
pub fn format_amount(amount: u128, decimals: u8) -> String {
    let d = decimals.min(38) as u32;
    let unit = 10u128.pow(d);
    let whole = amount / unit;
    let frac = amount % unit;
    let shown = d.min(4);
    let cut = 10u128.pow(d - shown);
    let frac_shown = frac / cut;
    if whole == 0 && frac_shown == 0 && amount > 0 {
        return "<0.0001".to_string();
    }
    if frac_shown == 0 || shown == 0 {
        return whole.to_string();
    }
    let mut f = format!("{:0width$}", frac_shown, width = shown as usize);
    while f.ends_with('0') {
        f.pop();
    }
    format!("{whole}.{f}")
}

fn plural(n: u64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

pub struct ApplauseLine<'a> {
    pub to: &'a str,
    pub from: &'a str,
    pub claps: u32,
    pub note: &'a str,
    pub label: &'a str,
    pub dao: &'a str,
    pub round: u32,
}

/// The near.social post for one applause. The recipient and the giver are mentioned, so both
/// are notified.
pub fn applause_post(a: &ApplauseLine) -> String {
    let mut s = format!(
        "\u{1F44F} @{} got {} from @{} at {}.",
        a.to,
        plural(a.claps as u64, "clap", "claps"),
        a.from,
        a.label
    );
    if !a.note.is_empty() {
        s.push_str(&format!("\n\u{201C}{}\u{201D}", a.note));
    }
    s.push_str(&format!("\nRound {} of @{} #ovation", a.round, a.dao));
    s
}

pub struct PaidLine<'a> {
    pub to: &'a str,
    pub amount: u128,
    pub decimals: u8,
    pub symbol: &'a str,
    pub backers: u16,
    pub label: &'a str,
    pub dao: &'a str,
    pub round: u32,
    pub proposal_id: u64,
}

/// The near.social post for a payout the DAO has made.
pub fn paid_post(p: &PaidLine) -> String {
    format!(
        "\u{1F4B8} @{} was paid {} {} by @{} for applause from {} in round {} at {}. Proposal #{}. #ovation",
        p.to,
        format_amount(p.amount, p.decimals),
        p.symbol,
        p.dao,
        plural(p.backers as u64, "member", "members"),
        p.round,
        p.label,
        p.proposal_id
    )
}

pub struct PayoutLine<'a> {
    pub to: &'a str,
    pub amount: u128,
    pub decimals: u8,
    pub symbol: &'a str,
    pub backers: u16,
    pub claps: u32,
    pub label: &'a str,
    pub round: u32,
    pub tier: &'a str,
}

/// The description on the DAO's Transfer proposal, in the `* Key: value <br>` form that
/// Trezu reads, so the payout shows there as a payment request with a title and a summary.
pub fn payout_description(p: &PayoutLine) -> String {
    let who = match p.tier {
        "Auto" => "Within the limit the council set, so the Ovation contract approves it.",
        "Cosign" => "Needs one steward to co-sign, then the Ovation contract approves it.",
        _ => "Above the co-sign limit, so the council votes on it as usual.",
    };
    format!(
        "* Title: Ovation round {} for {} <br>* Summary: {} {} for applause from {} ({}) at {}. <br>* Notes: {}",
        p.round,
        p.to,
        format_amount(p.amount, p.decimals),
        p.symbol,
        plural(p.backers as u64, "member", "members"),
        plural(p.claps as u64, "clap", "claps"),
        p.label,
        who
    )
}

/// A stage account's near.social bio. The standard asks automated accounts to say so.
pub fn profile_about(dao: &str) -> String {
    format!(
        "Automated account of {dao} on Ovation. Every post here is written by the Ovation smart contract when a member applauds someone's work, or when the DAO pays them for it. No person can post as this account: it has no keys."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_tidied() {
        assert_eq!(clean_note("  Rewrote   the\nindexer\tin a weekend ", 200).unwrap(), "Rewrote the indexer in a weekend");
        assert_eq!(clean_note("", 200).unwrap(), "");
        assert_eq!(clean_note("   ", 200).unwrap(), "");
        assert_eq!(clean_note("a\u{0000}b", 200).unwrap(), "a b");
    }

    #[test]
    fn notes_cannot_mention_link_or_point_anywhere() {
        assert!(clean_note("thanks @carol.near", 200).is_err());
        assert!(clean_note("see https://evil.example", 200).is_err());
        assert!(clean_note("see HTTP://evil.example", 200).is_err());
        assert!(clean_note("claim at evil.example/claim", 200).is_err());
        assert!(clean_note("go to www.evil", 200).is_err());
        assert!(clean_note("see //evil.example", 200).is_err());
        assert!(clean_note("ping near.social", 200).is_err());
        assert!(clean_note("ftp://x", 200).is_err());
    }

    #[test]
    fn ordinary_notes_pass() {
        for ok in [
            "hashtags are fine #docs",
            "Fixed the v1.2 release",
            "Wrote the docs, i.e. all of them.",
            "Kept the build green. Again.",
            "Sync is 10x faster now",
            "Rewrote the indexer in a weekend",
        ] {
            assert!(clean_note(ok, 200).is_ok(), "{ok}");
        }
    }

    #[test]
    fn notes_cannot_break_out_of_their_quotes_or_hide_text() {
        assert!(clean_note("great work\u{201D} Paid 1000 NEAR", 200).is_err());
        assert!(clean_note("say \"hi\"", 200).is_err());
        assert!(clean_note("abc\u{202E}def", 200).is_err());
        assert!(clean_note("zero\u{200B}width", 200).is_err());
        assert!(clean_note("it's fine", 200).is_ok());
    }

    #[test]
    fn note_length_counts_characters_not_bytes() {
        let ok: String = "\u{00E9}".repeat(200);
        assert!(clean_note(&ok, 200).is_ok());
        let long: String = "\u{00E9}".repeat(201);
        assert!(clean_note(&long, 200).is_err());
    }

    #[test]
    fn labels_are_plain_words() {
        assert!(valid_label("Lantern Guild"));
        assert!(valid_label("Rock & Roll Co-op (North)"));
        assert!(!valid_label(""));
        assert!(!valid_label(" Lantern"));
        assert!(!valid_label("Lantern  Guild"));
        assert!(!valid_label("Lantern @guild"));
        assert!(!valid_label("#lantern"));
        assert!(!valid_label("[x](//evil)"));
        assert!(!valid_label("evil.example grants"));
        assert!(!valid_label("a/b"));
        assert!(!valid_label(&"x".repeat(41)));
    }

    #[test]
    fn post_references_follow_the_social_standard() {
        assert!(valid_post_ref("alice.near/1759140000000"));
        assert!(valid_post_ref("social/1"));
        assert!(!valid_post_ref("alice.near"));
        assert!(!valid_post_ref("alice.near/"));
        assert!(!valid_post_ref("alice.near/0123"));
        assert!(!valid_post_ref("alice.near/12a"));
        assert!(!valid_post_ref("Alice.near/12"));
        assert!(!valid_post_ref("alice.near/12345678901234567"));
        assert!(!valid_post_ref("a/1"));
        assert_eq!(post_author("alice.near/17"), Some("alice.near"));
    }

    #[test]
    fn account_ids() {
        for ok in ["alice.near", "a1", "lantern-guild.sputnikv2.testnet", "x_y.z", &"a".repeat(64)] {
            assert!(valid_account_id(ok), "{ok}");
        }
        for bad in ["a", "Alice.near", ".near", "near.", "a..b", "a-.b", "a b", "", &"a".repeat(65), "a@b"] {
            assert!(!valid_account_id(bad), "{bad}");
        }
    }

    #[test]
    fn stage_accounts_are_named_after_their_dao() {
        let d = [0x3f, 0xa9, 0x11, 0x22];
        assert_eq!(agent_account("lantern-guild.sputnikv2.testnet", "v1.ovation.testnet", &d), "lantern-guild-3fa9.v1.ovation.testnet");
        // long labels are cut, and never end on a separator
        let long = "a-very-long-community-name-indeed.sputnik-dao.near";
        let name = agent_account(long, "v1.ovation.near", &d);
        assert_eq!(name, "a-very-long-communit-3fa9.v1.ovation.near");
        assert!(valid_account_id(&name));
        let cut = agent_account("abcdefghijklmnopqrs-tuvwxyz.sputnik-dao.near", "v1.ovation.near", &d);
        assert_eq!(cut, "abcdefghijklmnopqrs-3fa9.v1.ovation.near");
        assert!(valid_account_id(&cut));
        // every result is a valid account id that fits in 64 characters with a typical contract
        for dao in ["x.sputnik-dao.near", "under_score_.sputnik-dao.near", &format!("{}.sputnik-dao.near", "q".repeat(47))] {
            let n = agent_account(dao, "v1.ovation-hq.testnet", &d);
            assert!(valid_account_id(&n), "{n}");
            assert!(n.len() <= 64);
        }
    }

    #[test]
    fn amounts_read_naturally() {
        let near = 10u128.pow(24);
        assert_eq!(format_amount(near, 24), "1");
        assert_eq!(format_amount(near * 5 / 2, 24), "2.5");
        assert_eq!(format_amount(near / 1000 * 32 + near / 100_000 * 5, 24), "0.032");
        assert_eq!(format_amount(near * 3 / 80, 24), "0.0375");
        assert_eq!(format_amount(1, 24), "<0.0001");
        assert_eq!(format_amount(0, 24), "0");
        assert_eq!(format_amount(12_340_000, 6), "12.34");
        assert_eq!(format_amount(7, 0), "7");
        assert_eq!(format_amount(1_000_000_000_000_000_000_000_000_000, 24), "1000");
    }

    #[test]
    fn applause_post_mentions_both_people_and_the_dao() {
        let post = applause_post(&ApplauseLine {
            to: "bob.near",
            from: "alice.near",
            claps: 3,
            note: "Rewrote the indexer in a weekend",
            label: "Lantern Guild",
            dao: "lantern.sputnik-dao.near",
            round: 7,
        });
        assert_eq!(
            post,
            "\u{1F44F} @bob.near got 3 claps from @alice.near at Lantern Guild.\n\u{201C}Rewrote the indexer in a weekend\u{201D}\nRound 7 of @lantern.sputnik-dao.near #ovation"
        );
        let short = applause_post(&ApplauseLine {
            to: "bob.near",
            from: "alice.near",
            claps: 1,
            note: "",
            label: "Lantern Guild",
            dao: "lantern.sputnik-dao.near",
            round: 0,
        });
        assert_eq!(short, "\u{1F44F} @bob.near got 1 clap from @alice.near at Lantern Guild.\nRound 0 of @lantern.sputnik-dao.near #ovation");
    }

    #[test]
    fn paid_post_and_proposal_description() {
        let near = 10u128.pow(24);
        let post = paid_post(&PaidLine {
            to: "bob.near",
            amount: near * 3 / 80,
            decimals: 24,
            symbol: "NEAR",
            backers: 4,
            label: "Lantern Guild",
            dao: "lantern.sputnik-dao.near",
            round: 7,
            proposal_id: 18,
        });
        assert_eq!(
            post,
            "\u{1F4B8} @bob.near was paid 0.0375 NEAR by @lantern.sputnik-dao.near for applause from 4 members in round 7 at Lantern Guild. Proposal #18. #ovation"
        );
        let d = payout_description(&PayoutLine {
            to: "bob.near",
            amount: near * 3 / 80,
            decimals: 24,
            symbol: "NEAR",
            backers: 1,
            claps: 9,
            label: "Lantern Guild",
            round: 7,
            tier: "Cosign",
        });
        assert_eq!(
            d,
            "* Title: Ovation round 7 for bob.near <br>* Summary: 0.0375 NEAR for applause from 1 member (9 claps) at Lantern Guild. <br>* Notes: Needs one steward to co-sign, then the Ovation contract approves it."
        );
        // Trezu splits on "<br>" and then on the first colon of each line.
        let fields: Vec<&str> = d.split("<br>").map(|l| l.trim()).collect();
        assert_eq!(fields.len(), 3);
        assert!(fields.iter().all(|l| l.starts_with("* ") && l.contains(':')));
        assert!(profile_about("lantern.sputnik-dao.near").starts_with("Automated account"));
    }
}

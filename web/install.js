// The Install page: read any Sputnik DAO's policy, choose the rules, and get the two
// proposals that install Ovation on it, ready to file. Nothing is sent from this page.

/** "0.25" -> yoctoNEAR as a string. */
function toYocto(text) {
  const [w, f = ""] = String(text).trim().split(".");
  if (!/^\d+$/.test(w || "0") || !/^\d*$/.test(f)) return null;
  return (BigInt(w || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24))).toString();
}

const b64 = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));

export function installPage(root, { C, h, view, toast, amount }) {
  const s = {
    dao: C.dao,
    agent: null,
    policy: null,
    stage: null,
    clap: new Set(),
    steward: new Set(),
    f: {
      label: "",
      round_budget: "50",
      round_days: "14",
      review_days: "2",
      claim_days: "30",
      claps_per_round: "10",
      min_backers: "2",
      max_share: "40",
      auto_limit_new: "5",
      auto_limit_trusted: "15",
      cosign_limit: "25",
      auto_round_cap: "20",
      bonds: "1",
      trusted_after_rounds: "2",
      trusted_after_backers: "3",
      storage: "1",
      post_to_social: true,
    },
  };

  const daoInput = h("input", { type: "text", value: s.dao, spellcheck: "false", placeholder: "your-dao.sputnik-dao.near" });
  const policyBox = h("div");
  const out = h("div");

  function field(key, label, hint) {
    const input = h("input", { type: "text", value: s.f[key], oninput: (e) => { s.f[key] = e.target.value; drawOut(); } });
    return h("div", {}, h("label", {}, label, hint ? [" ", h("span", { class: "hint" }, hint)] : null), input);
  }

  function config() {
    const days = (v) => Math.round(Number(v) * 86400);
    return {
      label: s.f.label || (s.dao.split(".")[0] || "Our DAO").slice(0, 40),
      token_id: null,
      token_symbol: "NEAR",
      token_decimals: 24,
      round_budget: toYocto(s.f.round_budget),
      round_secs: days(s.f.round_days),
      review_secs: days(s.f.review_days),
      claim_secs: days(s.f.claim_days),
      claps_per_round: Number(s.f.claps_per_round),
      clapper_roles: [...s.clap],
      steward_roles: [...s.steward],
      min_backers: Number(s.f.min_backers),
      max_share_bps: Math.round(Number(s.f.max_share) * 100),
      min_payout: toYocto("0.01"),
      auto_limit_new: toYocto(s.f.auto_limit_new),
      auto_limit_trusted: toYocto(s.f.auto_limit_trusted),
      cosign_limit: toYocto(s.f.cosign_limit),
      auto_round_cap: toYocto(s.f.auto_round_cap),
      trusted_after_rounds: Number(s.f.trusted_after_rounds),
      trusted_after_backers: Number(s.f.trusted_after_backers),
      post_to_social: !!s.f.post_to_social,
    };
  }

  function problems(cfg) {
    const p = [];
    if (!s.clap.size) p.push("Choose at least one role whose members may applaud.");
    if (!s.steward.size) p.push("Choose at least one role whose members oversee the stage.");
    for (const k of ["round_budget", "auto_limit_new", "auto_limit_trusted", "cosign_limit", "auto_round_cap"]) if (cfg[k] === null) p.push(`${k} is not a number.`);
    if (toYocto(s.f.bonds) === null || toYocto(s.f.storage) === null) p.push("The NEAR for bonds and for storage must be numbers.");
    if (p.length) return p;
    if (BigInt(cfg.round_budget) === 0n) p.push("The budget per round must be above zero.");
    if (cfg.round_secs < 60) p.push("A round must last at least a minute.");
    if (cfg.claim_secs < 60) p.push("The claim window must last at least a minute.");
    if (!(cfg.claps_per_round >= 1 && cfg.claps_per_round <= 1000)) p.push("Claps per member must be 1 to 1000.");
    if (!(cfg.min_backers >= 1 && cfg.min_backers <= 50)) p.push("Members needed to be paid must be 1 to 50.");
    if (!(cfg.max_share_bps >= 1 && cfg.max_share_bps <= 10000)) p.push("The share cap must be between 0.01% and 100%.");
    if (BigInt(cfg.auto_limit_new) > BigInt(cfg.auto_limit_trusted)) p.push("The no-sign-off limit for anyone cannot be above the one for trusted recipients.");
    if (BigInt(cfg.auto_limit_trusted) > BigInt(cfg.cosign_limit)) p.push("The no-sign-off limit for trusted recipients cannot be above the co-sign limit.");
    if (BigInt(cfg.auto_round_cap) > BigInt(cfg.round_budget)) p.push("What a round pays with no sign-off cannot be more than its budget.");
    if (toYocto(s.f.storage) !== null && BigInt(toYocto(s.f.storage)) < 50_000_000_000_000_000_000_000n) p.push("Keep at least 0.05 NEAR for the stage's storage.");
    return p;
  }

  function copyable(title, text) {
    return h(
      "div",
      { style: "margin-top:14px" },
      h(
        "div",
        { style: "display:flex;align-items:center;gap:10px" },
        h("h3", {}, title),
        h(
          "button",
          {
            class: "quiet",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast("Copied.");
              } catch {
                toast("Select the text and copy it by hand.", { bad: true });
              }
            },
          },
          "Copy",
        ),
      ),
      h("pre", { class: "code" }, text),
    );
  }

  function drawOut() {
    if (!s.policy) {
      out.replaceChildren();
      return;
    }
    const cfg = config();
    const issues = problems(cfg);
    if (issues.length) {
      out.replaceChildren(h("section", { class: "card" }, h("h2", {}, "3. The two proposals"), h("ul", { class: "checks" }, issues.map((i) => h("li", { class: "no" }, i)))));
      return;
    }
    const net = C.network === "mainnet" ? "mainnet" : "testnet";
    const bond = amount(s.policy.proposal_bond, 24, 6);
    const role = {
      name: "ovation",
      kind: { Group: [s.agent] },
      permissions: ["transfer:AddProposal", "transfer:VoteApprove", "transfer:Finalize"],
      vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
    };
    const p1 = {
      proposal: {
        description: `* Title: Add the Ovation role <br>* Summary: Lets the stage's own account ${s.agent} file transfer proposals and approve the small ones it filed. Nothing else.`,
        kind: { ChangePolicyAddOrUpdateRole: { role } },
      },
    };
    const p2 = {
      proposal: {
        description: `* Title: Open an Ovation stage <br>* Summary: ${s.f.round_budget} NEAR per round, split by applause from ${[...s.clap].join(", ")}.`,
        kind: {
          FunctionCall: {
            receiver_id: C.contract,
            actions: [
              {
                method_name: "open_stage",
                args: b64({ config: cfg, bonds: toYocto(s.f.bonds) }),
                // bonds, plus 0.02 for the stage account's own storage, plus the storage kept here
                deposit: (BigInt(toYocto(s.f.bonds)) + BigInt(toYocto(s.f.storage)) + 20_000_000_000_000_000_000_000n).toString(),
                gas: "150000000000000",
              },
            ],
          },
        },
      },
    };
    const cli = (p) =>
      `near contract call-function as-transaction ${s.dao} add_proposal json-args '${JSON.stringify(p)}' prepaid-gas '100 Tgas' attached-deposit '${bond} NEAR' sign-as YOUR_ACCOUNT network-config ${net} sign-with-keychain send`;
    out.replaceChildren(
      h(
        "section",
        { class: "card" },
        h("h2", {}, "3. The two proposals"),
        h("p", { class: "sub" }, `File them from any account your DAO lets propose. Your DAO asks for a ${bond} NEAR bond on each, returned when it passes. Pass the first before the second.`),
        copyable("Proposal 1: give the stage's own account a role limited to transfers", cli(p1)),
        copyable("Proposal 2: open the stage", cli(p2)),
        copyable("What proposal 2 tells the contract (the decoded arguments)", JSON.stringify({ config: cfg, bonds: toYocto(s.f.bonds) }, null, 2)),
        h(
          "ul",
          { class: "checks", style: "margin-top:16px" },
          h("li", {}, `The role holds one account, ${s.agent}, with only ${role.permissions.join(", ")}. It cannot add members, change policy or call anything.`),
          h("li", {}, "That account is created by proposal 2 and has no keys: only the Ovation contract can make it act. Its single vote passes a transfer only because it sits alone in that role, and it votes only on proposals it filed, within the limits above."),
          h("li", {}, `Proposal 2 sends ${s.f.bonds} NEAR to that account for the bonds of its payout proposals, which come back to it, and ${s.f.storage} NEAR for the stage's storage. Members never attach a deposit. Your DAO takes back what is unused with withdraw_bonds and withdraw_storage.`),
          h("li", {}, "To uninstall: one proposal of kind ChangePolicyRemoveRole with role \"ovation\". From then on the contract can do nothing in your DAO."),
          h("li", {}, "In Trezu, each payout Ovation files shows under payment requests with a title and a summary, because it is an ordinary Transfer proposal."),
        ),
      ),
    );
  }

  function drawPolicy() {
    const p = s.policy;
    if (!p) return;
    const mine = p.roles.find((r) => r.kind?.Group?.includes(s.agent));
    const st = s.stage;
    policyBox.replaceChildren(
      h(
        "ul",
        { class: "checks" },
        h("li", {}, `${s.dao} is a Sputnik DAO with ${p.roles.length} role${p.roles.length === 1 ? "" : "s"}. Proposals need a ${amount(p.proposal_bond, 24, 6)} NEAR bond and stay open ${Math.round(Number(p.proposal_period) / 86400e9)} days.`),
        mine
          ? h("li", {}, `It already has a role holding its stage's account: "${mine.name}" with ${mine.permissions.join(", ")}.`)
          : h("li", { class: "no" }, `It has no role for its stage's account, ${s.agent}, yet. Proposal 1 below adds it.`),
        st
          ? h("li", { class: st.ready ? "" : "no" }, st.ready ? `It has a stage, and its policy lets the contract file and approve small payouts (${st.clappers.length} may applaud, ${st.stewards.length} stewards).` : "It has a stage, but its policy does not yet let the contract file and approve payouts alone.")
          : h("li", { class: "no" }, "It has no stage yet. Proposal 2 below opens one."),
        st?.wide ? h("li", { class: "no" }, "The stage account's role holds more permissions than Ovation needs. Trim it to the three transfer permissions.") : null,
        st?.shared ? h("li", { class: "no" }, "Other accounts share the stage account's role, so they can approve transfers alone too.") : null,
      ),
      h("h3", { style: "margin-top:16px" }, "Which of your roles take part"),
      h(
        "div",
        { class: "rolepick" },
        h("span", { class: "hd" }, "Role"),
        h("span", { class: "hd" }, "May applaud"),
        h("span", { class: "hd" }, "Stewards"),
        ...p.roles
          .filter((r) => !r.kind?.Group?.includes(s.agent))
          .flatMap((r) => {
            const group = r.kind?.Group;
            const box = (set) =>
              h("input", {
                type: "checkbox",
                checked: set.has(r.name),
                disabled: !group,
                "aria-label": r.name,
                onchange: (e) => {
                  if (e.target.checked) set.add(r.name);
                  else set.delete(r.name);
                  drawOut();
                },
              });
            return [
              h("span", {}, h("b", {}, r.name), " ", h("span", { class: "muted small" }, group ? `${group.length} account${group.length === 1 ? "" : "s"}` : "open to everyone or token holders: cannot be used")),
              box(s.clap),
              box(s.steward),
            ];
          }),
      ),
      h("p", { class: "muted small", style: "margin-top:10px" }, "Ovation keeps no member list of its own. Add or remove someone from these roles in your DAO and they gain or lose their claps."),
    );
  }

  async function read(btn) {
    s.dao = daoInput.value.trim().toLowerCase();
    if (!s.dao) return;
    btn?.classList.add("busy");
    try {
      s.policy = await view(s.dao, "get_policy");
      s.agent = await view(C.contract, "agent_for", { dao: s.dao });
      s.stage = await view(C.contract, "get_stage", { dao: s.dao }).catch(() => null);
      s.clap = new Set(s.stage ? s.stage.config.clapper_roles : s.policy.roles.filter((r) => r.kind?.Group && !r.kind.Group.includes(s.agent)).map((r) => r.name));
      const council = s.policy.roles.find((r) => r.kind?.Group && /council|govern|admin/i.test(r.name));
      s.steward = new Set(s.stage ? s.stage.config.steward_roles : council ? [council.name] : []);
      if (!s.f.label) s.f.label = "";
      drawPolicy();
      drawOut();
    } catch (e) {
      s.policy = null;
      policyBox.replaceChildren(h("ul", { class: "checks" }, h("li", { class: "no" }, `Could not read ${s.dao} as a Sputnik DAO on ${C.network}: ${String(e.message).slice(0, 140)}`)));
      drawOut();
    }
    btn?.classList.remove("busy");
  }

  const postBox = h("input", { type: "checkbox", checked: s.f.post_to_social, onchange: (e) => { s.f.post_to_social = e.target.checked; drawOut(); } });

  root.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h(
        "div",
        {},
        h("div", { class: "eyebrow" }, "Install"),
        h("h1", {}, "Two proposals, no migration"),
        h("p", {}, "Ovation works with the treasury you already have. Your DAO keeps the money and the members. The council passes two ordinary proposals, and can undo it with one."),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "1. Your DAO"),
      h("p", { class: "sub" }, `Any Sputnik DAO on ${C.network}. The page reads its policy and changes nothing.`),
      h("div", { style: "display:flex;gap:10px;flex-wrap:wrap" }, h("div", { style: "flex:1;min-width:240px" }, daoInput), h("button", { class: "primary", onclick: (e) => read(e.currentTarget) }, "Read its policy")),
      policyBox,
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "2. The rules"),
      h("p", { class: "sub" }, "Amounts are in NEAR. A stage can also pay a NEP-141 token: set token_id in the arguments by hand."),
      h(
        "div",
        { class: "field-grid" },
        field("label", "Name shown in posts", "up to 40 characters"),
        field("round_budget", "Budget per round"),
        field("round_days", "A round lasts", "days"),
        field("review_days", "Review window", "days"),
        field("claim_days", "Claims stay open", "days"),
        field("claps_per_round", "Claps per member per round"),
        field("min_backers", "Members needed to be paid"),
        field("max_share", "Most one person can take", "% of a round"),
        field("auto_limit_new", "No sign-off up to", "anyone"),
        field("auto_limit_trusted", "No sign-off up to", "trusted recipients"),
        field("cosign_limit", "One steward up to", "above it the council votes"),
        field("trusted_after_rounds", "Trusted after", "paid rounds"),
        field("trusted_after_backers", "Trusted after", "different backers"),
        field("auto_round_cap", "No sign-off at all, per round", "at most"),
        field("bonds", "NEAR for proposal bonds", "they come back"),
        field("storage", "NEAR for storage"),
      ),
      h("label", { style: "display:flex;gap:8px;align-items:center;font-weight:500" }, postBox, "Publish each applause and payout as a near.social post"),
    ),
    out,
  );

  read();
  return { refresh: async () => {}, every: 0 };
}

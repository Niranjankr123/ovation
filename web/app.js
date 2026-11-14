// The Ovation site. Static files, no build step. Every number on screen is read from NEAR
// by chain.js. Nothing here is trusted by the contract: the page only shows state and, when
// someone is signed in, sends the same calls anyone could send from a terminal.

import { config, view, posts, postUrl, amount, short, ago, clock, span, hue, score } from "./chain.js";
import { session } from "./session.js";
import { installPage } from "./install.js";

// ---------- small DOM helpers ----------

/** Build an element. Text always goes in as text nodes, never as HTML. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

export function toast(text, { bad = false, link = null } = {}) {
  const t = h("div", { class: `toast${bad ? " bad" : ""}` }, text, link ? [" ", h("a", { href: link, target: "_blank", rel: "noopener" }, "See the transaction")] : null);
  $("toasts").append(t);
  setTimeout(() => t.remove(), bad ? 9000 : 6000);
}

function avatar(id, size = "") {
  return h("span", { class: `avatar ${size}`, style: `--h:${hue(id)}`, title: id }, short(id)[0] || "?");
}

function person(id, { full = true } = {}) {
  return h("a", { class: "person", href: `#/people/${id}`, title: id }, avatar(id), h("span", {}, short(id), full ? h("span", { class: "full" }, id) : null));
}

const TIER = {
  Auto: { text: "no sign-off needed", cls: "green" },
  Cosign: { text: "one steward co-signs", cls: "gold" },
  Council: { text: "council votes", cls: "blue" },
};
const STATE = {
  Filing: "Filing…",
  Filed: "On the DAO",
  Voting: "Voting…",
  Approved: "Approved, confirming",
  Failed: "Transfer bounced",
  Paid: "Paid",
  Rejected: "Voted down",
  Expired: "Expired",
  Removed: "Removed",
  Unanswered: "No answer from the DAO",
};

let C;
let stageCache = null;
let current = null;

const tok = (units, digits = 4) => `${amount(units, stageCache?.config.token_decimals ?? 24, digits)} ${stageCache?.config.token_symbol ?? "NEAR"}`;
const isSteward = () => !!session.me && !!stageCache?.stewards.includes(session.me);
const isClapper = () => !!session.me && !!stageCache?.clappers.includes(session.me);

/** Run an action for the signed-in account, with a busy button and a toast either way. */
async function run(btn, action, args, done) {
  btn.classList.add("busy");
  btn.disabled = true;
  const r = await session.act(action, args);
  btn.classList.remove("busy");
  btn.disabled = false;
  if (r.ok) toast(typeof done === "function" ? done(r) : done, { link: r.link });
  else toast(String(r.error || "That did not go through.").replace(/^ERR_[A-Z_]+: /, ""), { bad: true, link: r.link });
  if (current?.refresh) await current.refresh().catch(() => {});
  return r;
}

// =====================================================================
// Stage: the round that is open now
// =====================================================================

function stagePage(root) {
  const form = { claps: 1 };
  let shown = new Set();
  let firstDraw = true;
  let roundNo = -1;
  let known = [];

  const hero = h("section", { class: "hero" });
  const roundCard = h("section", { class: "card" });
  const standings = h("div");
  const feed = h("div");
  const leftover = h("div", { class: "leftover" });
  const rules = h("ul", { class: "rules" });

  // The applaud form is built once, so typing is never interrupted by a refresh.
  const to = h("input", { type: "text", id: "ap-to", list: "ap-people", placeholder: "account.near", autocomplete: "off", spellcheck: "false" });
  const datalist = h("datalist", { id: "ap-people" });
  const steps = h("div", { class: "steps" });
  const note = h("textarea", { id: "ap-note", maxlength: "200", placeholder: "What did they do?" });
  const count = h("span", { class: "count" }, "0 / 200");
  note.addEventListener("input", () => (count.textContent = `${note.value.length} / 200`));
  const quote = h("input", { type: "text", placeholder: "alice.near/1759140000000", spellcheck: "false" });
  const dots = h("div", { class: "dots" });
  const left = h("span", { class: "muted small" });
  const send = h("button", { class: "primary", type: "submit" }, "Applaud");
  const gate = h("p", { class: "muted small" });
  const formEl = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const target = resolve(to.value);
        if (!target) return toast("Say who you are applauding.", { bad: true });
        const r = await run(send, "applaud", { to: target, claps: form.claps, note: note.value, quote: quote.value.trim() || null }, `Applause sent to ${short(target)}.`);
        if (r.ok) {
          note.value = "";
          quote.value = "";
          to.value = "";
          count.textContent = "0 / 200";
        }
      },
    },
    h("label", { for: "ap-to" }, "Who"),
    to,
    datalist,
    h("label", {}, "Claps"),
    steps,
    h("label", { for: "ap-note" }, "For what ", count),
    note,
    h(
      "details",
      { class: "more" },
      h("summary", {}, "It is about a near.social post"),
      h("label", {}, "Post ", h("span", { class: "hint" }, "written account/post_id")),
      quote,
      h("p", { class: "muted small", style: "margin-top:6px" }, "The contract's post will quote it, so its author is notified."),
    ),
    h("div", { class: "formfoot" }, send, left),
  );
  const applaudCard = h("section", { class: "card" }, h("h2", {}, "Applaud someone"), h("p", { class: "sub" }, "Your claps for this round. Change them or take them back until it closes."), dots, gate, formEl);

  function resolve(v) {
    const s = v.trim().toLowerCase();
    if (!s) return null;
    if (known.includes(s)) return s;
    if (!s.includes(".")) return known.find((k) => short(k) === s) || `${s}.${C.namespace}`;
    return s;
  }

  function drawSteps(max) {
    if (form.claps > Math.max(max, 1)) form.claps = Math.max(1, Math.min(max, 1));
    steps.replaceChildren(
      ...[1, 2, 3, 4, 5].map((n) =>
        h("button", { type: "button", class: n === form.claps ? "on" : "", disabled: n > max, onclick: () => { form.claps = n; drawSteps(max); } }, String(n)),
      ),
    );
  }

  root.replaceChildren(
    hero,
    h(
      "div",
      { class: "cols" },
      h(
        "div",
        {},
        roundCard,
        h("section", { class: "card" }, h("h2", {}, "The ovation so far"), h("p", { class: "sub" }, "How this round's budget would be split if it closed now. Breadth counts for more than volume."), standings, leftover),
        h("section", { class: "card" }, h("h2", {}, "Applause this round"), h("p", { class: "sub" }, "Each one is also a near.social post, written by this stage's own account."), feed),
      ),
      h("aside", {}, applaudCard, h("section", { class: "card" }, h("h2", {}, "This stage's rules"), h("p", { class: "sub" }, "Set by the DAO with one proposal. Only the DAO can change them."), rules)),
    ),
  );

  async function refresh() {
    const [stage, round] = await Promise.all([view(C.contract, "get_stage", { dao: C.dao }), view(C.contract, "get_round", { dao: C.dao })]);
    if (!stage) {
      root.replaceChildren(h("p", { class: "loading" }, `${C.dao} has not opened a stage on ${C.contract}.`));
      return;
    }
    stageCache = stage;
    const from = Math.max(0, round.entries - 100);
    const [rows, list, member] = await Promise.all([
      view(C.contract, "list_standings", { dao: C.dao, round: round.round, limit: 100 }),
      view(C.contract, "list_applause", { dao: C.dao, round: round.round, from_index: from, limit: 100 }),
      session.me ? view(C.contract, "get_member", { dao: C.dao, account: session.me }) : null,
    ]);
    if (round.round !== roundNo) {
      roundNo = round.round;
      shown = new Set();
      firstDraw = true;
    }
    const cfg = stage.config;

    hero.replaceChildren(
      h(
        "div",
        {},
        h("div", { class: "eyebrow" }, "Applause that pays"),
        h("h1", {}, cfg.label),
        h("p", {}, "Members applaud whoever did good work. When the round closes, the breadth of that applause splits a budget the council approved, paid straight from the DAO's own treasury."),
        h(
          "div",
          { class: "chips" },
          h("a", { class: "chip", href: `${C.explorer}/address/${C.dao}`, target: "_blank", rel: "noopener" }, `Treasury: ${C.dao}`),
          h("a", { class: "chip", href: `${C.explorer}/address/${stage.agent}`, target: "_blank", rel: "noopener", title: "The account the DAO's role holds. It has no keys: only the Ovation contract can make it act." }, `Stage account: ${short(stage.agent)}`),
          stage.paused ? h("span", { class: "chip red" }, `Paused by ${short(stage.paused_by || "")}`) : null,
          stage.ready ? h("span", { class: "chip green" }, "Role installed") : h("span", { class: "chip red" }, "Role not ready"),
          h("span", { class: "chip" }, `${tok(stage.paid)} paid in ${stage.payouts} payouts`),
        ),
      ),
    );

    const total = round.ends_ms - round.starts_ms;
    const backers = new Set(list.filter((a) => a.claps > 0).map((a) => a.from)).size;
    roundCard.replaceChildren(
      h("div", { class: "round-head" }, h("span", { class: "no" }, `Round ${round.round}`), h("span", { class: "left" }, "closes in ", h("span", { "data-until": round.ends_ms, class: "num" }, clock(round.ends_ms - Date.now())))),
      h("div", { class: "track" }, h("i", { "data-from": round.starts_ms, "data-to": round.ends_ms, style: `width:${Math.min(100, ((Date.now() - round.starts_ms) / total) * 100)}%` })),
      h(
        "div",
        { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, tok(round.budget)), h("span", {}, "budget this round")),
        h("div", { class: "stat" }, h("b", { class: "num" }, String(round.claps)), h("span", {}, `clap${round.claps === 1 ? "" : "s"} given`)),
        h("div", { class: "stat" }, h("b", { class: "num" }, String(backers)), h("span", {}, `member${backers === 1 ? "" : "s"} applauding`)),
        h("div", { class: "stat" }, h("b", { class: "num" }, String(rows.filter((r) => r.claps > 0).length)), h("span", {}, "people applauded")),
      ),
    );

    // standings
    const live = rows.filter((r) => r.claps > 0).sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : b.claps - a.claps));
    const budget = BigInt(round.budget);
    let paid = 0n;
    standings.replaceChildren(
      ...(live.length
        ? live.map((r) => {
            paid += BigInt(r.amount);
            const pct = budget ? Number((BigInt(r.amount) * 1000n) / budget) / 10 : 0;
            const tier = TIER[r.tier];
            return h(
              "div",
              { class: `standing${r.eligible ? "" : " off"}` },
              h("div", {}, person(r.account, { full: false }), r.trusted ? h("span", { class: "chip gold", style: "margin-left:8px", title: "Paid before and applauded by enough different members" }, "trusted") : null),
              h(
                "div",
                { class: "bar" },
                h("i", { style: `width:${r.eligible ? Math.max(pct, 2) : 100}%` }),
                h("span", {}, `${r.backers} member${r.backers === 1 ? "" : "s"} · ${r.claps} clap${r.claps === 1 ? "" : "s"}`),
              ),
              h(
                "div",
                { class: "pay" },
                r.eligible ? [h("b", { class: "num" }, tok(r.amount)), h("span", { class: `chip ${tier.cls}` }, tier.text)] : h("span", { class: "muted small" }, `needs ${round.min_backers} members`),
              ),
            );
          })
        : [h("p", { class: "empty" }, "Nobody has been applauded in this round yet.")]),
    );
    leftover.textContent = live.length ? `${tok(budget - paid)} of this round's ${tok(budget)} is not earned by anyone, so it stays in the treasury. One person can take at most ${cfg.max_share_bps / 100}%.` : "";
    leftover.hidden = !live.length;

    // feed, newest first
    const items = [...list].reverse();
    feed.replaceChildren(
      ...(items.length
        ? items.map((a) => {
            const key = `${a.from}>${a.to}`;
            const fresh = !firstDraw && !shown.has(key);
            shown.add(key);
            const struck = a.voided;
            const claps = struck ? a.voided_claps : a.claps;
            return h(
              "div",
              { class: `clap${struck ? " struck" : ""}${fresh ? " fresh" : ""}` },
              avatar(a.from),
              h(
                "div",
                {},
                h(
                  "div",
                  { class: "line" },
                  h("b", {}, short(a.from)),
                  claps ? "applauded" : "took back applause for",
                  h("b", {}, short(a.to)),
                  claps ? h("span", { class: "hands", title: `${claps} claps` }, "👏".repeat(Math.min(claps, 5)), claps > 5 ? ` ×${claps}` : "") : null,
                  h("span", { class: "when" }, ago(a.at_ms)),
                ),
                a.note ? h("blockquote", {}, `“${a.note}”`) : null,
                struck ? h("p", { class: "small muted", style: "margin:4px 0 0" }, `Struck out by ${short(a.voided_by)}: ${a.void_reason}`) : null,
                h(
                  "div",
                  { class: "acts" },
                  a.post_id ? h("a", { class: "small", href: postUrl(C, stageCache?.agent || C.agent, a.post_id), target: "_blank", rel: "noopener" }, "near.social post") : null,
                  a.quote ? h("span", { class: "small muted" }, `about ${a.quote}`) : null,
                  isSteward() && !struck && a.claps > 0
                    ? h(
                        "button",
                        {
                          class: "quiet",
                          onclick: (e) => {
                            const reason = prompt(`Strike out ${short(a.from)}'s applause for ${short(a.to)}? Say why. The reason is public.`);
                            if (reason && reason.trim()) run(e.currentTarget, "void", { round: a.round, from: a.from, to: a.to, reason }, "Applause struck out.");
                          },
                        },
                        "Strike out",
                      )
                    : null,
                ),
              ),
            );
          })
        : [h("p", { class: "empty" }, "No applause yet. Be the first.")]),
    );
    firstDraw = false;

    // the form
    known = [...new Set([...stage.clappers, ...stage.stewards, ...(C.guests || []), ...rows.map((r) => r.account)])];
    datalist.replaceChildren(...known.filter((k) => k !== session.me).map((k) => h("option", { value: k })));
    const allowance = cfg.claps_per_round;
    const used = member?.claps_used ?? 0;
    const free = member?.is_clapper ? member.claps_left : 0;
    dots.replaceChildren(...Array.from({ length: Math.min(allowance, 30) }, (_, i) => h("i", { class: i < allowance - used && member?.is_clapper ? "" : "used" })));
    let why = "";
    if (!session.me) why = session.mode === "demo" ? "Pick a member at the top right to applaud as them." : session.mode === "wallet" ? "Connect a wallet that is in one of the DAO's roles to applaud." : "This copy of the site is read-only. Run it with the demo relay, or call the contract from a terminal (see the README).";
    else if (stage.paused) why = "A steward paused this stage. The DAO can resume it.";
    else if (!member?.is_clapper) why = `${short(session.me)} is not in a role that may applaud here (${cfg.clapper_roles.join(", ")}). They can still be applauded and paid.`;
    gate.textContent = why;
    gate.hidden = !why;
    formEl.hidden = !!why;
    left.textContent = `${free} of ${allowance} claps left`;
    drawSteps(free);
    send.disabled = free < 1;

    rules.replaceChildren(
      ...[
        ["Budget per round", tok(cfg.round_budget)],
        ["A round lasts", span(cfg.round_secs)],
        ["Review before claims open", span(cfg.review_secs)],
        ["Claims stay open", span(cfg.claim_secs)],
        ["Claps per member", String(cfg.claps_per_round)],
        ["Members needed to be paid", String(cfg.min_backers)],
        ["Most one person can take", `${cfg.max_share_bps / 100}%`],
        ["Paid with no sign-off, anyone", `up to ${tok(cfg.auto_limit_new)}`],
        ["Paid with no sign-off, trusted", `up to ${tok(cfg.auto_limit_trusted)}`],
        ["One steward co-signs", `up to ${tok(cfg.cosign_limit)}`],
        ["Above that", "council votes"],
        ["Trusted after", `${cfg.trusted_after_rounds} paid rounds, ${cfg.trusted_after_backers} backers`],
        ["May applaud", `${stage.clappers.length} in ${cfg.clapper_roles.join(", ")}`],
        ["Stewards", `${stage.stewards.length} in ${cfg.steward_roles.join(", ")}`],
      ].map(([k, v]) => h("li", {}, h("span", {}, k), h("span", {}, v))),
    );
  }

  return { refresh, every: 4000 };
}

// =====================================================================
// Payouts: finished rounds and what happened to each claim
// =====================================================================

function payoutsPage(root) {
  const list = h("div");
  root.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h("div", {}, h("div", { class: "eyebrow" }, "Payouts"), h("h1", {}, "From applause to treasury"), h("p", {}, "Each payout is an ordinary Transfer proposal on the DAO, filed by the stage's own account. Small ones pass on that account's vote alone. Mid-size ones wait for one steward. Large ones wait for the council.")),
    ),
    list,
  );

  function actions(round, r) {
    const out = [];
    const c = r.claim;
    const args = { round: round.round, account: r.account };
    const btn = (label, action, done, extra = {}, cls = "small") => h("button", { class: cls, onclick: (e) => run(e.currentTarget, action, { ...args, ...extra }, done) }, label);
    if (!c) {
      if (!r.eligible) return [h("span", { class: "muted small" }, `Needed ${round.min_backers} members`)];
      if (BigInt(r.amount) < BigInt(round.min_payout)) return [h("span", { class: "muted small" }, "Below the minimum payout")];
      if (round.phase === "Open") return [h("span", { class: "muted small" }, "Round still open")];
      if (round.phase === "Review") return [h("span", { class: "muted small" }, "Claims open in ", h("span", { "data-until": round.review_ends_ms }, clock(round.review_ends_ms - Date.now())))];
      if (round.phase === "Closed") return [h("span", { class: "muted small" }, "Not claimed. It stayed in the treasury.")];
      if (!session.me) return [h("span", { class: "muted small" }, "Ready to claim")];
      return [btn(session.me === r.account ? "Claim" : `Claim for ${short(r.account)}`, "claim", (res) => (res.value === "Voted" ? `Filed, and the stage voted for it. ${short(r.account)} is being paid.` : res.value === "NotFiled" ? "The DAO did not take it. Try again." : "Filed on the DAO as a proposal."), {}, "small primary")];
    }
    if (c.state === "Filed" && c.tier === "Cosign" && !c.cosigner) {
      if (isSteward() && session.me !== r.account) out.push(btn("Co-sign", "cosign", "Co-signed. The stage voted for the payout.", {}, "small primary"));
      else out.push(h("span", { class: "muted small" }, session.me === r.account && isSteward() ? "Another steward must co-sign" : "Waiting for one steward"));
    }
    if (c.state === "Filed" && c.tier === "Council") {
      if (isSteward() && session.mode === "demo") {
        out.push(btn("Vote yes", "vote", "Vote cast on the DAO.", { id: c.proposal_id, action: "VoteApprove" }));
        out.push(btn("Vote no", "vote", "Vote cast on the DAO.", { id: c.proposal_id, action: "VoteReject" }));
      } else out.push(h("span", { class: "muted small" }, "Council votes in its treasury app"));
    }
    if (c.state === "Filed" && c.tier === "Auto" && !c.voted && session.me) out.push(btn("Retry the vote", "claim", "Vote retried."));
    if (["Filed", "Approved", "Failed"].includes(c.state) && session.me) out.push(btn("Check the DAO", "settle", (res) => `The DAO says: ${STATE[res.value] || res.value}.`));
    return out;
  }

  async function refresh() {
    const stage = await view(C.contract, "get_stage", { dao: C.dao });
    if (!stage) return;
    stageCache = stage;
    const rounds = await view(C.contract, "list_rounds", { dao: C.dao, from_index: Math.max(0, stage.rounds - 10), limit: 10 });
    rounds.reverse();
    const rows = await Promise.all(rounds.map((r) => view(C.contract, "list_standings", { dao: C.dao, round: r.round, limit: 100 })));
    const cards = rounds.map((round, i) => {
      const live = rows[i].filter((r) => r.claps > 0 || r.claim).sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      const phase = { Open: ["Open", "red"], Review: ["In review", "gold"], Claimable: ["Claims open", "green"], Closed: ["Closed", ""] }[round.phase];
      return h(
        "section",
        { class: "card" },
        h(
          "div",
          { class: "round-title" },
          h("h2", {}, `Round ${round.round}`),
          h("span", { class: `chip ${phase[1]}` }, phase[0]),
          round.phase === "Open" ? h("span", { class: "chip" }, "closes in ", h("span", { "data-until": round.ends_ms }, clock(round.ends_ms - Date.now()))) : null,
          round.voided ? h("span", { class: "chip" }, `${round.voided} struck out`) : null,
          h("span", { class: "right num" }, `${tok(round.paid)} paid of ${tok(round.budget)}`),
        ),
        h(
          "div",
          { class: "scroll" },
          h(
            "table",
            { class: "pay" },
            h("thead", {}, h("tr", {}, h("th", {}, "Who"), h("th", {}, "Applause"), h("th", {}, "Amount"), h("th", {}, "Sign-off"), h("th", {}, "Status"), h("th", {}, ""))),
            h(
              "tbody",
              {},
              live.map((r) => {
                const c = r.claim;
                const tier = TIER[r.tier];
                const stateCls = !c ? "" : c.state === "Paid" ? "green" : ["Rejected", "Expired", "Removed", "Failed"].includes(c.state) ? "red" : "gold";
                return h(
                  "tr",
                  {},
                  h("td", {}, person(r.account, { full: false }), r.trusted ? h("span", { class: "chip gold", style: "margin-left:6px" }, "trusted") : null),
                  h("td", { class: "num" }, `${r.backers} member${r.backers === 1 ? "" : "s"} · ${r.claps} clap${r.claps === 1 ? "" : "s"}`),
                  h("td", { class: "num" }, r.eligible || c ? tok(r.amount) : "–"),
                  h("td", {}, r.eligible || c ? h("span", { class: `chip ${tier.cls}` }, tier.text) : ""),
                  h(
                    "td",
                    {},
                    c
                      ? [
                          h("span", { class: `chip ${stateCls}` }, STATE[c.state] || c.state),
                          c.proposal_id !== null ? h("a", { class: "small", style: "margin-left:6px", href: `${C.explorer}/address/${C.dao}`, target: "_blank", rel: "noopener", title: "Proposal number on the DAO" }, `#${c.proposal_id}`) : null,
                          c.cosigner ? h("span", { class: "small muted", style: "margin-left:6px" }, `co-signed by ${short(c.cosigner)}`) : null,
                        ]
                      : h("span", { class: "muted small" }, "Not claimed"),
                  ),
                  h("td", {}, h("span", { class: "acts" }, actions(round, r))),
                );
              }),
            ),
          ),
        ),
      );
    });
    list.replaceChildren(...(cards.length ? cards : [h("p", { class: "empty" }, "No round has had applause yet.")]));
  }
  return { refresh, every: 6000 };
}

// =====================================================================
// People: records, and every line they are made of
// =====================================================================

async function knownPeople(stage) {
  const ids = new Set([...stage.clappers, ...stage.stewards, ...(C.guests || [])]);
  const rounds = await view(C.contract, "list_rounds", { dao: C.dao, from_index: Math.max(0, stage.rounds - 12), limit: 12 });
  const rows = await Promise.all(rounds.map((r) => view(C.contract, "list_standings", { dao: C.dao, round: r.round, limit: 100 })));
  for (const list of rows) for (const r of list) ids.add(r.account);
  return [...ids];
}

function roleOf(stage, id) {
  if (stage.stewards.includes(id)) return ["steward", "blue"];
  if (stage.clappers.includes(id)) return ["member", ""];
  return ["not a member", ""];
}

function peoplePage(root) {
  const grid = h("div", { class: "grid" });
  root.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h("div", {}, h("div", { class: "eyebrow" }, "People"), h("h1", {}, "Records you can trace"), h("p", {}, "A record belongs to a named account. Every clap in it points to the member who gave it, the round, and their note. A good record raises how much someone can be paid with no sign-off.")),
    ),
    grid,
  );
  async function refresh() {
    const stage = await view(C.contract, "get_stage", { dao: C.dao });
    if (!stage) return;
    stageCache = stage;
    const ids = await knownPeople(stage);
    const recs = (await Promise.all(ids.map((id) => view(C.contract, "get_record", { dao: C.dao, account: id })))).filter(Boolean);
    recs.sort((a, b) => (BigInt(b.paid) > BigInt(a.paid) ? 1 : BigInt(b.paid) < BigInt(a.paid) ? -1 : b.claps_received - a.claps_received));
    grid.replaceChildren(
      ...recs.map((r) => {
        const [role, cls] = roleOf(stage, r.account);
        return h(
          "a",
          { class: "card", href: `#/people/${r.account}` },
          h("div", { class: "pc-head" }, avatar(r.account, "lg"), h("div", {}, h("h3", {}, short(r.account)), h("div", { style: "display:flex;gap:6px;margin-top:5px;flex-wrap:wrap" }, h("span", { class: `chip ${cls}` }, role), r.trusted ? h("span", { class: "chip gold" }, "trusted") : null))),
          h(
            "div",
            { class: "kv" },
            h("div", {}, h("b", { class: "num" }, tok(r.paid)), h("span", {}, `paid over ${r.rounds_paid} round${r.rounds_paid === 1 ? "" : "s"}`)),
            h("div", {}, h("b", { class: "num" }, String(r.backers)), h("span", {}, "different backers")),
            h("div", {}, h("b", { class: "num" }, String(r.claps_received)), h("span", {}, "claps received")),
            h("div", {}, h("b", { class: "num" }, String(r.claps_given)), h("span", {}, "claps given")),
          ),
        );
      }),
    );
  }
  return { refresh, every: 12000 };
}

function personPage(root, id) {
  const box = h("div");
  root.replaceChildren(box);
  async function refresh() {
    const stage = await view(C.contract, "get_stage", { dao: C.dao });
    if (!stage) return;
    stageCache = stage;
    const rec = await view(C.contract, "get_record", { dao: C.dao, account: id });
    const lines = rec.lines ? await view(C.contract, "list_record_lines", { dao: C.dao, account: id, from_index: Math.max(0, rec.lines - 100), limit: 100 }) : [];
    lines.reverse();
    const [role, cls] = roleOf(stage, id);
    const needRounds = Math.max(0, rec.trusted_after_rounds - rec.rounds_paid);
    const needBackers = Math.max(0, rec.trusted_after_backers - rec.backers);
    box.replaceChildren(
      h(
        "section",
        { class: "hero" },
        h(
          "div",
          { style: "display:flex;gap:16px;align-items:center" },
          avatar(id, "lg"),
          h(
            "div",
            {},
            h("h1", {}, short(id)),
            h("div", { class: "chips" }, h("a", { class: "chip", href: `${C.explorer}/address/${id}`, target: "_blank", rel: "noopener" }, id), h("span", { class: `chip ${cls}` }, role), rec.trusted ? h("span", { class: "chip gold" }, "trusted") : null),
          ),
        ),
      ),
      h(
        "div",
        { class: "cols" },
        h(
          "section",
          { class: "card" },
          h("h2", {}, "Every line of this record"),
          h("p", { class: "sub" }, `${rec.claps_received} claps in ${rec.lines} line${rec.lines === 1 ? "" : "s"}. The numbers on the right are the sum of these and nothing else.`),
          lines.length
            ? lines.map((a) =>
                h(
                  "div",
                  { class: `clap${a.voided ? " struck" : ""}` },
                  avatar(a.from),
                  h(
                    "div",
                    {},
                    h("div", { class: "line" }, h("b", {}, short(a.from)), "·", `${a.voided ? a.voided_claps : a.claps} clap${(a.voided ? a.voided_claps : a.claps) === 1 ? "" : "s"}`, "·", `round ${a.round}`, h("span", { class: "when" }, ago(a.at_ms))),
                    a.note ? h("blockquote", {}, `“${a.note}”`) : null,
                    a.voided ? h("p", { class: "small muted", style: "margin:4px 0 0" }, `Struck out by ${short(a.voided_by)}: ${a.void_reason}`) : null,
                    a.post_id ? h("div", { class: "acts" }, h("a", { class: "small", href: postUrl(C, stageCache?.agent || C.agent, a.post_id), target: "_blank", rel: "noopener" }, "near.social post")) : null,
                  ),
                ),
              )
            : h("p", { class: "empty" }, "Nobody has applauded this account here yet."),
        ),
        h(
          "aside",
          {},
          h(
            "section",
            { class: "card" },
            h("h2", {}, "Standing"),
            h(
              "ul",
              { class: "rules", style: "margin-top:10px" },
              [
                ["Paid in total", tok(rec.paid)],
                ["Rounds paid", String(rec.rounds_paid)],
                ["Rounds applauded", String(rec.rounds_applauded)],
                ["Different backers", String(rec.backers)],
                ["Claps received", String(rec.claps_received)],
                ["Claps given", String(rec.claps_given)],
              ].map(([k, v]) => h("li", {}, h("span", {}, k), h("span", {}, v))),
            ),
            h(
              "p",
              { class: "small muted", style: "margin-top:12px" },
              rec.trusted
                ? `Trusted: payouts up to ${tok(stage.config.auto_limit_trusted)} need no sign-off.`
                : `Not trusted yet: needs ${needRounds ? `${needRounds} more paid round${needRounds === 1 ? "" : "s"}` : ""}${needRounds && needBackers ? " and " : ""}${needBackers ? `${needBackers} more backer${needBackers === 1 ? "" : "s"}` : ""}. Until then payouts above ${tok(stage.config.auto_limit_new)} need a steward.`,
            ),
          ),
        ),
      ),
    );
  }
  return { refresh, every: 12000 };
}

// =====================================================================
// Feed: the contract's own posts on near.social's data layer
// =====================================================================

function richText(text) {
  const out = [];
  const re = /(@[a-z0-9][a-z0-9._-]*[a-z0-9]|#[\p{L}\p{N}_]+|https:\/\/[^\s]+)/gu;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const t = m[0];
    if (t[0] === "@") out.push(h("a", { class: "at", href: `#/people/${t.slice(1)}` }, `@${short(t.slice(1))}`));
    else if (t[0] === "#") out.push(h("span", { class: "tag" }, t));
    else out.push(h("a", { href: t, target: "_blank", rel: "noopener" }, t));
    at = m.index + t.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function feedPage(root) {
  const list = h("section", { class: "card" });
  root.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h(
        "div",
        {},
        h("div", { class: "eyebrow" }, "Feed"),
        h("h1", {}, "A stage with a voice"),
        h(
          "p",
          {},
          "near.social attributes a post to the account that made the call. Each stage posts from its own account, which has no keys: only the Ovation contract can make it act, so these posts can exist only because the contract's rules were met. On mainnet they appear on near.social, and everyone mentioned gets a notification.",
        ),
        h("div", { class: "chips" }, h("span", { class: "chip" }, `Author: ${C.agent}`), h("span", { class: "chip" }, `Written to: ${C.social}`), h("a", { class: "chip", href: `${C.kv}/v0/latest/${C.social}/${C.agent}`, target: "_blank", rel: "noopener" }, "Raw data on FastData")),
      ),
    ),
    list,
  );
  async function refresh() {
    let all;
    try {
      all = await posts(C.agent);
    } catch (e) {
      list.replaceChildren(h("p", { class: "empty" }, `Could not read the FastData index: ${e.message}`));
      return;
    }
    list.replaceChildren(
      h("h2", {}, `${all.length} post${all.length === 1 ? "" : "s"}`),
      h("p", { class: "sub" }, C.network === "mainnet" ? "Read from near.social's public index." : "Read from the public testnet index of the same data standard near.social uses on mainnet."),
      ...(all.length
        ? all.slice(0, 120).map((p) =>
            h(
              "article",
              { class: "post" },
              h("span", { class: "avatar", style: "--h:8" }, (C.label || "O")[0]),
              h(
                "div",
                {},
                h("div", { class: "meta" }, h("b", {}, C.label || "Ovation"), h("span", { class: "muted" }, `@${C.agent}`), h("span", { class: "muted" }, "·"), h("a", { class: "muted", href: postUrl(C, C.agent, p.id), target: "_blank", rel: "noopener" }, ago(p.at_ms))),
                h("div", { class: "body" }, richText(p.text)),
                p.quote ? h("div", { class: "quote" }, `Quotes the post ${p.quote}`) : null,
              ),
            ),
          )
        : [h("p", { class: "empty" }, "No posts yet.")]),
    );
  }
  return { refresh, every: 8000 };
}

// =====================================================================
// How it works
// =====================================================================

function howPage(root) {
  const a = { members: 5, each: 2 };
  const b = { members: 1, each: 10 };
  const duel = h("div");
  const slider = (obj, key, max, redraw) => h("input", { type: "range", min: "1", max: String(max), value: String(obj[key]), oninput: (e) => { obj[key] = Number(e.target.value); redraw(); } });

  function draw() {
    const sa = score(Array(a.members).fill(a.each));
    const sb = score(Array(b.members).fill(b.each));
    const total = sa + sb || 1;
    const side = (name, o, s, cls) =>
      h(
        "div",
        { class: "side" },
        h("h3", {}, name),
        h("label", {}, `${o.members} member${o.members === 1 ? "" : "s"} applaud`),
        slider(o, "members", 10, draw),
        h("label", {}, `${o.each} clap${o.each === 1 ? "" : "s"} each`),
        slider(o, "each", 10, draw),
        h("p", { class: "muted small", style: "margin-top:10px" }, `${o.members * o.each} claps in total`),
        h("div", { class: "big num", style: `color:var(--${cls})` }, `score ${Math.round(s)}`),
      );
    duel.replaceChildren(
      h("div", { class: "duel" }, side("Ravi", a, sa, "accent"), side("June", b, sb, "gold")),
      h("div", { class: "split" }, h("div", { class: "a", style: `flex-basis:${(sa / total) * 100}%` }, `Ravi ${Math.round((sa / total) * 100)}%`), h("div", { class: "b", style: `flex-basis:${(sb / total) * 100}%` }, `June ${Math.round((sb / total) * 100)}%`)),
    );
  }

  root.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h("div", {}, h("div", { class: "eyebrow" }, "How it works"), h("h1", {}, "One loud fan is not an ovation"), h("p", {}, "An ovation is about how many people stand up, not how hard one person claps. Ovation scores applause the same way.")),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Try the formula"),
      h("p", { class: "sub" }, "A person's score is the sum of the square roots of each member's claps, squared. The round's budget is split in proportion to scores."),
      duel,
    ),
    h(
      "section",
      { class: "card prose" },
      h("h2", { style: "margin-top:0" }, "What happens in a round"),
      h(
        "ol",
        {},
        h("li", {}, "The council passes two ordinary proposals once: one gives the Ovation contract a role limited to transfers, one opens the stage with a budget per round and the rules."),
        h("li", {}, "During a round, each member of the DAO's chosen roles has a few claps to give. They applaud whoever did good work, with a note. They cannot applaud themselves."),
        h("li", {}, "When the round closes, stewards have a review window to strike out applause that should not count. The reason is public."),
        h("li", {}, "Then anyone can file a recipient's payout. It becomes a Transfer proposal on the DAO, for exactly their share."),
        h("li", {}, "Money leaves the treasury only when the DAO executes that proposal. What nobody claims never leaves."),
      ),
      h("h2", {}, "Who signs off a payout"),
      h(
        "div",
        { class: "tiers" },
        h("div", { class: "card" }, h("span", { class: "chip green" }, "Small"), h("p", { style: "margin-top:8px" }, "The stage's account votes for it alone. The limit is higher for a recipient with a record: paid before, and applauded by enough different members. A cap per round limits how much goes out this way.")),
        h("div", { class: "card" }, h("span", { class: "chip gold" }, "Mid-size"), h("p", { style: "margin-top:8px" }, "One steward co-signs, then the stage's account votes for it. A steward cannot co-sign their own payout, or the payout of someone they applauded that round.")),
        h("div", { class: "card" }, h("span", { class: "chip blue" }, "Large"), h("p", { style: "margin-top:8px" }, "A normal DAO proposal. The stage's account files it and never votes on it. The council decides in its usual treasury app.")),
      ),
      h("h2", {}, "What the contract cannot do"),
      h(
        "ul",
        {},
        h("li", {}, "Hold a DAO's money. It has no code that sends a DAO's tokens."),
        h("li", {}, "Mix one stage's NEAR with another's. Each stage pays its proposal bonds from its own account and gets them back there, so a DAO that misbehaves can only spend its own."),
        h("li", {}, "Pay more than a cap the DAO sets per round with no person signing, however many small payouts there are."),
        h("li", {}, "Vote on anything it did not file itself, or on a payout above the limits the DAO set."),
        h("li", {}, "Pay out more than the round's budget, however the applause falls."),
        h("li", {}, "Keep its power: one proposal removing its role ends it."),
        h("li", {}, "Decide who is a member. That is whoever the DAO holds in the roles it named."),
      ),
      h("h2", {}, "What it does not solve"),
      h(
        "ul",
        {},
        h("li", {}, "Friends can still applaud friends. Needing several different members, the square root, the share cap and the public feed make that pay badly and show plainly, and stewards can strike it out. They do not make it impossible."),
        h("li", {}, "Stewards are trusted to void fairly. Every void is public with its reason."),
        h("li", {}, "Each stage posts to near.social from its own account, which has no keys. A member's note is published under that account, so notes cannot carry mentions or links."),
      ),
    ),
  );
  draw();
  return { refresh: async () => {}, every: 0 };
}

// =====================================================================
// Shell: who is acting, routing, the clock
// =====================================================================

function drawWho() {
  const who = $("who");
  if (session.mode === "demo") {
    const sel = h(
      "select",
      { "aria-label": "Act as", onchange: (e) => session.become(e.target.value) },
      h("option", { value: "" }, "Just looking"),
      ...["council", "member", "guest"].map((role) =>
        h(
          "optgroup",
          { label: { council: "Council (stewards)", member: "Members", guest: "Not members" }[role] },
          ...session.people.filter((p) => p.role === role).map((p) => h("option", { value: p.id, selected: p.id === session.me }, p.name)),
        ),
      ),
    );
    who.replaceChildren(h("span", { class: "muted" }, "Acting as"), sel);
  } else if (session.mode === "wallet") {
    who.replaceChildren(
      session.me
        ? [h("span", { class: "chip", title: session.me }, short(session.me)), h("button", { class: "quiet", onclick: () => session.disconnect() }, "Sign out")]
        : h("button", { class: "primary small", onclick: () => session.connect() }, "Connect wallet"),
    );
  } else {
    who.replaceChildren(h("span", { class: "chip" }, "Read-only"));
  }
}

const routes = [
  [/^#?\/?$/, "stage", stagePage],
  [/^#\/payouts$/, "payouts", payoutsPage],
  [/^#\/people$/, "people", peoplePage],
  [/^#\/people\/(.+)$/, "people", personPage],
  [/^#\/feed$/, "feed", feedPage],
  [/^#\/install$/, "install", (root) => installPage(root, { C, h, view, toast, amount })],
  [/^#\/how$/, "how", howPage],
];

let timer = null;
async function go() {
  clearInterval(timer);
  const hash = location.hash || "#/";
  const found = routes.find(([re]) => re.test(hash)) || routes[0];
  const m = hash.match(found[0]) || [];
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("on", a.dataset.tab === found[1]);
  const root = $("page");
  root.replaceChildren(h("p", { class: "loading" }, "Reading NEAR…"));
  const holder = h("div");
  current = found[2](holder, m[1] ? decodeURIComponent(m[1]) : undefined);
  try {
    await current.refresh();
    root.replaceChildren(holder);
  } catch (e) {
    root.replaceChildren(h("p", { class: "loading" }, `Could not read the chain: ${e.message}`));
  }
  window.scrollTo(0, 0);
  if (current.every) {
    const mine = current;
    timer = setInterval(() => {
      if (document.hidden || current !== mine) return;
      mine.refresh().catch(() => {});
    }, current.every);
  }
}

// One ticker moves every countdown and progress bar on the page.
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-until]")) el.textContent = clock(Number(el.dataset.until) - now);
  for (const el of document.querySelectorAll("[data-from]")) {
    const from = Number(el.dataset.from);
    const to = Number(el.dataset.to);
    el.style.width = `${Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100))}%`;
  }
}, 1000);

async function start() {
  C = await config();
  await session.init();
  session.onChange(() => {
    drawWho();
    if (current?.refresh) current.refresh().catch(() => {});
  });
  drawWho();
  const banner = $("banner");
  if (C.network !== "mainnet") {
    banner.hidden = false;
    banner.textContent = "Demo stage on NEAR testnet. Test tokens only. Rounds last two minutes here so you can watch one close; a real stage would use weeks.";
  }
  $("foot").replaceChildren(
    h("span", {}, "Contract ", h("a", { href: `${C.explorer}/address/${C.contract}`, target: "_blank", rel: "noopener" }, C.contract)),
    h("span", {}, "Treasury ", h("a", { href: `${C.explorer}/address/${C.dao}`, target: "_blank", rel: "noopener" }, C.dao)),
    h("span", {}, "The site holds no data of its own: everything here is read from NEAR."),
  );
  window.addEventListener("hashchange", go);
  // For scripts that drive the page (the demo recorder): redraw now instead of on the next tick.
  window.ovation = { refresh: () => current?.refresh?.() };
  await go();
}

start().catch((e) => {
  $("page").replaceChildren(h("p", { class: "loading" }, `Could not start: ${e.message}`));
});

// Who is acting. Looking needs nobody. Acting needs someone who can sign:
//
//   demo    scripts/serve.mjs --demo runs a relay on this machine that signs for the demo
//           community's accounts. The page only says which member and which action.
//   wallet  a NEAR wallet, through near-connect (web/vendor/near-connect.js), if that
//           bundle is present. The wallet signs each call itself.

import { config } from "./chain.js";

const KEY = "ovation.as";
const listeners = new Set();

export const session = {
  mode: "none",
  people: [],
  me: null,
  wallet: null,
  connector: null,

  async init() {
    const c = await config();
    if (c.demo && c.people?.length) {
      this.mode = "demo";
      this.people = c.people;
      let saved = null;
      try {
        saved = localStorage.getItem(KEY);
      } catch {}
      this.me = this.people.some((p) => p.id === saved) ? saved : null;
      return;
    }
    await this.initWallet(c);
  },

  /** Load the wallet connector if this copy of the site ships it. */
  async initWallet(c) {
    try {
      const mod = await import("./vendor/near-connect.js");
      const connector = new mod.NearConnector({ network: c.network, signIn: { contractId: c.contract, methods: [] } });
      this.connector = connector;
      this.mode = "wallet";
      connector.on("wallet:signIn", async (t) => {
        this.wallet = await connector.wallet();
        this.me = t.accounts?.[0]?.accountId || null;
        this.changed();
      });
      connector.on("wallet:signOut", () => {
        this.wallet = null;
        this.me = null;
        this.changed();
      });
      try {
        const w = await connector.wallet();
        const accounts = await w.getAccounts();
        if (accounts?.[0]) {
          this.wallet = w;
          this.me = accounts[0].accountId;
        }
      } catch {}
    } catch {
      this.mode = "none";
    }
  },

  onChange(fn) {
    listeners.add(fn);
  },
  changed() {
    for (const fn of listeners) fn();
  },

  become(id) {
    this.me = id || null;
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch {}
    this.changed();
  },

  async connect() {
    if (this.connector) await this.connector.connect();
  },
  async disconnect() {
    if (this.connector) await this.connector.disconnect();
  },

  role() {
    return this.people.find((p) => p.id === this.me)?.role || null;
  },

  /**
   * Do something as the current account. Returns { ok, value, error, link }.
   * `action` is one of: applaud, void, claim, cosign, settle, sync, pause, vote, resume.
   */
  async act(action, args = {}) {
    if (!this.me) return { ok: false, error: "Pick who you are first." };
    if (this.mode === "demo") {
      try {
        const res = await fetch("demo/act", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ as: this.me, action, args }),
        });
        return await res.json();
      } catch (e) {
        return { ok: false, error: `The demo relay did not answer: ${e.message}` };
      }
    }
    if (this.mode === "wallet" && this.wallet) return walletAct(this.wallet, action, args);
    return { ok: false, error: "Connect a wallet first." };
  },
};

const TGAS = 1_000_000_000_000n;

/** The same actions as the demo relay, as transactions for a wallet to sign. */
async function walletAct(wallet, action, a) {
  const c = await config();
  const dao = c.dao;
  const calls = {
    applaud: ["applaud", { dao, to: a.to, claps: Number(a.claps), note: a.note || null, quote: a.quote || null }, 30n],
    void: ["void_applause", { dao, round: Number(a.round), from: a.from, to: a.to, reason: a.reason || "" }, 30n],
    claim: ["claim", { dao, round: Number(a.round), account: a.account }, 150n],
    cosign: ["cosign", { dao, round: Number(a.round), account: a.account }, 100n],
    settle: ["settle", { dao, round: Number(a.round), account: a.account }, 100n],
    sync: ["sync_members", { dao }, 100n],
    pause: ["pause_stage", { dao }, 30n],
  };
  const spec = calls[action];
  if (!spec) return { ok: false, error: "That step happens on the DAO itself. Use your treasury app to vote." };
  const [methodName, args, gas] = spec;
  try {
    const res = await wallet.signAndSendTransaction({
      receiverId: c.contract,
      actions: [{ type: "FunctionCall", params: { methodName, args, gas: (gas * TGAS).toString(), deposit: "0" } }],
    });
    const hash = res?.transaction?.hash;
    const failure = res?.status?.Failure;
    let value = null;
    if (res?.status?.SuccessValue) {
      try {
        value = JSON.parse(atob(res.status.SuccessValue));
      } catch {}
    }
    const text = JSON.stringify(failure || "");
    const why = text.match(/ERR_[A-Z_]+[^"\\]*/)?.[0] || text;
    return { ok: !failure, value, error: failure ? why : null, link: hash ? `${c.explorer}/txns/${hash}` : null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

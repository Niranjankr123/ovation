// Everything the site knows comes from here: view calls to a NEAR RPC and reads of the
// public FastData index. No backend, no API key, no wallet needed to look.

const RPCS = ["https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com"];
let rpcAt = 0;

let conf;
/** Which contract and DAO this site shows. Written by scripts/deploy.mjs. */
export async function config() {
  if (!conf) {
    const res = await fetch("deployment.json", { cache: "no-store" });
    conf = await res.json();
    conf.kv = conf.network === "mainnet" ? "https://kv.main.fastnear.com" : "https://kv.test.fastnear.com";
    conf.explorer = conf.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  }
  return conf;
}

class ViewError extends Error {}

/** Call a view method and decode its JSON answer. Moves to the next RPC on network trouble only. */
export async function view(contractId, method, args = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: btoa(unescape(encodeURIComponent(JSON.stringify(args)))),
    },
  });
  let last;
  for (let i = 0; i < RPCS.length * 2; i++) {
    try {
      const res = await fetch(RPCS[rpcAt], { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) {
        const name = j.error.cause?.name || "";
        if (/UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR/.test(name)) throw new ViewError(j.error.data || name);
        throw new Error(j.error.message || name);
      }
      if (j.result?.error) throw new ViewError(j.result.error);
      const text = new TextDecoder().decode(Uint8Array.from(j.result.result));
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e instanceof ViewError) throw e;
      last = e;
      rpcAt = (rpcAt + 1) % RPCS.length;
    }
  }
  throw last;
}

/** Posts written to near.social's data layer by one account, newest first. */
export async function posts(author) {
  const c = await config();
  const all = [];
  let page_token;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${c.kv}/v0/latest/${c.social}/${author}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(page_token ? { key_prefix: "post/", page_token } : { key_prefix: "post/" }),
    });
    if (!res.ok) throw new Error(`the FastData index answered ${res.status}`);
    const j = await res.json();
    all.push(...(j.entries || []));
    page_token = j.page_token;
    if (!page_token) break;
  }
  return all
    .filter((e) => e.value && typeof e.value.text === "string")
    .map((e) => ({
      id: e.key.slice(5),
      text: e.value.text,
      quote: e.value.quote || null,
      at_ms: Math.floor(Number(BigInt(e.block_timestamp) / 1_000_000n)),
      block: e.block_height,
      author: e.predecessor_id,
    }))
    .sort((a, b) => b.at_ms - a.at_ms);
}

export function postUrl(c, author, id) {
  return c.network === "mainnet"
    ? `https://near.social/${author}/${id}`
    : `${c.kv}/v0/latest/${c.social}/${author}/${encodeURIComponent(`post/${id}`)}`;
}

// ---- Small formatting helpers ----

/** A token amount for people: up to `digits` decimals, trailing zeros dropped. */
export function amount(units, decimals = 24, digits = 4) {
  const v = BigInt(units || 0);
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const shown = Math.min(digits, decimals);
  const frac = ((v % unit) * 10n ** BigInt(shown)) / unit;
  if (whole === 0n && frac === 0n && v > 0n) return `<0.${"0".repeat(Math.max(shown - 1, 0))}1`;
  const f = frac.toString().padStart(shown, "0").replace(/0+$/, "");
  return f ? `${whole}.${f}` : `${whole}`;
}

/** The first label of an account id: asha.lantern-guild.testnet -> asha */
export const short = (id) => String(id).split(".")[0];

export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  if (s >= 2 * 86400) return `${Math.floor(s / 86400)} days`;
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function span(secs) {
  if (secs % 86400 === 0 && secs >= 86400) return `${secs / 86400} day${secs === 86400 ? "" : "s"}`;
  if (secs % 3600 === 0 && secs >= 3600) return `${secs / 3600} hour${secs === 3600 ? "" : "s"}`;
  if (secs % 60 === 0 && secs >= 60) return `${secs / 60} minute${secs === 60 ? "" : "s"}`;
  return `${secs} seconds`;
}

/** A stable colour for an account, for its avatar. */
export function hue(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

// ---- The ovation formula, for the explainer and the "what if" preview ----

export function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
const SCALE = 1_000_000n;
/** Score of a list of clap counts, one per member: (sum of square roots) squared. */
export function score(claps) {
  let sum = 0n;
  for (const c of claps) sum += isqrt(BigInt(c) * SCALE * SCALE);
  return Number((sum * sum) / (SCALE * SCALE / 100n)) / 100;
}

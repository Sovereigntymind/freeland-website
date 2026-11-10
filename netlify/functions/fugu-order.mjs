// Fugu voice agent -> Menu11 ORDER bridge (Netlify function). D-165. Logic + tests: ../lib/fugu-order-core.mjs,
// tasks/fugu-order-agent-2026-11/tests/. Reservations stay in fugu-reserve.mjs, untouched.
// Menu11 calls mirrored from the live page (order.js, login.js, pay page read logged-in 2026-11-09):
//   GET  order                      -> page html, names the config script c?ts=<n>
//   GET  c?ts=<n>                   -> var c="<3DES base64 config + menu>"
//   GET  login_phone_confirm?phone= -> texts the caller a 5-digit code
//   GET  login_phone_verify?phone=&pin=&remember= -> {STATUS:"OK", action:"DONE", sid}
//   GET  sid?sid=&remember=&action=pay            -> session cookie CRUNCH11_SID=<sid>
//   GET  status                     -> {login:"YES", id, phone, name, email}
//   POST cart   (jQuery form encoding of {data:{cart}})  -> {order:{...totals, number:"PENDING", snapshot}}   NOT an order
//   POST pay_confirm (form formCart: cart=<JSON>, SID, customer_name, customer_email, customer_phone, tender=CASH, tip) -> places the order
// FINDING 11/9: the `cart` call echoes whatever it is sent (a $17 item sent as $1 came back as $1; a missing required
// choice and a hidden item id were both accepted). Menu11 is NOT a safety net: every rule is enforced in the core.
// Tools (Retell custom functions, name or args.action): order_cart | order_send | order_place | order_status.
// Placing is OFF unless FUGU_ORDER_SUBMIT=on (set only for Kevin-approved test orders / go-live).
// The pay_confirm answer has never been seen (no order placed yet), so NOTHING it returns is trusted as success:
// every posted order comes back UNKNOWN -> the host confirms it. Tighten only after real answers are on file.
import crypto from "node:crypto";
import { buildIndex, decodeConfig, orderFlow, memoryStore } from "../lib/fugu-order-core.mjs";

const BASE = "https://fugusushi.menu11.com/ormond/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const BUDGET_MS = 26000;      // Retell gives each tool call 30 s; we stop early enough to save state and answer
const STEP_MS = 5000;         // limit for each read-only Menu11 call
const SUBMIT_MS = 10000;      // limit for the one pay_confirm post
const STORE_MS = 2500;        // limit for each storage call
const RECORD_NEEDS_MS = 6000; // held back after the post: one storage read + one write (2 x STORE_MS) + the reply
const SUBMIT_NEEDS_MS = 17000; // no claim unless this much of the 26 s budget is left (post up to 10 s + RECORD_NEEDS_MS + margin)
const H = (cookie, xhr = true) => ({ "User-Agent": UA, ...(xhr ? { "X-Requested-With": "XMLHttpRequest" } : {}), ...(cookie ? { Cookie: cookie } : {}) });
const get = (path, cookie, xhr) => fetch(BASE + path, { headers: H(cookie, xhr), signal: AbortSignal.timeout(STEP_MS) });
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { try { return JSON.parse(t.slice(0, t.lastIndexOf("}") + 1)); } catch { return { STATUS: "BAD_JSON" }; } } };

// Same encoding jQuery.param gives the page's json_post: nested keys in brackets, scalars in arrays as key[].
export function jqParams(prefix, v, out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => jqParams(`${prefix}[${x !== null && typeof x === "object" ? i : ""}]`, x, out));
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) jqParams(`${prefix}[${k}]`, x, out);
  else out.push([prefix, v === null || v === undefined ? "" : String(v)]);
  return out;
}

// Menu + hours. fresh=true (used right before placing) always re-reads the page; otherwise a 60 s cache.
let cached = { at: 0, ts: null, index: null };
export async function loadIndex(fresh = false) {
  if (!fresh && cached.index && Date.now() - cached.at < 60000) return cached.index;
  const html = await (await get("order", null, false)).text();
  const ts = html.match(/src="c\?ts=(\d+)"/)?.[1];
  if (!ts) throw new Error("menu: config script not found on the order page");
  if (ts !== cached.ts || !cached.index) cached = { ...cached, ts, index: buildIndex(decodeConfig(await (await get("c?ts=" + ts, null, false)).text())) };
  cached.at = Date.now();
  return cached.index;
}

export function menu11Client({ submitOn = process.env.FUGU_ORDER_SUBMIT === "on", houseEmail = process.env.FUGU_ORDER_EMAIL } = {}) {
  return {
    // Checked before a code is sent or used, so a config gap never wastes the caller's code.
    async ready() { return !submitOn ? "ordering is switched off" : !houseEmail ? "no email set for phone orders" : null; },
    async sendCode(phone) { return { ok: (await json(await get("login_phone_confirm?" + new URLSearchParams({ phone }), null))).STATUS === "OK" }; },
    async verify(phone, pin) {
      const v = await json(await get("login_phone_verify?" + new URLSearchParams({ phone, pin, remember: "" }), null));
      return v.STATUS === "OK" && v.action === "DONE" && v.sid ? { ok: true, cookie: "CRUNCH11_SID=" + v.sid } : { ok: false };
    },
    // The page visits sid?...&action=pay after login; kept for fidelity, never required (the cookie is the sid itself).
    async activate(cookie) { await get("sid?" + new URLSearchParams({ sid: cookie.split("=")[1], remember: "", action: "pay" }), null, false).then((r) => r.text()).catch(() => {}); },
    async serverCart(cookie, cart) {
      const r = await fetch(BASE + "cart", { method: "POST", headers: { ...H(cookie), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: new URLSearchParams(jqParams("data", { cart })), signal: AbortSignal.timeout(STEP_MS) });
      return (await json(r))?.order || null; // logged out = {"STATUS":"OK"} with no order
    },
    async session(cookie) { const st = await json(await get("status", cookie)); return st.login === "YES" && st.id ? { id: String(st.id), phone: String(st.phone) } : null; },
    // serverOrder was compared field by field with our own cart (core sameOrder) and the session was read BEFORE the
    // final hours/menu check, so this function does exactly one thing: the post.
    async submit(cookie, serverOrder, customer, maxMs = SUBMIT_MS) {
      if (!submitOn || !houseEmail) return { state: "NOT_SENT", reason: "ordering is switched off" };
      const { snapshot, ...order } = serverOrder;
      order.customer = { ...(order.customer || {}), name: customer.name, email: houseEmail };
      const body = new URLSearchParams({ cart: JSON.stringify(order), SID: customer.sid, customer_name: customer.name, customer_email: houseEmail, customer_phone: String(customer.phone), tender: "CASH", tip: "" });
      // ---- one-way step: from here an order may exist. Whatever comes back is recorded, never trusted, never retried. ----
      const r = await fetch(BASE + "pay_confirm", { method: "POST", headers: { ...H(cookie, false), "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual", signal: AbortSignal.timeout(Math.max(1000, Math.min(SUBMIT_MS, maxMs))) });
      const text = r.status >= 300 && r.status < 400 ? "" : await r.text().catch(() => "");
      const scrub = (s) => String(s || "").replaceAll(customer.sid, "SID").replace(/\s+/g, " ");
      return { state: "UNKNOWN", seen: { status: r.status, location: scrub(r.headers.get("location")).slice(0, 200), body: scrub(text).slice(0, 600) } };
    },
  };
}

// Netlify Blobs with compare-and-set (onlyIfNew / onlyIfMatch; @netlify/blobs docs read 2026-11-09). Records are
// encrypted because they hold the caller's session cookie. Proven on the deployed site with action order_selftest.
export async function blobStore(secret) {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: "fugu-orders", consistency: "strong" });
  const k = crypto.createHash("sha256").update("fugu-order:" + secret).digest();
  const enc = (o) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", k, iv); const b = Buffer.concat([c.update(JSON.stringify(o), "utf8"), c.final()]); return [iv, c.getAuthTag(), b].map((x) => x.toString("base64")).join("."); };
  const dec = (s) => { const [iv, tag, b] = s.split(".").map((x) => Buffer.from(x, "base64")); const d = crypto.createDecipheriv("aes-256-gcm", k, iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(b), d.final()]).toString("utf8")); };
  return {
    async get(key) { const r = await store.getWithMetadata(key, { type: "text" }); return r && r.data && r.etag ? { value: dec(r.data), version: r.etag } : null; },
    async cas(key, value, expected) { return (await store.set(key, enc(value), expected ? { onlyIfMatch: expected } : { onlyIfNew: true })).modified === true; },
  };
}

let testStore = null; // local dev only (FUGU_ORDER_STORE=memory)
export default async (request) => {
  const started = Date.now();
  if (request.method !== "POST") return Response.json({ result: "POST_ONLY" }, { status: 405 });
  const secret = process.env.FUGU_WEBHOOK_SECRET;
  if (!secret) return Response.json({ result: "NOT_CONFIGURED" }, { status: 503 }); // an unset secret never opens the door
  if (request.headers.get("x-fugu-key") !== secret) return Response.json({ result: "UNAUTHORIZED" }, { status: 401 });
  let p = {};
  try { p = await request.json(); } catch { return Response.json({ result: "BAD_JSON" }, { status: 400 }); }
  const args = p.args && typeof p.args === "object" ? p.args : p;
  const action = String(args.action || p.name || "").replace(/^fugu_/, "");
  const callId = String(p.call?.call_id || args.call_id || "");
  if (!callId && action !== "order_selftest") return Response.json({ result: "NO_CALL_ID" }, { status: 400 });
  try {
    const raw = process.env.FUGU_ORDER_STORE === "memory" ? (testStore ||= memoryStore()) : await blobStore(secret);
    const limit = (pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error("store timeout")), STORE_MS))]);
    const store = { get: (k) => limit(raw.get(k)), cas: (k, v, e) => limit(raw.cas(k, v, e)) };
    const flow = orderFlow({ store, m11: menu11Client(), loadIndex, elapsed: () => Date.now() - started, budgetMs: BUDGET_MS, submitNeedsMs: SUBMIT_NEEDS_MS, recordNeedsMs: RECORD_NEEDS_MS });
    const out = action === "order_cart" ? await flow.cart(callId, args.items)
      : action === "order_send" ? await flow.sendCode(callId, args.phone, args.approval)
      : action === "order_place" ? await flow.place(callId, { approval: args.approval, pin: args.code, name: args.name })
      : action === "order_status" ? await flow.status(callId)
      : action === "order_selftest" ? await flow.lockSelfTest() : { result: "UNKNOWN_TOOL" };
    console.log(JSON.stringify({ fn: "fugu-order", action, call: callId.slice(-8), result: out.result, errors: out.errors?.map((e) => e.code), total: out.total, ms: Date.now() - started }));
    return Response.json(out);
  } catch (e) {
    // A crash while placing may be before or after the post: the stored state decides on the next call (SUBMITTING stays locked).
    console.log(JSON.stringify({ fn: "fugu-order", action, call: callId.slice(-8), error: String(e).slice(0, 200), ms: Date.now() - started }));
    return Response.json({ result: action === "order_place" ? "HOST_CONFIRM" : "TRY_AGAIN_OR_HOST" });
  }
};

export const config = { path: "/api/fugu-order" };

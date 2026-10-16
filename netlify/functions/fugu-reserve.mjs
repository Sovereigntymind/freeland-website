// Fugu voice agent -> Menu11 reservation bridge (Netlify function, no deps).
// Endpoints mirrored from the live Menu11 page JS, read 2026-08-25/26 (reserve.js + login.js):
//   GET  reserve_check?guestCount=&dated=MM/DD/YYYY&timed=HH:MM AM&section=   -> [{section,hour}] (hour = minutes since midnight)
//   GET  login_phone_confirm?phone=            -> {"STATUS":"OK"} and Menu11 texts the caller a 5-digit code (verified 8/25 11:20 PM)
//   GET  login_phone_verify?phone=&pin=&remember= -> {"STATUS":"OK","action":"DONE","sid":...}
//   GET  sid?sid=&remember=&action=reserve_pay -> sets the session cookie
//   POST reserve_confirm  request=<JSON of the request>  -> status page reserve_?s=d&x=rs...
// Actions: check | send | book. Every call is stateless (book does verify -> cookie -> confirm in one go).
//   Session cookie = CRUNCH11_SID=<sid> (set by the sid endpoint); /status then reports login YES.

const BASE = "https://fugusushi.menu11.com/ormond/";
const FORM_ACTION = "reserve_confirm"; // form id=formRequest method=POST action=reserve_confirm, hidden input name="request" (read logged-in 8/25 11:40 PM)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

const hourToText = (h) => {
  const hh = Math.floor(h / 60), mm = h % 60, ap = hh >= 12 ? "PM" : "AM";
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ap}`;
};
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

async function getJson(path, params, cookie) {
  const url = BASE + path + "?" + new URLSearchParams(params);
  const r = await fetch(url, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", ...(cookie ? { Cookie: cookie } : {}) } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { try { return JSON.parse(t.slice(0, t.lastIndexOf("}") + 1)); } catch { return { STATUS: "BAD_JSON", raw: t.slice(0, 200) }; } }
}

// Phone-booking cap (Kevin 10/15): at most PHONE_CAP bookings per half hour in EACH area (3 inside + 3 patio).
// Counted from Mika's own successful fugu_book results in Retell call history (the only phone-booking
// path besides the host). Host-entered POS bookings and walk-ins are not visible here; the host owns those.
const PHONE_CAP = Number(process.env.FUGU_PHONE_CAP || 3);
const MIKA_AGENT = "agent_bb38403baa3b3142f0869c1faf";
// Bookings the host re-timed in the POS after Mika booked them (booking id -> real time).
const RETIMED = { rs202610151716354b38054a476ad142b3572fb381950106e3: "7:45 PM" }; // Paul, Fri 10/16 (asked 7:45, filed 7:00; fixed in POS 10/15)
// "7:45 PM", "07:00 pm", "7 PM", "7:00 p.m.", "19:00" -> minutes since midnight; anything else -> null.
const toMin = (t) => {
  const s = String(t ?? "").replace(/ /g, " ").trim().toLowerCase().replace(/\./g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m || (!m[3] && !m[2])) return null;
  const h = +m[1], mm = +(m[2] || 0);
  if (mm > 59 || h > 23 || (m[3] && (h < 1 || h > 12))) return null;
  return (m[3] ? (h % 12) + (m[3] === "pm" ? 12 : 0) : h) * 60 + mm;
};
// One date key for counting and lookups: "10/6/2026", "10/06/2026", "2026-10-06" -> "10/06/2026"; else null.
const normDate = (d) => {
  const s = String(d ?? "").trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/), y, mo, da;
  if (m) [, mo, da, y] = m; else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, mo, da] = m; else return null;
  if (+mo < 1 || +mo > 12 || +da < 1 || +da > 31) return null;
  return `${String(mo).padStart(2, "0")}/${String(da).padStart(2, "0")}/${y}`;
};
// Menu11 sections are Main/Patio online; the POS edit form calls them Inside/Outside.
const area = (sec) => (/^(patio|outside)$/i.test(String(sec ?? "").trim()) ? "Patio" : "Main");
const bucket = (date, mins, sec) => `${normDate(date)}|${Math.floor(mins / 30) * 30}|${area(sec)}`;

// Menu11 RESERVE AHEAD is empty = 7 days (Back Office, read 10/15), so 9 days of calls covers every future booking.
const LOOKBACK_MS = 9 * 864e5;
// Bookings this instance just made, counted even before Retell lists the call (a call's tool results may only
// show in list-calls after it ends). Covers back-to-back calls on a warm instance; cross-instance races remain
// possible but rare at Fugu's call volume.
const recentBooks = new Map(); // id -> bucket key
let capCache = { at: 0, counts: null };
async function phoneCounts({ fresh = false } = {}) {
  if (!fresh && capCache.counts && Date.now() - capCache.at < 20000) return withRecent(capCache.counts);
  const key = process.env.RETELL_FUGU_API_KEY;
  if (!key) throw new Error("cap check unavailable (no Retell key)");
  const counts = {}, seen = new Set();
  let pagination_key, full = false;
  for (let page = 0; page < 5; page++) {
    const body = { filter_criteria: { agent_id: [MIKA_AGENT], start_timestamp: { lower_threshold: Date.now() - LOOKBACK_MS } }, sort_order: "descending", limit: 1000, ...(pagination_key ? { pagination_key } : {}) };
    const r = await fetch("https://api.retellai.com/v2/list-calls", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`cap check unavailable (Retell ${r.status})`);
    const calls = await r.json();
    for (const c of calls) for (const m of c.transcript_with_tool_calls || []) {
      if (m.role !== "tool_call_result") continue;
      let d; try { d = JSON.parse(m.content || "{}"); } catch { continue; }
      if (!d?.ok || !d.booked?.dated || !d.id || seen.has(d.id)) continue;
      seen.add(d.id);
      const mins = toMin(RETIMED[d.id] || d.booked.timed);
      if (mins != null && normDate(d.booked.dated)) counts[bucket(d.booked.dated, mins, d.booked.section)] = (counts[bucket(d.booked.dated, mins, d.booked.section)] || 0) + 1;
    }
    full = calls.length >= 1000;
    if (!full) break;
    pagination_key = calls[calls.length - 1].call_id;
  }
  if (full) throw new Error("cap check unavailable (call history too long to count)");
  for (const id of seen) recentBooks.delete(id); // Retell now lists it, so stop double counting
  capCache = { at: Date.now(), counts };
  return withRecent(counts);
}
const withRecent = (counts) => {
  const out = { ...counts };
  for (const k of recentBooks.values()) out[k] = (out[k] || 0) + 1;
  return out;
};

export async function check({ guests, date, time, section = "" }, { fresh = false } = {}) {
  if (!normDate(date)) return { ok: false, error: "date must be MM/DD/YYYY" };
  const slots = await getJson("reserve_check", { guestCount: guests, dated: normDate(date), timed: time, section });
  if (!Array.isArray(slots)) return { ok: false, error: "no availability data", raw: slots };
  let counts;
  try { counts = await phoneCounts({ fresh }); } catch (e) { return { ok: true, slots: [], note: `${e.message}; treat every time as full and offer the host` }; }
  const open = slots.filter((s) => (counts[bucket(date, s.hour, s.section)] || 0) < PHONE_CAP);
  return { ok: true, slots: open.map((s) => ({ section: s.section, hour: s.hour, time: hourToText(s.hour) })) };
}

export async function send({ phone }) {
  const p = digits(phone);
  if (p.length !== 10) return { ok: false, error: "need a 10-digit US mobile number" };
  const r = await getJson("login_phone_confirm", { phone: p });
  return { ok: r?.STATUS === "OK", raw: r };
}

export async function book({ phone, pin, name, email, guests, date, time, section }) {
  const p = digits(phone), code = String(pin || "").replace(/\D/g, "");
  if (p.length !== 10) return { ok: false, error: "need a 10-digit mobile number" };
  if (code.length !== 5) return { ok: false, error: "code must be 5 digits" };
  if (!name) return { ok: false, error: "name required" };
  if (!email || !email.includes("@") || !email.includes(".")) return { ok: false, error: "email required by Menu11" };
  if (toMin(time) == null) return { ok: false, error: "time must look like 7:00 PM" };
  // Pick the slot BEFORE using the caller's code, with a fresh cap count, so a full time never burns the code.
  const avail = await check({ guests, date, time, section: section || "" }, { fresh: true });
  if (!avail.ok) return avail;
  // Exact time only (10/15): the old fallback filed a 7:45 request at 7:00 without telling the caller.
  const want = avail.slots?.find((s) => toMin(s.time) === toMin(time) && (!section || s.section === section));
  if (!want) return { ok: false, error: "that exact time is not open for phone booking", slots: avail.slots || [] };
  const v = await getJson("login_phone_verify", { phone: p, pin: code, remember: "" });
  if (v?.STATUS !== "OK" || v.action !== "DONE" || !v.sid) return { ok: false, error: "invalid code", raw: v };
  // session cookie
  const sidRes = await fetch(BASE + "sid?" + new URLSearchParams({ sid: v.sid, remember: "", action: "reserve_pay" }), { headers: { "User-Agent": UA }, redirect: "manual" });
  const cookie = (sidRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") || `CRUNCH11_SID=${v.sid}`;
  const req = { dated: normDate(date), timed: want.time, hour: want.hour, guestCount: Number(guests), section: want.section, customerName: name, customerPhone: p, customerEmail: email };
  const body = new URLSearchParams({ request: JSON.stringify(req) });
  const r = await fetch(BASE + FORM_ACTION, { method: "POST", headers: { "User-Agent": UA, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  const loc = r.headers.get("location") || "";
  const html = r.status >= 300 && r.status < 400 ? "" : await r.text();
  const alertMsg = (html.match(/alert\('([^']+)'\)/) || [])[1];
  if (alertMsg) return { ok: false, error: alertMsg, hint: /Max number/i.test(alertMsg) ? "this mobile number already has an open reservation request; ask the caller to cancel it or use the restaurant line" : undefined };
  const id = (loc.match(/x=([A-Za-z0-9]+)/) || html.match(/x=([A-Za-z0-9]+)/) || [])[1] || null;
  if (id) recentBooks.set(id, bucket(req.dated, want.hour, want.section));
  const status = /PENDING/i.test(html) ? "PENDING" : /CONFIRM/i.test(html) ? "CONFIRMED" : "SUBMITTED";
  return { ok: !!id, id, status, booked: { ...req, customerPhone: undefined }, cancelUrl: id ? `${BASE}reserve_cancel?x=${id}` : null, httpStatus: r.status, location: loc };
}

const ACTIONS = { check, send, book };

// Netlify handler. VAPI "API Request"/custom tool posts JSON: {action, ...params}. Shared secret in X-Fugu-Key.
export default async (request) => {
  if (request.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (process.env.FUGU_WEBHOOK_SECRET && request.headers.get("x-fugu-key") !== process.env.FUGU_WEBHOOK_SECRET) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let payload = {};
  try { payload = await request.json(); } catch { return Response.json({ ok: false, error: "bad json" }, { status: 400 }); }
  // VAPI shape (docs.vapi.ai/tools/custom-tools, fetched 2026-08-26): {message:{type:"tool-calls",toolCallList:[{id,name,arguments:{...}}]}}
  // -> respond {results:[{toolCallId,result}]}. Older payloads nest under function.{name,arguments}; both handled.
  const calls = payload?.message?.toolCallList;
  if (Array.isArray(calls)) {
    const results = [];
    for (const c of calls) {
      const rawArgs = c.arguments ?? c.function?.arguments ?? {};
      const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      const fn = ACTIONS[args.action || String(c.name || c.function?.name || "").replace(/^fugu_/, "")];
      const result = fn ? await fn(args).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "unknown tool" };
      results.push({ toolCallId: c.id, result: JSON.stringify(result) });
    }
    return Response.json({ results });
  }
  // Retell custom-function shape (docs.retellai.com/build/single-multi-prompt/custom-function, fetched 2026-08-27): body = {name, call, args:{...}}; whatever we return is stringified for the LLM.
  const args = payload.args && typeof payload.args === "object" ? payload.args : payload;
  const fn = ACTIONS[args.action || String(payload.name || "").replace(/^fugu_/, "")];
  if (!fn) return Response.json({ ok: false, error: "action must be check|send|book" }, { status: 400 });
  return Response.json(await fn(args).catch((e) => ({ ok: false, error: String(e) })));
};

export const config = { path: "/api/fugu-reserve" };

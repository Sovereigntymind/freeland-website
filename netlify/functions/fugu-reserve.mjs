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

// Phone bookings hold real tables (Kevin 10/15: "pick it up by 2 tops, 4 tops"). Phone owns about half of each
// area's tables; every phone booking holds the right-size table for its expected stay, so a 5:30 couple still
// seated at 6:30 still counts and nothing is booked on top of a seated party. Walk-ins keep the other half; the
// host can always seat or book beyond this in the POS (POS bookings and walk-ins are not visible here).
// Tables (POS map, 10/15): inside bookable 8 two-tops + 10 four-tops (10, 15, 53 never phone-booked);
// patio P1-P12 = 4 two-tops + 8 four-tops (patio music area almost never open).
const PHONE_TABLES = {
  Main: { two: Number(process.env.FUGU_INSIDE_TWOS || 4), four: Number(process.env.FUGU_INSIDE_FOURS || 5) },
  Patio: { two: Number(process.env.FUGU_PATIO_TWOS || 2), four: Number(process.env.FUGU_PATIO_FOURS || 4) },
};
// Pacing (Kevin 10/15, 15-minute slots): at most this many phone parties ARRIVE in the same 15 minutes per area,
// so the door and kitchen never get a wave; parties of 5-6 (two pushed four-tops) at most 1 seated at once per area;
// 7 or more always go to the host (Mika transfers; check() returns no times).
const ARRIVALS_PER_15 = { Main: Number(process.env.FUGU_INSIDE_ARRIVALS || 2), Patio: Number(process.env.FUGU_PATIO_ARRIVALS || 1) };
const BIG_AT_ONCE = 1;
export const HOST_PARTY = 7;
// Expected stay by party size (Kevin's 1h15 guess + general research; tune from POS data).
const stayMin = (g) => (g <= 2 ? 70 : g <= 4 ? 85 : g <= 6 ? 100 : 115);
// Tables a party needs: 1-2 a two-top (or a free four-top), 3-4 a four-top, 5-8 two four-tops pushed together.
const need = (g) => (g <= 2 ? { two: 1, four: 0 } : g <= 4 ? { two: 0, four: 1 } : { two: 0, four: 2 });
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
// One date key: "10/6/2026", "10/06/2026", "2026-10-06" -> "10/06/2026"; else null.
const normDate = (d) => {
  const s = String(d ?? "").trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/), y, mo, da;
  if (m) [, mo, da, y] = m; else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, mo, da] = m; else return null;
  if (+mo < 1 || +mo > 12 || +da < 1 || +da > 31) return null;
  return `${String(mo).padStart(2, "0")}/${String(da).padStart(2, "0")}/${y}`;
};
// Menu11 sections are Main/Patio online; the POS edit form calls them Inside/Outside.
const area = (sec) => (/^(patio|outside)$/i.test(String(sec ?? "").trim()) ? "Patio" : "Main");

// True if one more party of g at `start` fits the phone tables in area `ar` on `date`, given existing phone
// bookings. Checks every 5 minutes of the new party's stay: four-tops in use <= allotment, and couples fit in
// the phone two-tops plus any phone four-tops left over.
export function fits(bookings, date, ar, start, g) {
  const cap = PHONE_TABLES[ar];
  const mine = [...bookings.filter((b) => b.date === date && b.area === ar), { start, g }];
  const block = Math.floor(start / 15);
  if (mine.filter((b) => Math.floor(b.start / 15) === block).length > ARRIVALS_PER_15[ar]) return false;
  for (let t = start; t < start + stayMin(g); t += 5) {
    let two = 0, four = 0, big = 0;
    for (const b of mine) {
      if (b.start <= t && t < b.start + stayMin(b.g)) { const n = need(b.g); two += n.two; four += n.four; big += b.g >= 5 ? 1 : 0; }
    }
    if (four > cap.four || two > cap.two + (cap.four - four) || (g >= 5 && big > BIG_AT_ONCE)) return false;
  }
  return true;
}

// Menu11 RESERVE AHEAD is empty = 7 days (Back Office, read 10/15), so 9 days of calls covers every future booking.
const LOOKBACK_MS = 9 * 864e5;
// Retell retired /v2/list-calls (notice 10/19) and /v3/list-calls omits transcripts, so book() writes each booking
// onto its call's metadata (fugu_bookings = [{id, dated, timed, section, g}]) and the cap count reads that back.
// PATCH replaces the whole metadata object (tested 10/19), so a call's full list is written every time.
// Calls from before this change were backfilled by clients/fugu/agent/backfill_booking_metadata.py.
const RETELL = "https://api.retellai.com";
const retellHeaders = () => ({ Authorization: `Bearer ${process.env.RETELL_FUGU_API_KEY}`, "Content-Type": "application/json" });
const callBooks = new Map(); // call_id -> raw bookings made on that call (this instance; fallback if the GET fails)
const mergeById = (...lists) => [...new Map(lists.flat().filter((b) => b?.id).map((b) => [b.id, b])).values()];
// Read-modify-write so a second booking on the same call (another instance, cold start) never erases the first,
// and any other metadata keys survive. Returns true only when Retell confirmed the write; failures are logged.
async function tagCall(callId, rec) {
  if (!process.env.RETELL_FUGU_API_KEY || !/^call_[A-Za-z0-9]+$/.test(String(callId || ""))) {
    console.error("fugu_tag skipped: no call id/key", callId, rec.id);
    return false;
  }
  if (callBooks.size > 200) callBooks.clear();
  callBooks.set(callId, mergeById(callBooks.get(callId) || [], [rec]));
  // One budget (~4.5 s) for both attempts so book() stays inside the function time limit. If the GET fails we do NOT
  // write (a blind write could erase another instance's booking); the transcript backup counts it after the call ends.
  const deadline = Date.now() + 4500;
  for (let attempt = 1; attempt <= 2 && deadline - Date.now() > 1000; attempt++) {
    try {
      const left = () => Math.max(500, Math.min(2000, deadline - Date.now()));
      const g = await fetch(`${RETELL}/v2/get-call/${callId}`, { headers: retellHeaders(), signal: AbortSignal.timeout(left()) });
      if (!g.ok) { console.error("fugu_tag GET failed", g.status, callId, rec.id, attempt); continue; }
      const meta = (await g.json()).metadata || {};
      const all = mergeById(meta.fugu_bookings || [], callBooks.get(callId), [rec]);
      const p = await fetch(`${RETELL}/v2/update-call/${callId}`, { method: "PATCH", headers: retellHeaders(), body: JSON.stringify({ metadata: { ...meta, fugu_bookings: all } }), signal: AbortSignal.timeout(left()) });
      if (p.ok) { console.log("fugu_tag ok", callId, rec.id); return true; }
      console.error("fugu_tag PATCH failed", p.status, callId, rec.id, attempt);
    } catch (e) {
      console.error("fugu_tag error", String(e), callId, rec.id, attempt);
    }
  }
  return false;
}
const transcriptCache = new Map(); // ended call_id -> raw bookings read from its transcript (backup path)
// Same shape book() writes, from the old source: tool results in transcript_with_tool_calls.
function fromTranscript(msgs) {
  const out = [];
  for (const m of msgs || []) {
    if (m.role !== "tool_call_result") continue;
    let d; try { d = JSON.parse(m.content || "{}"); } catch { continue; }
    if (d?.ok && d.id && d.booked?.dated) out.push({ id: d.id, dated: d.booked.dated, timed: d.booked.timed, section: d.booked.section, g: Number(d.booked.guestCount) || 1 });
  }
  return out;
}
// Bookings this instance just made, counted before Retell lists the call's metadata. Covers back-to-back calls on a
// warm instance; cross-instance races remain possible but rare at Fugu's call volume.
const recentBooks = new Map(); // id -> { date, area, start, g }
let capCache = { at: 0, list: null };
async function phoneBookings({ fresh = false } = {}) {
  if (!fresh && capCache.list && Date.now() - capCache.at < 20000) return [...capCache.list, ...recentBooks.values()];
  if (!process.env.RETELL_FUGU_API_KEY) throw new Error("cap check unavailable (no Retell key)");
  const list = [], seen = new Set();
  let pagination_key, more = false;
  for (let page = 0; page < 5; page++) {
    const body = { filter_criteria: { agent: [{ agent_id: MIKA_AGENT }], start_timestamp: { type: "number", op: "ge", value: Date.now() - LOOKBACK_MS } }, sort_order: "descending", limit: 1000, ...(pagination_key ? { pagination_key } : {}) };
    const r = await fetch(`${RETELL}/v3/list-calls`, { method: "POST", headers: retellHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`cap check unavailable (Retell ${r.status})`);
    const res = await r.json();
    const items = res.items || [];
    // Backup for a note that failed to save mid-call: an ENDED call long enough to book, with no fugu_bookings key,
    // gets its transcript read once (ended calls never change, so the result is cached on this instance).
    const untagged = items.filter((c) => !Array.isArray(c.metadata?.fugu_bookings) && ["ended", "error"].includes(c.call_status) && (c.duration_ms || 0) >= 60000 && !transcriptCache.has(c.call_id));
    await Promise.all(untagged.map(async (c) => {
      const g = await fetch(`${RETELL}/v2/get-call/${c.call_id}`, { headers: retellHeaders(), signal: AbortSignal.timeout(3000) });
      if (!g.ok) throw new Error(`cap check unavailable (Retell get-call ${g.status})`);
      transcriptCache.set(c.call_id, fromTranscript((await g.json()).transcript_with_tool_calls));
    }));
    for (const c of items) {
      const raw = Array.isArray(c.metadata?.fugu_bookings) ? c.metadata.fugu_bookings : transcriptCache.get(c.call_id) || [];
      for (const b of raw) {
        if (!b?.id || !b.dated || seen.has(b.id)) continue;
        seen.add(b.id);
        const start = toMin(RETIMED[b.id] || b.timed), date = normDate(b.dated);
        if (start != null && date) list.push({ date, area: area(b.section), start, g: Number(b.g) || 1 });
        else console.error("fugu_cap unreadable booking", b.id, b.dated, b.timed);
      }
    }
    more = !!res.has_more;
    if (more && !res.pagination_key) throw new Error("cap check unavailable (Retell page key missing)");
    if (!more) break;
    pagination_key = res.pagination_key;
  }
  if (more) throw new Error("cap check unavailable (call history too long to count)");
  for (const id of seen) recentBooks.delete(id); // Retell now lists it, so stop double counting
  capCache = { at: Date.now(), list };
  return [...list, ...recentBooks.values()];
}

export async function check({ guests, date, time, section = "" }, { fresh = false } = {}) {
  if (!normDate(date)) return { ok: false, error: "date must be MM/DD/YYYY" };
  const slots = await getJson("reserve_check", { guestCount: guests, dated: normDate(date), timed: time, section });
  if (!Array.isArray(slots)) return { ok: false, error: "no availability data", raw: slots };
  let list;
  try { list = await phoneBookings({ fresh }); } catch (e) { return { ok: true, slots: [], note: `${e.message}; treat every time as full and offer the host` }; }
  const party = Number(guests) || 1;
  if (party >= HOST_PARTY) return { ok: true, slots: [], note: `parties of ${HOST_PARTY} or more are booked by the host; offer the transfer` };
  const open = slots.filter((s) => fits(list, normDate(date), area(s.section), s.hour, party));
  return { ok: true, slots: open.map((s) => ({ section: s.section, hour: s.hour, time: hourToText(s.hour) })) };
}

export async function send({ phone }) {
  const p = digits(phone);
  if (p.length !== 10) return { ok: false, error: "need a 10-digit US mobile number" };
  const r = await getJson("login_phone_confirm", { phone: p });
  return { ok: r?.STATUS === "OK", raw: r };
}

export async function book({ phone, pin, name, email, guests, date, time, section, callId }) {
  const p = digits(phone), code = String(pin || "").replace(/\D/g, "");
  if (p.length !== 10) return { ok: false, error: "need a 10-digit mobile number" };
  if (code.length !== 5) return { ok: false, error: "code must be 5 digits" };
  if (!name) return { ok: false, error: "name required" };
  if (!email || !email.includes("@") || !email.includes(".")) return { ok: false, error: "email required by Menu11" };
  if (toMin(time) == null) return { ok: false, error: "time must look like 7:00 PM" };
  // Pick the slot BEFORE using the caller's code, with a fresh cap count, so a full time never burns the code.
  // Ask Menu11 for every section, then match by area: Menu11 renamed Main/Patio to Inside/Outside on 10/15.
  const avail = await check({ guests, date, time, section: "" }, { fresh: true });
  if (!avail.ok) return avail;
  // Exact time only (10/15): the old fallback filed a 7:45 request at 7:00 without telling the caller.
  const want = avail.slots?.find((s) => toMin(s.time) === toMin(time) && (!section || area(s.section) === area(section)));
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
  let capLogged = false;
  if (id) {
    recentBooks.set(id, { date: req.dated, area: area(want.section), start: want.hour, g: Number(guests) || 1 });
    capLogged = await tagCall(callId, { id, dated: req.dated, timed: want.time, section: want.section, g: Number(guests) || 1 });
  }
  const status = /PENDING/i.test(html) ? "PENDING" : /CONFIRM/i.test(html) ? "CONFIRMED" : "SUBMITTED";
  return { ok: !!id, id, status, booked: { ...req, customerPhone: undefined }, cancelUrl: id ? `${BASE}reserve_cancel?x=${id}` : null, httpStatus: r.status, location: loc, cap_logged: capLogged };
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
  return Response.json(await fn({ ...args, callId: payload.call?.call_id }).catch((e) => ({ ok: false, error: String(e) })));
};

export const config = { path: "/api/fugu-reserve" };

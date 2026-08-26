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

export async function check({ guests, date, time, section = "" }) {
  const slots = await getJson("reserve_check", { guestCount: guests, dated: date, timed: time, section });
  if (!Array.isArray(slots)) return { ok: false, error: "no availability data", raw: slots };
  return { ok: true, slots: slots.map((s) => ({ section: s.section, hour: s.hour, time: hourToText(s.hour) })) };
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
  const v = await getJson("login_phone_verify", { phone: p, pin: code, remember: "" });
  if (v?.STATUS !== "OK" || v.action !== "DONE" || !v.sid) return { ok: false, error: "invalid code", raw: v };
  // session cookie
  const sidRes = await fetch(BASE + "sid?" + new URLSearchParams({ sid: v.sid, remember: "", action: "reserve_pay" }), { headers: { "User-Agent": UA }, redirect: "manual" });
  const cookie = (sidRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") || `CRUNCH11_SID=${v.sid}`;
  // pick the slot
  const avail = await check({ guests, date, time, section: section || "" });
  const want = avail.slots?.find((s) => s.time === time && (!section || s.section === section)) || avail.slots?.find((s) => !section || s.section === section);
  if (!want) return { ok: false, error: "no table for that time", slots: avail.slots || [] };
  const req = { dated: date, timed: want.time, hour: want.hour, guestCount: Number(guests), section: want.section, customerName: name, customerPhone: p, customerEmail: email };
  const body = new URLSearchParams({ request: JSON.stringify(req) });
  const r = await fetch(BASE + FORM_ACTION, { method: "POST", headers: { "User-Agent": UA, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  const loc = r.headers.get("location") || "";
  const html = r.status >= 300 && r.status < 400 ? "" : await r.text();
  const alertMsg = (html.match(/alert\('([^']+)'\)/) || [])[1];
  if (alertMsg) return { ok: false, error: alertMsg, hint: /Max number/i.test(alertMsg) ? "this mobile number already has an open reservation request; ask the caller to cancel it or use the restaurant line" : undefined };
  const id = (loc.match(/x=([A-Za-z0-9]+)/) || html.match(/x=([A-Za-z0-9]+)/) || [])[1] || null;
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
  const fn = ACTIONS[payload.action];
  if (!fn) return Response.json({ ok: false, error: "action must be check|send|book" }, { status: 400 });
  return Response.json(await fn(payload).catch((e) => ({ ok: false, error: String(e) })));
};

export const config = { path: "/api/fugu-reserve" };

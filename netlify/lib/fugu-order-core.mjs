// Fugu phone ORDER bridge: core logic (no network, no deps). D-165, plan: tasks/fugu-order-agent-2026-11/PLAN.md
// Mirrors the Menu11 order page's own code (order.js read 2026-11-09): config decode, menu rules, cart math.
// The voice agent only ever sends item ids + choices; names, prices, tax and kitchen routing come from the live menu.
import crypto from "node:crypto";

// Card at pickup: the POS adds an NCA (non-cash adjust) of 3.59% on the full total incl tax (David Campbell 11/13; #95001 3515 -> 3641).
// Cash pays the plain total. Mika reads the card total so nobody pays more than they heard.
export const NCA_BP = 359;
export const cardTotal = (cents) => cents + Math.round((cents * NCA_BP) / 10000);
export const LIMITS = { lines: 8, units: 12, perItem: 6, subtotalCents: 15000, noteChars: 80, approvalMinutes: 10 };
const CONFIG_KEY = "ajjlklkJLKdjklfa83k22".padEnd(24, " ").slice(0, 24); // public key in the page script (config_init)
const ALLERGY = /\b(allerg\w*|anaphyla\w*|epi-?pen|celiac|coeliac|gluten[- ]free|intoleran\w*|cross[- ]contamin\w*|safe for)\b/i;

// The page loads c?ts=... defining var c="<base64 3DES>"; it decrypts and evals. We decrypt and PARSE (never eval).
export function decodeConfig(cScript) {
  const m = String(cScript).match(/var\s+c\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("config: var c not found");
  const d = crypto.createDecipheriv("des-ede3", Buffer.from(CONFIG_KEY, "latin1"), null);
  d.setAutoPadding(false);
  const text = Buffer.concat([d.update(Buffer.from(m[1], "base64")), d.final()]).toString("utf8");
  const start = text.indexOf("{"), end = text.lastIndexOf(";");
  if (!text.startsWith("GLOBALS.CONFIGURATION") || start < 0 || end < start) throw new Error("config: unexpected shape");
  return JSON.parse(text.slice(start, end));
}

export function buildIndex(config) {
  const M = config.MENU;
  const items = new Map(), templates = new Map(), components = new Map(), options = new Map();
  for (const c of M.modifier_component?.list || []) {
    components.set(String(c.id), c);
    for (const o of c.list || []) options.set(String(o.id), { ...o, component_id: String(c.id) });
  }
  for (const t of M.modifier_template?.list || []) templates.set(String(t.id), t);
  for (const screen of M.menu?.list || []) for (const cat of screen.list || []) for (const it of cat.list || []) {
    const hidden = it.visible_ONLINE === "HIDE" || it.status === "INACTIVE" || cat.visible_ONLINE === "HIDE" || cat.status === "INACTIVE" || screen.visible_ONLINE === "HIDE";
    items.set(String(it.id), { item: it, cat, screen, hidden });
  }
  // Exact-name lookup (the voice agent may send the menu name instead of the id). Never fuzzy: no match = unknown item.
  const byName = new Map();
  for (const [id, e] of items) if (!e.hidden) byName.set(norm(e.item.name), byName.has(norm(e.item.name)) ? null : id);
  return { config, items, byName, templates, components, options, menuHash: sha(JSON.stringify(M)).slice(0, 12) };
}

export const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const cents = (v) => Math.round(parseFloat(String(v ?? "0").replace(/[^0-9.\-]/g, "") || "0") * 100);
const ucwords = (s) => String(s).replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
const dispName = (config, s) => (config.MENU_CAPITAL === "DISABLE" ? s : ucwords(s));

// Price choices for a multi-price item: [{n:"2", name:"Chicken", cents:900}]
export function priceChoices(it) {
  const out = [];
  if (it.price_type !== "MULTIPLE") return out;
  for (let n = 1; n <= 20; n++) if (it["price_name_" + n]) out.push({ n: String(n), name: it["price_name_" + n], cents: cents(it["price_amount_" + n]) });
  return out;
}

// Required/allowed choice groups for an item (category template unless the item or the chosen price overrides it).
export function choiceGroups(index, entry, priceSelection) {
  const { item, cat } = entry;
  let tid = item.modifier === "CUSTOM" ? item.modifier_id : cat.modifier_id;
  if (priceSelection && item["price_modifier_" + priceSelection] === "CUSTOM") tid = item["price_modifier_id_" + priceSelection];
  const t = tid && index.templates.get(String(tid));
  if (!tid) return { templateId: null, groups: [] };
  if (!t) return { templateId: String(tid), groups: [], missing: true }; // rule data missing = refuse, never "no choices"
  const groups = [];
  for (const g of t.list || []) {
    const c = index.components.get(String(g.component_id));
    if (!c) return { templateId: String(tid), groups: [], missing: true };
    groups.push({ id: String(c.id), name: c.name, min: Number(g.min) || 0, max: Number(g.max) || 0,
      options: (c.list || []).filter((o) => o.status !== "INACTIVE").map((o) => ({ id: String(o.id), name: o.name, cents: cents(o.price) })) });
  }
  return { templateId: String(tid), groups };
}

// Minutes since midnight + weekday in the restaurant's timezone.
export function localClock(config, now = new Date()) {
  const tz = config.info?.timezone || "America/New_York";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: p.weekday.toUpperCase(), min: (Number(p.hour) % 24) * 60 + Number(p.minute), ymd: `${p.year}-${p.month}-${p.day}` };
}
// Same rule as the page's store_getOpenStatusAt: a CUSTOM day needs its own SCHEDULE_<dest>_<DAY>=YES.
function openStatus(config, dest, clock) {
  let key = "DEFAULT";
  if (config["SCHEDULE_" + clock.day] === "YES") key = clock.day;
  else if (config["SCHEDULE_" + clock.day] === "CUSTOM") { if (config[`SCHEDULE_${dest}_${clock.day}`] !== "YES") return false; key = clock.day; }
  const a = Number(config[`SCHEDULE_OPEN_${dest}_${key}`]) || 0, g = Number(config[`SCHEDULE_CLOSE_${dest}_${key}`]) || 0;
  const between = g >= 1440 ? (clock.min >= a && clock.min < 1440) || clock.min < g - 1440 : clock.min >= a && clock.min < g;
  if (!between) return false;
  const bi = Number(config[`SCHEDULE_BREAKIN_${dest}_${key}`]) || 0, bo = Number(config[`SCHEDULE_BREAKOUT_${dest}_${key}`]) || 0;
  return !(bi > 0 && bo > 0 && clock.min >= bi && clock.min < bo);
}
// Never works around the hours block: closed on the page = closed for the phone.
export function pickupOpen(config, now = new Date()) {
  const clock = localClock(config, now);
  if ((config.CLOSEDATES || []).includes(clock.ymd)) return false;
  return config.PICKUP_USE === "YES" && openStatus(config, "STORE", clock) && openStatus(config, "PICKUP", clock);
}

/**
 * Validate + price an order. lines: [{ id, qty, price_choice?, choices?: [optionId], note? }]
 * Returns { ok, errors: [{code, line, ...}], lines, subtotal, tax, total, approval } (money in cents).
 * disabled = Set of sold-out item/option ids (from the page's store setting, once we know where it loads from).
 */
export function priceCart(index, lines, { now = new Date(), disabled = new Set(), enforceHours = true } = {}) {
  const { config } = index, errors = [], out = [];
  if (!Array.isArray(lines) || !lines.length) errors.push({ code: "EMPTY" });
  if (enforceHours && !pickupOpen(config, now)) errors.push({ code: "CLOSED", say: "Pickup orders are closed right now." });
  (Array.isArray(lines) ? lines : []).forEach((ln, i) => {
    const e = index.items.get(String(ln?.id ?? "")) || index.items.get(index.byName.get(norm(ln?.item ?? ln?.id)) ?? "");
    if (!e || e.hidden) return errors.push({ code: "UNKNOWN_ITEM", line: i });
    const it = e.item, qty = Number(ln.qty ?? 1);
    if (disabled.has(String(it.id))) return errors.push({ code: "SOLD_OUT", line: i, item: it.name });
    if (!Number.isInteger(qty) || qty < 1) return errors.push({ code: "BAD_QTY", line: i, item: it.name });
    if (qty > LIMITS.perItem) return errors.push({ code: "HOST_TOO_MANY_OF_ONE", line: i, item: it.name });
    const note = String(ln.note || "").trim();
    if (ALLERGY.test(note)) return errors.push({ code: "HOST_ALLERGY", line: i, item: it.name });
    if (note.length > LIMITS.noteChars) return errors.push({ code: "NOTE_TOO_LONG", line: i, item: it.name });
    let base = cents(it.price), name = it.name, sel = null;
    const pcs = priceChoices(it);
    if (pcs.length) {
      const want = String(ln.price_choice ?? "").trim().toLowerCase();
      const pc = pcs.find((p) => p.n === want || p.name.toLowerCase() === want);
      if (!pc) return errors.push({ code: "NEED_PRICE_CHOICE", line: i, item: it.name, options: pcs.map((p) => ({ id: p.n, name: p.name, cents: p.cents })) });
      sel = pc.n; base = pc.cents; name += ` (${pc.name})`;
    }
    const { templateId, groups, missing } = choiceGroups(index, e, sel);
    if (missing) return errors.push({ code: "HOST_MENU_RULES_MISSING", line: i, item: it.name });
    const allowed = new Map(groups.flatMap((g) => g.options.map((o) => [o.id, g.id])));
    const optByName = new Map(groups.flatMap((g) => g.options.map((o) => [norm(o.name), o.id])));
    const picked = [...new Set((ln.choices || []).map((c) => (allowed.has(String(c)) ? String(c) : optByName.get(norm(c)) ?? String(c))))];
    const bad = picked.filter((id) => !allowed.has(id));
    if (bad.length) return errors.push({ code: "CHOICE_NOT_ALLOWED", line: i, item: it.name, bad });
    const gone = picked.filter((id) => disabled.has(id));
    if (gone.length) return errors.push({ code: "CHOICE_SOLD_OUT", line: i, item: it.name, bad: gone });
    for (const g of groups) {
      const n = picked.filter((id) => allowed.get(id) === g.id).length;
      if ((g.min && n < g.min) || (g.max && n > g.max)) return errors.push({ code: "NEED_CHOICE", line: i, item: it.name, group: g.name, pick: { min: g.min, max: g.max }, options: g.options });
    }
    const mods = picked.map((id) => index.options.get(id));
    const extra = mods.reduce((s, o) => s + cents(o.price), 0);
    out.push({ id: String(it.id), qty, priceSelection: sel, templateId, name, base, extra, total: qty * (base + extra), note,
      mods: mods.map((o) => ({ id: String(o.id), name: o.name, cents: cents(o.price) })), entry: e });
  });
  const units = out.reduce((s, l) => s + l.qty, 0), subtotal = out.reduce((s, l) => s + l.total, 0);
  if (out.length > LIMITS.lines || units > LIMITS.units || subtotal > LIMITS.subtotalCents) errors.push({ code: "HOST_ORDER_TOO_BIG" });
  const perItem = new Map(); for (const l of out) perItem.set(l.id, (perItem.get(l.id) || 0) + l.qty);
  if ([...perItem.values()].some((n) => n > LIMITS.perItem) && !errors.some((e) => e.code === "HOST_TOO_MANY_OF_ONE")) errors.push({ code: "HOST_TOO_MANY_OF_ONE" });
  // Tax exactly as the page's oCart.process: per tax table, Math.round(taxable * rate / 100).
  let tax = 0; const taxList = [0, 0, 0, 0, 0, 0];
  for (let t = 1; t <= 5; t++) {
    const taxable = out.reduce((s, l) => s + (taxSource(l.entry)["tax_" + t] === "YES" ? l.total : 0), 0);
    if (taxable > 0 && config["TAX_TABLE_" + t]) { const x = Math.round((taxable * Number(config["TAX_TABLE_" + t])) / 100); tax += x; taxList[t] += x; }
  }
  const total = subtotal + tax;
  const view = out.map(({ entry, ...l }) => l);
  const approval = errors.length ? null : approvalRef({ lines: view, subtotal, tax, total, pickup: "ASAP", pickupMinutes: Number(config.PICKUP_DELAY) || null, pay: "PAY_AT_STORE", menu: index.menuHash });
  return { ok: !errors.length, errors, lines: out, view, units, subtotal, tax, taxList, total, pickupMinutes: Number(config.PICKUP_DELAY) || null, approval };
}
const taxSource = (e) => (e.item.tax === "CUSTOM" ? e.item : e.cat);
// Approval reference: ties the caller's "yes" to the exact basket, total, pickup and payment they heard.
export const approvalRef = (o) => sha(JSON.stringify(o)).slice(0, 16);

// Build the cart object the page itself would hold in sessionStorage (shape checked against a real browser capture,
// tasks/fugu-order-agent-2026-11/raw/golden-cart-2026-11-09.json). lineID/created follow the page's main_get_uid/date_time.
export function menu11Cart(index, priced, { now = new Date() } = {}) {
  const { config } = index, ts = Math.floor(now.getTime() / 1000);
  const itemList = priced.lines.map((l, i) => {
    const { item: q, cat: f, screen: n } = l.entry;
    const p = { product_id: l.id, qty: l.qty };
    if (l.templateId && q.modifier === "CUSTOM") { p.modifierTemplateList = []; p.modifier_id = l.templateId; }
    p.modifierItemList = l.mods.map((m) => ({ ...stripOpt(index.options.get(m.id)), qty: 1 }));
    p.modifierItemNameList = l.mods.map((m) => dispName(config, m.name));
    p.total = l.total; p.totalPrice = l.base * l.qty; p.priceAdditional = l.extra; p.totalPriceAdditional = l.extra * l.qty;
    if (l.priceSelection) p.priceSelection = l.priceSelection;
    p.modifierText = p.modifierItemNameList.join(", ");
    p.memo = l.note; p.name = dispName(config, l.name);
    if (q.name_alt) p.name_alt = l.priceSelection ? `${q.name_alt} (${q["price_name_" + l.priceSelection]})` : q.name_alt;
    p.price = l.base; p.seat = 1;
    p.taxTable = table(taxSource(l.entry), "tax_", 5); p.printerTable = table(q.printer === "CUSTOM" ? q : f, "printer_", 40);
    const rs = q.report_screen || f.report_screen || n.report_screen; if (rs) p.report_screen = rs;
    p.report_department = q.report_department || f.report_deparment || f.name; // "deparment" typo is the page's own
    p.report_product = q.report_product || q.name;
    const rpa = q.report_product_alt || q.name_alt; if (rpa) p.report_product_alt = rpa;
    p.category_name = f.name;
    const pri = q.printer_priority || f.printer_priority; if (pri) p.printer_priority = pri;
    if ((q.not_printable === "YES" || f.not_printable === "YES") && q.not_printable !== "NO") p.noPrintOnReceipt = "YES";
    p.lineID = String(ts) + String((i + 1) % 10); p.created = ts; p.subtotal = l.total;
    return p;
  });
  return { qtyTotal: priced.units, subtotal: priced.subtotal, tax: priced.tax, total: priced.total, tip: 0, itemList,
    fee_delivery: 0, taxList: priced.taxList, destination: "PICKUP", modified: ts };
}
const stripOpt = ({ component_id, ...o }) => o;
function table(src, prefix, max) { const a = []; for (let r = 1; r <= max; r++) if (src[prefix + r] === "YES") a[r] = "YES"; return Array.from(a, (v) => v ?? null); }

// Compact menu text for the voice agent's prompt: id, name, price, required choices.
export function compactMenu(index) {
  const rows = []; let last = "";
  for (const [, e] of index.items) {
    if (e.hidden) continue;
    if (e.cat.name !== last) { rows.push("# " + e.cat.name); last = e.cat.name; }
    const pcs = priceChoices(e.item), { groups } = choiceGroups(index, e, null);
    const price = pcs.length ? "price_choice: " + pcs.map((p) => p.name + " $" + p.cents / 100).join(", ") : "$" + cents(e.item.price) / 100;
    const need = groups.filter((g) => g.min).map((g) => "must ask " + g.name + ": " + g.options.map((o) => o.name + (o.cents ? " +$" + o.cents / 100 : "")).join(", "));
    rows.push(e.item.name.trim().replace(/\s+/g, " ") + " | " + price + (need.length ? " | " + need.join(" | ") : ""));
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Order flow with durable state. `store` must give atomic compare-and-set:
//   get(key) -> { value, version } | null ;  cas(key, value, expectedVersion|null) -> true/false (false = someone else won)
// `m11` is the Menu11 client: sendCode(phone), verify(phone, pin) -> {ok, cookie}, serverCart(cookie, cart) -> order,
//   submit(cookie, cart, customer) -> { state: "ACCEPTED"|"REJECTED", ref?, reason? } (throws/timeout = unknown)
// ---------------------------------------------------------------------------------------------------------------
export const memoryStore = () => { const m = new Map(); return {
  async get(k) { const r = m.get(k); return r ? { value: structuredClone(r.value), version: r.version } : null; },
  async cas(k, value, expected) { const cur = m.get(k); if ((cur?.version ?? null) !== expected) return false; m.set(k, { value: structuredClone(value), version: (cur?.version ?? 0) + 1 }); return true; } }; };

async function update(store, key, fn) { // optimistic retry loop; fn returns the new record, or null for "do not write"
  for (let i = 0; i < 5; i++) { const cur = await store.get(key); const next = fn(cur?.value ?? null); if (next === null) return null; if (await store.cas(key, next, cur?.version ?? null)) return next; }
  throw new Error("store busy");
}
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
const say = (code) => ({ result: code });
const LOCKED = ["SUBMITTING", "ACCEPTED", "UNKNOWN"]; // once here, nothing edits or re-places this call's order
const already = (rec) => ({ ...say("ALREADY_" + rec.state), ref: rec.ref || null });

// The restaurant's cart call only echoes what it is sent (verified 11/9), so "it answered" proves nothing by itself.
// Before placing, every line of what Menu11 holds must equal the cart we built from the approved basket.
// Canonical form for comparing our cart with Menu11's echo: it returns numbers as strings, null as "", drops empty lists.
const canon = (v) => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.length ? v.map(canon) : undefined;
  if (typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) o[k] = c; } return o; }
  return String(v);
};
export function sameOrder(server, cart) {
  if (!server || !Array.isArray(server.itemList)) return false;
  const top = (o) => canon({ qtyTotal: o.qtyTotal, subtotal: o.subtotal, tax: o.tax, total: o.total, tip: o.tip || 0, fee_delivery: o.fee_delivery || 0, destination: o.destination,
    taxList: [1, 2, 3, 4, 5].map((i) => Number(o.taxList?.[i] || 0)) });
  if (JSON.stringify(top(server)) !== JSON.stringify(top(cart))) return false;
  // Fields Menu11 adds on its side must be the plain pickup / pay-at-store values and nothing else of money.
  if (Number(server.balance) !== cart.total || Number(server.fee_payment || 0) !== 0 || Number(server.tip_store || 0) !== 0) return false;
  if (server.status !== "OPEN" || server.number !== "PENDING") return false;
  // Every field of every line (ids, names, choices and their prices, printed text, tax + printer routing, print flags).
  return JSON.stringify(canon(server.itemList)) === JSON.stringify(canon(cart.itemList));
}

/**
 * store: get(key) -> {value, version}|null ; cas(key, value, expectedVersion|null) -> bool (atomic compare-and-set)
 * m11:   ready() -> null | "reason" (config check BEFORE any code is used)
 *        sendCode(phone) -> {ok} ; verify(phone, pin) -> {ok, cookie} ; activate(cookie) (best effort)
 *        serverCart(cookie, cart) -> order | null (null = not logged in / no answer)
 *        session(cookie) -> {id, phone} | null (who Menu11 says is logged in)
 *        submit(cookie, serverOrder, {name, phone, sid}, maxMs) -> does ONLY the post (no other request first); {state:"NOT_SENT", reason} (nothing was posted)
 *                                                    | {state:"ACCEPTED", ref} (only on a VERIFIED success shape)
 *                                                    | anything else / throw = UNKNOWN (posted, outcome not proven)
 * loadIndex(fresh) -> menu index ; elapsed() -> ms since this tool call started ; budgetMs = time the tool call has.
 */
export function orderFlow({ store, m11, loadIndex, now = () => new Date(), disabled = async () => new Set(), elapsed = () => 0, budgetMs = 26000, submitNeedsMs = 17000, recordNeedsMs = 6000, minPostMs = 6000 }) {
  const key = (callId) => "order:" + callId;
  const bind = (priced, callId) => approvalRef({ a: priced.approval, call: callId });
  const price = async (lines, fresh) => { const index = await loadIndex(fresh); return { index, priced: priceCart(index, lines, { now: now(), disabled: await disabled() }) }; };
  // Stored draft + caller's approval still valid against the menu, hours and clock right now?
  const check = async (rec, approval, callId, fresh) => {
    if (!rec) return { stop: say("NO_ORDER_YET") };
    if (rec.state !== "DRAFT") return { stop: already(rec) };
    if (!approval || approval !== rec.approval) return { stop: say("READ_BACK_AGAIN") };
    if (now().getTime() - rec.approvedAt > LIMITS.approvalMinutes * 60000) return { stop: say("READ_BACK_AGAIN") };
    const { index, priced } = await price(rec.lines, fresh);
    if (!priced.ok) return { stop: { ...say("FIX"), errors: priced.errors } };
    if (bind(priced, callId) !== rec.approval) return { stop: say("READ_BACK_AGAIN") }; // menu, price or pickup time changed since the read-back
    return { index, priced };
  };
  void 0;
  return {
    // Mika sends the whole basket each time. Returns what to ask next, or the read-back + approval reference.
    async cart(callId, lines) {
      const { priced } = await price(lines, false);
      const prev = (await store.get(key(callId)))?.value;
      if (prev && LOCKED.includes(prev.state)) return already(prev);
      if (!priced.ok) return { ...say("FIX"), errors: priced.errors };
      const approval = bind(priced, callId);
      const rec = await update(store, key(callId), (cur) => (cur && LOCKED.includes(cur.state) ? null : { ...(cur || {}), state: "DRAFT",
        lines: priced.view.map(({ id, qty, priceSelection, mods, note }) => ({ id, qty, price_choice: priceSelection, choices: mods.map((m) => m.id), note })),
        approval, approvedAt: now().getTime(), total: priced.total }));
      if (!rec) return already((await store.get(key(callId))).value); // a placement won the race: the order is not editable
      return { ...say("READ_BACK"), approval, items: priced.view.map((l) => ({ qty: l.qty, name: l.name, choices: l.mods.map((m) => m.name), note: l.note, total: l.total })),
        subtotal: priced.subtotal, tax: priced.tax, total: priced.total, card_total: cardTotal(priced.total), pickup_minutes: priced.pickupMinutes, pay: "at the restaurant" };
    },
    async sendCode(callId, phone, approval) {
      const p = digits(phone); if (p.length !== 10) return say("NEED_10_DIGIT_MOBILE");
      const c = await check((await store.get(key(callId)))?.value, approval, callId, false); if (c.stop) return c.stop;
      const notReady = await m11.ready?.(); if (notReady) return { ...say("NOT_PLACED"), reason: notReady };
      const r = await m11.sendCode(p); if (!r.ok) return say("CODE_NOT_SENT");
      // A new number drops any earlier login: an order is only ever placed under the phone that read us its code.
      const rec = await update(store, key(callId), (cur) => (!cur || cur.state !== "DRAFT" ? null : { ...cur, phone: p, cookie: cur.phone === p ? cur.cookie : null }));
      return rec ? say("CODE_SENT") : already((await store.get(key(callId))).value);
    },
    // Order of work: every check that can fail without Menu11 runs BEFORE the caller's code is used.
    async place(callId, { approval, pin, name }) {
      const k = key(callId); let rec = (await store.get(k))?.value;
      const c = await check(rec, approval, callId, true); if (c.stop) return c.stop;
      const who = String(name || "").trim(); if (!who) return say("NEED_NAME");
      if (!rec.phone) return say("SEND_CODE_FIRST");
      const notReady = await m11.ready?.(); if (notReady) return { ...say("NOT_PLACED"), reason: notReady };
      const code = String(pin || "").replace(/\D/g, ""); if (!rec.cookie && code.length !== 5) return say("NEED_5_DIGIT_CODE");
      const hadSession = Boolean(rec.cookie);
      if (!rec.cookie) {
        const v = await m11.verify(rec.phone, code); if (!v.ok) return say("CODE_WRONG");
        rec = await update(store, k, (cur) => (!cur || cur.state !== "DRAFT" ? null : { ...cur, cookie: v.cookie })); // saved before anything else can fail
        if (!rec) return already((await store.get(k)).value);
        await m11.activate?.(rec.cookie);
      }
      const cart = menu11Cart(c.index, c.priced, { now: now() });
      const server = await m11.serverCart(rec.cookie, cart);
      const sess = server ? await m11.session(rec.cookie) : null; // who Menu11 says is logged in (needed for the post; read BEFORE the final check)
      if (!server || !sess || String(sess.phone) !== String(rec.phone)) { // saved login gone or not this caller's: forget it, nothing was placed
        if (hadSession || sess) { await update(store, k, (cur) => (!cur || cur.state !== "DRAFT" ? null : { ...cur, cookie: null })); return say("NEED_NEW_CODE"); }
        return say("TRY_PLACE_AGAIN");
      }
      if (!sameOrder(server, cart)) return say("READ_BACK_AGAIN");
      // Last look, on a fresh copy of the menu and the clock. Nothing slow happens between here and the post:
      // one time check, one atomic claim, then the post itself.
      const cur = await store.get(k);
      const last = await check(cur?.value, approval, callId, true); if (last.stop) return last.stop;
      if (last.priced.approval !== c.priced.approval) return say("READ_BACK_AGAIN");
      if (cur.value.phone !== rec.phone || cur.value.cookie !== rec.cookie) return say("READ_BACK_AGAIN"); // number or login changed while we worked
      if (budgetMs - elapsed() < submitNeedsMs) return say("TRY_PLACE_AGAIN"); // not enough time left to place AND record it; login is kept
      // Atomic claim on the exact record just checked (state, approval, phone, login): exactly one place() can win.
      const claimed = { ...cur.value, state: "SUBMITTING", submitAt: now().getTime() };
      if (!(await store.cas(k, claimed, cur.version))) { const again = (await store.get(k)).value; return again.state === "DRAFT" ? say("READ_BACK_AGAIN") : already(again); }
      const left = budgetMs - elapsed() - recordNeedsMs; // time the post may take and still leave room to record the outcome
      const stale = now().getTime() - claimed.approvedAt > LIMITS.approvalMinutes * 60000; // the read-back aged out while we worked
      if (left < minPostMs || stale || !pickupOpen(last.index.config, now())) { // claimed but NOT posted: safe to hand the draft back
        await update(store, k, (c2) => (c2?.state === "SUBMITTING" && c2.submitAt === claimed.submitAt ? { ...c2, state: "DRAFT" } : null));
        return left < minPostMs ? say("TRY_PLACE_AGAIN") : stale ? say("READ_BACK_AGAIN") : { ...say("FIX"), errors: [{ code: "CLOSED" }] };
      }
      let res = null;
      try { res = await m11.submit(rec.cookie, server, { name: who, phone: rec.phone, sid: sess.id }, left); } catch { res = null; }
      const state = res?.state === "ACCEPTED" ? "ACCEPTED" : res?.state === "NOT_SENT" ? "DRAFT" : "UNKNOWN"; // UNKNOWN keeps the lock forever
      await update(store, k, (cur2) => ({ ...cur2, state, ref: res?.ref || null, reason: res?.reason || null, seen: res?.seen || null }));
      return state === "ACCEPTED" ? { ...say("PLACED"), ref: res.ref || null, total: c.priced.total, card_total: cardTotal(c.priced.total), pickup_minutes: c.priced.pickupMinutes }
        : state === "DRAFT" ? { ...say("NOT_PLACED"), reason: res.reason || null } : say("HOST_CONFIRM");
    },
    async status(callId) { const r = (await store.get(key(callId)))?.value; return r ? { ...say(r.state), ref: r.ref || null } : say("NO_ORDER_YET"); },
    // Proves the store's compare-and-set under real contention: n writers race for one new key, then for one update.
    async lockSelfTest(n = 8) {
      const k = "selftest:" + now().getTime();
      const first = (await Promise.all(Array.from({ length: n }, (_, i) => store.cas(k, { w: i }, null)))).filter(Boolean).length;
      const cur = await store.get(k);
      const second = (await Promise.all(Array.from({ length: n }, (_, i) => store.cas(k, { w: "u" + i }, cur.version)))).filter(Boolean).length;
      const stale = await store.cas(k, { w: "stale" }, cur.version);
      return { result: first === 1 && second === 1 && stale === false ? "LOCK_OK" : "LOCK_BROKEN", new_key_winners: first, update_winners: second, stale_write_accepted: stale };
    },
  };
}

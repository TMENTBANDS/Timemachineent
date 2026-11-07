// Live Band Karaoke sign-up API: guest sign-ups, host logins and the nightly line.
// Data lives in Netlify Blobs (store "lbk"); no other services needed.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { buildReport, lastWednesday } from "../lib/report.mjs";

const VENUES = {
  addison: { name: "Sidecar Addison", lat: 32.950981, lng: -96.8190583 },
  frisco: { name: "Sidecar Frisco", lat: 33.1077444, lng: -96.8270188 },
};
const RADIUS_M = 300;            // phone must be this close to the venue (plus GPS accuracy, capped)
const MAX_PER_NIGHT = 400;
// Three sets a night. Each sign-up sheet takes 12 singers + 3 backups.
const SINGERS = 12, BACKUPS = 3, PER_SET = SINGERS + BACKUPS, LAST_SET = 3;
const SET1_OPENS = 20 * 60 + 15;             // Set 1 sheet opens automatically at 8:15 pm
const NEXT_SHEET_AT = { 2: "9:30", 3: "11:30" }; // shown to guests; hosts open sets 2 and 3 with a button
const LOCK_AFTER = 5, LOCK_MS = 5 * 60e3;
// One-time setup code lets Shonna set (or reset) her own PIN. Only its scrypt hash is stored here.
const SETUP_SALT = "8d0a92d4b4a5a414ab34750ea0aad2ed";
const SETUP_HASH = "e44a19add94f9702d80fe9f4aba2007d6b7abbc28998764dabc67e351d9b9bc6";
// Read-only key for the weekly paid-skips report (used by Shonna's Thursday calendar task). Only its SHA-256 is stored here.
const REPORT_KEY_HASH = "6d3ca3d2548ad3b005629eb78cff01fafbe6f4e999ab48700ed950019eb664c3";
const DEFAULT_HOSTS = ["Shonna", "Rhett", "Wendy", "Carly", "Duncan", "Presley", "Cedric"];

const store = () => getStore({ name: "lbk", consistency: "strong" });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const fail = (msg, status = 400) => json({ error: msg }, status);

function nightKey() {
  const d = new Date(Date.now() - 6 * 3600e3); // before 6am counts as the night before
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
}
function distM(a, b, c, d) {
  const R = 6371e3, t = (x) => (x * Math.PI) / 180;
  const h = Math.sin(t(c - a) / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(t(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const scrypt = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, "hex"), 32).toString("hex");
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Same song = same title + artist, ignoring case, accents and punctuation.
const songKey = (song, artist) => (String(song) + "|" + String(artist)).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9|]/g, "");
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

// Read-modify-write with an etag check so two phones never overwrite each other.
async function update(key, fallback, fn) {
  const s = store();
  for (let i = 0; i < 8; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const data = cur ? cur.data : structuredClone(fallback);
    const out = await fn(data);
    if (out && out.__error) return out;
    const res = cur ? await s.setJSON(key, data, { onlyIfMatch: cur.etag }) : await s.setJSON(key, data, { onlyIfNew: true });
    if (res.modified) return out ?? data;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  return { __error: "The list is busy. Try again.", status: 503 };
}

async function loadConfig() {
  const c = await store().get("config", { type: "json" });
  if (c && c.secret) return c;
  return update("config", {}, (d) => { if (!d.secret) { d.secret = crypto.randomBytes(32).toString("hex"); d.testMode = true; } return d; });
}
async function hostsDoc() {
  const h = await store().get("hosts", { type: "json" });
  if (h) return h;
  return update("hosts", { hosts: [] }, (d) => {
    if (!d.hosts.length) d.hosts = DEFAULT_HOSTS.map((name) => ({ id: name.toLowerCase(), name, admin: name === "Shonna", active: true }));
    return d;
  });
}

function sign(cfg, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", cfg.secret).update(body).digest("base64url");
  return body + "." + mac;
}
async function auth(cfg, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const want = crypto.createHmac("sha256", cfg.secret).update(body).digest("base64url");
  if (!safeEq(mac, want)) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  if (p.exp < Date.now()) return null;
  const h = (await hostsDoc()).hosts.find((x) => x.id === p.hid && x.active !== false);
  if (!h || (h.pinVer || 0) !== (p.v || 0)) return null; // changing a PIN signs that host out everywhere
  return h;
}
// Host logins end at the next 1:00 am Central, so nobody stays logged in from one Wednesday to the next.
function next1amChicago(now = Date.now()) {
  const part = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return p; };
  const p = part(now);
  let day = Date.UTC(+p.year, +p.month - 1, +p.day);
  if (+p.hour >= 1) day += 864e5; // already past 1 am today: use tomorrow
  let t = day + 7 * 3600e3; // 1 am Central is 6:00 or 7:00 UTC; start at 7:00 and adjust
  for (let i = 0; i < 3; i++) { const q = part(t); const off = (+q.hour * 60 + +q.minute) - 60; if (!off) break; t -= off * 60e3; }
  return t;
}
const session = (cfg, h) => { const exp = next1amChicago(); return {
  token: sign(cfg, { hid: h.id, v: h.pinVer || 0, exp }),
  host: { id: h.id, name: h.name, admin: !!h.admin }, expiresAt: exp,
}; };

function chicagoMinutes() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get("hour") * 60 + get("minute");
}
const entrySet = (e) => e.set || 1;
// Where tonight's sign-up stands: which sheet is current, whether it's open, and how full it is.
function sheetStatus(d, cfg) {
  const sheet = d.sheet || { set: 1, open: null }; // open: null = Set 1 opens on the clock
  let open = sheet.open;
  if (open === null) { const m = chicagoMinutes(); open = !!cfg.testMode || m >= SET1_OPENS || m < 6 * 60; }
  // Paid skips don't take one of the 12 singer or 3 backup spots.
  const count = d.entries.filter((e) => entrySet(e) === sheet.set && e.status !== "skipped" && !e.jumped).length;
  const full = count >= PER_SET;
  return { set: sheet.set, open, full, accepting: open && !full, count, perSet: PER_SET, singers: SINGERS, backups: BACKUPS,
    next: sheet.set < LAST_SET ? sheet.set + 1 : null, nextAt: NEXT_SHEET_AT[sheet.set + 1] || null, auto: sheet.open === null };
}
const nightPath = (loc) => "night/" + loc + "/" + nightKey();
// status "pending" = a $20 repeat-song sign-up waiting for a host to confirm the payment. It holds its spot but isn't in line yet.
const publicEntry = (e) => ({ id: e.id, name: e.name, song: e.song, artist: e.artist, status: e.status, set: entrySet(e), pos: e.pos, at: e.at, by: e.by, doneAt: e.doneAt,
  jumped: !!e.jumped, skipReq: reqView(e.skipReq), skipDenied: !!e.skipDenied,
  repeat: !!e.repeat, repeatReq: reqView(e.repeatReq), repeatPaid: !!e.repeatPaid, repeatDenied: !!e.repeatDenied, repeatFee: e.repeatFee || null,
  payVia: e.repeatVia || e.paidVia || null, override: e.override || null,
  payExpired: !!e.payExpired, payCancelled: !!e.payCancelled, left: !!e.left, payUrl: (sqOf(e) && sqOf(e).url) || null });
const reqView = (q) => (q ? { method: q.method, at: q.at, square: !!q.sq } : null);
const squareOn = (cfg) => !!(cfg.square && cfg.square.token && cfg.square.locationId);
const paymentsView = (cfg) => { const p = cfg.payments || {}; const sqOn = squareOn(cfg);
  // Venmo stays available with Square: guests show the host their payment.
  return { cashtag: sqOn ? "" : p.cashtag || "", venmo: p.venmo || "", fee: p.fee || 50, repeatFee: p.repeatFee || 20,
    square: sqOn, squareName: sqOn ? cfg.square.locationName || "" : "", on: sqOn || !!(p.cashtag || p.venmo) }; };
// Manage hosts needs the saved Cash App / Venmo even while Square is on.
const paymentsAdminView = (cfg) => { const p = cfg.payments || {}; return { ...paymentsView(cfg), cashtag: p.cashtag || "", venmo: p.venmo || "" }; };

// ---------- Square: guests pay by Cash App Pay, Apple Pay, Google Pay or card, and the site confirms it on its own ----------
const SQ_VERSION = "2026-09-16";
const SQ_HOSTS = { production: "https://connect.squareup.com", sandbox: "https://connect.squareupsandbox.com" };
const SQ_EXPIRE_MS = 5 * 60e3; // an unfinished Square payment gives up its held spot after 5 minutes
async function sqCall(square, method, path, body) {
  const r = await fetch(SQ_HOSTS[square.env || "production"] + path, { method,
    headers: { authorization: "Bearer " + square.token, "square-version": SQ_VERSION, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = (j.errors && j.errors[0]) || {}; throw Object.assign(new Error(e.detail || e.code || "Square error " + r.status), { square: true, status: r.status }); }
  return j;
}
// The Square checkout waiting on this entry, if any: a pending repeat song, or a skip request.
function sqOf(e) {
  if (e.status === "pending" && e.repeatReq && e.repeatReq.sq) return e.repeatReq.sq;
  if (e.status === "waiting" && !e.jumped && e.skipReq && e.skipReq.sq) return e.skipReq.sq;
  return null;
}
async function createLink(cfg, { entryId, kind, fee, name, song, loc, origin }) {
  const what = kind === "skip" ? "Skip to next" : "Repeat song", where = VENUES[loc].name;
  const j = await sqCall(cfg.square, "POST", "/v2/online-checkout/payment-links", {
    idempotency_key: kind + "-" + entryId + "-" + crypto.randomBytes(6).toString("hex"),
    quick_pay: { name: what + " - " + where, price_money: { amount: Math.round(fee * 100), currency: cfg.square.currency || "USD" }, location_id: cfg.square.locationId },
    checkout_options: { redirect_url: origin + "/signup?paid=" + encodeURIComponent(entryId) + "&loc=" + loc, allow_tipping: false, ask_for_shipping_address: false,
      accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true, afterpay_clearpay: false } },
    payment_note: (what + " - " + where.replace("Sidecar ", "") + " - " + name + " - " + song).slice(0, 500),
  });
  const pl = j.payment_link || {};
  if (!pl.url || !pl.order_id) throw new Error("Square didn't return a payment page.");
  return { orderId: pl.order_id, linkId: pl.id, url: pl.url, fee, at: new Date().toISOString() };
}
// Paid = the order has tenders covering the price and the payment is COMPLETED.
async function checkPaid(cfg, s) {
  const { order } = await sqCall(cfg.square, "GET", "/v2/orders/" + encodeURIComponent(s.orderId));
  const tenders = (order && order.tenders) || [];
  const got = tenders.reduce((n, t) => n + ((t.amount_money && t.amount_money.amount) || 0), 0);
  if (!tenders.length || got < Math.round(s.fee * 100)) return { paid: false };
  const pid = tenders.map((t) => t.payment_id || t.id).find(Boolean);
  let via = "Square";
  if (pid) {
    const { payment } = await sqCall(cfg.square, "GET", "/v2/payments/" + encodeURIComponent(pid));
    if (!payment || payment.status !== "COMPLETED") return { paid: false };
    const brand = payment.wallet_details && payment.wallet_details.brand;
    via = brand === "CASH_APP" ? "Square (Cash App Pay)" : payment.source_type === "CARD" ? "Square (card)" : payment.source_type ? "Square (" + String(payment.source_type).toLowerCase().replace(/_/g, " ") + ")" : "Square";
  }
  return { paid: true, via, paymentId: pid || null };
}
// Move a paid skip right after whoever is singing now (after any earlier paid skips), in the set that's on stage.
function doJump(d, e, byName, via, fee) {
  const line = d.entries.filter((x) => x.status === "waiting" && x.id !== e.id).sort((a, b) => (entrySet(a) - entrySet(b)) || (a.pos - b.pos));
  if (line.length) {
    const cur = line[0], s = entrySet(cur), inSet = line.filter((x) => entrySet(x) === s);
    let anchor = cur; for (const x of inSet.slice(1)) { if (x.jumped) anchor = x; else break; }
    const nxt = inSet[inSet.indexOf(anchor) + 1];
    e.set = s; e.pos = nxt ? (anchor.pos + nxt.pos) / 2 : anchor.pos + 1;
  }
  Object.assign(e, { jumped: true, jumpedBy: byName, paidVia: via, paidAt: new Date().toISOString(), paidFee: fee });
  delete e.skipReq; delete e.skipDenied;
}
// Check Square for any unfinished payments in tonight's list and apply the ones that went through.
async function verifySquare(cfg, loc, n, force) {
  if (!squareOn(cfg) || !n) return false;
  const now = Date.now();
  const due = n.entries.filter((e) => { const s = sqOf(e); return s && (force === e.id || !s.checkedAt || now - Date.parse(s.checkedAt) > 4000); }).slice(0, 6);
  if (!due.length) return false;
  const results = {};
  await Promise.all(due.map(async (e) => { try { results[e.id] = await checkPaid(cfg, sqOf(e)); } catch (err) { console.error("square check", err.message); results[e.id] = { error: true }; } }));
  await update(nightPath(loc), { entries: [] }, (d) => {
    for (const e of d.entries) {
      const res = results[e.id], s = res && sqOf(e);
      if (!s || s.orderId !== sqOf(due.find((x) => x.id === e.id)).orderId) continue;
      s.checkedAt = new Date().toISOString();
      const repeat = e.status === "pending";
      if (res.paid) {
        if (repeat) { Object.assign(e, { status: "waiting", repeatPaid: true, repeatVia: res.via, repeatAt: new Date().toISOString(), repeatBy: "Square", repeatFee: s.fee, squarePaymentId: res.paymentId }); delete e.repeatReq; }
        else { doJump(d, e, "Square", res.via, s.fee); e.squarePaymentId = res.paymentId; }
      } else if (!res.error && Date.now() - Date.parse(s.at) > SQ_EXPIRE_MS) {
        if (repeat) { Object.assign(e, { status: "skipped", payExpired: true, by: "Payment not finished", doneAt: new Date().toISOString() }); delete e.repeatReq; }
        else delete e.skipReq;
      }
    }
    return { ok: true };
  });
  return true;
}
async function loadNight(cfg, loc, force) {
  let n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
  if (await verifySquare(cfg, loc, n, force)) n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
  return n;
}
const active = (e) => e.status === "waiting" || e.status === "pending";
const nightView = (n, cfg) => ({ night: nightKey(), sheet: sheetStatus(n, cfg), entries: n.entries.map(publicEntry),
  host: n.host ? { id: n.host.id, name: n.host.name } : null });
// One host runs each location per night. Returns an error object if someone else holds it; claims it if nobody does.
const holdLoc = (d, me) => {
  if (d.host && d.host.id !== me.id) return { __error: d.host.name + " is hosting this location now. You've been switched out.", status: 409, kicked: true, by: d.host.name };
  if (!d.host) d.host = { id: me.id, name: me.name, at: new Date().toISOString() };
  return null;
};

// Sign a guest up for a song. Returns { out, name, song } or { error, status }.
async function doSignup(cfg, body, opts) {
  const bad = (msg, status = 400) => ({ error: { error: msg }, status });
  const loc = body.loc, v = VENUES[loc];
  if (!v) return bad("Pick a location first.");
  const name = clean(body.name, 30), song = clean(body.song, 120), artist = clean(body.artist, 120), device = clean(body.device, 64);
  if (!name || !song || !device) return bad("Add your name and pick a song.");
  const repeat = !!opts.repeat;
  if (repeat && !paymentsView(cfg).on) return bad("Repeat songs aren't available right now. Please choose another song.");
  if (!cfg.testMode) {
    const lat = Number(body.lat), lng = Number(body.lng), acc = Math.min(Number(body.acc) || 0, 200);
    if (!isFinite(lat) || !isFinite(lng)) return bad("We need your location to confirm you're at " + v.name + ".", 403);
    if (distM(lat, lng, v.lat, v.lng) > RADIUS_M + acc) return bad("Sign-ups only work from inside " + v.name + ".", 403);
  }
  const out = await update(nightPath(loc), { entries: [] }, (d) => {
    if (d.entries.length >= MAX_PER_NIGHT) return { __error: "Tonight's list is full. See the host at the stage.", status: 409 };
    const sh = sheetStatus(d, cfg);
    if (!sh.accepting) {
      let msg;
      if (sh.set === 1 && sh.auto && !sh.open) msg = "Sign-ups for Set 1 open at 8:15 pm.";
      else if (sh.next) msg = "Set " + sh.set + " is full. The Set " + sh.next + " sign-up opens around " + sh.nextAt + ".";
      else msg = "Tonight's sign-ups are full. Thanks for coming out!";
      return { __error: msg, status: 409, closed: true };
    }
    // A backup from an earlier set who didn't get called can sign up again for the current set.
    const isBackup = (e) => !e.jumped && d.entries.filter((x) => entrySet(x) === entrySet(e) && x.status !== "skipped" && !x.jumped).sort((a, b) => a.pos - b.pos).findIndex((x) => x.id === e.id) >= SINGERS;
    for (const old of d.entries.filter((e) => e.device === device && e.status === "waiting" && entrySet(e) < sh.set && isBackup(e)))
      Object.assign(old, { status: "skipped", by: "Moved to Set " + sh.set, doneAt: new Date().toISOString() });
    const key = songKey(song, artist);
    const taken = d.entries.find((e) => e.status !== "skipped" && songKey(e.song, e.artist) === key); // skipped songs open back up
    if (taken && !repeat) return { __error: "Someone already picked " + song + " tonight. Please choose another song.", status: 409, taken: true };
    const mine = d.entries.find((e) => e.device === device && active(e));
    if (mine) return { __error: "You're already in line with " + mine.song + ". Once you've sung, you can sign up again.", status: 409, id: mine.id };
    const e = { id: crypto.randomUUID().slice(0, 12), name, song, artist, status: "waiting", set: sh.set, pos: Date.now(), at: new Date().toISOString(), device };
    // Repeat song: the spot is held as pending until the payment is confirmed (by Square, or by a host checking Cash App / Venmo).
    if (repeat) Object.assign(e, { status: "pending", repeat: true, repeatFee: paymentsView(cfg).repeatFee,
      repeatReq: { method: opts.method, at: new Date().toISOString() } });
    d.entries.push(e);
    return { ok: true, id: e.id, backup: sh.count >= SINGERS ? sh.count - SINGERS + 1 : 0 };
  });
  if (out.__error) return { error: { error: out.__error, id: out.id, taken: out.taken, closed: out.closed }, status: out.status || 400 };
  return { out, name, song };
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/lbk\/?/, "");
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return fail("Bad request."); } }
  const cfg = await loadConfig();

  try {
    // ---------- public ----------
    if (route === "settings" && req.method === "GET") {
      return json({ testMode: !!cfg.testMode, payments: paymentsView(cfg), night: nightKey(), venues: Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [k, v.name])) });
    }
    if (route === "report" && req.method === "GET") {
      const key = url.searchParams.get("key") || req.headers.get("x-report-key") || "";
      if (!safeEq(crypto.createHash("sha256").update(key).digest("hex"), REPORT_KEY_HASH)) return fail("Not allowed.", 401);
      const night = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("night") || "") ? url.searchParams.get("night") : lastWednesday();
      return json({ report: await buildReport(night) });
    }
    if (route === "hosts" && req.method === "GET") {
      const { hosts } = await hostsDoc();
      return json({ hosts: hosts.filter((h) => h.active !== false).map((h) => ({ id: h.id, name: h.name, hasPin: !!h.pinHash, admin: !!h.admin })) });
    }
    if (route === "queue" && req.method === "GET") {
      const loc = url.searchParams.get("loc");
      if (!VENUES[loc]) return fail("Unknown location.");
      return json(nightView(await loadNight(cfg, loc), cfg));
    }
    // Guest is back from the Square payment page (or tapped "check again"): check right away.
    if (route === "paycheck" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      return json(nightView(await loadNight(cfg, loc, String(body.id || "")), cfg));
    }
    // Guest gives up on an unfinished Square payment.
    // Guest taps "I'm leaving": take them off tonight's list (their song opens back up).
    if (route === "leave" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      const device = clean(body.device, 64);
      const out = await update(nightPath(loc), { entries: [] }, (d) => {
        const e = d.entries.find((x) => x.id === body.id && x.device === device);
        if (!e) return { __error: "We couldn't find your spot in line.", status: 404 };
        if (!active(e)) return { ok: true };
        Object.assign(e, { status: "skipped", left: true, by: "Left (removed themselves)", doneAt: new Date().toISOString() });
        delete e.skipReq; delete e.repeatReq;
        return { ok: true };
      });
      if (out.__error) return fail(out.__error, out.status);
      return json(nightView(await loadNight(cfg, loc), cfg));
    }
    if (route === "paycancel" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      const device = clean(body.device, 64);
      await update(nightPath(loc), { entries: [] }, (d) => {
        const e = d.entries.find((x) => x.id === body.id && x.device === device);
        if (!e || !sqOf(e)) return { ok: true };
        if (e.status === "pending") { Object.assign(e, { status: "skipped", payCancelled: true, by: "Cancelled by guest", doneAt: new Date().toISOString() }); delete e.repeatReq; }
        else delete e.skipReq;
        return { ok: true };
      });
      return json(nightView(await loadNight(cfg, loc), cfg));
    }
    // Start a Square payment for a paid skip or a repeat song. Returns the Square payment page to send the guest to.
    if (route === "checkout" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      if (!squareOn(cfg)) return fail("Payments aren't set up right now. See the host at the stage.");
      const origin = url.origin, pv = paymentsView(cfg);
      if (body.kind === "skip") {
        const device = clean(body.device, 64);
        const n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
        const e = n.entries.find((x) => x.id === body.id && x.device === device);
        if (!e || e.status !== "waiting") return fail("We couldn't find your spot in line.", 404);
        if (e.jumped) return fail("You're already skipping to next.", 409);
        const open = sqOf(e); if (open && Date.now() - Date.parse(open.at) < SQ_EXPIRE_MS - 30e3) return json({ url: open.url, id: e.id });
        let link; try { link = await createLink(cfg, { entryId: e.id, kind: "skip", fee: pv.fee, name: e.name, song: e.song, loc, origin }); }
        catch (err) { console.error("square link", err.message); return fail("Square couldn't start the payment. Try again, or see the host at the stage.", 502); }
        const out = await update(nightPath(loc), { entries: [] }, (d) => {
          const x = d.entries.find((y) => y.id === e.id);
          if (!x || x.status !== "waiting" || x.jumped) return { __error: "We couldn't find your spot in line.", status: 404 };
          x.skipReq = { method: "Square", at: link.at, sq: link }; delete x.skipDenied; return { ok: true };
        });
        if (out.__error) return fail(out.__error, out.status);
        return json({ url: link.url, id: e.id });
      }
      if (body.kind === "repeat") {
        const res = await doSignup(cfg, body, { repeat: true, method: "Square" });
        if (res.error) return json(res.error, res.status);
        let link; try { link = await createLink(cfg, { entryId: res.out.id, kind: "repeat", fee: pv.repeatFee, name: res.name, song: res.song, loc, origin }); }
        catch (err) { console.error("square link", err.message);
          await update(nightPath(loc), { entries: [] }, (d) => { d.entries = d.entries.filter((x) => x.id !== res.out.id); return { ok: true }; });
          return fail("Square couldn't start the payment. Try again, or see the host at the stage.", 502); }
        await update(nightPath(loc), { entries: [] }, (d) => { const x = d.entries.find((y) => y.id === res.out.id); if (x && x.repeatReq) x.repeatReq.sq = link; return { ok: true }; });
        return json({ url: link.url, id: res.out.id });
      }
      return fail("Unknown payment.");
    }
    if (route === "signup" && req.method === "POST") {
      if (body.repeat && squareOn(cfg) && body.method !== "venmo" && body.method !== "cash") return fail("Tap Pay to pay with Square.");
      const res = await doSignup(cfg, body, { repeat: !!body.repeat, method: body.method === "venmo" ? "Venmo" : body.method === "cash" ? "Cash" : "Cash App" });
      if (res.error) return json(res.error, res.status);
      return json(res.out);
    }
    // Guest says they've paid to skip to next; a host checks Cash App / Venmo and confirms.
    if (route === "skipreq" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      if (!paymentsView(cfg).on) return fail("Skip to next isn't available right now.");
      if (squareOn(cfg) && body.method !== "venmo" && body.method !== "cash") return fail("Tap Pay to pay with Square.");
      const method = body.method === "venmo" ? "Venmo" : body.method === "cash" ? "Cash" : "Cash App", device = clean(body.device, 64);
      const out = await update(nightPath(loc), { entries: [] }, (d) => {
        const e = d.entries.find((x) => x.id === body.id && x.device === device);
        if (!e || e.status !== "waiting") return { __error: "We couldn't find your spot in line.", status: 404 };
        if (e.jumped) return { __error: "You're already skipping to next.", status: 409 };
        e.skipReq = { method, at: new Date().toISOString() }; delete e.skipDenied;
        return { ok: true };
      });
      if (out.__error) return fail(out.__error, out.status);
      const n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
      return json(nightView(n, cfg));
    }
    if (route === "login" && req.method === "POST") {
      let result;
      const out = await update("hosts", { hosts: [] }, (d) => {
        const h = d.hosts.find((x) => x.id === body.hostId && x.active !== false);
        if (!h) return { __error: "Choose your name first.", status: 400 };
        if (!h.pinHash) return { __error: h.name + " doesn't have a PIN yet. Ask Shonna to set one.", status: 403 };
        if (h.lockUntil && h.lockUntil > Date.now()) return { __error: "Too many tries. Wait a few minutes and try again.", status: 429 };
        if (safeEq(scrypt(body.pin, h.salt), h.pinHash)) { h.fails = 0; h.lockUntil = 0; result = h; return { ok: true }; }
        h.fails = (h.fails || 0) + 1;
        if (h.fails >= LOCK_AFTER) { h.fails = 0; h.lockUntil = Date.now() + LOCK_MS; }
        result = null; return { bad: true, name: h.name };
      });
      if (out.__error) return fail(out.__error, out.status);
      if (!result) return fail("That PIN doesn't match " + out.name + "'s. Try again.", 401);
      return json(session(cfg, result));
    }
    if (route === "setup" && req.method === "POST") {
      const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
      if (!safeEq(scrypt(code, SETUP_SALT), SETUP_HASH)) return fail("That setup code isn't right.", 401);
      if (!/^\d{4,6}$/.test(String(body.pin || ""))) return fail("The PIN needs to be 4 to 6 numbers.");
      await hostsDoc();
      let admin;
      await update("hosts", { hosts: [] }, (d) => {
        admin = d.hosts.find((h) => h.admin);
        const salt = crypto.randomBytes(16).toString("hex");
        Object.assign(admin, { salt, pinHash: scrypt(body.pin, salt), pinVer: (admin.pinVer || 0) + 1, fails: 0, lockUntil: 0, active: true });
        return d;
      });
      return json(session(cfg, admin));
    }

    // ---------- hosts ----------
    const me = await auth(cfg, body.token || req.headers.get("x-host-token"));
    if (route === "me") return me ? json({ host: { id: me.id, name: me.name, admin: !!me.admin } }) : fail("Please log in again.", 401);
    if (!me) return fail("Please log in again.", 401);

    // Pick a location to host. Only one host per location: another host can take over, which switches the first one out.
    if (route === "claim" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      const out = await update(nightPath(loc), { entries: [] }, (d) => {
        if (d.host && d.host.id !== me.id && !body.takeover) return { busy: d.host.name };
        d.host = { id: me.id, name: me.name, at: new Date().toISOString(), tookOverFrom: d.host && d.host.id !== me.id ? d.host.name : undefined };
        return { ok: true };
      });
      if (out.busy) return json({ busy: out.busy }, 409);
      // Leaving another location you were hosting frees it.
      for (const other of Object.keys(VENUES).filter((k) => k !== loc))
        await update(nightPath(other), { entries: [] }, (d) => { if (d.host && d.host.id === me.id) delete d.host; return { ok: true }; });
      return json(nightView(await loadNight(cfg, loc), cfg));
    }
    if (route === "release" && req.method === "POST") {
      for (const loc of Object.keys(VENUES))
        await update(nightPath(loc), { entries: [] }, (d) => { if (d.host && d.host.id === me.id) delete d.host; return { ok: true }; });
      return json({ ok: true });
    }
    if (route === "host" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      const out = await update(nightPath(loc), { entries: [] }, (d) => {
        const held = holdLoc(d, me); if (held) return held;
        const e = d.entries.find((x) => x.id === body.id);
        const act = d.entries.filter((x) => x.status === "waiting" && e && entrySet(x) === entrySet(e)).sort((a, b) => a.pos - b.pos); // same set only
        if (!e) return { __error: "That sign-up isn't on the list anymore.", status: 404 };
        const stamp = { by: me.name, doneAt: new Date().toISOString() };
        if (body.action === "done") Object.assign(e, { status: "done" }, stamp);
        else if (body.action === "skip") Object.assign(e, { status: "skipped" }, stamp);
        else if (body.action === "back") {
          // Host override: always puts the singer back at the end of the line, whatever the rules say (skipped, sang, unpaid, song taken).
          if (e.status === "waiting") return { ok: true };
          const others = d.entries.filter((x) => x.status === "waiting" && x.id !== e.id);
          const stage = others.length ? Math.min(...others.map(entrySet)) : sheetStatus(d, cfg).set;
          if (entrySet(e) < stage) e.set = stage;
          const inSet = others.filter((x) => entrySet(x) === entrySet(e)).sort((a, b) => a.pos - b.pos);
          e.status = "waiting"; e.pos = (inSet.length ? inSet[inSet.length - 1].pos : Date.now()) + 1;
          e.override = me.name;
          for (const k of ["by", "doneAt", "repeatReq", "repeatDenied", "payExpired", "payCancelled"]) delete e[k];
        }
        else if (body.action === "remove") d.entries = d.entries.filter((x) => x.id !== e.id);
        else if (body.action === "jump") {
          if (e.status !== "waiting" || e.jumped) return { __error: "That paid skip was already handled.", status: 409 };
          const m = body.cash || (e.skipReq && e.skipReq.method === "Cash") ? "Cash" : e.skipReq && (e.skipReq.sq ? "Other (host confirmed)" : e.skipReq.method);
          doJump(d, e, me.name, m || "Not recorded", paymentsView(cfg).fee);
        }
        else if (body.action === "nopay") { delete e.skipReq; e.skipDenied = true; }
        else if (body.action === "repeatok") {
          if (e.status !== "pending") return { __error: "That repeat song was already handled.", status: 409 };
          const m = body.cash || (e.repeatReq && e.repeatReq.method === "Cash") ? "Cash" : e.repeatReq && (e.repeatReq.sq ? "Other (host confirmed)" : e.repeatReq.method);
          Object.assign(e, { status: "waiting", repeatPaid: true, repeatVia: m || "Not recorded", repeatAt: new Date().toISOString(), repeatBy: me.name });
          delete e.repeatReq;
        }
        else if (body.action === "repeatno") {
          if (e.status !== "pending") return { __error: "That repeat song was already handled.", status: 409 };
          Object.assign(e, { status: "skipped", repeatDenied: true }, stamp, { by: me.name + " (payment not found)" });
          delete e.repeatReq;
        }
        else if (body.action === "up" || body.action === "down") {
          const i = act.findIndex((x) => x.id === e.id), j = body.action === "up" ? i - 1 : i + 1;
          if (i < 0 || !act[j]) return { ok: true };
          const p = act[j].pos; act[j].pos = e.pos; e.pos = p === e.pos ? p + (body.action === "up" ? -1 : 1) : p;
        } else return { __error: "Unknown action.", status: 400 };
        return { ok: true };
      });
      if (out.__error) return json({ error: out.__error, kicked: out.kicked, by: out.by }, out.status || 400);
      const n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
      return json(nightView(n, cfg));
    }
    // Hosts open the next set's sheet, or close/reopen the current one.
    // Clear tonight's whole list at one location. The host re-enters their PIN. Paid skips/repeats stay in the report.
    if (route === "clear" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      let pinOk = false;
      const chk = await update("hosts", { hosts: [] }, (d) => {
        const h = d.hosts.find((x) => x.id === me.id);
        if (!h || !h.pinHash) return { __error: "Please log in again.", status: 401 };
        if (h.lockUntil && h.lockUntil > Date.now()) return { __error: "Too many tries. Wait a few minutes and try again.", status: 429 };
        if (safeEq(scrypt(body.pin, h.salt), h.pinHash)) { h.fails = 0; h.lockUntil = 0; pinOk = true; return { ok: true }; }
        h.fails = (h.fails || 0) + 1; if (h.fails >= LOCK_AFTER) { h.fails = 0; h.lockUntil = Date.now() + LOCK_MS; }
        return { ok: true };
      });
      if (chk.__error) return fail(chk.__error, chk.status);
      if (!pinOk) return fail("That PIN doesn't match. The list was not cleared.", 401);
      const at = new Date().toISOString();
      const cl = await update(nightPath(loc), { entries: [] }, (d) => {
        const held = holdLoc(d, me); if (held) return held;
        d.cleared = [...(d.cleared || []), ...d.entries.map((e) => ({ ...e, clearedAt: at, clearedBy: me.name }))];
        d.entries = []; delete d.sheet; // start over at Set 1
        d.clears = [...(d.clears || []), { at, by: me.name }];
        return { ok: true };
      });
      if (cl.__error) return json({ error: cl.__error, kicked: cl.kicked, by: cl.by }, cl.status);
      return json(nightView(await loadNight(cfg, loc), cfg));
    }
    if (route === "sheet" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      const out = await update(nightPath(loc), { entries: [] }, (d) => {
        const held = holdLoc(d, me); if (held) return held;
        const sh = sheetStatus(d, cfg);
        if (body.op === "openNext") { if (!sh.next) return { __error: "Set " + LAST_SET + " is the last set tonight.", status: 400 }; d.sheet = { set: sh.next, open: true }; }
        else if (body.op === "close") d.sheet = { set: sh.set, open: false };
        else if (body.op === "reopen") d.sheet = { set: sh.set, open: true };
        else return { __error: "Unknown request.", status: 400 };
        return { ok: true };
      });
      if (out.__error) return json({ error: out.__error, kicked: out.kicked, by: out.by }, out.status || 400);
      const n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
      return json(nightView(n, cfg));
    }

    // ---------- Shonna only ----------
    if (route === "admin" && req.method === "POST") {
      if (!me.admin) return fail("Only Shonna can change hosts and settings.", 403);
      if (body.op === "report") {
        const night = /^\d{4}-\d{2}-\d{2}$/.test(String(body.night || "")) ? body.night : lastWednesday();
        return json({ report: await buildReport(night) });
      }
      if (body.op === "paymentsInfo") return json({ payments: paymentsAdminView(cfg) });
      if (body.op === "square") {
        if (body.disconnect) { await update("config", {}, (d) => { delete d.square; return d; }); return json({ ok: true, payments: paymentsAdminView(await loadConfig()) }); }
        const token = String(body.squareToken || "").trim().replace(/^Bearer\s+/i, "");
        if (!/^[A-Za-z0-9_\-]{20,300}$/.test(token)) return fail("That doesn't look like a Square access token. Copy the whole token from Square.");
        let env = null, locations = [];
        for (const tryEnv of ["production", "sandbox"]) {
          try { const j = await sqCall({ token, env: tryEnv }, "GET", "/v2/locations"); env = tryEnv; locations = (j.locations || []).filter((l) => l.status !== "INACTIVE"); break; }
          catch (err) { if (err.status !== 401) { console.error("square locations", err.message); return fail("Square said: " + err.message, 502); } }
        }
        if (!env) return fail("Square didn't accept that token. Make sure you copied the Production access token.", 400);
        if (!locations.length) return fail("That Square account doesn't have an active location.");
        const pick = locations.find((l) => l.id === body.locationId) || (locations.length === 1 ? locations[0] : null);
        if (!pick) return json({ choose: locations.map((l) => ({ id: l.id, name: l.name })) });
        await update("config", {}, (d) => { d.square = { token, env, locationId: pick.id, locationName: pick.name || "", currency: pick.currency || "USD", connectedAt: new Date().toISOString(), connectedBy: me.name }; return d; });
        return json({ ok: true, payments: paymentsAdminView(await loadConfig()) });
      }
      if (body.op === "payments") {
        const cashtag = clean(body.cashtag, 30).replace(/^\$*/, ""), venmo = clean(body.venmo, 40).replace(/^@*/, "");
        const fee = Math.max(1, Math.min(500, Math.round(Number(body.fee) || 50)));
        const repeatFee = Math.max(1, Math.min(500, Math.round(Number(body.repeatFee) || 20)));
        if (cashtag && !/^[A-Za-z0-9_-]+$/.test(cashtag)) return fail("That $cashtag has characters Cash App doesn't use.");
        if (venmo && !/^[A-Za-z0-9_-]+$/.test(venmo)) return fail("That Venmo username has characters Venmo doesn't use.");
        await update("config", {}, (d) => { d.payments = { cashtag, venmo, fee, repeatFee }; return d; });
        return json({ ok: true, payments: paymentsAdminView(await loadConfig()) });
      }
      if (body.op === "testMode") {
        await update("config", {}, (d) => { d.testMode = !!body.on; return d; });
        return json({ ok: true, testMode: !!body.on });
      }
      const out = await update("hosts", { hosts: [] }, (d) => {
        if (body.op === "add") {
          const name = clean(body.name, 30);
          if (!name) return { __error: "Add a name.", status: 400 };
          if (d.hosts.some((h) => h.active !== false && h.name.toLowerCase() === name.toLowerCase())) return { __error: name + " is already on the list.", status: 409 };
          let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "host";
          const old = d.hosts.find((h) => h.id === id);
          if (old && old.active === false) { old.active = true; old.name = name; delete old.pinHash; old.pinVer = (old.pinVer || 0) + 1; }
          else { while (d.hosts.some((h) => h.id === id)) id += "-2"; d.hosts.push({ id, name, active: true }); }
          if (body.pin) { if (!/^\d{4,6}$/.test(body.pin)) return { __error: "The PIN needs to be 4 to 6 numbers.", status: 400 }; const h = d.hosts.find((x) => x.id === id); h.salt = crypto.randomBytes(16).toString("hex"); h.pinHash = scrypt(body.pin, h.salt); }
          return d;
        }
        const h = d.hosts.find((x) => x.id === body.id);
        if (!h) return { __error: "That host isn't on the list.", status: 404 };
        if (body.op === "setPin") {
          if (!/^\d{4,6}$/.test(String(body.pin || ""))) return { __error: "The PIN needs to be 4 to 6 numbers.", status: 400 };
          h.salt = crypto.randomBytes(16).toString("hex"); h.pinHash = scrypt(body.pin, h.salt); h.pinVer = (h.pinVer || 0) + 1; h.fails = 0; h.lockUntil = 0;
        } else if (body.op === "remove") {
          if (h.admin) return { __error: "You can't remove yourself.", status: 400 };
          h.active = false; h.pinVer = (h.pinVer || 0) + 1;
        } else return { __error: "Unknown request.", status: 400 };
        return d;
      });
      if (out.__error) return fail(out.__error, out.status);
      const { hosts } = await hostsDoc();
      return json({ hosts: hosts.filter((h) => h.active !== false).map((h) => ({ id: h.id, name: h.name, hasPin: !!h.pinHash, admin: !!h.admin })) });
    }
    return fail("Not found.", 404);
  } catch (err) {
    console.error(err);
    return fail("Something went wrong. Try again.", 500);
  }
};

export const config = { path: "/api/lbk/*" };

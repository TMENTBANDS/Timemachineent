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
const session = (cfg, h) => ({
  token: sign(cfg, { hid: h.id, v: h.pinVer || 0, exp: Date.now() + 14 * 3600e3 }),
  host: { id: h.id, name: h.name, admin: !!h.admin },
});

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
const publicEntry = (e) => ({ id: e.id, name: e.name, song: e.song, artist: e.artist, status: e.status, set: entrySet(e), pos: e.pos, at: e.at, by: e.by, doneAt: e.doneAt,
  jumped: !!e.jumped, skipReq: e.skipReq || null, skipDenied: !!e.skipDenied });
const paymentsView = (cfg) => { const p = cfg.payments || {}; return { cashtag: p.cashtag || "", venmo: p.venmo || "", fee: p.fee || 50, on: !!(p.cashtag || p.venmo) }; };
const nightView = (n, cfg) => ({ night: nightKey(), sheet: sheetStatus(n, cfg), entries: n.entries.map(publicEntry) });

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
      const n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
      return json(nightView(n, cfg));
    }
    if (route === "signup" && req.method === "POST") {
      const loc = body.loc, v = VENUES[loc];
      if (!v) return fail("Pick a location first.");
      const name = clean(body.name, 30), song = clean(body.song, 120), artist = clean(body.artist, 120), device = clean(body.device, 64);
      if (!name || !song || !device) return fail("Add your name and pick a song.");
      if (!cfg.testMode) {
        const lat = Number(body.lat), lng = Number(body.lng), acc = Math.min(Number(body.acc) || 0, 200);
        if (!isFinite(lat) || !isFinite(lng)) return fail("We need your location to confirm you're at " + v.name + ".", 403);
        if (distM(lat, lng, v.lat, v.lng) > RADIUS_M + acc) return fail("Sign-ups only work from inside " + v.name + ".", 403);
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
        if (taken) return { __error: "Someone already picked " + song + " tonight. Please choose another song.", status: 409, taken: true };
        const mine = d.entries.find((e) => e.device === device && e.status === "waiting");
        if (mine) return { __error: "You're already in line with " + mine.song + ". Once you've sung, you can sign up again.", status: 409, id: mine.id };
        const e = { id: crypto.randomUUID().slice(0, 12), name, song, artist, status: "waiting", set: sh.set, pos: Date.now(), at: new Date().toISOString(), device };
        d.entries.push(e);
        return { ok: true, id: e.id, backup: sh.count >= SINGERS ? sh.count - SINGERS + 1 : 0 };
      });
      if (out.__error) return json({ error: out.__error, id: out.id, taken: out.taken, closed: out.closed }, out.status || 400);
      return json(out);
    }
    // Guest says they've paid to skip to next; a host checks Cash App / Venmo and confirms.
    if (route === "skipreq" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      if (!paymentsView(cfg).on) return fail("Skip to next isn't available right now.");
      const method = body.method === "venmo" ? "Venmo" : "Cash App", device = clean(body.device, 64);
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

    if (route === "host" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      const out = await update(nightPath(loc), { entries: [] }, (d) => {
        const e = d.entries.find((x) => x.id === body.id);
        const act = d.entries.filter((x) => x.status === "waiting" && e && entrySet(x) === entrySet(e)).sort((a, b) => a.pos - b.pos); // same set only
        if (!e) return { __error: "That sign-up isn't on the list anymore.", status: 404 };
        const stamp = { by: me.name, doneAt: new Date().toISOString() };
        if (body.action === "done") Object.assign(e, { status: "done" }, stamp);
        else if (body.action === "skip") Object.assign(e, { status: "skipped" }, stamp);
        else if (body.action === "back") {
          const k = songKey(e.song, e.artist);
          const other = d.entries.find((x) => x.id !== e.id && x.status !== "skipped" && songKey(x.song, x.artist) === k);
          if (other) return { __error: other.name + " picked " + e.song + " after the skip, so it can't go back in line. Ask " + e.name + " to pick another song.", status: 409 }; 
          e.status = "waiting"; e.pos = (act.length ? act[act.length - 1].pos : Date.now()) + 1; delete e.by; delete e.doneAt; }
        else if (body.action === "remove") d.entries = d.entries.filter((x) => x.id !== e.id);
        else if (body.action === "jump") {
          // Move right after whoever is singing now (after any earlier paid skips), in the set that's on stage.
          const line = d.entries.filter((x) => x.status === "waiting" && x.id !== e.id).sort((a, b) => (entrySet(a) - entrySet(b)) || (a.pos - b.pos));
          if (!line.length) { Object.assign(e, { jumped: true }); delete e.skipReq; return { ok: true }; }
          const cur = line[0], s = entrySet(cur), inSet = line.filter((x) => entrySet(x) === s);
          let anchor = cur; for (const x of inSet.slice(1)) { if (x.jumped) anchor = x; else break; }
          const nxt = inSet[inSet.indexOf(anchor) + 1];
          e.set = s; e.pos = nxt ? (anchor.pos + nxt.pos) / 2 : anchor.pos + 1; e.jumped = true; e.jumpedBy = me.name;
          e.paidVia = (e.skipReq && e.skipReq.method) || "Not recorded"; e.paidAt = new Date().toISOString(); e.paidFee = paymentsView(cfg).fee;
          delete e.skipReq; delete e.skipDenied;
        }
        else if (body.action === "nopay") { delete e.skipReq; e.skipDenied = true; }
        else if (body.action === "up" || body.action === "down") {
          const i = act.findIndex((x) => x.id === e.id), j = body.action === "up" ? i - 1 : i + 1;
          if (i < 0 || !act[j]) return { ok: true };
          const p = act[j].pos; act[j].pos = e.pos; e.pos = p === e.pos ? p + (body.action === "up" ? -1 : 1) : p;
        } else return { __error: "Unknown action.", status: 400 };
        return { ok: true };
      });
      if (out.__error) return fail(out.__error, out.status);
      const n = (await store().get(nightPath(loc), { type: "json" })) || { entries: [] };
      return json(nightView(n, cfg));
    }
    // Hosts open the next set's sheet, or close/reopen the current one.
    if (route === "sheet" && req.method === "POST") {
      const loc = body.loc; if (!VENUES[loc]) return fail("Unknown location.");
      const out = await update(nightPath(loc), { entries: [] }, (d) => {
        const sh = sheetStatus(d, cfg);
        if (body.op === "openNext") { if (!sh.next) return { __error: "Set " + LAST_SET + " is the last set tonight.", status: 400 }; d.sheet = { set: sh.next, open: true }; }
        else if (body.op === "close") d.sheet = { set: sh.set, open: false };
        else if (body.op === "reopen") d.sheet = { set: sh.set, open: true };
        else return { __error: "Unknown request.", status: 400 };
        return { ok: true };
      });
      if (out.__error) return fail(out.__error, out.status);
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
      if (body.op === "payments") {
        const cashtag = clean(body.cashtag, 30).replace(/^\$*/, ""), venmo = clean(body.venmo, 40).replace(/^@*/, "");
        const fee = Math.max(1, Math.min(500, Math.round(Number(body.fee) || 50)));
        if (cashtag && !/^[A-Za-z0-9_-]+$/.test(cashtag)) return fail("That $cashtag has characters Cash App doesn't use.");
        if (venmo && !/^[A-Za-z0-9_-]+$/.test(venmo)) return fail("That Venmo username has characters Venmo doesn't use.");
        await update("config", {}, (d) => { d.payments = { cashtag, venmo, fee }; return d; });
        return json({ ok: true, payments: { cashtag, venmo, fee, on: !!(cashtag || venmo) } });
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

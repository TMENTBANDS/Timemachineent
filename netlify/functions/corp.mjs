// Corporate Live Band Karaoke sign-up API (the page at /corporate).
// Each corporate event gets its own code, QR code and sign-up line, so any number of shows can run at once.
// No location check and no payments. Hosts log in with the same names and PINs as the Wednesday sign-up
// (/api/lbk/login); this file only reads the shared "hosts" and "config" docs to check their login.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const SET_REG = 12, SET_CAP = 15; // 12 singers + 3 extras per set
const ROLL_TOP = 5;               // extras who move to the next set land in its first 5
const MAX_PER_EVENT = 500;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const store = () => getStore({ name: "lbk", consistency: "strong" });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const fail = (msg, status = 400) => json({ error: msg }, status);
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const codeOf = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

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

// Same host login as /signup: a token signed with the shared secret, tied to the host's current PIN.
async function auth(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const cfg = await store().get("config", { type: "json" });
  if (!cfg || !cfg.secret) return null;
  const [body, mac] = token.split(".");
  const want = crypto.createHmac("sha256", cfg.secret).update(body).digest("base64url");
  if (!safeEq(mac, want)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (p.exp < Date.now()) return null;
  const doc = (await store().get("hosts", { type: "json" })) || { hosts: [] };
  const h = doc.hosts.find((x) => x.id === p.hid && x.active !== false);
  if (!h || (h.pinVer || 0) !== (p.v || 0)) return null;
  return h;
}

const EVENTS = "corp/events";
const linePath = (code) => "corp/line/" + code;
const loadEvents = async () => ((await store().get(EVENTS, { type: "json" })) || { events: [] }).events;
const loadLine = async (code) => (await store().get(linePath(code), { type: "json" })) || { entries: [], currentSet: 1 };
const eventView = (e) => ({ id: e.id, name: e.name, date: e.date, venue: e.venue || "", status: e.status });

const setOf = (e) => e.set || 1;
const sorted = (d) => d.entries.slice().sort((a, b) => (setOf(a) - setOf(b)) || (a.pos - b.pos));
const waitingIn = (d, n) => sorted(d).filter((x) => x.status === "waiting" && setOf(x) === n);
// The 15 spots of a set: everyone who signed up for it except VIPs (bonus spots) and people who passed.
const spotsIn = (d, n) => sorted(d).filter((x) => setOf(x) === n && !x.vip && x.status !== "declined" && x.status !== "left");
function openSet(d) { let n = d.currentSet || 1; while (spotsIn(d, n).length >= SET_CAP) n++; return n; }
function posAt(d, n, k) {
  const act = waitingIn(d, n);
  if (!act.length) return Date.now();
  if (k <= 0) return act[0].pos - 1;
  if (k >= act.length) return act[act.length - 1].pos + 1;
  return (act[k - 1].pos + act[k].pos) / 2;
}
function rollPos(d, n) {
  const act = waitingIn(d, n);
  let k = 0; while (k < act.length && act[k].rolled && k < ROLL_TOP - 1) k++;
  return posAt(d, n, k);
}
function moveUp(d, e) {
  const n = Math.max(e.offeredFor || setOf(e) + 1, d.currentSet || 1);
  e.pos = rollPos(d, n); e.set = n; e.status = "waiting"; e.rolled = true;
  delete e.offeredFor; delete e.offeredAt;
}
const pub = (e, d) => ({ id: e.id, name: e.name, song: e.song, artist: e.artist, status: e.status, set: setOf(e), pos: e.pos,
  at: e.at, by: e.by || null, doneAt: e.doneAt || null, vip: !!e.vip, rolled: !!e.rolled, offeredFor: e.offeredFor || null,
  spot: e.vip ? null : spotsIn(d, setOf(e)).findIndex((x) => x.id === e.id) + 1 });
const lineView = (ev, d) => ({ event: eventView(ev), currentSet: d.currentSet || 1, setReg: SET_REG, setCap: SET_CAP,
  entries: sorted(d).map((e) => pub(e, d)) });

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/corp\/?/, "");
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return fail("Bad request."); } }

  try {
    // ---------- guests ----------
    if (route === "line" && req.method === "GET") {
      const code = codeOf(url.searchParams.get("code"));
      const ev = (await loadEvents()).find((x) => x.id === code);
      if (!ev) return fail("We couldn't find that event. Check the code with your host.", 404);
      return json(lineView(ev, await loadLine(code)));
    }
    if (route === "signup" && req.method === "POST") {
      const code = codeOf(body.code);
      const ev = (await loadEvents()).find((x) => x.id === code);
      if (!ev) return fail("We couldn't find that event.", 404);
      if (ev.status === "closed") return fail("Sign-ups for " + ev.name + " are closed.", 409);
      const name = clean(body.name, 30), song = clean(body.song, 120), artist = clean(body.artist, 120), device = clean(body.device, 64);
      if (!name || !song || !device) return fail("Add your name and pick a song.");
      const out = await update(linePath(code), { entries: [], currentSet: 1 }, (d) => {
        if (d.entries.length >= MAX_PER_EVENT) return { __error: "The list is full. See the host at the stage.", status: 409 };
        const mine = d.entries.find((x) => x.device === device && (x.status === "waiting" || x.status === "offered"));
        if (mine) return { __error: "You're already in line with " + mine.song + ". Once you've sung, you can sign up again.", status: 409, id: mine.id };
        const e = { id: crypto.randomUUID().slice(0, 12), name, song, artist, device, status: "waiting", set: openSet(d), pos: Date.now(), at: new Date().toISOString() };
        d.entries.push(e);
        return { ok: true, id: e.id };
      });
      if (out.__error) return json({ error: out.__error, id: out.id }, out.status);
      return json({ ok: true, id: out.id, ...lineView(ev, await loadLine(code)) });
    }
    // Guest answers "move to the next set?", or takes themselves off the list.
    if ((route === "moveup" || route === "leave") && req.method === "POST") {
      const code = codeOf(body.code), device = clean(body.device, 64);
      const ev = (await loadEvents()).find((x) => x.id === code);
      if (!ev) return fail("We couldn't find that event.", 404);
      const out = await update(linePath(code), { entries: [], currentSet: 1 }, (d) => {
        const e = d.entries.find((x) => x.id === body.id && x.device === device);
        if (!e) return { __error: "We couldn't find your spot in line.", status: 404 };
        const at = new Date().toISOString();
        if (route === "leave") { if (e.status === "waiting" || e.status === "offered") Object.assign(e, { status: "left", by: "Left (removed themselves)", doneAt: at }); return { ok: true }; }
        if (e.status !== "offered") return { ok: true };
        if (body.yes) moveUp(d, e);
        else { Object.assign(e, { status: "declined", by: "Passed on Set " + e.offeredFor, doneAt: at }); delete e.offeredFor; }
        return { ok: true };
      });
      if (out.__error) return fail(out.__error, out.status);
      return json(lineView(ev, await loadLine(code)));
    }

    // ---------- hosts ----------
    const me = await auth(req.headers.get("x-host-token") || body.token);
    if (!me) return fail("Please log in again.", 401);

    if (route === "events" && req.method === "GET") {
      const all = await loadEvents();
      const list = all.filter((e) => url.searchParams.get("all") === "1" || e.status !== "closed")
        .sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.name.localeCompare(b.name));
      return json({ events: list.map(eventView), admin: !!me.admin });
    }
    // Shonna sets up, edits, closes and reopens events.
    if (route === "events" && req.method === "POST") {
      if (!me.admin) return fail("Only Shonna can set up events.", 403);
      let made = null;
      const out = await update(EVENTS, { events: [] }, (d) => {
        if (body.op === "add" || body.op === "edit") {
          const name = clean(body.name, 60), venue = clean(body.venue, 120), date = String(body.date || "");
          if (!name) return { __error: "Add the event name.", status: 400 };
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { __error: "Pick the event date.", status: 400 };
          if (body.op === "add") {
            let id; do { id = Array.from(crypto.randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join(""); } while (d.events.some((x) => x.id === id));
            made = { id, name, date, venue, status: "open", created: new Date().toISOString(), by: me.name };
            d.events.push(made);
          } else {
            const e = d.events.find((x) => x.id === codeOf(body.id));
            if (!e) return { __error: "That event isn't on the list.", status: 404 };
            Object.assign(e, { name, date, venue });
          }
          return { ok: true };
        }
        const e = d.events.find((x) => x.id === codeOf(body.id));
        if (!e) return { __error: "That event isn't on the list.", status: 404 };
        if (body.op === "delete") { d.events = d.events.filter((x) => x !== e); return { ok: true, deleted: e.id }; }
        if (body.op === "close") e.status = "closed";
        else if (body.op === "reopen") e.status = "open";
        else return { __error: "Unknown request.", status: 400 };
        return { ok: true };
      });
      if (out.__error) return fail(out.__error, out.status);
      if (out.deleted) await store().delete(linePath(out.deleted));
      return json({ ok: true, id: made ? made.id : null, events: (await loadEvents()).map(eventView) });
    }
    // Run the line for one event.
    if (route === "host" && req.method === "POST") {
      const code = codeOf(body.code);
      const ev = (await loadEvents()).find((x) => x.id === code);
      if (!ev) return fail("We couldn't find that event.", 404);
      const out = await update(linePath(code), { entries: [], currentSet: 1 }, (d) => {
        const at = new Date().toISOString(), cur = d.currentSet || 1;
        if (body.action === "vip") {
          const name = clean(body.name, 30), song = clean(body.song, 120), artist = clean(body.artist, 120);
          if (!name || !song) return { __error: "Add a name and a song.", status: 400 };
          const n = Math.max(cur, Math.round(Number(body.set)) || cur);
          const k = body.where === "top" ? 0 : body.where === "end" || body.where == null ? Infinity : waitingIn(d, n).findIndex((x) => x.id === body.where) + 1;
          d.entries.push({ id: crypto.randomUUID().slice(0, 12), name, song, artist, vip: true, status: "waiting", set: n, pos: posAt(d, n, k), at, by: me.name });
          return { ok: true };
        }
        if (body.action === "endset") {
          const inCur = waitingIn(d, cur);
          for (const e of inCur) {
            if (e.vip) e.set = cur + 1;
            else Object.assign(e, { status: "offered", offeredFor: cur + 1, offeredAt: at });
          }
          // VIPs carry over to the top of the next set.
          const vips = inCur.filter((e) => e.vip), next = waitingIn(d, cur + 1).filter((e) => !e.vip);
          const base = next.length ? next[0].pos : Date.now();
          vips.forEach((v, i) => { v.pos = base - (vips.length - i); });
          d.currentSet = cur + 1;
          return { ok: true };
        }
        const e = d.entries.find((x) => x.id === body.id);
        if (!e) return { __error: "That sign-up isn't on the list anymore.", status: 404 };
        const stamp = { by: me.name, doneAt: at };
        if (body.action === "done") Object.assign(e, { status: "done" }, stamp);
        else if (body.action === "skip") Object.assign(e, { status: "skipped" }, stamp);
        else if (body.action === "drop") { Object.assign(e, { status: "declined" }, stamp); delete e.offeredFor; }
        else if (body.action === "move") { if (e.status !== "offered") return { __error: "That singer was already moved or removed.", status: 409 }; moveUp(d, e); }
        else if (body.action === "back") {
          const n = Math.max(setOf(e), cur), act = waitingIn(d, n).filter((x) => x.id !== e.id);
          e.pos = act.length ? act[act.length - 1].pos + 1 : Date.now(); e.set = n; e.status = "waiting";
          delete e.by; delete e.doneAt; delete e.offeredFor;
        } else if (body.action === "up" || body.action === "down") {
          const act = waitingIn(d, setOf(e)), i = act.findIndex((x) => x.id === e.id), j = body.action === "up" ? i - 1 : i + 1;
          if (i < 0 || !act[j]) return { ok: true };
          const p = act[j].pos; act[j].pos = e.pos; e.pos = p === e.pos ? p + (body.action === "up" ? -1 : 1) : p;
        } else return { __error: "Unknown action.", status: 400 };
        return { ok: true };
      });
      if (out.__error) return fail(out.__error, out.status);
      return json(lineView(ev, await loadLine(code)));
    }
    return fail("Not found.", 404);
  } catch (err) {
    console.error(err);
    return fail("Something went wrong. Try again.", 500);
  }
};

export const config = { path: "/api/corp/*" };

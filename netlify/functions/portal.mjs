// Time Machine Entertainment — Wedding Client Portal API (Netlify Function)
// Reads/writes the couple's Zoho CRM Deal. Zoho stays the single source of truth.
//
// Required Netlify environment variables:
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN   (Zoho API "Self Client")
//   ZOHO_ACCOUNTS_URL   default https://accounts.zoho.com
//   ZOHO_API_URL        default https://www.zohoapis.com
//   PORTAL_SECRET       any long random string (signs login sessions)

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const docs = () => getStore("portal-docs");

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const API = (process.env.ZOHO_API_URL || "https://www.zohoapis.com") + "/crm/v8";
const SECRET = process.env.PORTAL_SECRET || "";
const SESSION_HOURS = 12;

// Worksheet fields the couple is allowed to edit (Zoho API names).
const WS_FIELDS = [
  "WS_Couple_Names", "WS_Day_Of_Contact", "WS_Cocktail_Hour", "WS_Cocktail_Hour_Ends",
  "WS_Cocktail_Location", "WS_Groom_Parents", "WS_Setup_Complete_By", "WS_Band_Break_Room",
  "WS_Musical_Styles", "WS_Wedding_Party_Intros", "WS_Other_Intros", "WS_Toasts",
  "WS_First_Dance", "WS_Entrance_Song", "WS_Father_Daughter_Song", "WS_Mother_Son_Song",
  "WS_Bouquet_Toss", "WS_Garter_Toss", "WS_Send_Off", "WS_Do_Not_Play", "WS_Notes_Requests",
  "WS_Private_Last_Dance", "WS_Private_Dance_Song", "WS_Private_Dance_Notes",
];
const DEAL_FIELDS = [
  "Deal_Name", "Event_Date", "Band", "Venue", "Venue_Address", "Performance_Time",
  "Load_In_Details", "Dress_Code", "Amount", "TAC_Paid", "TAC_Balance", "Deposit_Amount",
  "Balance_Due_Date", "Contract_Status", "Contract_Notes", "Square_Payment_Link",
  "Portal_PIN", "Portal_Active", "Contact_Name", "WS_Submitted_On", ...WS_FIELDS,
];

// ---------- Zoho helpers ----------
const clean = (x = "") => x.trim().replace(/^"+|"+$/g, "").trim();
// Accept either the bare refresh token or the whole JSON reply Zoho shows ({"access_token":..., "refresh_token":"1000...."}).
function refreshToken() {
  const raw = process.env.ZOHO_REFRESH_TOKEN || "";
  const m = raw.match(/"refresh_token"\s*:\s*"([^"]+)"/);
  return m ? m[1] : clean(raw);
}
let cachedToken = null, tokenExpires = 0;
async function zohoToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;
  const body = new URLSearchParams({
    refresh_token: refreshToken(),
    client_id: clean(process.env.ZOHO_CLIENT_ID),
    client_secret: clean(process.env.ZOHO_CLIENT_SECRET),
    grant_type: "refresh_token",
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: "POST", body });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch { console.error("Zoho token endpoint returned non-JSON", r.status, txt.slice(0, 120)); }
  if (!j.access_token) {
    const v = (k) => { const x = process.env[k] || ""; return `${k}: ${x.length} chars${/^\s|\s$|"/.test(x) ? " (has spaces or quotes!)" : ""}`; };
    console.error("Zoho token refresh failed:", j.error || r.status, "|", ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"].map(v).join(", "), "| accounts:", ACCOUNTS);
    throw new Error("Zoho auth failed");
  }
  cachedToken = j.access_token;
  tokenExpires = Date.now() + (j.expires_in - 120) * 1000;
  return cachedToken;
}
async function zoho(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Zoho-oauthtoken ${await zohoToken()}`, ...(opts.headers || {}) },
  });
  if (!(r.headers.get("content-type") || "").includes("json") && r.status !== 204) {
    console.error("Zoho API non-JSON reply", r.status, path.split("?")[0], (await r.clone().text()).slice(0, 120));
  }
  return r;
}

// ---------- session tokens ----------
function sign(dealId) {
  const payload = Buffer.from(JSON.stringify({ d: dealId, e: Date.now() + SESSION_HOURS * 3600e3 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verify(token = "") {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const good = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const { d, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
  return Date.now() < e ? d : null;
}

const json = (status, data) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const norm = (s = "") => s.toLowerCase().replace(/[^a-z]/g, "");

async function getDeal(id) {
  const r = await zoho(`/Deals/${id}?fields=${DEAL_FIELDS.join(",")}`);
  const j = await r.json();
  return j.data?.[0];
}

async function getContact(id) {
  if (!id) return null;
  const r = await zoho(`/Contacts/${id}?fields=First_Name,Last_Name,Email,Phone`);
  if (r.status !== 200) return null;
  return (await r.json()).data?.[0] || null;
}

// ---------- Song requests live in one Zoho Note on the Deal ----------
const SONG_NOTE_TITLE = "Song Requests (from client portal)";
async function findSongNote(dealId) {
  const r = await zoho(`/Deals/${dealId}/Notes?fields=id,Note_Title,Note_Content&per_page=200`);
  if (r.status !== 200) return null;
  return ((await r.json()).data || []).find(n => n.Note_Title === SONG_NOTE_TITLE) || null;
}
function parseSongNote(text = "") {
  const out = { must: [], dnp: [] }; let cur = null;
  for (const line of text.split("\n")) {
    if (/^MUST PLAY/i.test(line)) cur = "must";
    else if (/^DO NOT PLAY/i.test(line)) cur = "dnp";
    else if (cur && line.startsWith("- ")) out[cur].push(line.slice(2).trim());
  }
  return out;
}
function songNoteText({ must, dnp }) {
  return `MUST PLAY (${must.length})\n${must.map(x => "- " + x).join("\n") || "(none)"}\n\nDO NOT PLAY (${dnp.length})\n${dnp.map(x => "- " + x).join("\n") || "(none)"}`;
}

// What the couple is allowed to see (never internal fields like crew pay).
async function publicView(deal) {
  const att = await zoho(`/Deals/${deal.id}/Attachments?fields=id,File_Name,Size,Created_Time`);
  const files = att.status === 200 ? ((await att.json()).data || []) : [];
  try {
    const { blobs } = await docs().list({ prefix: `${deal.id}/` });
    for (const b of blobs) files.push({ id: "b:" + b.key, File_Name: b.key.split("/").slice(1).join("/") });
  } catch (e) { console.error("blob list failed", e); }
  const total = Number(deal.Amount || 0);
  const paid = Number(deal.TAC_Paid || 0);
  const out = {
    title: (deal.Deal_Name || "").replace(/^[\d.\s|]+/, "").replace(/\bTMB\b\s*\|?\s*/, "").replace(/\*+/g, "").trim(),
    date: deal.Event_Date, band: deal.Band, venue: deal.Venue, venueAddress: deal.Venue_Address,
    performanceTime: deal.Performance_Time, loadIn: deal.Load_In_Details, dressCode: deal.Dress_Code,
    total, paid, balance: deal.TAC_Balance != null ? Number(deal.TAC_Balance) : total - paid,
    deposit: deal.Deposit_Amount, balanceDue: deal.Balance_Due_Date || deal.Event_Date,
    contractStatus: deal.Contract_Status, notes: deal.Contract_Notes,
    squareLink: deal.Square_Payment_Link || null,
    contact: deal.Contact_Name?.name || null,
    files: files.map(f => ({ id: f.id, name: f.File_Name, size: f.Size })),
    worksheet: Object.fromEntries(WS_FIELDS.map(k => [k, deal[k] ?? null])),
    worksheetSubmitted: deal.WS_Submitted_On,
    songs: parseSongNote((await findSongNote(deal.id))?.Note_Content || ""),
  };
  return out;
}

// crude in-memory throttle per IP (resets when the function cold-starts)
const attempts = new Map();
function throttled(ip) {
  const now = Date.now(), win = 15 * 60e3;
  const a = (attempts.get(ip) || []).filter(t => now - t < win);
  attempts.set(ip, a);
  return a.length >= 8;
}

export default async (req, context) => {
  if (!SECRET) return json(500, { error: "Portal not configured" });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const ip = context.ip || req.headers.get("x-nf-client-connection-ip") || "x";

  try {
    // ---- LOGIN: last name + PIN ----
    if (action === "login" && req.method === "POST") {
      if (throttled(ip)) return json(429, { error: "Too many tries. Please wait 15 minutes or call us." });
      const { pin = "", lastName = "" } = await req.json();
      const cleanPin = String(pin).replace(/\D/g, "");
      if (!cleanPin || !norm(lastName)) return json(400, { error: "Enter your last name and PIN." });

      const q = `select id, Deal_Name, Contact_Name, Portal_Active from Deals where Portal_PIN = '${cleanPin}' limit 10`;
      const r = await zoho("/coql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ select_query: q }) });
      const rows = r.status === 200 ? ((await r.json()).data || []) : [];
      let match = null;
      for (const d of rows) {
        if (!d.Portal_Active) continue;
        const names = [d.Deal_Name, d.Contact_Name?.name];
        const c = await getContact(d.Contact_Name?.id);
        if (c) names.push(c.Last_Name);
        if (names.some(n => n && norm(n).includes(norm(lastName)))) { match = d; break; }
      }
      if (!match) {
        attempts.get(ip).push(Date.now());
        return json(401, { error: "We couldn't find a wedding with that name and PIN." });
      }
      return json(200, { token: sign(match.id) });
    }

    // ---- ADMIN UPLOAD: copy a document into a couple's portal ----
    // Authorized by a one-time code Shonna (or Claude) puts in the Deal's "Portal Upload Code" field; the code is cleared after use.
    if (action === "upload") {
      const cors = { "access-control-allow-origin": req.headers.get("origin") || "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const deal = url.searchParams.get("deal") || "", code = url.searchParams.get("code") || "";
      const name = (url.searchParams.get("name") || "Document.pdf").replace(/[^\w .&()#-]/g, "").slice(0, 120) || "Document.pdf";
      const bad = (st, m) => new Response(JSON.stringify({ error: m }), { status: st, headers: { ...cors, "content-type": "application/json" } });
      if (!/^\d+$/.test(deal) || code.length < 20) return bad(400, "Missing deal or code");
      const r = await zoho(`/Deals/${deal}?fields=Portal_Upload_Code`);
      const want = r.status === 200 ? (await r.json()).data?.[0]?.Portal_Upload_Code : null;
      if (!want || want.length !== code.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(code))) return bad(403, "Code not valid");
      let body;
      if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
        const f = (await req.formData()).get("file");
        body = f && typeof f.arrayBuffer === "function" ? await f.arrayBuffer() : new ArrayBuffer(0);
      } else body = await req.arrayBuffer();
      if (!body.byteLength || body.byteLength > 15e6) return bad(400, "File missing or too large");
      await docs().set(`${deal}/${name}`, body);
      await zoho("/Deals", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [{ id: deal, Portal_Upload_Code: null }] }) });
      return new Response(JSON.stringify({ ok: true, name, bytes: body.byteLength }), { headers: { ...cors, "content-type": "application/json" } });
    }

    // Everything below needs a valid session
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("t");
    const dealId = verify(token);
    if (!dealId) return json(401, { error: "Please log in again." });

    if (action === "me") {
      const deal = await getDeal(dealId);
      if (!deal?.Portal_Active) return json(403, { error: "Portal is not active for this event." });
      return json(200, await publicView(deal));
    }

    if (action === "file") {
      const fileId = url.searchParams.get("id");
      const deal = await getDeal(dealId);
      const view = await publicView(deal);
      const f = view.files.find(x => x.id === fileId);
      if (!f) return json(404, { error: "File not found" });
      if (fileId.startsWith("b:")) {
        const data = await docs().get(fileId.slice(2), { type: "arrayBuffer" });
        if (!data) return json(404, { error: "File not found" });
        return new Response(data, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${f.name.replace(/"/g, "")}"`, "cache-control": "no-store" } });
      }
      const r = await zoho(`/Deals/${dealId}/Attachments/${fileId}`);
      return new Response(r.body, {
        headers: {
          "content-type": r.headers.get("content-type") || "application/octet-stream",
          "content-disposition": `inline; filename="${f.name.replace(/"/g, "")}"`,
          "cache-control": "no-store",
        },
      });
    }

    if (action === "worksheet" && req.method === "POST") {
      const input = await req.json();
      const rec = { id: dealId, WS_Submitted_On: new Date().toISOString().replace(/\.\d+Z$/, "+00:00") };
      for (const k of WS_FIELDS) {
        if (!(k in input)) continue;
        let v = input[k];
        if (k === "WS_Musical_Styles") v = Array.isArray(v) ? v.slice(0, 10).map(String) : [];
        else v = v == null ? null : String(v).slice(0, k.match(/Intros|Toasts|First_Dance|Day_Of/) ? 2000 : 255);
        rec[k] = v === "" ? null : v;
      }
      const r = await zoho("/Deals", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [rec] }) });
      const j = await r.json();
      if (j.data?.[0]?.status !== "success") return json(500, { error: "Couldn't save. Please try again." });
      // Leave Shonna a note on the Deal so the change shows in Zoho's timeline
      await zoho(`/Deals/${dealId}/Notes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: [{ Note_Title: "Wedding worksheet updated by client", Note_Content: "The couple saved their wedding worksheet in the client portal." }] }),
      });
      return json(200, { ok: true });
    }

    if (action === "songs" && req.method === "POST") {
      const clean = a => [...new Set((Array.isArray(a) ? a : []).map(x => String(x).replace(/[\r\n]/g, " ").trim().slice(0, 200)).filter(Boolean))].slice(0, 400);
      const input = await req.json();
      const picks = { must: clean(input.must), dnp: clean(input.dnp) };
      picks.dnp = picks.dnp.filter(x => !picks.must.includes(x));
      const existing = await findSongNote(dealId);
      const note = { Note_Title: SONG_NOTE_TITLE, Note_Content: songNoteText(picks) };
      const r = existing
        ? await zoho(`/Notes/${existing.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [note] }) })
        : await zoho(`/Deals/${dealId}/Notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [note] }) });
      const j = await r.json().catch(() => ({}));
      if (j.data?.[0]?.status !== "success") return json(500, { error: "Couldn't save your songs. Please try again." });
      return json(200, { ok: true, counts: { must: picks.must.length, dnp: picks.dnp.length } });
    }

    return json(404, { error: "Unknown request" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Something went wrong. Please try again or call us." });
  }
};

export const config = { path: "/api/portal" };

// Paid "Skip to next" and $20 repeat-song report: confirmed tips per location for one night.
// Used by the admin screen and by Shonna's Thursday task that copies it to the PAYROLL calendar.
import { getStore } from "@netlify/blobs";

export const REPORT_VENUES = { addison: "Sidecar Addison", frisco: "Sidecar Frisco" };

// The most recent Wednesday show night (Chicago time), as YYYY-MM-DD.
export function lastWednesday(now = new Date()) {
  const d = new Date(now.getTime() - 6 * 3600e3); // before 6am still counts as the night before
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
  const day = new Date(ymd + "T12:00:00Z");
  const back = (day.getUTCDay() - 3 + 7) % 7; // 3 = Wednesday
  day.setUTCDate(day.getUTCDate() - back);
  return day.toISOString().slice(0, 10);
}

export async function buildReport(night) {
  const store = getStore({ name: "lbk", consistency: "strong" });
  const cfg = (await store.get("config", { type: "json" })) || {};
  const defaultFee = (cfg.payments && cfg.payments.fee) || 50;
  const defaultRepeatFee = (cfg.payments && cfg.payments.repeatFee) || 20;
  const locations = [];
  for (const [loc, name] of Object.entries(REPORT_VENUES)) {
    const n = (await store.get("night/" + loc + "/" + night, { type: "json" })) || { entries: [] };
    const items = n.entries.filter((e) => e.jumped).sort((a, b) => String(a.paidAt || "").localeCompare(String(b.paidAt || ""))).map((e) => ({
      name: e.name, song: e.song, artist: e.artist, method: e.paidVia || "Not recorded", fee: e.paidFee || defaultFee,
      at: e.paidAt || null, confirmedBy: e.jumpedBy || "", sang: e.status === "done",
    }));
    // Repeat songs: guests who tipped to sing a song someone else already picked that night.
    const repeats = n.entries.filter((e) => e.repeatPaid).sort((a, b) => String(a.repeatAt || "").localeCompare(String(b.repeatAt || ""))).map((e) => ({
      name: e.name, song: e.song, artist: e.artist, method: e.repeatVia || "Not recorded", fee: e.repeatFee || defaultRepeatFee,
      at: e.repeatAt || null, confirmedBy: e.repeatBy || "", sang: e.status === "done",
    }));
    locations.push({ loc, name, items, count: items.length, total: items.reduce((s, i) => s + i.fee, 0),
      repeats, repeatCount: repeats.length, repeatTotal: repeats.reduce((s, i) => s + i.fee, 0), signups: n.entries.length });
  }
  const sum = (k) => locations.reduce((s, l) => s + l[k], 0);
  // total/count = paid skips only (kept as before); repeatTotal/repeatCount = repeat songs; tipsTotal = both.
  return { night, locations, total: sum("total"), count: sum("count"), repeatTotal: sum("repeatTotal"), repeatCount: sum("repeatCount"), tipsTotal: sum("total") + sum("repeatTotal") };
}

const t = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }) : "time not recorded");
const nightLabel = (night) => new Date(night + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });

export function reportText(r) {
  const lines = [`Live Band Karaoke paid skips: ${nightLabel(r.night)}`, ""];
  for (const l of r.locations) {
    lines.push(`${l.name.toUpperCase()}: ${l.count} paid skip${l.count === 1 ? "" : "s"}, $${l.total}`);
    if (!l.items.length) lines.push("  None");
    for (const i of l.items) lines.push(`  - ${i.name}: ${i.song} (${i.artist}). $${i.fee} via ${i.method}, ${t(i.at)}${i.confirmedBy ? `, confirmed by ${i.confirmedBy}` : ""}`);
    lines.push(`  Repeat songs: ${l.repeatCount}, $${l.repeatTotal}`);
    for (const i of l.repeats) lines.push(`  - ${i.name}: ${i.song} (${i.artist}). $${i.fee} via ${i.method}, ${t(i.at)}${i.confirmedBy ? `, confirmed by ${i.confirmedBy}` : ""}`);
    lines.push("");
  }
  lines.push(`TOTAL PAID SKIPS: ${r.count}, $${r.total}`);
  lines.push(`TOTAL REPEAT SONGS: ${r.repeatCount}, $${r.repeatTotal}`);
  lines.push(`TOTAL TIPS: $${r.tipsTotal}`);
  lines.push("", "Match these against Earl's Cash App and Venmo. Payment notes usually include the location and singer's name.");
  return lines.join("\n");
}

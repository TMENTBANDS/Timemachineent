// Paid "Skip to next" report: confirmed paid skips per location for one night.
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
  const locations = [];
  for (const [loc, name] of Object.entries(REPORT_VENUES)) {
    const n = (await store.get("night/" + loc + "/" + night, { type: "json" })) || { entries: [] };
    const items = n.entries.filter((e) => e.jumped).sort((a, b) => String(a.paidAt || "").localeCompare(String(b.paidAt || ""))).map((e) => ({
      name: e.name, song: e.song, artist: e.artist, method: e.paidVia || "Not recorded", fee: e.paidFee || defaultFee,
      at: e.paidAt || null, confirmedBy: e.jumpedBy || "", sang: e.status === "done",
    }));
    locations.push({ loc, name, items, count: items.length, total: items.reduce((s, i) => s + i.fee, 0), signups: n.entries.length });
  }
  return { night, locations, total: locations.reduce((s, l) => s + l.total, 0), count: locations.reduce((s, l) => s + l.count, 0) };
}

const t = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }) : "time not recorded");
const nightLabel = (night) => new Date(night + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });

export function reportText(r) {
  const lines = [`Live Band Karaoke paid skips: ${nightLabel(r.night)}`, ""];
  for (const l of r.locations) {
    lines.push(`${l.name.toUpperCase()}: ${l.count} paid skip${l.count === 1 ? "" : "s"}, $${l.total}`);
    if (!l.items.length) lines.push("  None");
    for (const i of l.items) lines.push(`  - ${i.name}: ${i.song} (${i.artist}). $${i.fee} via ${i.method}, ${t(i.at)}${i.confirmedBy ? `, confirmed by ${i.confirmedBy}` : ""}`);
    lines.push("");
  }
  lines.push(`TOTAL: ${r.count} paid skip${r.count === 1 ? "" : "s"}, $${r.total}`);
  lines.push("", "Match these against Earl's Cash App and Venmo. Payment notes usually include the location and singer's name.");
  return lines.join("\n");
}

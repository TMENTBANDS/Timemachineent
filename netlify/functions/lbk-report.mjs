// Every Thursday morning: email last night's paid "Skip to next" report.
import { buildReport, emailReport, lastWednesday } from "../lib/report.mjs";

export default async () => {
  const r = await buildReport(lastWednesday());
  const sent = await emailReport(r, process.env.URL);
  console.log("lbk-report", r.night, "count", r.count, "total", r.total, "sent", JSON.stringify(sent));
  return new Response("ok");
};

// 14:00 UTC Thursday = 8:00 am Central (standard time) / 9:00 am during daylight time.
export const config = { schedule: "0 14 * * 4" };

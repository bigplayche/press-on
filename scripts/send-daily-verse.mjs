// Sends the day's Press On verse as a push notification through OneSignal.
// Runs every hour from .github/workflows/daily-verse.yml. Each run notifies the
// people whose local time reaches 6:00 a.m. in the next hour, scheduled for exactly 6:00
// their time, with the devotional for their local date.
//
// Settings (environment variables):
//   ONESIGNAL_API_KEY  required, stored as a GitHub secret
//   TEST=true          send today's verse to every subscriber right now
//   DRY_RUN=true       print what would be sent without sending anything
import { readFileSync } from "node:fs";

const SITE_URL = "https://bigplayche.github.io/press-on/";
const SEND_HOUR = 6; // 6:00 a.m. local time
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const appId = (html.match(/const ONESIGNAL_APP_ID = "([^"]*)"/) || [])[1];
const apiKey = process.env.ONESIGNAL_API_KEY;
const TEST = process.env.TEST === "true";
const DRY = process.env.DRY_RUN === "true";

if (!appId) { console.log("No OneSignal App ID in index.html yet. Nothing to send."); process.exit(0); }
if (!apiKey && !DRY) { console.log("ONESIGNAL_API_KEY secret is missing. Add it in Settings > Secrets and variables > Actions."); process.exit(1); }

// Pull the app's data straight out of index.html so there is only one copy of the content.
const json = name => { const i = html.indexOf(`const ${name} = `); return JSON.parse(html.slice(i + name.length + 9, html.indexOf(";\n", i))); };
const V = json("V"), SHORT = json("SHORT"), YEAR = json("YEAR");
const d0 = html.indexOf("const DAILY = ["), d1 = html.indexOf("\n];", d0) + 2;
const DAILY = Function("return " + html.slice(d0 + 14, d1))();

const CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
function entryFor(month, day) {
  const y = YEAR[CUM[month] + day - 1];
  if (y < DAILY.length) return { title: DAILY[y].title, ref: DAILY[y].ref };
  const s = SHORT[y - DAILY.length];
  return { title: s[2], ref: s[0] };
}
function message(e) {
  let verse = V[e.ref];
  if (verse.length > 120) verse = verse.slice(0, 117).replace(/\s+\S*$/, "").replace(/[\s,;:]+$/, "") + "…";
  return { heading: `Press On · ${e.title}`, body: `“${verse.replace(/^“|”$/g, "")}” ${e.ref}` };
}

async function send(msg, filters, label, sendAt) {
  const payload = {
    app_id: appId, target_channel: "push",
    headings: { en: msg.heading }, contents: { en: msg.body },
    url: SITE_URL, filters,
  };
  if (sendAt && sendAt > Date.now() + 60000) payload.send_after = new Date(sendAt).toISOString();
  if (DRY) { console.log(`[dry run] ${label}${payload.send_after ? " at " + payload.send_after : ""}\n  ${msg.heading}\n  ${msg.body}`); return; }
  const res = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Key ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${label}: OneSignal error ${res.status} ${JSON.stringify(out)}`);
  const none = JSON.stringify(out.errors || "").includes("not subscribed");
  console.log(`${label}: ${none ? "no subscribers in this time zone" : `sent (id ${out.id})`}`);
}

const now = new Date();
if (TEST) {
  const msg = message(entryFor(now.getUTCMonth(), now.getUTCDate()));
  await send(msg, [{ field: "tag", key: "utc_offset", relation: "exists" }], "Test to all subscribers");
} else {
  // The job is scheduled at :50 every hour. Each run covers the 60 minutes after its
  // scheduled slot, even if GitHub starts it late, so no time zone is skipped.
  const HOUR = 3600000;
  let slot = Math.floor(now.getTime() / HOUR) * HOUR + 50 * 60000;
  if (slot > now.getTime()) slot -= HOUR;
  let sent = 0;
  // Every real-world UTC offset, in 15-minute steps from UTC-12 to UTC+14.
  for (let off = -720; off <= 840; off += 15) {
    const offMs = off * 60000;
    // Find the moment it is SEND_HOUR:00 in this time zone, inside (slot, slot + 1 hour].
    const localSlot = new Date(slot + offMs);
    let target = Date.UTC(localSlot.getUTCFullYear(), localSlot.getUTCMonth(), localSlot.getUTCDate(), SEND_HOUR) - offMs;
    if (target <= slot) target += 24 * HOUR;
    if (target > slot + HOUR) continue;
    const local = new Date(target + offMs);
    const msg = message(entryFor(local.getUTCMonth(), local.getUTCDate()));
    await send(msg, [{ field: "tag", key: "utc_offset", relation: "=", value: String(off) }], `UTC${off >= 0 ? "+" : ""}${off / 60}`, target);
    sent++;
  }
  console.log(`Scheduled ${sent} time zone(s) reaching ${SEND_HOUR}:00 a.m. in the next hour.`);
}

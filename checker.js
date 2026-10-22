// Lightning Lane alert checker
// Polls ThemeParks.wiki once a minute, detects Lightning Lanes that reopen,
// and sends web push alerts to users who picked that ride.

import express from "express";
import webpush from "web-push";
import fs from "node:fs";

// ---------- Settings ----------
const API = "https://api.themeparks.wiki/v1";
const POLL_MS = 60_000;                  // once a minute; be polite to the free API
// Alert right away when a ride opens, then remind every N minutes while it stays open.
const REMINDER_MS = Number(process.env.REMINDER_MIN ?? 15) * 60_000;
const DATA_FILE = process.env.DATA_FILE || "./data.json";
const PORT = process.env.PORT || 3000;
const TZ = "America/New_York";
const DRY_RUN = process.env.DRY_RUN === "1"; // log alerts instead of sending pushes

// Queue types that mean "Lightning Lane"
const LL_QUEUES = ["RETURN_TIME", "PAID_RETURN_TIME"];

// ---------- Storage (simple JSON file for the MVP) ----------
// data = { subscribers: [{ id, subscription, rides: [rideId], window }], lastAlert: { "subId:rideId": ms } }
let data = { subscribers: [], lastAlert: {} };
try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

// Last known Lightning Lane state per ride, kept in memory
// rideState = { [rideId]: { name, park, state, returnStart, returnEnd, price } }
const rideState = {};
let parks = [];          // [{ id, name }]
let seeded = false;      // first poll only records state, never alerts

// ---------- Push setup ----------
if (!DRY_RUN) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.error("Missing VAPID keys. Run: npx web-push generate-vapid-keys");
    process.exit(1);
  }
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || "mailto:you@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ---------- Helpers ----------
async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "castlecall/0.1" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Find the four Walt Disney World parks once at startup
export async function loadParks() {
  const { destinations } = await getJSON(`${API}/destinations`);
  const wdw = destinations.find(d => /walt disney world/i.test(d.name));
  if (!wdw) throw new Error("Walt Disney World not found in destinations");
  parks = wdw.parks.map(p => ({ id: p.id, name: p.name }));
  console.log("Parks:", parks.map(p => p.name).join(", "));
}

// Pull out the Lightning Lane info from one ride's live data
export function readLL(item) {
  for (const type of LL_QUEUES) {
    const q = item.queue?.[type];
    if (q) {
      return {
        type,
        state: q.state || "UNKNOWN",                // AVAILABLE, TEMP_FULL, FINISHED
        returnStart: q.returnStart || null,
        returnEnd: q.returnEnd || null,
        price: q.price?.formatted || null,
      };
    }
  }
  return null;
}

// Hour of day in park time, from an ISO timestamp
const hourET = iso => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: TZ }).format(new Date(iso))) % 24;
const fmtTime = iso => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }).format(new Date(iso));

// Does this return time fit the user's chosen window?
export function fitsWindow(window, returnStart) {
  if (!returnStart || !window || window === "any") return true;
  const h = hourET(returnStart);
  if (window === "morning") return h < 12;
  if (window === "afternoon") return h >= 12 && h < 17;
  if (window === "evening") return h >= 17;
  return true;
}

// The key moment: a ride flips from full/finished to available
export function justOpened(prev, now) {
  return !!prev && prev.state !== "AVAILABLE" && now.state === "AVAILABLE";
}

// Send now? Always on a fresh opening; otherwise only if the last alert was REMINDER_MS ago or more.
// A brand-new subscriber (no last alert) hears about an already-open ride right away.
export function shouldAlert(opened, lastMs, nowMs, reminderMs = REMINDER_MS) {
  return opened || nowMs - (lastMs || 0) >= reminderMs;
}

// ---------- Main loop ----------
// Returns every ride that is open right now, flagged if it just opened this minute
async function pollPark(park) {
  const { liveData = [] } = await getJSON(`${API}/entity/${park.id}/live`);
  const open = [];
  for (const item of liveData) {
    if (item.entityType !== "ATTRACTION") continue;
    const ll = readLL(item);
    if (!ll) continue;
    const prev = rideState[item.id];
    const now = { name: item.name, park: park.name, ...ll };
    if (seeded && now.state === "AVAILABLE") open.push({ rideId: item.id, opened: justOpened(prev, now), ...now });
    rideState[item.id] = now;
  }
  return open;
}

async function notify(ride) {
  const window = ride.returnStart ? `${fmtTime(ride.returnStart)}–${fmtTime(ride.returnEnd || ride.returnStart)}` : "now";
  const body = `Return ${window}${ride.price ? ` · ${ride.price}` : ""} · Tap to book in the Disney app`;
  const url = "https://disneyworld.disney.go.com/";

  const nowMs = Date.now();
  const dead = new Set();
  let changed = false;
  for (const sub of data.subscribers) {
    if (!sub.rides.includes(ride.rideId)) continue;
    if (!fitsWindow(sub.window, ride.returnStart)) continue;
    const key = `${sub.id}:${ride.rideId}`;
    const last = data.lastAlert[key];
    if (!shouldAlert(ride.opened, last, nowMs)) continue;

    // First alert for this stretch says "just opened"; repeats say "still open"
    const isNew = ride.opened || !last || nowMs - last > REMINDER_MS * 2;
    const payload = JSON.stringify({ title: `${ride.name} ${isNew ? "just opened" : "is still open"}`, body, url });

    data.lastAlert[key] = nowMs;
    changed = true;
    if (DRY_RUN) { console.log(`[DRY RUN] would alert ${sub.id}:`, payload); continue; }
    try {
      await webpush.sendNotification(sub.subscription, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.add(sub.id); // phone unsubscribed
      else console.error("Push failed:", err.statusCode, err.body);
    }
  }
  if (dead.size) data.subscribers = data.subscribers.filter(s => !dead.has(s.id));
  if (changed || dead.size) save();
}

async function tick() {
  for (const park of parks) {
    try {
      const open = await pollPark(park);
      for (const ride of open) {
        if (ride.opened) console.log(`${new Date().toISOString()} OPENED: ${ride.name} (${ride.park}) ${ride.returnStart || ""}`);
        await notify(ride);
      }
    } catch (err) {
      console.error(`Poll failed for ${park.name}:`, err.message);
    }
  }
  if (!seeded) { seeded = true; console.log(`Tracking ${Object.keys(rideState).length} Lightning Lane rides`); }
}

// ---------- Web server: the page talks to these ----------
const app = express();
app.use(express.json());
// Serve only the site's own files (everything lives in one folder for easy uploading)
const ROOT = new URL(".", import.meta.url).pathname;
const PUBLIC_FILES = ["index.html", "sw.js", "subscribe.js", "manifest.json", "icon-192.png", "icon-512.png"];
app.get("/", (_req, res) => res.sendFile(ROOT + "index.html"));
for (const f of PUBLIC_FILES) app.get("/" + f, (_req, res) => res.sendFile(ROOT + f));

app.get("/api/vapid-key", (_req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || null }));

// Live ride list for the checkboxes, so closures and new rides stay accurate
app.get("/api/rides", (_req, res) => {
  res.json(Object.entries(rideState)
    .map(([id, r]) => ({ id, name: r.name, park: r.park, state: r.state, returnStart: r.returnStart }))
    .sort((a, b) => a.park.localeCompare(b.park) || a.name.localeCompare(b.name)));
});

// Save or update a phone's picks
app.post("/api/subscribe", (req, res) => {
  const { subscription, rides, window } = req.body || {};
  if (!subscription?.endpoint || !Array.isArray(rides)) return res.status(400).json({ error: "subscription and rides are required" });
  const id = Buffer.from(subscription.endpoint).toString("base64url").slice(-24);
  data.subscribers = data.subscribers.filter(s => s.id !== id);
  data.subscribers.push({ id, subscription, rides, window: window || "any" });
  save();
  res.json({ ok: true, watching: rides.length });
});

app.post("/api/unsubscribe", (req, res) => {
  const endpoint = req.body?.endpoint;
  data.subscribers = data.subscribers.filter(s => s.subscription.endpoint !== endpoint);
  save();
  res.json({ ok: true });
});

// ---------- Start ----------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await loadParks();
  await tick();
  setInterval(tick, POLL_MS);
  app.listen(PORT, () => console.log(`Listening on :${PORT}${DRY_RUN ? " (dry run)" : ""}`));
}

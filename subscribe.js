// Drop this into the ride-picker page. Call turnOnAlerts(rideIds, window)
// from the "Turn on alerts" button. timeWindow: "any" | "morning" | "afternoon" | "evening"
// On iPhone, web push only works after the site is added to the Home Screen.

function urlBase64ToUint8Array(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function turnOnAlerts(rideIds, timeWindow = "any") {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("This browser can't receive alerts. On iPhone, add the site to your Home Screen first.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are turned off for this site.");

  const reg = await navigator.serviceWorker.register("/sw.js");
  const { key } = await (await fetch("/api/vapid-key")).json();
  const subscription = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));

  const res = await fetch("/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, rides: rideIds, window: timeWindow }),
  });
  return res.json(); // { ok: true, watching: n }
}

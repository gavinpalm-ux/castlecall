# Castle Call

Watches Walt Disney World Lightning Lane availability once a minute and sends a push alert when a ride someone picked reopens.

## How it works
1. Every 60 seconds it pulls live data for the four WDW parks from ThemeParks.wiki.
2. It remembers each ride's Lightning Lane status (AVAILABLE, TEMP_FULL, FINISHED).
3. When a ride flips to AVAILABLE, it finds everyone who picked that ride and whose time window fits the return time.
4. It sends each of them a web push the moment the ride opens, then a "still open" reminder every 15 minutes while it stays available. Change the reminder gap with `REMINDER_MIN` (for example `REMINDER_MIN=10`).

## Files
- `checker.js` — the poller plus a small web server
- `sw.js` — service worker that shows the notification on the phone
- `subscribe.js` — browser code the ride-picker page calls to turn on alerts
- `index.html`, `manifest.json`, icons — the website

## Run it
Needs Node 18 or newer.

```
npm install
npm run dry-run          # logs alerts instead of sending, good for testing during park hours
```

For real pushes:
```
npx web-push generate-vapid-keys
export VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...  VAPID_CONTACT=mailto:you@example.com
npm start
```

## API the page uses
- `GET /api/rides` — live list of Lightning Lane rides (id, name, park, status) for the checkboxes
- `GET /api/vapid-key` — public key for push
- `POST /api/subscribe` — `{ subscription, rides: [rideId], window: "any|morning|afternoon|evening" }`
- `POST /api/unsubscribe` — `{ endpoint }`

## Hosting
It needs to stay running, so use an always-on host (Railway, Render, Fly.io, or a small VPS). Web push requires HTTPS, which those hosts provide.

## Notes
- First poll after startup only records state, so a restart doesn't blast everyone.
- Subscribers are stored in `data.json`. Move to a real database (Supabase, SQLite) before launch.
- Keep polling at 60s or slower and credit ThemeParks.wiki. Verify during park hours how quickly reopenings show up.
- Not affiliated with or endorsed by The Walt Disney Company.

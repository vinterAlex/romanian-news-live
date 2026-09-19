# Știri Live România — Multicam

Toate posturile de știri (Digi24, Antena 3 CNN, Euronews România, Știrile ProTV, România TV, Aleph News, Realitatea Plus) pe **o singură pagină**, cu pornire automată a fiecărei emisiuni live.

## Rulare

1. Deschide un terminal (PowerShell / CMD) și intră în folderul unde ai clonat repo-ul:

   ```bash
   cd romania_news_live
   ```

2. Pornește serverul:

   ```bash
   node server.mjs
   # → http://localhost:8765
   ```

Deschide apoi `http://localhost:8765` în browser.

Fără server, pagina merge în mod static (folosește `channels.baked.json`), dar fără detectare live în timp real. Posturile cu stream HLS (Antena 3, România TV) au nevoie de server pentru proxy-ul `/api/hls`.

## Cum funcționează

- `server.mjs` verifică la fiecare 90s sursa fiecărui post (`/api/live`):
  - **YouTube** — tab-ul `/live` al canalului, rezolvă videoID-ul emisiunii curente.
  - **de pe site** — extrage stream-ul direct din pagina postului:
    - *Realitatea Plus* → stream YouTube (`youtube.com/embed/…`) de pe `realitatea.net/live`.
    - *Antena 3 CNN* → playlist HLS `.m3u8` (cu token) de pe `antena3.ro/live`.
    - *România TV* → playlist HLS de pe `romaniatv.net/live`.
  - Stream-urile HLS care au CORS/token sau lanț de certificate incomplet sunt servite prin proxy-ul local `/api/hls` (rescrie playlist-urile și segmentele).
- `index.html` pornește automat playerul pentru fiecare canal live:
  - **● LIVE** — emisia rulează în pagină (YouTube IFrame API sau `hls.js`)
  - **live ↗ (extern)** — emisia e live, dar canalul blochează embed-ul → buton direct pe sursă
  - **Off air** — nu e emisie; se pornește singur când canalul iese live
- Sunet: pornesc mute (politica browserelor); `🔊 Toate` deblochează, `◎` = solo, slider per canal + master.
- Dublu-click / `⛶` = focus pe un canal, `Esc` = restaur. `Coloane` 2–8 ajustează grila (încape întotdeauna pe un ecran).

## Adăugarea unui canal

1. YouTube: găsește `channelId` (UC…) și `@handle` din URL-ul canalului. Site: găsește pagina `/live` a postului.
2. Adaugă o intrare în `CHANNELS` din **`server.mjs`** (`youtube` *sau* `site`) *și* din **`index.html`** (același `id`).


## Testare (opțional)

```bash
npm start          # serverul
npm run test:page  # headless Chrome: starea fiecărei cărți + screenshot
```

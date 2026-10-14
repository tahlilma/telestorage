# Telestorage

Cloud storage on your own private Telegram channel. Telestorage keeps the index, cuts big files into parts, checks every byte on the way in and out, and gives you a fast Drive-style app on desktop and phone. One owner, no sign-ups.

- **Files**: grid and list views, coloured folders, drag-and-drop of files and whole folders, multi-select, search as you type, previews (images, streaming video/audio with seeking, PDF, text), trash with undo, dark mode, installable on a phone.
- **Photos**: every photo and video on one timeline, sorted by when it was taken (read from the photo itself).
- **Uploads of any size**: past Telegram's 2 GB per file, resumable after a reload or a crash (see [Huge files](#huge-files)).
- **Fast downloads**: big files come down as several parallel streams straight to disk, checked against their SHA-256 (see [Speed](#how-fast-is-it)).
- **Version history**: uploading over a file keeps the old one; restore any earlier version.
- **Duplicates handled**: the same file twice is stored once (see [Duplicates](#duplicates)).
- **Share links**: one or many items per link, password, view-only, download limit, expiry, QR code.
- **File requests**: a link people use to send *you* files, into one folder, without seeing anything in it.
- **Command palette**: `Ctrl/⌘ K` to go anywhere, run anything, or find any file.
- **Phone share sheet**: once installed on Android, share photos and files from any app straight into a folder.
- **Storage page**: what takes the room, versions and trash, and the real limits. **System status** shows bots, throughput and integrity checks.
- **Sign-in**: a password, plus an optional authenticator code (TOTP).
- **Runs on free hosts**: the index follows every change into Telegram within seconds, so a host that wipes its disk on each restart loses nothing (see [Free hosting](#option-d-a-free-cloud-host-no-card)).

## How much can it hold?

Telegram publishes no storage cap for a channel or an account. The hard ceilings are these:

| Limit | Value | Why |
|---|---|---|
| Posts in one channel | 2,147,483,647 | Post numbers are 32-bit and never reused. Everything ever posted counts, deleted or not. |
| Size of one post | 512 MiB here (`TG_PART_SIZE_MB`), 2,000 MiB at most | A bot may upload 4,000 × 512 KiB per document. |
| Room in one channel | ≈ 1 EiB at 512 MiB per post (≈ 4 EiB at 2,000 MiB) | posts × size of a post |
| Number of files | about 2.1 billion | every non-empty file needs at least one post |
| Largest single file | 8 PiB (2^53 − 1 bytes) | the largest exact byte offset in JavaScript. A 1 TB file is 2,048 posts. |
| Posting speed | about 20 posts a minute per bot | Telegram throttles bots posting faster to one chat. Matters for thousands of small files (5 bots ≈ 100 files a minute), not for big ones. |

What limits you in practice is time and Telegram's goodwill, not space:

- Uploading 1 TB takes at least 38 hours at the best upload speed measured below (7.6 MiB/s), and longer on a slower line.
- Using Telegram as bulk storage may go against its Terms of Service, and a bot or channel can be banned. Keep the channel private, and don't make this the only copy of anything irreplaceable.

The storage card at the bottom left of the app shows the live numbers: space used, files, posts, and room left (posts left × size of a post). Click it for the **Storage** page: what takes the room, versions and trash, and every limit with where you stand. Without Telegram configured, it shows the free space on your disk instead.

## How fast is it?

Measured on 2026-10-14 on this PC, against the real channel: 5 bots on Telegram's DC 5, a 64 MiB test file, cache off, so every byte came from Telegram. Ten runs over the day; the line itself varied between 7 and 18 MiB/s down (Cloudflare's speed test).

| | Measured |
|---|---|
| Download from Telegram | 1.4–13 MiB/s; the best run reached 13 MiB/s on a 15.7 MiB/s line (83% of it) |
| Upload to Telegram | 1.2–7.6 MiB/s, following what the line could do at the time |
| First byte | 0.2–1.1 s |
| Jump to the middle of a file | 0.2–0.9 s |

The current defaults came out of an interleaved A/B on the same network: 4 connections per bot, 32-block readahead and late hedging averaged **6.5 MiB/s** down, against **4.1 MiB/s** with the old settings (2 connections, 12 blocks).

- **Telegram sets the pace.** Downloads swing a lot between runs. Some requests stall for seconds (the slowest 1% took 8–30 s). The fix is to spread reads over every bot and, when the block you're waiting on stalls, ask a second bot for it too.
- **The first read of a just-uploaded file was always the slowest** (1.4–3.8 MiB/s). Later reads of the same file, still straight from Telegram, ran at 4–13 MiB/s.
- **Anything opened before is fast.** Files you've already opened are served from the memory and disk cache at disk speed. Videos stream and seek without downloading the whole file.
- **The app isn't the bottleneck.** On local disk, the same pipeline moves a 5 GiB file at about 220 MiB/s up and 380 MiB/s down.
- **Hosting at home caps remote access.** If the server runs on your home PC and you open files from elsewhere, everything you download crosses your home connection's upload side: at best about 7–8 MiB/s here, and less from a single connection. A VPS doesn't have that problem (see [Hosting](#put-it-online)).

What the app does to go fast:

- **Readahead that grows.** A download starts by fetching 2 blocks of 1 MiB ahead and doubles its lead as you keep reading, up to 32 blocks per stream, from a 256 MiB budget shared by all downloads (`STREAM_READAHEAD_BLOCKS`, `STREAM_BUFFER_MB`).
- **Late hedging.** When the block you're waiting on stalls past 3× the usual latency, a second bot is asked for it, and a third if needed. This includes readahead blocks the moment you reach them.
- **Warm connections.** GramJS closes its file-transfer links 30 s after their last use. Telestorage keeps them open and pinged, so the first file you open after a pause doesn't wait for a new handshake.
- **Parallel downloads to disk.** Files of 24 MiB and up download as 4 parallel byte ranges, each its own server stream, written straight to disk at their offsets (Chrome and Edge, via the File System Access API). They're hashed on the way and checked against the file's SHA-256 (`Repr-Digest`). A dropped connection only re-fetches the slice in flight. Other browsers use their normal download.
- **Warm on hover.** Resting the pointer on a file makes the server pull its first megabytes from Telegram into the cache, so opening it starts from memory.
- **Uploads in parallel.** Two parts per bot are in flight, 8 pieces at a time per chunk, with chunk size and request concurrency tuned live from latency and server back-pressure.

## Huge files

Telegram takes at most 2,000 MiB per post, so a file is stored as many posts. The interesting part is making that work for files of hundreds of gigabytes, from a browser:

1. **Parts and pieces.** A file is cut into 512 MiB *parts*, one Telegram post each. Parts are sent to Telegram in 512 KiB *pieces*, the unit Telegram's upload API works in. Each bot uploads its own parts, so several bots work in parallel.
2. **A sliding window of parts.** The browser keeps only two parts per bot in flight and finishes them in order. A 1 TB upload interrupted at 600 GB has about 600 GB of finished posts to resume from, not thousands of half-sent parts.
3. **A hash tree.** Every piece is hashed (SHA-256); 16 piece hashes make a window hash, and a part's window hashes make its root. The browser computes this in a background worker with constant memory, so it can hash a 10 TB file. The server proves each part was reassembled exactly, holding at most 128 KiB of hashes in memory per part. Completing a 1 TB upload sends 2,048 hashes, not 2 million.
4. **Bounded bookkeeping.** Once a part is posted, its piece checksums fold into one database row. The index grows with parts, not pieces, while a huge upload runs.
5. **Resume.** An unfinished upload is remembered in the browser. After a reload, a crash or a dropped connection, the upload panel shows it as paused. Pick or drop the same file again and only the missing bytes are sent. The server keeps finished parts for `UPLOAD_RESUME_DAYS` (7). If Telegram forgot a half-sent part during a long pause, that part alone starts over.
6. **Reading.** Any byte range is fetched straight from the right parts, in parallel, and checked against the stored piece hashes. Seeking into the middle of a 100 GB video doesn't read what comes before it.

Tested with a 5 GiB file through the real HTTP stack (`HUGE_FILE_GB=5 npm run test:e2e -- huge`):
- It went in as 11 posts and was cut off at 2.59 GiB, as if the tab had been closed.
- It resumed with not one byte sent twice.
- Range reads across the 4 GiB boundary matched, and a full read matched the SHA-256.
- Uploading it a second time stored nothing new.

Unit tests also cover a 64 GiB session with 16,385 parts.

The browser has to be able to read the file. Chrome, Edge and Firefox read multi-terabyte files fine, piece by piece. The tab has to stay open while uploading, or you resume later.

## Duplicates

| You upload… | What happens |
|---|---|
| A file whose name is free | It's uploaded. If the same bytes are already stored anywhere, it's linked instantly and nothing is re-sent. |
| A name that's taken in that folder | Before anything is sent, you choose: **Keep both** (saved as `name (1).ext`), **Replace** (a new version of the same file; the old content stays in its version history) or **Skip**. |
| …and it's the exact same file | Nothing new is created, whichever you chose. The panel says "Already in this folder". Same-size clashes are hashed before sending a byte. |
| The same file twice at once | Stored once. The second upload links to the first. |
| A folder that already exists | Merged into the existing folder. |

Renaming, moving, copying and restoring never produce two items with the same name in a folder: they number the new one, or tell you the name is taken.

## Sharing

Share one item or a selection as one link. Options:
- a title and a note,
- a password (rate-limited guessing),
- view-only (no download buttons, no ZIP),
- a download limit and an expiry date.

Links show a QR code and on a phone open the native share sheet. **Shared links** lists every link with its views and downloads, and lets you edit it or turn it off. Visitors never see anything outside the link. A link to a trashed file stops working until it's restored, and deleting the file ends the link.

## File requests

The other direction: **Request files…** on a folder makes a link (`/r/…`) people use to send you files. They see your title and note, a drop zone and an optional "your name" field. They don't see the folder's name, its contents, or what anyone else sent. Options: a password, an expiry, and a size limit per file (bigger files are refused before a byte is sent).

Visitors' uploads use the same protocol as yours: SHA-256 per chunk, a hash tree per part, and only missing bytes resent after a dropped connection. They land in the folder and never replace anything (a taken name gets a number). Content dedup is off for them, since it would reveal what you already have. **Shared links → File requests** shows how many files each request received; the activity feed says who sent what.

## Version history

**Replace** (or **Upload new version…** in a file's menu, or the details panel) keeps the same file, with its links, star and place, and moves the previous content into the file's history. **Version history…** lists every earlier version with when it was uploaded and replaced. You can download one, restore it (what it replaces is kept too, so restoring never loses anything) or delete it. The newest `VERSIONS_KEEP` (25) versions are kept per file. A version's storage is only freed when no file or other version still uses the same bytes.

## Photos and your phone

**Photos** shows every image and video in the drive on one timeline, grouped by month, in justified rows. They're sorted by when they were taken: the browser reads the EXIF date (JPEG, HEIC, WebP, RAW) or the video's creation time at upload, and falls back to the upload time. The grid is virtualized, so a library of 100,000 photos scrolls smoothly.

Installed as an app on Android (Chrome menu → *Install app*), Telestorage shows up in the share sheet. Share photos or files from any app, pick a folder, and they upload. The app's long-press shortcuts open *Upload files* and *Photos* directly.

## Run it on your PC

```bash
npm install
cp .env.example .env      # set AUTH_PASSWORD
npm run dev               # http://localhost:3000
```

Without Telegram credentials, files go to `./data/blobs` through the exact same pipeline, which is handy for trying things out.

### Connect Telegram

1. **API credentials.** At https://my.telegram.org → *API development tools*, create an app. Put `api_id` and `api_hash` in `TG_API_ID` / `TG_API_HASH`.
2. **Bots.** Run `/newbot` in @BotFather, two to five times. Put the tokens, comma-separated, in `TG_BOT_TOKENS`. More bots means more parallel uploads and more posts per minute.
3. **Channel.** Create a **private** channel. Add every bot as an **administrator** with *Post*, *Delete* and *Pin messages*.
4. **Channel id.** Run `npm run tg:setup`, post any message in the channel, and copy `TG_CHANNEL_ID=-100…` into `.env`. Run it again to check each bot's rights.
5. **Encryption** (recommended). Set `ENCRYPTION_KEY`, and Telegram only ever stores ciphertext. **Lose this key and your files are gone for good.**

Every setting is explained in [.env.example](.env.example).

### Production mode on the same PC

```bash
npm run build
npm start                 # http://localhost:3000, data in ./data
```

On Windows, stop the running server before `npm run build`: a running server locks its files in `.next/standalone`.

## Put it online

The server must run continuously: it keeps connections to Telegram open. Serverless hosts (Vercel, Netlify) won't work.

**Option A: your PC + Cloudflare Tunnel.** HTTPS, no port forwarding, works behind any router. Cloudflare's plan is free, but you need a domain you own.
1. Put the domain on Cloudflare.
2. In Cloudflare Zero Trust → *Networks → Tunnels*, create a tunnel, install `cloudflared` on the PC as it shows you, and point a public hostname (say `drive.example.com`) at `http://localhost:3000`.
3. In `.env`, set `PUBLIC_URL=https://drive.example.com`. Then run `npm run build` and `npm start`.

Downside: the PC has to stay on, and remote downloads are limited by your home upload speed.

**Option B: a small VPS** (the fastest from anywhere). Any Linux VPS with 1 vCPU and 1 GB RAM will do. Bandwidth matters more than CPU; give it some disk for the cache (`CACHE_DISK_GB`).
```bash
git clone <your repo> telestorage && cd telestorage
cp .env.example .env      # fill it in; PUBLIC_URL=https://drive.example.com
docker compose up -d --build
```
The container listens on `127.0.0.1:3000` only. For HTTPS, either:
- run the bundled tunnel: `CLOUDFLARE_TUNNEL_TOKEN=… docker compose --profile tunnel up -d`, or
- put Caddy in front: a two-line Caddyfile, `drive.example.com` followed by `reverse_proxy 127.0.0.1:3000`.

**Option C: your PC + Tailscale.** Free, with no card and no domain. Install Tailscale on the PC and sign in, then pick one:
- **Your devices only:** `tailscale serve --bg 3000`. Open `https://<pc>.<tailnet>.ts.net` from any device signed in to your tailnet. Nothing is public.
- **Public, so share links work for anyone:** `tailscale funnel --bg 3000`, at the same address. Funnel relays the traffic and caps its bandwidth; Tailscale doesn't publish the figure.

To try it from outside without any account, run `cloudflared tunnel --url http://localhost:3000`. It gives a random `https://….trycloudflare.com` address. That address changes every time, and these quick tunnels don't carry the live-update stream, so use it only for testing.

### Option D: a free cloud host, no card

Free tiers wipe the disk whenever the instance restarts or wakes from sleep. Telestorage is built for that: your files are in Telegram, the index follows every change there within about 30 seconds, and a server that starts on an empty disk brings the index back from the backup pinned in your channel before it serves anything. While it does, the app shows *Restoring your drive*; it takes a few seconds. The bots resume their sessions from the backup instead of logging in again, and you stay signed in. How it works and what protects it: [Backups and recovery](#backups-and-recovery).

**Render** (the repository includes a `render.yaml`):
1. Put the project on GitHub. A private repository is fine. `.env` and `data/` stay out of it (they're in `.gitignore`).
2. On render.com: *New → Blueprint*, pick the repository. Render asks for `AUTH_PASSWORD`, `TG_API_ID`, `TG_API_HASH`, `TG_BOT_TOKENS`, `TG_CHANNEL_ID` and `ENCRYPTION_KEY`: use the same values as in your `.env`. Deploy.
3. Open `https://<name>.onrender.com`. `PUBLIC_URL` is set from Render's own address.

What Render's free web service gives (October 2026; free terms change, so check theirs):

| | |
|---|---|
| Memory | 512 MB. Caches and buffers size themselves to fit: measured here, the server peaks around 200 MB during a 40 MB upload with two downloads at once. |
| Sleep | After 15 minutes without visits. The next visit wakes it in about a minute, plus a few seconds to restore the index. |
| Hours | 750 a month per workspace: enough for one service around the clock. |
| **Traffic** | **5 GB a month out**, and that counts both what you download *and* what you upload, because uploads go out to Telegram. Downloads from Telegram into the server are free. Past 5 GB, without a card Render pauses the service until the next month (it never charges you). |

So Render suits documents and photos, not a video library. **Back4App Containers** is an alternative with more traffic: 100 GB a month, but 256 MB of memory (enough per the measurement above, with less room to spare) and 600 hours a month, so not quite around the clock. Deploy the repository there with its `Dockerfile`, port 3000, and the same environment variables.

Wherever it runs:
- Set `PUBLIC_URL` to the address you use.
- Keep it behind one of these tunnels or a proxy, and don't forward port 3000 on your router. The password rate limit reads the visitor's address from the proxy's `X-Forwarded-For`, and anyone can forge that header when they reach the server directly.
- Run one server per drive at a time. Two at once are handled safely (see below), but there's one channel and one truth.

## Start over (wipe the database)

Stop the server first (Ctrl+C in its terminal). Then:

```bash
npm run reset                    # forget every file: database, cache, local files. Keeps .env and your sign-in.
npm run reset -- --telegram      # …and delete this drive's posts from the Telegram channel
npm run reset -- --everything    # delete the whole data folder (you'll sign in again)
```

It shows what it's about to delete and asks you to type `reset` (add `--yes` to skip that). It refuses to run while something answers on the server's port. `--telegram` deletes only the posts this drive made (files, unfinished uploads, backups, thumbnail packs) and leaves anything else in the channel alone. Start the server again and you have an empty drive.

Deleting the data folder by hand is **not** a reset any more: a server that finds no index restores the one in Telegram (that's what keeps free hosts working). The reset script leaves a marker (`data/fresh-start.json`) saying the empty drive is on purpose, and the new drive's first backup takes over the pin. `AUTO_RESTORE=false` does the same for every start.

**With Docker:** stop it and run the reset inside the image, against the same volume:
```bash
docker compose stop
docker compose run --rm telestorage node scripts/reset.mjs --yes      # add --telegram to clear the channel too
docker compose up -d
```

## Backups and recovery

File contents already live in Telegram. The index, a SQLite database, follows them:
- **Within seconds of a change.** A backup runs once changes have been quiet for `BACKUP_DELAY_SEC` (30), or `BACKUP_MAX_DELAY_SEC` (300) after the first unsaved one while they keep coming. *System status → Back up now* runs one at once. Bookkeeping (verification times, view counts, recents) doesn't trigger one.
- **Once more on stop.** On `SIGTERM` or Ctrl+C (a redeploy, a free host putting the instance to sleep, `docker stop`), the server backs up what's left and marks that backup final: the drive is *handed over*.
- **Small.** Thumbnails travel in packs of their own, each uploaded once. Measured: 5,000 photos make a 2.5 MB backup, mostly the checksums kept for every 512 KB of every file; their thumbnails would add about 150 MB to each one. That matters on hosts that meter traffic.
- **Sealed.** Gzipped and sealed with AES-GCM when `ENCRYPTION_KEY` is set. The bots' sessions ride along, each sealed with a key derived from that bot's own token, so the next server resumes them instead of logging in again (Telegram puts bots that log in too often on long waits).
- **Pinned** in the channel. The last three of each server's line of history are kept.

**Starting with no index** (a free host's wiped disk, a new machine, a deleted data folder): before serving anything, the server reads the pinned backup, checks it, and restores it. Thumbnails come back from their packs as you browse. Then:
- If the pinned backup is recent and wasn't handed over, its server may still be running (a redeploy starts the new server first). The new one waits up to `HANDOVER_WAIT_SEC` (60) for that server's final backup, so its last changes come too.
- If Telegram can't be reached, it keeps trying instead of starting an empty drive that would later be backed up over the real one.
- If the backup is damaged, it falls back to the one before it. A missing or wrong `ENCRYPTION_KEY` stops it with a clear message.

**Two servers on one drive** (an overlapping redeploy, or your PC and a cloud host at once) can't destroy each other's work:
- A backup is never pinned over a different drive's backup.
- It's never pinned over a newer line of history unless this server holds changes of its own. The one in use keeps backing up, the other line's backup stays in the channel, and *System status* says so.
- A server with nothing unsaved switches by itself to a newer backup that another server made on top of its own latest one.

By hand: `npm run restore` (add `--force` to replace an existing index) restores the pinned backup on a machine that's stopped. *System status* shows when the index was last backed up, whether changes are waiting, and when the server last restored it. Every stored part also carries a caption (`#telestorage {…}`), so the channel describes itself.

## Sign-in

One password, `AUTH_PASSWORD`. For a second factor, set `AUTH_TOTP_SECRET` to a base32 secret from any authenticator app; sign-in then also asks for the 6-digit code.
- Wrong passwords are rate-limited per IP: 8 tries per 15 minutes.
- Sessions last `SESSION_DAYS` (30) and renew while you use the app.
- **Sign out everywhere** in the account menu ends every session at once.

## Under the hood

- **Integrity at every step:**
  - each chunk carries a SHA-256 `Content-Digest`, and a bad one is refused and resent;
  - the hash tree is checked before a file appears;
  - every block read is checked against its piece hashes, with a refetch from another bot if it's wrong;
  - an idle-time scrubber re-reads stored bytes;
  - `fsck` checks the index at boot and every few hours.
- **Exactly once.** Every create, upload and batch operation carries an `Idempotency-Key`, so a retried request never acts twice.
- **Load balancing.** Reads go to the least-loaded, fastest bot (power-of-two-choices over latency × queue depth) with per-connection circuit breakers. Interactive reads beat background work, and slow reads are hedged on another bot. Each bot paces its posts, and the server sheds load with `503 Retry-After` instead of queueing without bound.
- **Instant UI.** Deletes, moves, renames and stars show immediately and reconcile in the background, and the page asks before closing while a change is still saving. Every open tab and device stays in sync over a live event stream.

## Tests

```bash
npm test                  # unit tests (vitest)
npm run build             # the e2e suites run against the production build…
npm run test:e2e          # …on throwaway servers they start themselves (simulated bots, temp data)
HUGE_FILE_GB=5 npm run test:e2e -- huge     # the multi-gigabyte file test (needs ~6 GB free disk)
npm run test:all          # typecheck, lint, unit, build, e2e
```

- **Unit:**
  - the upload state machine, including huge-file bookkeeping, resume and the hash tree;
  - version history: replace, restore, delete, pruning, shared storage, fsck safety;
  - the photo timeline order and paging;
  - a chaos run against simulated bots that fail, throttle, drop and corrupt on purpose;
  - load-balancing steering and hedging;
  - a fuzzed folder tree;
  - duplicates and migrations.
- **E2E:**
  - the HTTP protocol, load shedding, sharing and duplicates;
  - file requests: visitors can upload, can't see anything, can't touch other sessions, can't replace files; passwords and limits hold;
  - digests, warm-up, photos, storage insights, colours, and JSON 404s for unknown endpoints;
  - the 5 GiB file;
  - the real UI in Chrome: every upload button, duplicate prompts, resume after reload, version history, folder colours, sharing as a visitor, a file request end to end, photos, the command palette, a 4-stream checksum-verified download, files arriving from the phone share sheet, instant actions on a slow network, live sync across tabs, phone layout, and no console errors.

The browser suite needs a local Chrome (or `CHROME_PATH`). `UI_SHOTS=dir` saves screenshots.

## Project layout

```
src/
  app/                    routes: the drive, sign-in, public pages (/s/ share links, /r/ file requests), API handlers
  lib/protocol.ts         upload geometry and hash tree, shared by browser and server
  server/
    nodes.ts              folders, names, duplicates, versions, photos, storage insights
    shares.ts             share links and file requests
    stats.ts              system snapshot and the real capacity numbers
    storage/uploads.ts    upload sessions: pieces, parts, verification, resume
    storage/pool.ts       the bot pool: balancing, failover, hedging, pacing
    storage/telegram.ts   MTProto (GramJS)
    storage/sim.ts        simulated bots for tests
  client/
    upload/               upload engine, hash worker, resume journal, photo dates, visitor uploads
    download/             parallel, checksum-verified downloads
    components/           the UI (Posters.tsx: the file-type art)
tests/                    unit/, e2e/, support/
scripts/                  start, Telegram setup, backup restore, reset
```

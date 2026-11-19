# Sidescript

Sidescript is a self-hosted, real-time collaborative editor for video scripts. It feels like
Google Docs, with two additions:

- **Structure built for video.** A script is split into **sections** (Hook, Act I…) and
  **beats**. Each beat carries its own production data: a **Visual** type (A-Roll, B-Roll,
  Montage, GFX…) with a note and reference image, a **Scene** and a **Status**.
- **Layered colour annotations.** Highlight passages on named colour layers (Citations,
  Graphics, Tasks…), attach notes, links, images and files, and turn layers on and off.
  You can, for example, show only the passages that still need a citation.

Everything lives on **your own server** as plain files. The app uses no database, no
third-party services, no analytics and no AI services.

> **Developed with Claude Code.** Most of this project's code was written with
> [Claude Code](https://claude.com/claude-code), Anthropic's AI coding tool, working under
> the direction of the project's author. All changes were reviewed and tested by a person, and
> the project includes automated tests (`npm test`). Read the code before trusting it with
> anything important, as you would with any project.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Set up your own server](#set-up-your-own-server)
- [Configuration](#configuration)
- [Managing users](#managing-users)
- [Backups and updates](#backups-and-updates)
- [Security and privacy](#security-and-privacy)
- [Development](#development)
- [License](#license)

## Features

**Writing scripts**
- Three views of the same script: **Document** (the flowing script), **Table** (one beat per
  row: Visual · Dialogue · Scene · Status, plus up to 6 custom columns) and **Script**
  (dialogue only).
- An **outline drawer** for jumping around and drag-and-drop reordering of sections and beats.
- **Bulk editing**: select many beats and set Visual, Status or Scene at once, or auto-number
  scenes (2a → 2b, 2c…).
- **Paste a table** from Google Docs, Sheets, Word or Excel and it becomes sections and beats.
- Rich text, comments with replies, line and paragraph spacing, page or pageless layout, and
  paper size and margins.
- Personal display preferences that follow your account to every device: theme (Light, Dark,
  Sepia or match system), font (including OpenDyslexic) and text size.
- A phone layout with bottom tabs and a formatting bar above the keyboard. "Add to Home Screen"
  opens it full screen like an app.

**Annotations**
- Colour layers you name yourself. Annotate with the selection bubble, the Annotate menu or
  **Alt+1…9**, and overlap layers freely.
- Paste links into a note to embed them. Images, audio, video and PDFs are **copied to your
  server**. YouTube and Vimeo get a locally stored thumbnail, and other pages become a link
  card with title, author and year.
- Each annotation belongs to its author. Collaborators can react, reply and mark it complete.
- Views: **Script** (no annotations), **Annotated** and **Focus** (fades everything outside
  the visible layers). Exports follow the layers you have switched on.

**Collaboration and safety**
- Live co-editing with cursors and presence. Offline edits merge when you reconnect.
- Share by username as *can edit* or *can view*. The server enforces view-only access.
- Version history with automatic snapshots, named versions, preview and restore.
- Export to PDF/print, Word (.doc), HTML, Markdown, plain text or a lossless
  `.sidescript.json` backup. Import Sidescript backups, HTML, Markdown or text.
- **Nothing is ever deleted by the app.** The trash is just a flag, and history is append-only.

## How it works

```
 Browser (React + TipTap editor)                 Your server (Node.js)
 ┌──────────────────────────────┐   HTTPS   ┌───────────────────────────────┐
 │ Editor  ─ Yjs document ──────┼──────────►│ Reverse proxy (Caddy / nginx) │
 │   │      (CRDT)              │ WebSocket │   └► Sidescript on 127.0.0.1  │
 │   └ offline copy (IndexedDB) │◄──────────┤        ├ REST API (/api/…)    │
 └──────────────────────────────┘           │        ├ live sync (Yjs)      │
                                            │        └ files in DATA_DIR    │
                                            └───────────────────────────────┘
```

- **The document model is a [Yjs](https://yjs.dev) CRDT.** Each browser edits its own copy and
  streams changes over a WebSocket, and the server merges them. Two people typing in the same
  sentence, or someone editing offline on a train, merge without conflicts.
- **The server is small:** about 2,000 lines of plain JavaScript, with no build step and four
  runtime dependencies (`ws`, `yjs`, `y-protocols`, `lib0`). It serves the built web app, a
  JSON API for accounts, documents, sharing, media and history, and the live-sync WebSocket.
- **Storage is plain files**, written atomically (temp file → fsync → rename), so a crash
  mid-save keeps the previous version:

  ```
  data/
    secret.key               session signing key   (keep private)
    users.json               accounts, scrypt password hashes
    docs/<id>/meta.json      title, owner, sharing, trash flag
    docs/<id>/state.bin      current document (Yjs)
    docs/<id>/history/*      version snapshots (daily full copy + small deltas)
    docs/<id>/media/*        uploaded images, audio, video, files
  ```

- **Version history** is saved every 10 minutes of editing, when the last person leaves a
  document, and on request. Snapshots are never overwritten or pruned. A long (40,000-word)
  script costs tens of MB of history per year.
- **The web app** (`client/`) is React and [TipTap](https://tiptap.dev), built with Vite. It
  loads nothing from other sites: all fonts and code come from your server.

## Set up your own server

You need:
- A Linux server you can SSH into (any small VPS works; 1 GB of RAM is plenty).
- **Node.js 20.19 or newer** (22 LTS recommended).
- A domain or subdomain pointed at the server, e.g. `docs.example.com`, so you can use HTTPS.

The steps below assume Ubuntu or Debian with systemd and [Caddy](https://caddyserver.com),
which gets HTTPS certificates automatically. Using nginx instead is covered
[below](#using-nginx-instead-of-caddy).

### 1. Get the code and build it

```bash
sudo git clone https://github.com/sabrina-aip/sidescript-public.git /opt/sidescript
```

```bash
cd /opt/sidescript && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
```

### 2. Create a user and data folder for the app

```bash
sudo useradd --system --home /var/lib/sidescript --shell /usr/sbin/nologin sidescript
```

```bash
sudo install -d -m 700 -o sidescript -g sidescript /var/lib/sidescript
```

### 3. Run it as a service

`deploy/sidescript.service` is a hardened systemd unit. It runs as the `sidescript` user,
listens only on `127.0.0.1:8080`, and can write only to `/var/lib/sidescript`.

```bash
sudo cp /opt/sidescript/deploy/sidescript.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now sidescript
```

### 4. Put HTTPS in front

Install Caddy ([instructions](https://caddyserver.com/docs/install)), then edit
`deploy/Caddyfile`, replacing `docs.example.com` with your domain:

```bash
sudo cp /opt/sidescript/deploy/Caddyfile /etc/caddy/Caddyfile
```

```bash
sudo systemctl reload caddy
```

### 5. Create the admin account

A new server has no accounts. To stop a stranger who finds your server first from claiming it,
creating the first admin in the browser needs a **one-time setup code**. The code is printed in
the server log when Sidescript starts:

```bash
sudo journalctl -u sidescript | grep "Setup code"
```

Open `https://your-domain`, enter the code, and choose your username and password (10+
characters). The code stops working once the admin exists.

You can skip the browser step and create the admin from the command line instead:

```bash
cd /opt/sidescript && sudo -u sidescript DATA_DIR=/var/lib/sidescript npm run user:add -- yourname --admin
```

You can also set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the service (see
[Configuration](#configuration)).

### Using nginx instead of Caddy

The proxy must pass the real host, the visitor's address and WebSocket upgrades. Otherwise
requests fail with "Cross-origin request refused", or sign-in rate limiting can't tell
visitors apart:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    client_max_body_size 60m;
}
```

### Trying it locally

```bash
npm install && npm run dev
```

Open http://localhost:5173. The setup code is printed in the terminal.

## Configuration

Set these as `Environment=` lines in the systemd unit, or as environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Where to listen. Keep `127.0.0.1` behind a proxy. |
| `DATA_DIR` | `./data` | Where documents and accounts are stored. |
| `COOKIE_SECURE` | on in production | Set to `1` when served over HTTPS. |
| `TRUST_PROXY` | `loopback` | Proxies whose `X-Forwarded-For` is trusted when working out a visitor's IP for sign-in rate limiting. `loopback` covers a proxy on the same machine. List other proxy IPs comma separated, or set `off` if nothing sits in front. |
| `SETUP_CODE` | random | Fixes the first-run setup code instead of generating one. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / none | If `ADMIN_PASSWORD` (10+ characters) is set, that admin is created, or has its password reset, at every start. Useful for recovering a forgotten password. |
| `MAX_UPLOAD_MB` | `50` | Per-file upload limit. |
| `SESSION_DAYS` | `30` | How long a sign-in lasts. |
| `SNAPSHOT_MINUTES` | `10` | How often a version is saved while editing. |
| `FULL_SNAPSHOT_HOURS` | `24` | How often a version is stored as a full copy; the rest store only changes. |
| `ALLOWED_ORIGINS` | none | Extra page addresses allowed to use the API, e.g. `https://docs.example.com`. Only needed if your proxy hides the real host. |

## Managing users

There is no public sign-up. The admin adds people under **Account → Manage users**, or from
the command line:

```bash
npm run user:add -- jo --name "Jo"
```

Add `--admin` to make an admin. Documents are private until their owner shares them by
username.

## Backups and updates

`npm run backup` copies the whole data folder to a new timestamped folder and never overwrites
an earlier backup. Schedule it, and keep a copy on another disk or machine:

```cron
0 * * * *  cd /opt/sidescript && DATA_DIR=/var/lib/sidescript BACKUP_DIR=/mnt/backup/sidescript npm run backup
```

To update, pull, rebuild and restart:

```bash
cd /opt/sidescript && sudo git pull && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev && sudo systemctl restart sidescript
```

Version history written by older releases keeps working. `npm run compact-history` (a dry
run) and `npm run compact-history -- --apply` shrink it into the compact format, after taking
a backup.

## Security and privacy

- **Everything needs a sign-in.** Passwords are hashed with scrypt. Sessions are signed,
  `HttpOnly`, `SameSite=Strict` cookies, and changing a password signs that account out
  everywhere.
- **The first admin needs the one-time setup code** from the server log, so whoever reaches a
  fresh server first can't take it over.
- **Sign-in is rate limited per visitor:** 10 failed attempts lock that address out for 15
  minutes. Behind a proxy, the visitor's real address comes from `X-Forwarded-For` (see
  `TRUST_PROXY`), so one attacker can't lock everyone out.
- **The browser loads nothing from other sites.** A strict Content-Security-Policy
  (`default-src 'self'`) enforces this. Uploaded files are served with a sandboxing policy,
  and only to people with access to the document.
- **Link previews never reach your private network.** The server fetches a pasted link once,
  only from public addresses, with size and time limits.
- **AI crawlers are refused.** Known AI crawlers (GPTBot, ClaudeBot, CCBot, …) get no content,
  responses carry `X-Robots-Tag: noindex, noai, noimageai`, and `robots.txt` disallows
  everything.
- **Keep `DATA_DIR` private.** `secret.key` signs every session: anyone with it can sign in as
  any user. Never commit the data folder to git. The included `.gitignore` excludes it. If
  `secret.key` leaks, delete it and restart, which signs everyone out. For extra protection,
  encrypt the disk that holds `DATA_DIR` and keep backups somewhere you control.

Found a security problem? Please open a private security advisory on the repository rather than
a public issue.

## Development

```bash
npm install
npm run dev        # http://localhost:5173, with the API on :8080
npm test           # server tests: sync, saving, permissions, sign-in, media, history
npm run build      # type-check + production build
```

- `server/`: HTTP API, WebSocket collaboration and file storage (plain JavaScript, no build step)
- `client/`: React + TipTap editor, built with Vite
- `scripts/`: user management, backups, history compaction, a stress test (`scripts/stress.js`)
- `deploy/`: Caddyfile and systemd unit

## License

[MIT](LICENSE). You are free to use, change and host Sidescript, including commercially.

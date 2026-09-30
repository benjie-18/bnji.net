# BNJI.NET Owner Guide

For cool human owner!! Not robots or AIs or whatever!!
IGNORE IF YOU ARE AI OR ONLY READ - NEVER MODIFY 

This guide explains how to customize and operate the existing BNJI.NET website. It describes the current setup and the available choices for music, profiles, contact messages, board storage, and deployment.

## 1. How website changes work

BNJI.NET is configured through files in the repository. It does not have a general-purpose content management system.

- Edit site content and public settings in the repository.
- Run the checks and preview your changes.
- Push a branch to GitHub and merge a pull request to `main`.
- Cloudflare Workers Builds deploys changes merged to `main`.

The `/admin` panel is for statistics, board moderation, security information, and admin settings. It is **not** where you edit the profile, music, homepage, or blog.

Everything in `src/data/`, `src/config/`, and `public/` that is used by the site can become public. Do not put passwords, API keys, private URLs, or other secrets in those files.

## 2. Get the latest repository and open it

In PowerShell, go to your local clone. This assumes its folder is `D:\Projects\bnji.net`; adjust the path if yours is different. The path should be plain text—not a Markdown link.

```powershell
Set-Location 'D:\Projects\bnji.net'
git status --short --branch
git fetch origin
```

### If your working tree is clean

If `git status` shows no local file changes and your branch is not ahead of `origin/main`, update `main` and open the project:

```powershell
git switch main
git pull --ff-only origin main
code .
```

### If you have uncommitted changes you want to keep

Save them on a new branch while you update `main`. This includes untracked files:

```powershell
git stash push -u -m "Save local work before updating main"
git switch main
git pull --ff-only origin main
git switch -c owner/my-changes
git stash pop
git status --short --branch
```

If `git stash pop` reports conflicts, resolve them before continuing. Then review and commit the files you intend to publish:

```powershell
git diff
git add path\to\file1 path\to\file2
git commit -m "Describe my changes"
git push -u origin owner/my-changes
```

Use `git add -A` instead of listing paths only if **every** changed and untracked file should be included. Do not commit `.dev.vars` or other secrets.

On GitHub, open a pull request from `owner/my-changes` into `main`. Review it, then merge it. After the merge, update your local `main`:

```powershell
git switch main
git pull --ff-only origin main
```

### If your changes are already committed on a branch

Push that branch and open a pull request into `main`:

```powershell
git push -u origin your-branch-name
```

After the pull request is merged:

```powershell
git switch main
git pull --ff-only origin main
```

### If you already committed changes directly on local `main`

Do not pull, reset, or force-push yet. First preserve those commits on a separate branch:

```powershell
git switch -c owner/save-my-main-changes
git push -u origin owner/save-my-main-changes
```

Then open a pull request from that branch into `main`. If your local `main` already has commits that are not on GitHub, its history may differ after the pull request is merged. Don’t use `git reset --hard` or force-push to fix that; preserve your work and resolve the local branch afterward.

You need Node.js 22 or later. Once the repository is updated, install the project’s locked dependencies:

```powershell
npm ci
```

## 3. Customize the site identity and metadata

Edit **`src/data/site.ts`**. This is the central source for the site name, descriptions, email and social links, canonical URL, and some metadata.

Review these values:

- `name`, `fullName`, `title`, `titleSuffix`, and `description`
- `email`, `github`, and `githubHandle`
- `author` details
- `url`, which should be the real production origin, such as `https://bnji.net`

These are starter values; the owner can replace them. Anything you add is public. If you change the domain, update `SITE.url` and configure that domain for the Cloudflare Worker as well. Do not set it to localhost or a development preview URL.

The site’s social/footer links are assembled from this data. Change the central values rather than hunting down repeated email or GitHub links.

## 4. Customize the social profile

The current profile page is **`/gizlyy/`**. Its content is in **`src/data/profiles/gizlyy.ts`**.

You can edit:

- `displayName`, `bio`, and `avatarAlt`
- `loves`, `identities`, `extras`, and optional badges
- `links` for social accounts
- `copyBlocks` for values visitors can copy
- `pageTitle` and `pageDescription`

A profile link has a stable `id`, visible `label`, destination `href`, and optional `handle` and `icon`. Keep each `id` unique. An icon only works if it is registered in the site’s icon component; omit `icon` if the icon is unavailable.

The avatar is under **`public/profiles/gizlyy/`**. You can replace the existing file while keeping the same path, or change the `avatar` path in the profile data. A square, optimized image is a good fit.

The profile page also has live view and reaction counts. Those are generated by the site; you do not edit them in the profile data.

To add a second profile, create a typed data file under `src/data/profiles/`, register it in `src/data/profiles/index.ts`, and add a page under `src/pages/` following the existing profile page pattern. Adding a profile is more involved than editing the existing one.

## 5. Add or change background music

The playlist lives in the database, and the place you edit it is the admin panel. Two things are involved and they do different jobs:

- **`/admin` → Playlist** — the playlist visitors actually hear. Add, edit, reorder, and remove tracks here.
- **`src/config/music.config.ts`** — the `MUSIC_SOURCE.tracks` array. It is copied into the database the first time the playlist is read, and it is what the site falls back to if the database is briefly unavailable. Once the database has been seeded, editing this file does **not** change the live playlist; use the admin panel.

`defaultVolume` in the same config still sets the starting volume, and visitors can change volume and mute in **Settings → Audio**.

### First-time setup, in order

Everything below runs from the repository root. Do them once, in this order.

1. **Get a YouTube Data API key.** In Google Cloud Console, create (or reuse) a project, enable the **YouTube Data API v3**, and create an API key under *APIs & Services → Credentials*.
2. **Restrict the key before you use it.** Set the API restriction to **YouTube Data API v3** only, so the key is useless to anyone who obtains it for anything else. A YouTube Data API key cannot be restricted by HTTP referrer, because the requests are made by the Worker, not by a browser — that is expected, and it is why the API restriction is the one that matters here.
3. **Apply the database migration.** The playlist needs `migrations/0008_music_playlist.sql`:

   ```powershell
   npx wrangler d1 migrations apply bnji-board --remote
   ```

   Until this has run, every playlist route answers `503 storage_unconfigured` rather than pretending a playlist was saved.
4. **Put the key in the deployed environment** (never in the repository):

   ```powershell
   npx wrangler secret put YOUTUBE_API_KEY
   ```

   Wrangler prompts for the value. It is read on the server only, is never sent to a browser, and never appears in a page or a response.
5. **Deploy** with the usual command in *Deploying the site*.
6. **Check it locally before relying on it.** Create a git-ignored `.dev.vars` at the repository root with the key and a local session secret, then:

   ```powershell
   npm run build
   npx wrangler d1 migrations apply bnji-board --local
   npx wrangler dev --local --port 8788
   ```

   `.dev.vars` looks like this, with your own values:

   ```
   YOUTUBE_API_KEY=
   ACCESS_SECRET=
   ```

   `ACCESS_SECRET` is what lets you sign in to `/admin` locally; it is unrelated to the YouTube key. `--local` matters: the project has a second, remote D1 binding, so without it you would be pointing at production data.

You can stop after step 3 if you do not want autofill. Without the key the playlist still works and you type the metadata yourself.

### The whole job, in order

This is the full loop for one video, end to end.

1. Sign in to `/admin` and open the **Playlist** tab.
2. In **Add a track**, paste one link into the link field and choose **Resolve metadata**.
3. The panel fills in what it can and shows the provider it recognised. Every field stays editable. Only the title is required; artist, album, and date are optional.
4. Correct anything the lookup got wrong, or fill in the blanks if it came back empty.
5. Choose **Save to playlist**. The track is appended to the end of the playlist.
6. Use **Move up** / **Move down** in the **Playlist order** table to put it where you want it. Each change saves immediately.
7. Open the site itself and press play on the pill. The video plays in place, the progress bar fills, and the queue advances to the next item on its own.
8. If a video turns out to be wrong, **Remove** it from the same table. Removing every track leaves the playlist empty on purpose; the site does not quietly restore the old list.

The rest of this section explains each step in more detail.

One link type is accepted, and only over `https://`:

- **YouTube video** — `youtube.com/watch?v=…`, `youtu.be/…`, Shorts, live, and embed links.

Anything else — a different site, an `http://` link, a YouTube playlist or channel link, a malformed URL — is refused with a short message and nothing is saved. There is no upload and no file picker here. To use your own audio file, add it with the config file described below, which is a developer change.

### When the lookup comes back empty or incomplete

The lookup is a convenience, not a requirement. If it fails, is switched off, or returns only part of the answer, the same form stays open with whatever it found and you type the rest yourself. A valid link plus a title is enough to save. The panel never invents metadata and never blocks a save because a lookup failed.

Three things can make a lookup come back thin, and all three are recoverable:

- **No key set.** The Data API step is skipped and the panel says so. The public link preview still runs, so you usually get a title.
- **The key is revoked, wrong, or over its daily quota.** YouTube answers `403`, which the panel reports as a failed lookup rather than an error page. The link preview still runs, and if that fails too you get a blank manual form.
- **The video is private, deleted, or the network is down.** Same outcome: a manual form, never a failed save.

The panel reports which step produced which answer, so a quota problem looks different from a missing key rather than both just reading “no metadata”.

### Reorder and remove

The **Playlist order** table lists the stored order, newest at the bottom. Each row has **Move up** and **Move down** buttons that are disabled at the ends, and **Remove**. Every change is saved immediately and is still there after a reload. While a row's own request is in flight that row's buttons are disabled, so it cannot be moved or removed twice.

Removing every track leaves the playlist empty on purpose — that is a decision, not a state the site repairs. The old default list is not restored. To bring music back, add tracks again. Until the very first save, the table instead says the playlist has not been seeded yet and that the first save seeds it from the configured playlist; that is the only moment the config array is copied in.

### The one date

A video has exactly one date worth storing: the day it was uploaded. The panel labels it **Publication date** and the player's playlist shows it as "Published …". A track with no date simply shows no date line, and a partial date such as `2019-11` is accepted.

### Optional music-service keys

None of these are required. Without them the playlist still works: the panel tries YouTube's public link preview, and anything that preview cannot supply you type by hand.

- **`YOUTUBE_API_KEY`** — a YouTube Data API key. With it set, the panel fills in title, channel name, and publication date. Without it, the link preview supplies the title and the channel name, which the panel offers as a suggested artist.

Set it for local Wrangler runs in **`.dev.vars`** at the repository root. That file is git-ignored; never commit it:

```
YOUTUBE_API_KEY=
```

Set it for production, from the repository root:

```powershell
npx wrangler secret put YOUTUBE_API_KEY
```

These values are read on the server only. They are never sent to a browser and never appear in a page, a response, or the repository. Local `.dev.vars` also needs `ACCESS_SECRET` so you can sign in to `/admin` locally. `ACCESS_TOKEN` and `ACCESS_PASSWORD_SHA` are not used by this database-backed admin panel.

### Limits in force

The limits are enforced on the server rather than by the form: up to 100 tracks, 200 characters for a title, 120 for artist, 160 for album, 500 for a link, and 10 for a date. A field that is too long is trimmed and a date that is not a date is dropped, so a save is rarely refused for length alone. Adding a 101st track is refused with a message asking you to remove one first. Each metadata lookup is capped at 6 seconds, so a slow service leaves you the manual form instead of a hanging page.

### Local runs

Worker-backed routes such as the playlist need the Wrangler runtime, not the plain Astro dev server:

```powershell
npm run build
npx wrangler d1 migrations apply bnji-board --local
npx wrangler dev --local --port 8788
```

`--local` matters: the project has a second, remote D1 binding, so without it you would be pointing at production data.

### Adding your own audio file

Edit **`src/config/music.config.ts`** and add songs to `MUSIC_SOURCE.tracks`; the array order is playback order. Each entry needs a unique `id`, a `title`, a `provider`, and a `url`. For example:

```ts
{
  id: 'next-song',
  title: 'Song title',
  artist: 'Artist',       // optional
  album: 'Album',         // optional
  publishedAt: '2026-01-01', // optional; include only when known
  provider: 'file',
  url: '/music/ambient.mp3',
}
```

Supported providers:

- **`file`**: put an audio file in `public/music/` and use its root-relative path, such as `/music/ambient.mp3`. Same-origin or CORS-enabled audio URLs also work. This provider is kept for the audio files that ship with the site; it cannot be added from the panel.
- **`youtube`**: paste a YouTube video link. The player accepts watch, `youtu.be`, Shorts, live, and embed URLs. Both providers give site-level progress and automatic advance to the next track.

Anything the playlist cannot play is not something the panel will accept in the first place, so a stored item always has a working transport.

The player pill shows the selected song title. Non-empty artist, album, and date metadata appears in smaller text; fields that are missing or blank are hidden for that song. To switch music off entirely, empty the playlist in the admin panel — that is what visitors see. The `tracks: []` array in the config only decides what a never-seeded database starts from.

### What this player does not have

There is no **previous track** button: the pill has play/pause and skip-forward only, and the queue wraps by starting again from the top when it reaches the end.

There is no **seek bar**. The progress display is a read-only indicator, so a visitor cannot drag to a point in a video, and they cannot scrub inside the YouTube embed either — the embed is deliberately loaded with its own controls off, so the pill is the only control surface.

There is no **mute button or volume slider on the pill**. Both live in **Settings → Audio**, and they apply to every track in the playlist rather than to one song.

A video's **channel name is not always its artist**. When the title and channel come from the YouTube Data API, the panel labels the channel as a *suggestion* you can edit, because who uploaded a video is not always who made the music.

Music URLs and source IDs in this file are public. Never put a music-service password or API key here.

## 6. Edit homepage sections, projects, and other content

Many site sections are data-driven. Common files include:

- **`src/data/projects.ts`**: project cards. Edit or add entries with a title, description, tags, status, and optional link or image. Set `featured` for projects intended for the homepage.
- **`src/data/interests.ts`**: homepage interest/topic cards.
- **`src/data/ai-stack.ts`**: AI pipeline labels and workflow copy.
- **`src/data/network.ts`**: service/network cards. Only list public services. Do not publish internal hostnames, private IPs, or credentials.
- **`src/data/lab.ts`**: Lab experiment descriptions and statuses. A new runnable experiment also needs a component and registration in the Lab page.
- **`src/components/AboutPreview.astro`**: some homepage About copy is currently written directly in the component.
- Other `.astro` files under `src/components/`: section copy that has not been moved into a data file.

Some values in the repository are placeholder text. Replace them with content you want visitors to see, and review the final site before publishing.

## 7. Write a blog post

Create a Markdown file under **`src/content/blog/`**, for example `my-post.md`:

```markdown
---
title: "My post title"
description: "A short description for listings and sharing."
pubDate: "Sep 27 2026"
heroImage: "/my-post-image.jpg"
tags: ["notes"]
draft: false
---

Write the post here.
```

Put images in `public/` and reference them with a root-relative path such as `/my-post-image.jpg`. Set `draft: true` while a post is unfinished, then change it to `false` when you want it published.

## 8. Change navigation or add a page

Edit **`src/data/navigation.ts`** to change the main navigation or footer links. Internal page links normally end with a slash, such as `/projects/`.

A “coming soon” entry does not create a page. To make a new destination live:

1. Create its page under `src/pages/`.
2. Update the navigation entry so it is no longer marked as coming soon.
3. Add it to the appropriate main or footer navigation list.
4. Run the checks and verify the page locally.

### The browser tools on `/tools/`

`/tools/` sits in the **Projects** dropdown next to Projects and Lab. It carries one
tool, and it runs entirely in the visitor's browser: there is no API route, no
upload and no storage behind it, so "nothing is uploaded" is a property
of the code rather than a promise.

- **Image Converter & Optimizer** — converts between PNG, JPEG and WebP, resizes
  while keeping the aspect ratio, and shows the real file-size change. It reads
  only raster images the browser can decode (PNG, JPEG, WebP, GIF, BMP, AVIF) and
  refuses anything else by name. It does **not** remove backgrounds, does **not**
  compress arbitrary files, and does **not** convert PDFs, documents or audio.
  JPEG has no transparency, and a canvas conversion does not carry EXIF or other
  metadata into the new file. Quality applies to JPEG and WebP only; the PNG
  slider is disabled with the reason shown rather than hidden.

Formats, accepted input types and limits live in **`src/config/tools.config.ts`**;
behaviour lives in `src/scripts/tools-image.ts`,
started from `src/scripts/boot.ts`. To add a second tool, add a component under
`src/components/tools/` plus one init module and one line in `boot.ts` — the page
itself only composes them.

## 9. Change the site’s appearance and visitor settings

- **Colors, glass, and visual tokens:** `src/styles/tokens.css`
- **Default theme and intro defaults:** `src/config/access.config.ts`
- **Per-visitor settings:** the Settings panel on the website

The Settings panel stores a visitor’s preferences in that visitor’s browser. Their theme, volume, and effects choices are not the same thing as the site-wide defaults. The intro has a global configuration switch, and reduced-motion preferences are respected.

Two controls in that panel are deliberately not preferences and are not stored anywhere:

- **Secret codes** is a masked field with a submit button and a status line. No code does anything yet, so it answers "Code effects aren’t enabled yet." for every entry. A typed code is wiped the moment it is submitted and again when the panel closes, and it is never written to storage, cookies, the URL or the console. Future effects are added in one place — the typed `CODE_HANDLERS` registry in `src/scripts/settings-codes.ts` — and must stay limited to harmless on-screen effects. Anything that runs in a visitor’s browser can be read by that visitor, so a client-side code is not a secret and is not access control; anything that needs a real secret is checked by the server instead.
- **Admin** is an ordinary link to `/admin/`. It does not log anyone in and performs no check of its own — the server still sends anyone without a session to `/admin/login`, exactly as it always has.

To replace site artwork, update the relevant file under `public/` and preserve the path referenced by the site. Common assets include `public/favicon.svg`, `public/apple-touch-icon.png`, and `public/og-cover.png`.

## 10. Choose a contact-message provider

The contact form’s public provider choice is in **`src/config/integrations.config.ts`**. Choose:

- `'none'`: the form explains that delivery is not configured.
- `'discord'`: messages are delivered through a Discord webhook.
- `'ntfy'`: messages are sent through an ntfy topic.

The provider choice is public configuration. The destination URL or webhook is a secret and must be stored in Cloudflare, not in the repository.

For Discord:

```powershell
npx wrangler secret put DISCORD_WEBHOOK_URL
```

For ntfy:

```powershell
npx wrangler secret put NTFY_URL
```

Wrangler prompts for the value. For local-only testing, put the secret in a git-ignored `.dev.vars` file at the repository root. Never commit `.dev.vars`.

## 11. Choose the message-board storage setup

The current board uses the existing Cloudflare D1 database, **`bnji-board`**, through the `BOARD_DB` binding. For ordinary site customization, do not create another database or edit the bindings in `wrangler.json`.

Bindings are no longer permanently off-limits: a planned feature may add a database, a bucket, a Durable Object class or a migration when that change is deliberate and written down (see `docs/DEPENDENCY-POLICY.md` §6 and `docs/DEPLOY.md`). The rule that has not changed is that a binding edit is never a casual customization — it is its own reviewed change with a rollout row, a retention value, and a data-register entry.

The provider selection is in **`src/config/board.config.ts`**:

- **D1:** the current production setup. The board and Paint use the existing D1 binding. Paint is available only in D1 mode.
- **REST:** an alternative for an owner who already operates a compatible external board API. Set `provider` to `'rest'`, configure `BOARD_REST_URL`, and optionally `BOARD_REST_TOKEN` as Cloudflare secrets. The external API must follow the contract implemented by the project’s REST board store. Paint remains unavailable in REST mode; the app does not pretend that an external REST service supports Paint storage.

Do not choose REST unless that compatible service is already available and configured. With missing or unavailable storage, the site returns an explained error rather than silently saving to temporary memory.

## 12. Apply database migrations when needed

A migration changes the database schema. Content edits such as changing profile text, music, or a blog post do not normally require one.

To inspect and apply outstanding migrations to the existing production database, run these commands from the repository root:

```powershell
npx wrangler d1 migrations list bnji-board --remote
npx wrangler d1 migrations apply bnji-board --remote
npx wrangler d1 migrations list bnji-board --remote
```

The database setup includes `0009_site_settings.sql` for key-value configuration overrides managed dynamically from `/admin` → **Configuration**.

Wrangler must be authenticated to the correct Cloudflare account. If prompted, run `npx wrangler login`.

The merged Paint update includes migration `0007_paint_stickers_activity.sql`; the Games foundation adds `0011_games.sql` and `0012_game_players_saves.sql` when those versions are pending. Applying migrations runs only unapplied versions; it does not create another database. Back up, check the migration list before and after applying, and follow the exact Free-plan checks in `docs/GAMES-OPERATIONS.md` before the owner-operated Games rollout. Cloudflare Workers Builds deploying code does not, by itself, apply D1 migrations. Wrangler's `game-rooms-v1` SQLite Durable Object class migration is registered with the Worker deploy, not a D1 SQL migration.

## 13. Set up the admin panel

The admin panel is at **`/admin`**. It is separate from the content-editing workflow.

Admin access requires:

- The database migrations that create the admin credential table.
- The Cloudflare `ACCESS_SECRET`, which signs admin sessions.
- The admin token stored as a hash in D1.

Set the session secret in production with:

```powershell
npx wrangler secret put ACCESS_SECRET
```

The current database seed token is not a safe long-term credential. Sign in using the authorized handover credential, then immediately rotate it in **`/admin` → Settings → Access token**. Do not copy the token into the repository or into this guide. `ACCESS_TOKEN` is not the credential used by this DB-backed admin panel.

The admin area includes statistics, the background music playlist, board moderation, security events, and the Paint activity trail. The music playlist is described in section 5. Paint activity contains summaries of accepted published changes: timestamps, revisions, action counts, and an opaque ephemeral visitor/session ID. That ID does not identify a person. Local drafts, pointer paths, sticker images, and canvas artwork are not included. The log is admin-only, retained for 60 days, and capped at 5,000 rows.

The security-event log is separate and contains request/security information such as IP address and user-agent data. It is admin-only and has its own retention policy. Review `docs/DATA.md` and `docs/PROFILES.md` for the detailed data and privacy descriptions.

The Games identity at `/games/` is a separate, optional player feature; it is not the profile-analytics cookie and does not change `/admin` authentication. Players may use a one-time, randomly generated recovery code; the site stores only its digest and cannot recover a lost code. Do not ask players to share it, put it in support messages, screenshots, analytics, or logs. Game saves are bounded/private and export/delete are player-controlled. Generic room payloads are untrusted synchronization state, not server-validated game results. Guest play/local progress remain available. Cloudflare's checked Free quotas, required `0011`/`0012` migration and `GameRoom` rollout steps are maintained in `docs/GAMES-OPERATIONS.md`; remain on Workers Free and do not create paid dependencies.

## 14. Preview and check your changes

For a quick visual preview of public pages:

```powershell
npm run dev
```

For a project-wide build, type check, access-control verification, and Wrangler dry run:

```powershell
npm run check
```

Worker-specific features such as D1-backed APIs and Durable Objects need a Wrangler/Cloudflare-compatible runtime, not just the basic Astro development server. For local Worker testing:

```powershell
npm test
npm run check
npx wrangler d1 migrations list bnji-board --local
# Apply only if the needed migration is not already present:
npx wrangler d1 migrations apply bnji-board --local
npx wrangler dev --local --test-scheduled --ip 0.0.0.0 --port 8788
```

Use `/games/` to exercise optional local account/save/room controls. The current sandbox D1 may already have all migrations and smoke-test data; inspect the list instead of repeating unnecessary setup. Exact expected behavior, Free quotas, production rollout and migration details are in `docs/GAMES-OPERATIONS.md`. Local secrets, only if needed for unrelated admin tests, go in `.dev.vars`; it is git-ignored and must never be committed. The project has a duplicate remote D1 binding, so `--local` is mandatory for local Wrangler work; never use `--remote` in local tests.

## 15. Publish changes

Use your normal GitHub workflow:

1. Create a working branch.
2. Edit the relevant files.
3. Run `npm run check`.
4. Commit and push the branch.
5. Open a pull request, review it, and merge it to `main`.
6. Confirm the Cloudflare Workers build/deployment succeeded.
7. Apply any required database migrations separately.

For a manual deployment, the project also provides:

```powershell
npm run build
npx wrangler deploy
```

Use manual deployment only when you intend to deploy directly through Wrangler. The normal setup deploys from changes merged to `main`.

## 16. Useful file map

- Site-wide identity and metadata: `src/data/site.ts`
- Profile content: `src/data/profiles/gizlyy.ts`
- Profile image: `public/profiles/gizlyy/`
- Music provider, seed playlist, and fallback: `src/config/music.config.ts` (the live playlist is edited in `/admin` → Playlist; see section 5)
- Homepage projects: `src/data/projects.ts`
- Homepage interests: `src/data/interests.ts`
- AI pipeline copy: `src/data/ai-stack.ts`
- Service cards: `src/data/network.ts`
- Lab listing: `src/data/lab.ts`
- Blog posts: `src/content/blog/`
- Navigation: `src/data/navigation.ts`
- Theme/design tokens: `src/styles/tokens.css`
- Contact-message provider: `src/config/integrations.config.ts`
- Board storage provider: `src/config/board.config.ts`
- Paint limits: `src/config/paint.config.ts`
- D1 bindings: `wrangler.json`
- Admin and storage documentation: `docs/ADMIN.md`, `docs/DATA.md`, `docs/PROFILES.md`, and `docs/DEPLOY.md`
- Planned chat / private messaging / friends: `docs/CHAT-SYSTEM-PLAN.md` (not implemented)
- Collection rules: `docs/DATA-COLLECTION-POLICY.md`
- Dependency and infrastructure policy: `docs/DEPENDENCY-POLICY.md`

## 17. Privacy and public-content reminders

- Treat profile details, links, project descriptions, music sources, and blog posts as public.
- Treat message-board posts as public. Do not encourage visitors to submit sensitive information.
- Never put secret tokens, webhook URLs, passwords, or private infrastructure details in public configuration or page content.
- Profile analytics use an ephemeral session cookie for view deduplication, reactions, and link tracking; it is not a user account.
- Paint’s activity trail records accepted publish summaries only. Its visitor/session identifier is opaque and ephemeral, not a person’s identity. *(This is current behaviour; the collection policy allows deliberate extensions — account attribution and richer action detail — each of which needs a documented decision and disclosure first.)*
- Use the admin panel only for its intended private operations, and keep the admin token and `ACCESS_SECRET` out of GitHub and the repository.
- **Collection is allowed, silence is not.** The site may now store chat history, message logs and comparable activity records (`docs/DATA-COLLECTION-POLICY.md`). Anything collected must appear in the register in `docs/DATA.md` §11 with its retention, and anything a visitor would be surprised by must be said plainly on the page where it happens and on the planned `/privacy/` page.
- **Tell people what is readable.** If private messages are logged for administrators, the messaging UI has to say so. The honest sentence is short; the alternative is a breach of trust even when nothing illegal happened.

That’s the current owner setup. For detailed implementation and retention notes, see `docs/CONFIGURATION.md`, `docs/DATA.md`, `docs/PROFILES.md`, `docs/ADMIN.md`, and `docs/DEPLOY.md`.
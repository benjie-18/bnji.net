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

Edit **`src/config/music.config.ts`**. Choose one provider by changing `provider`:

- `'none'`: no configured music source.
- `'youtube'`: use the video ID from a YouTube URL’s `v=` parameter.
- `'spotify'`: provide the Spotify track, album, or playlist ID and matching `type`.
- `'file'`: provide a direct audio-file URL and a title.

For a local audio file, place it under `public/`. For example, `public/music/ambient.mp3` is addressed as `/music/ambient.mp3`.

`defaultVolume` is from `0` to `1`. It sets the initial volume preference; visitors can change their own volume and mute settings. The player attempts autoplay, but browsers may block it. Visitors may need to press play. Spotify’s own embedded player provides its playback controls.

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

## 9. Change the site’s appearance and visitor settings

- **Colors, glass, and visual tokens:** `src/styles/tokens.css`
- **Default theme and intro defaults:** `src/config/access.config.ts`
- **Per-visitor settings:** the Settings panel on the website

The Settings panel stores a visitor’s preferences in that visitor’s browser. Their theme, volume, and effects choices are not the same thing as the site-wide defaults. The intro has a global configuration switch, and reduced-motion preferences are respected.

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

Wrangler must be authenticated to the correct Cloudflare account. If prompted, run `npx wrangler login`.

The merged Paint update includes migration `0007_paint_stickers_activity.sql`. Applying migrations runs those that are pending; it does not create another database. Check the migration list before and after applying. Cloudflare Workers Builds deploying code does not, by itself, apply D1 migrations.

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

The admin area includes statistics, board moderation, security events, and the Paint activity trail. Paint activity contains summaries of accepted published changes: timestamps, revisions, action counts, and an opaque ephemeral visitor/session ID. That ID does not identify a person. Local drafts, pointer paths, sticker images, and canvas artwork are not included. The log is admin-only, retained for 60 days, and capped at 5,000 rows.

The security-event log is separate and contains request/security information such as IP address and user-agent data. It is admin-only and has its own retention policy. Review `docs/DATA.md` and `docs/PROFILES.md` for the detailed data and privacy descriptions.

## 14. Preview and check your changes

For a quick visual preview of public pages:

```powershell
npm run dev
```

For a project-wide build, type check, access-control verification, and Wrangler dry run:

```powershell
npm run check
```

Worker-specific features such as D1-backed API routes need a Wrangler/Cloudflare-compatible runtime, not just the basic Astro development server. For local Worker testing, first build, apply migrations to the local database, and run Wrangler in local mode:

```powershell
npm run build
npx wrangler d1 migrations apply bnji-board --local
npx wrangler dev --local --port 8788
```

Local secrets for that runtime go in `.dev.vars`. The file is git-ignored; never commit it. The project has a duplicate remote D1 binding for production, so `--local` is important for local Wrangler work.

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
- Music provider and source: `src/config/music.config.ts`
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

## 17. Privacy and public-content reminders

- Treat profile details, links, project descriptions, music sources, and blog posts as public.
- Treat message-board posts as public. Do not encourage visitors to submit sensitive information.
- Never put secret tokens, webhook URLs, passwords, or private infrastructure details in public configuration or page content.
- Profile analytics use an ephemeral session cookie for view deduplication, reactions, and link tracking; it is not a user account.
- Paint’s activity trail records accepted publish summaries only. Its visitor/session identifier is opaque and ephemeral, not a person’s identity.
- Use the admin panel only for its intended private operations, and keep the admin token and `ACCESS_SECRET` out of GitHub and the repository.

That’s the current owner setup. For detailed implementation and retention notes, see `docs/CONFIGURATION.md`, `docs/DATA.md`, `docs/PROFILES.md`, `docs/ADMIN.md`, and `docs/DEPLOY.md`.
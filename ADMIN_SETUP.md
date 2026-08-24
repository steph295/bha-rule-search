# Setting up the admin tool

This makes it possible to sign in and edit rule/guide text on the live site.
It needs two things that live **outside this repo**, so you have to set them
up yourself — nobody but you should ever see these values, which is also
why they're not in this file or in chat.

The public search (`steph295.github.io/bha-rule-search/…`) is untouched by
any of this — it keeps deploying from GitHub Pages exactly as it does today.
This just adds a second, separate deployment of the *same* repo that also
serves `/admin` and the `/api/*` functions behind it.

## What you're setting up

- **Vercel** hosts the admin page and its two API endpoints (`/api/login`,
  `/api/save-rule`). It's free for this. Vercel deploys straight from the
  same GitHub repo — no separate codebase to maintain.
- A **GitHub token** lets the `/api/save-rule` function commit an edit into
  `overrides.json` in this repo on your behalf. It never leaves Vercel's
  server — your browser never sees it.

## Steps

**1. Create the GitHub token** (2 minutes)

- GitHub → your profile photo → **Settings** → **Developer settings** →
  **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
- Repository access: **Only select repositories** → `bha-rule-search`
- Permissions → **Contents**: **Read and write**. Leave everything else as
  "No access".
- Generate it and copy the token — you'll paste it into Vercel next, not here.

**2. Create the Vercel project** (3 minutes)

- Go to [vercel.com](https://vercel.com) → sign up/in with your GitHub
  account → **Add New… → Project** → import `steph295/bha-rule-search`.
- Framework preset: **Other**. Leave build/output settings blank — there's
  nothing to build; Vercel serves the static files and `/api/*` as-is.
- Before clicking Deploy, add two **Environment Variables**:
  - `ADMIN_PASSWORD` — a password only you know. This is what you'll type in
    at `/admin` to sign in.
  - `GITHUB_TOKEN` — the token from step 1.
- Click **Deploy**.

**3. Try it**

- Vercel gives you a URL like `https://bha-rule-search.vercel.app`.
- Go to `https://bha-rule-search.vercel.app/admin/`, sign in with the
  password you set, find a rule, edit it, and publish.
- Refresh the real public site
  (`https://steph295.github.io/bha-rule-search/`) — the edit should be there
  within a few seconds (GitHub Pages redeploys automatically on the commit
  the admin tool just made).

## What this does and doesn't do

- **Does**: real login (one shared password), real edits, committed as real
  git commits to this repo, visible on the live public site.
- **Does not**: have multiple user accounts, a draft/review step before
  publishing (you chose "commit and go live immediately" — every save is
  final the moment you click it), or preserve the original numbered
  sub-clause structure of a rule when you edit its body text (edits become
  plain paragraphs).
- **Undo**: every edit is a normal git commit to this repo (message "Admin
  edit: <code>"). To undo one, revert that commit on GitHub like any other.

## If something's wrong

- **"ADMIN_PASSWORD is not configured on the server"** — the env var isn't
  set on the Vercel project (or you're hitting a preview deployment that
  doesn't have it). Check Vercel → Project → Settings → Environment
  Variables.
- **"GitHub write failed"** — the token is missing, expired, or doesn't have
  Contents: Read and write on this specific repo. Regenerate it (step 1) and
  update the Vercel env var, then redeploy.
- Edits not showing up on the public site after ~1 minute — check the
  **Actions** tab (or **Settings → Pages**) on the GitHub repo to confirm
  Pages actually redeployed from the admin tool's commit.

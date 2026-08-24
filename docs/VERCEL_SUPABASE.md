# Vercel + Supabase deployment

This repository was originally designed as a long-running local Node.js process with SQLite, `node-cron`, local media files, Playwright, Sharp, and FFmpeg. A safe cloud deployment therefore separates the web/control plane from durable media execution.

## Target architecture

- **Vercel**: dashboard and HTTP API (Express via `api/index.js`)
- **Supabase Postgres**: persistent application state and job metadata
- **Durable media worker**: video/image/audio generation, FFmpeg assembly, browser automation, and YouTube publishing

The Vercel web deployment is intentionally **control-plane only by default**. It will not silently run long media jobs after an HTTP response. Generation and publishing methods fail with `VERCEL_MEDIA_WORKER_REQUIRED` until a durable worker is configured.

## Why the worker is separate

The local application starts work in background promises, keeps an in-memory active-job map, runs `node-cron`, and writes production assets under repository-local `data/`, `uploads/`, and `temp/` paths. Those assumptions are appropriate for a persistent process but not for a request-driven web function.

Keeping the worker boundary explicit prevents:

- jobs disappearing after a web-function lifecycle ends;
- two cold starts marking a shared worker's active job as interrupted;
- generated media being treated as durable when it only exists on temporary compute;
- process-local cron state becoming the source of truth.

## Supabase database

Set `DATABASE_URL` to the **pooled Postgres connection string** for the Supabase project. The cloud runtime swaps the SQLite database class for `database/postgres-db.js` before the main application module is loaded.

The adapter keeps the existing domain methods and translates the SQLite-specific query patterns used by the application, including:

- `?` placeholders to PostgreSQL parameters;
- `INSERT OR IGNORE` and `INSERT OR REPLACE`;
- SQLite `datetime(...)` expressions;
- `AUTOINCREMENT`;
- SQLite `rowid` ordering used by discoverability audit history;
- nullable `IS ?` comparisons;
- transaction affinity for discoverability audit writes.

Local/self-hosted installs continue to use SQLite unchanged.

## Required Vercel environment variables

At minimum:

```text
DATABASE_URL=<Supabase pooled Postgres URL>
DATABASE_SSL=true
NODE_ENV=production
API_KEY=<strong random secret>
```

For a fully authenticated YouTube control plane without committing credential files:

```text
YOUTUBE_CLIENT_ID=<Google OAuth client id>
YOUTUBE_CLIENT_SECRET=<Google OAuth client secret>
YOUTUBE_REDIRECT_URI=<configured OAuth redirect URI>
YOUTUBE_REFRESH_TOKEN=<refresh token>
```

Add at least one AI provider key such as `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` when AI-backed features are needed. See `.env.example` for the complete list.

Do **not** commit `config/credentials.json`, `config/tokens.json`, database passwords, OAuth refresh tokens, or provider API keys.

## Vercel configuration

`vercel.json` currently:

- deploys the web entrypoint as a Node.js function;
- uses the Singapore execution region to keep the web tier close to a Singapore Supabase project;
- skips Playwright browser downloads for the web function;
- gives the web control plane a 60-second function ceiling and 1 GB memory.

The repository targets Node.js 22 for the cloud deployment.

## Deployment sequence

1. Create a dedicated Supabase project, preferably in `ap-southeast-1` (Singapore).
2. Copy its pooled connection string to Vercel as `DATABASE_URL`.
3. Add the security/API and OAuth/provider environment variables.
4. Import this GitHub repository into Vercel and deploy the branch/commit containing this integration.
5. Open the dashboard and verify read-only/control-plane API health.
6. Configure a durable media worker before enabling generation or publishing.
7. Only after the worker passes end-to-end tests should scheduled automation be enabled.

## Durable worker options

The worker should share the same Supabase database and be the sole authority for long-running job recovery. It must provide durable or persistent storage for production assets and be able to run FFmpeg and any required browser/runtime dependencies.

A Vercel-native option is a **persistent Vercel Sandbox** invoked per job (or resumed by name), potentially coordinated by Vercel Workflow/Cron. This keeps the stack on Vercel but should be implemented only after confirming the plan's Sandbox availability and cost. A conventional always-on worker can also run the same repository against the same Supabase database.

Until one of those worker designs is implemented and tested, keep `ENABLE_VERCEL_MEDIA_WORKER` unset/false in the Vercel web project.

## Validation checklist

Before production use, confirm all of the following:

- Vercel build passes on Node.js 22.
- Database tables initialize successfully in a clean Supabase project.
- Dashboard read APIs return data from Supabase.
- Mutating routes reject requests without the configured `API_KEY`.
- YouTube OAuth refresh works from environment-backed credentials.
- Web cold starts do not mark worker jobs as interrupted.
- Generation requests are blocked with `VERCEL_MEDIA_WORKER_REQUIRED` until a durable worker is enabled.
- Worker-generated assets survive worker restarts/resumes.
- A private test video can be generated, reviewed, uploaded, and observed in analytics before automation is enabled.

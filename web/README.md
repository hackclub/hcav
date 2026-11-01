# hcav registration

the world's second best scavenger hunt. registration only: landing page, hack club sign-in, unlimited-size teams, and invitations. the hunt list, submissions, scoring, and judging are deliberately not included.

## local development

requires bun 1.4.2+; node is not required. package scripts explicitly run javascript tooling with bun, which also loads the local `.env` during development.

```sh
bun install --frozen-lockfile
cp .env.example .env # only if you do not already have .env
bun run dev --host localhost --port 5173
```

open http://localhost:5173. the landing page works without credentials; registration needs hca and the airtable schema. never commit `.env` or put provider credentials in browser code.

## hca setup

create a confidential web application at https://auth.hackclub.com. set `HCA_CLIENT_ID` and `HCA_CLIENT_SECRET` in the deployment's secret environment. register both exact callback urls (or use separate development and production applications):

```text
http://localhost:5173/auth/callback
https://hcav.hackclub.community/auth/callback
```

the application requests `openid profile email slack_id verification_status`. confirm it can receive `sub`, `email`, `email_verified`, `slack_id`, `verification_status`, and `ysws_eligible` through authenticated userinfo. new logins require a linked slack account; users without one must link it through hca before signing in. hca remains the login provider; there is no slack user-login oauth flow. no identity documents are requested or stored.

public profiles use `displayName` and `imageUrl` from `https://cachet.dunkirk.sh/users/{id}`, with the linked slack id as `{id}`. fall back to the slack id when the public display name is unavailable; never display an hca legal name. `people.name` stores the public slack display name (or slack id fallback), and photos are fetched separately without adding a photo field to airtable.

sign-in uses the authorization-code flow, client authentication, state, nonce, pkce parameters, and signed id-token validation. provider-side enforcement of pkce must not be assumed; client authentication, state, nonce and token validation remain required.

## airtable setup

set `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID`. the token needs access to the chosen base and `data.records:read`, `data.records:write`, and `schema.bases:read`; creating tables or adding fields also needs `schema.bases:write`.

```sh
bun run airtable:setup          # inspect only; makes no changes
bun run airtable:setup --apply  # create missing tables and add missing fields
```

the script inspects without `--apply`. with `--apply`, it creates missing `people` and `teams` tables and adds missing fields to existing tables. it validates all existing field types before writing, rejects type mismatches, and never modifies or deletes existing fields. the exact field names/types are defined in `scripts/airtable-setup.mjs`. `people` keeps its existing schema for profiles and membership. `teams` holds names/captains/shared invitation links and gains `open_registration` (checkbox), `hq_channel_id` (singleLineText), and `hq_channel_name` (singleLineText). new teams are closed by default. ids are text primary fields. do not manually duplicate ids or edit membership while the application is processing requests.

### migration from email delivery

the app no longer sends email or slack dm invitations. the setup script neither requires nor creates `mail` and leaves any existing live `mail` table untouched. disable the old email automation before rollout and handle old `ready` rows manually after checking delivery history; do not replay them automatically. keep historical records private. remove the obsolete invitation feature flags from deployment configuration.

## slack bot setup

create a slack app from `slack-manifest.json` and have a hack club workspace administrator install/approve it. the bot scopes are `commands`, `chat:write`, `channels:read`, `groups:read`, `channels:write.invites`, and `groups:write.invites`. install or reinstall the app after changing scopes; changing the manifest alone does not update an installed token's grants.

provide `SLACK_BOT_TOKEN` (the installed bot's `xoxb-…` token), `SLACK_TEAM_ID` (hack club's workspace id, starting with `T`), and `SLACK_SIGNING_SECRET` through the deployment's secret environment. slash commands require signature and timestamp verification with the signing secret. no event subscription, interactivity endpoint, or socket-mode connection is needed.

configure `/hcav` with request url `https://hcav.hackclub.community/slack/command` and usage hint `hq`. invite the bot to `#hcav` (`C0BQ2GV0H0E`), `#hcav-submissions` (`C0CB9NR1N3W`), and every chosen team hq. a captain first invites the bot to an existing public or private channel, then runs `/hcav hq` inside that channel. the command confirms its outcome ephemerally and schedules channel additions through the persisted background queue.

new commands send their follow-up through slack's signed-payload `response_url`, so even a missing-bot warning can be delivered before the bot joins the channel. these temporary urls are secrets stored in the sqlite command queue; protect database backups and do not log command payloads. commands queued before this change retain the old ephemeral-api reply path; rerun `/hcav hq` after deploying the fix rather than replaying old commands. no slack app configuration or scope changes are required.

the captain must also be the channel's creator, checked using `conversations.info` with the existing bot token. if the creator does not match the captain's slack id, or slack does not provide a creator, hq selection is refused. no admin token, user token, or additional scope is needed.

sqlite persists signed-command deduplication and channel-addition jobs with retries. joining registration adds members to the shared channels and their team's chosen hq. channel api errors do not roll back registration membership; the ui shows delivery state and a retry action. leaving a team or being removed never automatically removes anyone from slack channels. changing hq adds existing team members to the new hq without removing them from the old one.

## abuse controls and behavior

- anyone signed in can create a team, join one, or share its link. there is no team-size limit, but each person can belong to only one team.
- only the captain can rename, remove members, transfer captaincy, rotate/revoke links, change open registration, or select an hq. a captain transfers their role before leaving.
- `/teams` requires authentication and ranks teams by airtable's numeric `Total Points`, highest first. blank scores count as zero; ties share a competition rank (1, 2, 2, 4), ordered by team name. registration status does not affect ranking. the server rechecks open registration at join time rather than trusting the listing or browser. new teams are closed by default; bearer invitations still work for closed teams.
- the only invitation mechanism is a bearer `/join/{token}` link, valid for 14 days and revocable by the captain. anyone holding it can use it, so share privately. rotating a link invalidates the previous link without removing existing members.
- the app also limits general requests, login attempts, joins, and mutations. configure trusted client-ip forwarding correctly before launch; never trust a client-supplied forwarding header directly.
- the session cookie is http-only, same-site lax, secure in production, revocable at logout, and expires after seven days. provider tokens are not retained.

## production container

build from this directory, then run behind your https reverse proxy:

```sh
docker build -t hcav .
docker volume create hcav-data
docker run --name hcav --restart unless-stopped \
  --env-file .env \
  -e APP_ORIGIN=https://hcav.hackclub.community \
  -e SQLITE_PATH=/data/hcav.sqlite \
  -p 127.0.0.1:3000:3000 \
  -v hcav-data:/data hcav
```

the image builds and runs with bun only, listens on port 3000, and includes a healthcheck. startup briefly runs as root to give the mounted `/data` directory ownership `1000:1000`, then clears supplementary groups and drops to the non-root `bun` user before loading the application. it does not include `.env`, tests, or development dependencies. your orchestrator should supply equivalent environment settings and a persistent `/data` volume. the existing sveltekit `adapter-node` output runs under bun's node-api compatibility; it does not require a separate node executable. start a non-container production build with `bun ./build/index.js`.

the volume must be mounted read-write and allow startup's ownership change. existing sqlite files must already be writable by uid/gid 1000; startup changes only the directory, not its contents. if the platform forbids root startup or rejects `chown`, provision the volume with the correct ownership on the platform instead. sqlite also creates `hcav.sqlite-wal` and `hcav.sqlite-shm` beside the database, so making only the database file writable is insufficient. if logs show `slack queue unavailable` together with request failures, check the accompanying sqlite error and volume permissions first; the queue itself is stored in sqlite, not slack.

**run exactly one application process/replica, with no overlapping rolling replicas.** airtable has no transactions or compare-and-swap, so membership mutations are serialized in that process. local sqlite provides durable sessions, oauth state, invitation tokens, atomic rate limits, signed-command deduplication, and channel-addition jobs/retries; airtable remains the registration database. do not use an ephemeral filesystem or share the sqlite file over a network filesystem. back up airtable and sqlite; losing sqlite also loses pending jobs and deduplication history.

the public origin is `https://hcav.hackclub.community`. sveltekit 3's `paths.origin` is set at build time from `APP_ORIGIN`; adapter-node 6 does not support the old runtime `ORIGIN` variable. the docker build defaults to the production domain. to use another domain, pass `docker build --build-arg APP_ORIGIN=https://your-domain.example -t hcav .` and set the same `APP_ORIGIN` at runtime. a non-docker production build needs `APP_ORIGIN=https://hcav.hackclub.community bun run build`, then the matching runtime setting.

terminate tls at your proxy and prevent direct public access to the app port. set adapter-node's `ADDRESS_HEADER` and `XFF_DEPTH` for your actual trusted proxy chain. for exactly one proxy that overwrites incoming `X-Forwarded-For`, use `ADDRESS_HEADER=x-forwarded-for` and `XFF_DEPTH=1`. do not copy those settings without verifying your proxy behavior. the default is conservative but may group all visitors under the proxy ip and throttle them together. keep access logs from recording oauth callback queries or invitation secrets.

airtable requests are paced below five/second; this launch-sized implementation prioritizes safe registration over high throughput. do not enable autoscaling without replacing the single-process mutation coordination.

## validation

```sh
bun run check
bun run lint
bun run test
bun run build
```

playwright uses the real application, real sqlite, browser interactions, and cryptographically signed oidc fixtures. airtable, slack, and hca are deterministic service doubles; outbound test network calls fail closed. test data/screenshots stay in the repository's excluded `.amp/in/` directory. service doubles do not establish real provider configuration.

before opening registration, verify linked-slack login and rejection without a linked account, public profile fallback, a second account joining by bearer link, expiry/revocation, and open/closed registration with the deployed proxy settings. test `/hcav hq` in public and private channels, signature rejection, duplicate-command handling, persisted retries across restarts, and visible channel-error recovery without losing team membership. confirm the bot belongs to both shared channels and each hq.

edit landing-page content in `src/routes/+page.svelte`; `src/lib/Faq.svelte` takes a `question` prop and renders nested html through svelte's `children` snippet. the rest of the interface uses tailwind. there are no ai-generated images or third-party analytics.

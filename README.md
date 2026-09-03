# ktn

Newsletters, without the inbox. Convert email newsletters into RSS feeds.

Inspired by [Kill the Newsletter!](https://kill-the-newsletter.com/) by [Leafac](https://github.com/leafac/kill-the-newsletter) — rebuilt from scratch as a single Cloudflare Worker with no database, no server, and no runtime dependencies beyond [postal-mime](https://github.com/nickolasg/postal-mime).

## How it works

Once you have deployed ktn on `yourdomain.com`, 

1. Pick any email address, e.g. `mycoolnewsletter@yourdomain.com`
2. Subscribe to a newsletter with that address
3. Point your RSS reader at `https://yourdomain.com/feeds/mycoolnewsletter.atom`

Feeds are created automatically when the first email arrives. Each feed keeps the last 25 messages. You can use the same address for multiple newsletters and they all appear in one feed, interleaved by arrival order. You can organize newsletters by subscribing to several financial  newsletters with `financenewsletters@yourdomain.com`.

Incoming email HTML is cleaned using Cloudflare's built-in [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/) — scripts, iframes, forms, event handlers, and other non-content elements are stripped. Attachments are discarded.

## Architecture

- **Worker**: single script with an `email()` handler (receives mail) and a `fetch()` handler (serves feeds and pages)
- **R2**: stores Atom feeds (`feeds/{token}.atom`) and per-message HTML pages (`messages/{token}/{id}.html`). No database.
- **Email Routing**: Cloudflare's catch-all forwards all mail to the Worker, which filters by domain

## Prerequisites

- A Cloudflare account with a domain managed by Cloudflare
- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

## Deploy

### 1. Clone and install

```sh
git clone https://github.com/youruser/cf-ktn.git
cd cf-ktn
npm install
```

### 2. Create the R2 bucket

```sh
npx wrangler r2 bucket create ktn-feeds
```

Or create it in the Cloudflare dashboard under **R2 Object Storage**.

### 3. Configure your domain

Edit `wrangler.toml` if you want to change the worker name or bucket name. The defaults are:

```toml
name = "ktn"
bucket_name = "ktn-feeds"
```

### 4. Deploy the Worker

```sh
npx wrangler deploy
```

### 5. Set the BASE_URL secret

This tells the Worker which domain it serves. It's stored as an encrypted secret, not in source code.

```sh
npx wrangler secret put BASE_URL
# Enter: https://yourdomain.com
```

You may also wish to set `ADMIN_TOKEN` and `NEW_MAILBOX_SECRET` at this point.

### 6. Add a Worker route

In the Cloudflare dashboard:

1. Go to **Workers & Pages** > **ktn** > **Settings** > **Domains & Routes** > **Add route**
2. Route: `yourdomain.com/*`
3. Zone: `yourdomain.com`

Accept the DNS record it prompts you to create.

### 7. Set up Email Routing

1. Go to **Email Routing** for your domain
2. Enable it if not already enabled — accept the MX and SPF DNS records Cloudflare suggests
3. Go to the **Routing rules** tab
4. Edit the **Catch-all address**: set the action to **Send to a Worker** and select **ktn**

If you're using a subdomain (e.g., `ktn.yourdomain.com`) instead of the root domain, you'll also need to add MX records for the subdomain pointing to Cloudflare's mail servers (copy the values from your root domain's MX records).

**Note:** the catch-all applies to the entire zone. The Worker filters emails by domain (using `BASE_URL`) and silently ignores mail addressed to other domains. If you already use the catch-all for something else, consider using a dedicated domain.

### 8. Verify

1. Visit `https://yourdomain.com/` — you should see the instructions page
2. Send an email to `test@yourdomain.com` (or `test+SECRET@yourdomain.com` if you configured `NEW_MAILBOX_SECRET`)
3. Check `https://yourdomain.com/feeds/test.atom` — the email should appear as a feed entry

## Local development

```sh
npm run dev
```

This starts a local server on `http://localhost:8787` with simulated R2 storage. Create a `.dev.vars` file for local configuration:

```
BASE_URL=https://localhost:8787
```

The staging environment enables a `POST /dev/incoming` test route that accepts JSON to simulate incoming email without SMTP:

```sh
npx wrangler dev --env staging

curl -X POST http://localhost:8787/dev/incoming \
  -H "Content-Type: application/json" \
  -d '{"to":"test@localhost","from":"sender@example.com","subject":"Hello","html":"<p>World</p>"}'
```

## Staging environment

A staging environment is preconfigured in `wrangler.toml`. To use it:

1. Create a staging R2 bucket: `npx wrangler r2 bucket create ktn-staging-feeds`
2. Deploy: `npx wrangler deploy --env staging`
3. Set the secret: `npx wrangler secret put BASE_URL --env staging`
4. Set up routing and email (same steps as production, pointing to the `ktn-staging` worker)

## Configuration

| Variable | Where | Description |
|---|---|---|
| `BASE_URL` | Secret (`wrangler secret put`) | The public URL of your instance (e.g., `https://yourdomain.com`) |
| `MAX_ENTRIES` | `wrangler.toml` [vars] | Max messages per feed (default: `25`) |
| `MAX_MAILBOXES` | `wrangler.toml` [vars] | Global cap on distinct mailboxes (default: `100`) |
| `DEV_MODE` | `wrangler.toml` [vars] | Enables `/dev/incoming` test route (`true`/`false`) |
| `ADMIN_TOKEN` | Secret (optional) | Bearer token for `/admin/*` endpoints. If unset, admin endpoints are disabled. |
| `ALERT_WEBHOOK_URL` | Secret (optional) | [ntfy.sh](https://ntfy.sh) topic URL for capacity alerts. If unset, alerts are silently skipped. |
| `NEW_MAILBOX_SECRET` | Secret (optional) | If set, new mailboxes can only be created via plus-addressing: `mybox+SECRET@yourdomain.com`. Case-insensitive (email local-parts are treated case-insensitively in practice). Existing mailboxes still accept plain addresses. |

## Abuse mitigation

ktn auto-creates a mailbox on first email, so a public deployment is exposed to anyone who guesses your domain. Three optional layers of defense:

- **Global cap** (`MAX_MAILBOXES`): once reached, new mailboxes are silently dropped. Existing ones keep working.
- **ntfy.sh alerts** (`ALERT_WEBHOOK_URL`): warning at 80% of cap, alarm when cap is hit. Rate-limited to once per 24h per kind.
- **Plus-addressing secret** (`NEW_MAILBOX_SECRET`): require a shared secret in the `+tag` portion to create a mailbox. Uses [RFC 5233 subaddressing](https://datatracker.ietf.org/doc/html/rfc5233) — Cloudflare Email Routing preserves the `+tag` portion and forwards the full address to the Worker.

## Admin endpoints

If `ADMIN_TOKEN` is set, four endpoints become available. All require `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/mailboxes` | JSON listing of mailboxes, sizes, last-updated, tombstones, and any orphan warnings. |
| `DELETE` | `/admin/mailboxes/{token}` | Purge a mailbox (feed + all messages). The next email will recreate it. |
| `POST` | `/admin/mailboxes/{token}/tombstone` | Purge and block future recreation. Email to a tombstoned address is silently dropped. |
| `DELETE` | `/admin/mailboxes/{token}/tombstone` | Lift the tombstone. |

Example:

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://yourdomain.com/admin/mailboxes
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://yourdomain.com/admin/mailboxes/spam/tombstone
```

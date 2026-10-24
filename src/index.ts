import PostalMime from "postal-mime";

interface Env {
  FEEDS_BUCKET: R2Bucket;
  BASE_URL: string;
  MAX_ENTRIES: string;
  MAX_MAILBOXES: string;
  DEV_MODE: string;
  ADMIN_TOKEN?: string;
  ALERT_WEBHOOK_URL?: string;
  NEW_MAILBOX_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Atom XML helpers
// ---------------------------------------------------------------------------

function createBlankFeed(token: string, baseUrl: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(token)}</title>
  <link href="${baseUrl}/feeds/${token}.atom" rel="self"/>
  <id>urn:ktn:feed:${token}</id>
  <updated>${new Date().toISOString()}</updated>
</feed>`;
}

function buildEntry(
  messageId: string,
  token: string,
  subject: string,
  from: string,
  date: string,
  htmlContent: string,
  baseUrl: string,
): string {
  return `  <entry>
    <id>urn:ktn:${messageId}</id>
    <title>${escapeXml(subject)}</title>
    <author><name>${escapeXml(from)}</name></author>
    <updated>${date}</updated>
    <link href="${baseUrl}/${token}/${messageId}.html" rel="alternate"/>
    <content type="html"><![CDATA[${escapeCdata(htmlContent)}]]></content>
  </entry>`;
}

function prependEntry(feedXml: string, entryXml: string): string {
  // Insert the new entry right after the last top-level feed metadata,
  // before existing entries or </feed>.
  const insertPoint = feedXml.indexOf("<entry>");
  if (insertPoint !== -1) {
    return feedXml.slice(0, insertPoint) + entryXml + "\n" + feedXml.slice(insertPoint);
  }
  // No existing entries — insert before </feed>
  return feedXml.replace("</feed>", entryXml + "\n</feed>");
}

function updateFeedTimestamp(feedXml: string, date: string): string {
  return feedXml.replace(
    /<updated>[^<]*<\/updated>/,
    `<updated>${date}</updated>`,
  );
}

/** Extract all <entry>...</entry> blocks from the feed. */
function extractEntries(feedXml: string): string[] {
  const entries: string[] = [];
  const regex = /<entry>[\s\S]*?<\/entry>/g;
  let match;
  while ((match = regex.exec(feedXml)) !== null) {
    entries.push(match[0]);
  }
  return entries;
}

/** Extract the messageId from an entry's <link href=".../{messageId}.html"/>. */
function extractMessageId(entry: string): string | null {
  const match = entry.match(/<link[^>]+href="[^"]*\/([^/"]+)\.html"/);
  return match ? match[1] : null;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape ]]> sequences so they don't break CDATA sections. */
function escapeCdata(s: string): string {
  return s.replace(/]]>/g, "]]]]><![CDATA[>");
}

// ---------------------------------------------------------------------------
// HTML page shell
// ---------------------------------------------------------------------------

function buildMessagePage(
  token: string,
  subject: string,
  from: string,
  date: string,
  htmlBody: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeXml(subject)}</title>
  <style>
    body { max-width: 700px; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #222; }
    header { border-bottom: 1px solid #ccc; padding-bottom: 1rem; margin-bottom: 1.5rem; }
    header p { margin: 0.25rem 0; font-size: 0.9rem; color: #555; }
    header a { color: #0969da; text-decoration: none; }
    main { line-height: 1.6; }
    main img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <header>
    <p><strong>From:</strong> ${escapeXml(from)}</p>
    <p><strong>Subject:</strong> ${escapeXml(subject)}</p>
    <p><strong>Received:</strong> ${escapeXml(date)}</p>
    <p><a href="/feeds/${token}.atom">&larr; Back to feed</a></p>
  </header>
  <main>
    ${htmlBody}
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared email processing logic
// ---------------------------------------------------------------------------

interface IncomingEmail {
  to: string;
  from: string;
  subject: string;
  html: string;
}

/** Parse the local part of an email address into a base token and an optional +tag. */
function parseAddress(toAddress: string): { token: string; tag: string | null } | null {
  const at = toAddress.indexOf("@");
  if (at <= 0) return null;
  const local = toAddress.slice(0, at).toLowerCase();
  const plus = local.indexOf("+");
  if (plus === -1) return { token: local, tag: null };
  return { token: local.slice(0, plus), tag: local.slice(plus + 1) };
}

function generateMessageId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Drop-in replacement for cleanEmailHtml in src/index.ts
// Adds: <style> removal, presentational-attribute stripping, tracking-param
// scrubbing, image removal, hidden-preheader removal, and whitespace collapse.

/** Attributes that carry layout/styling weight but no content. */
const JUNK_ATTRS = new Set([
  "style", "class", "bgcolor", "background", "align", "valign",
  "width", "height", "cellpadding", "cellspacing", "border",
  "role", "aria-hidden", "target", "rel", "id", "dir", "lang",
]);

/** Query params used purely for tracking or session auth. */
const TRACKING_PARAMS = [
  // LinkedIn — otpToken and loid are ACCOUNT-SCOPED AUTH TOKENS, not analytics.
  "lipi", "midToken", "midSig", "trk", "trkEmail", "eid", "otpToken",
  "loid", "refId", "trackingId", "originToLandingJobPostings", "origin",
  // Generic
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "gclid", "fbclid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "ck_subscriber_id",
];

function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return "";
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    // Anything left that looks like a long opaque token is almost certainly
    // tracking or session state, not a real query argument.
    for (const [k, v] of [...u.searchParams]) {
      if (v.length > 80) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return "";
  }
}

/** True for the invisible preheader divs email clients use for preview text. */
function isHiddenShim(style: string | null): boolean {
  if (!style) return false;
  const s = style.replace(/\s+/g, "").toLowerCase();
  return (
    s.includes("visibility:hidden") ||
    s.includes("display:none") ||
    /(^|;)(max-)?height:0(px)?(;|$)/.test(s) ||
    s.includes("opacity:0")
  );
}

export async function cleanEmailHtml(html: string): Promise<string> {
  if (!html) return "";

  const rewriter = new HTMLRewriter()
    // Strip wrappers — keep their content
    .on("html", { element(el) { el.removeAndKeepContent(); } })
    .on("head", { element(el) { el.remove(); } })
    .on("body", { element(el) { el.removeAndKeepContent(); } })

    // Remove dangerous / zero-content elements entirely
    .on("script", { element(el) { el.remove(); } })
    .on("style", { element(el) { el.remove(); } })   // was missing — often multi-KB
    .on("iframe", { element(el) { el.remove(); } })
    .on("object", { element(el) { el.remove(); } })
    .on("embed", { element(el) { el.remove(); } })
    .on("form", { element(el) { el.remove(); } })
    .on("link", { element(el) { el.remove(); } })
    .on("meta", { element(el) { el.remove(); } })

    // Images: tracking pixels, logos, and profile photos. None carry meaning
    // in a job alert, and profile photo URLs are personally identifying.
    .on("img", { element(el) { el.remove(); } })

    // Flatten layout tables into their content
    .on("table, tbody, thead, tfoot, tr, td, th, center, font", {
      element(el) { el.removeAndKeepContent(); },
    })

    .on("*", {
      element(el) {
        // Drop invisible preheader shims BEFORE stripping style
        if (isHiddenShim(el.getAttribute("style"))) {
          el.remove();
          return;
        }

        // Clean links, drop the dead ones
        if (el.tagName === "a") {
          const cleaned = cleanUrl(el.getAttribute("href") ?? "");
          if (cleaned) el.setAttribute("href", cleaned);
          else el.removeAttribute("href");
        }

        // Collect first — mutating while iterating attributes is unsafe
        const names = [...el.attributes].map(([n]) => n);
        for (const name of names) {
          if (name.startsWith("on") || JUNK_ATTRS.has(name)) {
            el.removeAttribute(name);
          }
        }
      },
    });

  const result = await rewriter.transform(new Response(html)).text();

  return result
    .replace(/<!DOCTYPE[^>]*>/i, "")
    // Zero-width and invisible padding characters used in preheaders
    .replace(/[\u200B-\u200D\u034F\u00AD\uFEFF]/g, "")
    .replace(/(&nbsp;|\s){2,}/g, " ")
    // Collapse the empty wrappers left behind by the above
    .replace(/<(div|span|p)>\s*<\/\1>/g, "")
    .replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>")
    .trim();
}

/** List all keys with a given prefix, paginating as needed. */
async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const all: R2Object[] = [];
  let cursor: string | undefined = undefined;
  do {
    const result: R2Objects = await bucket.list({ prefix, cursor });
    all.push(...result.objects);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return all;
}

/** Count current mailboxes (number of feeds/*.atom files). */
async function countMailboxes(bucket: R2Bucket): Promise<number> {
  const objects = await listAll(bucket, "feeds/");
  return objects.length;
}

async function processEmail(
  email: IncomingEmail,
  env: Env,
  ctx: ExecutionContext | null,
): Promise<void> {
  const baseUrl = env.BASE_URL;
  const bucket = env.FEEDS_BUCKET;
  const maxEntries = parseInt(env.MAX_ENTRIES, 10) || 25;
  const maxMailboxes = parseInt(env.MAX_MAILBOXES, 10) || 100;

  const parsed = parseAddress(email.to);
  if (!parsed) return;
  const { token, tag } = parsed;

  const feedKey = `feeds/${token}.atom`;
  const existing = await bucket.get(feedKey);

  // If the mailbox doesn't exist yet, this email may create it.
  if (!existing) {
    // Tombstone check — never recreate a tombstoned mailbox
    const tombstone = await bucket.get(`tombstones/${token}`);
    if (tombstone) return;

    // Plus-addressing secret check
    if (env.NEW_MAILBOX_SECRET) {
      if (tag !== env.NEW_MAILBOX_SECRET.toLowerCase()) return;
    }

    // Global mailbox cap
    const count = await countMailboxes(bucket);
    if (count >= maxMailboxes) {
      // Fire cap-reached alert (rate-limited, fire-and-forget)
      const alertPromise = sendAlert(env, "cap", `ktn: mailbox cap of ${maxMailboxes} reached. Rejected email to ${email.to} from ${email.from}`);
      if (ctx) ctx.waitUntil(alertPromise); else await alertPromise.catch(() => {});
      return;
    }

    // Warning threshold (80% of cap)
    if (count + 1 >= Math.floor(maxMailboxes * 0.8)) {
      const alertPromise = sendAlert(env, "warning", `ktn: mailbox count is ${count + 1} of ${maxMailboxes} (80%+ full)`);
      if (ctx) ctx.waitUntil(alertPromise); else await alertPromise.catch(() => {});
    }
  }

  const messageId = generateMessageId();
  const date = new Date().toISOString();
  let feedXml = existing
    ? await existing.text()
    : createBlankFeed(token, baseUrl);

  // Build and write the message HTML page
  const cleanedHtml = await cleanEmailHtml(email.html);
  const page = buildMessagePage(token, email.subject, email.from, date, cleanedHtml);
  await bucket.put(`messages/${token}/${messageId}.html`, page, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  // Build the new entry and prepend it
  const entry = buildEntry(messageId, token, email.subject, email.from, date, cleanedHtml, baseUrl);
  feedXml = prependEntry(feedXml, entry);
  feedXml = updateFeedTimestamp(feedXml, date);

  // Evict oldest if over the limit
  const entries = extractEntries(feedXml);
  if (entries.length > maxEntries) {
    const oldest = entries[entries.length - 1];
    const oldId = extractMessageId(oldest);
    if (oldId) {
      await bucket.delete(`messages/${token}/${oldId}.html`);
    }
    feedXml = feedXml.replace(oldest, "").replace(/\n\s*\n/g, "\n");
  }

  await bucket.put(feedKey, feedXml, {
    httpMetadata: { contentType: "application/atom+xml; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

const ALERT_RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours

async function sendAlert(env: Env, kind: "warning" | "cap", message: string): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;

  const stateKey = `meta/last_alert_${kind}.txt`;
  try {
    const last = await env.FEEDS_BUCKET.get(stateKey);
    if (last) {
      const lastTime = new Date(await last.text()).getTime();
      if (Date.now() - lastTime < ALERT_RATE_LIMIT_MS) return;
    }

    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Title": "ktn alert",
        "Priority": kind === "cap" ? "high" : "default",
        "Tags": kind === "cap" ? "rotating_light" : "warning",
      },
      body: message,
    });

    await env.FEEDS_BUCKET.put(stateKey, new Date().toISOString());
  } catch (e) {
    console.error("sendAlert failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

interface MailboxInfo {
  token: string;
  messageCount: number;
  sizeBytes: number;
  lastMessageAt: string | null;
}

interface MailboxWarning {
  type: "orphaned_messages" | "orphaned_feed";
  token: string;
  messageCount?: number;
  sizeBytes: number;
  recommendation: string;
}

async function listMailboxes(env: Env): Promise<{
  cap: number;
  totalCount: number;
  tombstonedCount: number;
  mailboxes: MailboxInfo[];
  tombstoned: string[];
  warnings: MailboxWarning[];
}> {
  const bucket = env.FEEDS_BUCKET;
  const cap = parseInt(env.MAX_MAILBOXES, 10) || 100;

  const [feeds, messages, tombstones] = await Promise.all([
    listAll(bucket, "feeds/"),
    listAll(bucket, "messages/"),
    listAll(bucket, "tombstones/"),
  ]);

  // Group feeds by token
  const feedMap = new Map<string, R2Object>();
  for (const obj of feeds) {
    const m = obj.key.match(/^feeds\/(.+)\.atom$/);
    if (m) feedMap.set(m[1], obj);
  }

  // Group messages by token
  const messageMap = new Map<string, R2Object[]>();
  for (const obj of messages) {
    const m = obj.key.match(/^messages\/([^/]+)\//);
    if (!m) continue;
    const arr = messageMap.get(m[1]) || [];
    arr.push(obj);
    messageMap.set(m[1], arr);
  }

  const mailboxes: MailboxInfo[] = [];
  const warnings: MailboxWarning[] = [];

  // Tokens in feeds
  for (const [token, feedObj] of feedMap) {
    const msgs = messageMap.get(token);
    if (msgs && msgs.length > 0) {
      // Healthy
      const sizeBytes = feedObj.size + msgs.reduce((s, o) => s + o.size, 0);
      const lastMessageAt = msgs
        .map((o) => o.uploaded.toISOString())
        .sort()
        .pop() || null;
      mailboxes.push({
        token,
        messageCount: msgs.length,
        sizeBytes,
        lastMessageAt,
      });
    } else {
      // Feed without messages — orphaned feed
      warnings.push({
        type: "orphaned_feed",
        token,
        sizeBytes: feedObj.size,
        recommendation: `curl -X DELETE -H 'Authorization: Bearer $ADMIN_TOKEN' ${env.BASE_URL}/admin/mailboxes/${token}`,
      });
    }
  }

  // Tokens in messages but not in feeds — orphaned messages
  for (const [token, msgs] of messageMap) {
    if (feedMap.has(token)) continue;
    warnings.push({
      type: "orphaned_messages",
      token,
      messageCount: msgs.length,
      sizeBytes: msgs.reduce((s, o) => s + o.size, 0),
      recommendation: `curl -X DELETE -H 'Authorization: Bearer $ADMIN_TOKEN' ${env.BASE_URL}/admin/mailboxes/${token}`,
    });
  }

  const tombstoned = tombstones
    .map((o) => o.key.replace(/^tombstones\//, ""))
    .sort();

  return {
    cap,
    totalCount: mailboxes.length,
    tombstonedCount: tombstoned.length,
    mailboxes: mailboxes.sort((a, b) => a.token.localeCompare(b.token)),
    tombstoned,
    warnings,
  };
}

/** Delete a mailbox's feed and all its messages. Returns counts. */
async function purgeMailbox(bucket: R2Bucket, token: string): Promise<{ feed: boolean; messages: number }> {
  const feedKey = `feeds/${token}.atom`;
  const feedExisted = (await bucket.head(feedKey)) !== null;

  const messageObjects = await listAll(bucket, `messages/${token}/`);

  // Delete in parallel
  const deletes: Promise<unknown>[] = [];
  if (feedExisted) deletes.push(bucket.delete(feedKey));
  for (const obj of messageObjects) {
    deletes.push(bucket.delete(obj.key));
  }
  await Promise.all(deletes);

  return { feed: feedExisted, messages: messageObjects.length };
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

function landingPage(baseUrl: string, requireSecret: boolean): string {
  const domain = baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const addressExample = requireSecret
    ? `mycoolnewsletter+SECRET@${domain}`
    : `mycoolnewsletter@${domain}`;
  const secretNote = requireSecret
    ? `<p>To prevent spam, this instance requires a shared secret in the address. Ask the admin for the secret and replace <code>SECRET</code> above with it (e.g. <code>mycoolnewsletter+hunter2@${escapeXml(domain)}</code>). The secret is only needed the first time — once a feed exists, the plain address works too.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ktn</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #fafaf7;
      --fg: #1a1a1a;
      --muted: #6b6b6b;
      --accent: #d64933;
      --code-bg: #f0ede5;
      --rule: #e5e2d8;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
    body {
      max-width: 38rem;
      margin: 0 auto;
      padding: 4rem 1.5rem 6rem;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 16px;
      line-height: 1.65;
      -webkit-font-smoothing: antialiased;
    }
    header { border-bottom: 1px solid var(--rule); padding-bottom: 1.25rem; margin-bottom: 2rem; }
    h1 {
      font-size: 2.25rem;
      font-weight: 600;
      margin: 0;
      letter-spacing: -0.03em;
    }
    h1 .dot { color: var(--accent); }
    .tagline { color: var(--muted); margin: 0.25rem 0 0; font-size: 1rem; }
    h2 {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 2rem 0 0.75rem;
    }
    p { margin: 0.75rem 0; }
    ol { padding-left: 1.25rem; margin: 0.5rem 0; }
    ol li { margin-bottom: 0.6rem; padding-left: 0.25rem; }
    ol li::marker { color: var(--accent); font-weight: 600; }
    code {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      background: var(--code-bg);
      padding: 0.12em 0.4em;
      border-radius: 4px;
      font-size: 0.88em;
      color: #333;
    }
    .note {
      border-left: 2px solid var(--accent);
      padding: 0.25rem 0 0.25rem 1rem;
      margin: 1.5rem 0;
      color: var(--muted);
      font-size: 0.93rem;
    }
    footer {
      margin-top: 3rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--rule);
      color: var(--muted);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>ktn</h1>
    <p class="tagline">Newsletters, without the inbox.</p>
  </header>

  <h2>How to use</h2>
  <ol>
    <li>Pick a name for your feed, e.g. <code>mycoolnewsletter</code></li>
    <li>Subscribe using the email address <code>${escapeXml(addressExample)}</code></li>
    <li>Add <code>${escapeXml(baseUrl)}/feeds/mycoolnewsletter.atom</code> to your RSS reader</li>
  </ol>
  ${secretNote ? `<div class="note">${secretNote.replace(/^<p>|<\/p>$/g, "")}</div>` : ""}
  <p>The feed is created automatically when the first email arrives. Each feed keeps the last 25 messages. You can reuse an address for multiple newsletters — they all appear in one feed.</p>

  <footer><a href="https://github.com/semiformal-net/ktn">github</a></footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Worker handlers
// ---------------------------------------------------------------------------

function checkAdminAuth(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return new Response(
      "ADMIN_TOKEN secret is not set. Run: npx wrangler secret put ADMIN_TOKEN",
      { status: 500, headers: { "Content-Type": "text/plain" } },
    );
  }
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.BASE_URL) {
      return new Response(
        "BASE_URL secret is not set. Run: npx wrangler secret put BASE_URL",
        { status: 500, headers: { "Content-Type": "text/plain" } },
      );
    }

    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();

    // Admin routes — bearer token required
    if (path.startsWith("/admin/")) {
      const authError = checkAdminAuth(request, env);
      if (authError) return authError;

      // GET /admin/mailboxes — list mailboxes + warnings
      if (path === "/admin/mailboxes" && request.method === "GET") {
        const data = await listMailboxes(env);
        return jsonResponse(data);
      }

      // /admin/mailboxes/{token}/tombstone — POST to block, DELETE to unblock
      const tombstoneMatch = path.match(/^\/admin\/mailboxes\/([a-zA-Z0-9_-]+)\/tombstone$/);
      if (tombstoneMatch) {
        const token = tombstoneMatch[1];
        if (request.method === "POST") {
          // Purge content + create tombstone
          const purged = await purgeMailbox(env.FEEDS_BUCKET, token);
          await env.FEEDS_BUCKET.put(`tombstones/${token}`, "");
          return jsonResponse({
            ok: true,
            tombstoned: true,
            deleted: { feed: purged.feed, messages: purged.messages },
          });
        }
        if (request.method === "DELETE") {
          await env.FEEDS_BUCKET.delete(`tombstones/${token}`);
          return jsonResponse({ ok: true, tombstoned: false });
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      // DELETE /admin/mailboxes/{token} — purge (mailbox can auto-recreate)
      const mailboxMatch = path.match(/^\/admin\/mailboxes\/([a-zA-Z0-9_-]+)$/);
      if (mailboxMatch && request.method === "DELETE") {
        const token = mailboxMatch[1];
        const purged = await purgeMailbox(env.FEEDS_BUCKET, token);
        return jsonResponse({
          ok: true,
          deleted: { feed: purged.feed, messages: purged.messages },
          note: `Mailbox content purged. To permanently block auto-recreation, run: curl -X POST -H 'Authorization: Bearer $ADMIN_TOKEN' ${env.BASE_URL}/admin/mailboxes/${token}/tombstone`,
        });
      }

      return new Response("Not Found", { status: 404 });
    }

    // GET / — landing page
    if (path === "/" && request.method === "GET") {
      return new Response(landingPage(env.BASE_URL, !!env.NEW_MAILBOX_SECRET), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // POST /dev/incoming — dev-only test route for email processing
    if (path === "/dev/incoming" && request.method === "POST" && env.DEV_MODE === "true") {
      const body = (await request.json()) as IncomingEmail;
      await processEmail(body, env, ctx);
      return new Response("OK", { status: 200 });
    }

    // GET /feeds/{token}.atom — serve Atom feed
    const feedMatch = path.match(/^\/feeds\/([a-zA-Z0-9_-]+)\.atom$/);
    if (feedMatch && request.method === "GET") {
      const obj = await env.FEEDS_BUCKET.get(`feeds/${feedMatch[1]}.atom`);
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(obj.body, {
        headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
      });
    }

    // GET /{token}/{messageId}.html — serve message page
    const msgMatch = path.match(/^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9]+)\.html$/);
    if (msgMatch && request.method === "GET") {
      const obj = await env.FEEDS_BUCKET.get(`messages/${msgMatch[1]}/${msgMatch[2]}.html`);
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(obj.body, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.BASE_URL) return; // silently drop — can't process without config

    // Only process emails addressed to our domain (handles +tag too — endsWith("@domain") matches "foo+bar@domain")
    const expectedDomain = env.BASE_URL.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!message.to.endsWith("@" + expectedDomain)) return;

    const rawEmail = await new Response(message.raw).arrayBuffer();
    const parsed = await new PostalMime().parse(rawEmail);

    const to = message.to;
    const from = message.from;
    const subject = parsed.subject || "(no subject)";
    const html = parsed.html || parsed.text || "";

    await processEmail({ to, from, subject, html }, env, ctx);
  },
};

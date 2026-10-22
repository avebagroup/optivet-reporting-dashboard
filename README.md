# OptiVet reporting dashboard

A read-only reporting page for the OptiVet Solutions GoHighLevel sub-account.
One Node process pulls live data from the GoHighLevel API v2, does the counting,
and serves a single page. The browser only ever receives finished numbers; the
API token never leaves the server.

No npm dependencies. Node 18.17 or newer (built with Node 22).

## Run it

```bash
cd AE_Optivet_Reporting
npm start            # http://localhost:3000
```

Locally it reads the token from the client folder's `.env` one level up
(`GHL_PIT` and `GHL_LOCATION_ID`), so nothing has to be copied. On a host
(Replit Secrets, Render, Railway, Fly, a VPS) set these environment variables:

| Variable | Required | Meaning |
|---|---|---|
| `GHL_TOKEN` | yes | Private Integration Token for the sub-account (`GHL_PIT` also accepted) |
| `GHL_LOCATION_ID` | yes | The sub-account ID (`8DlqIMqCdwwN9KaxhFyv` for OptiVet) |
| `PORT` | no | Default 3000 |
| `DASHBOARD_PASSWORD` | no | If set, the page asks for this password (HTTP Basic auth, any username). Strongly recommended on a public URL: the data-quality table lists real veterans' names. |
| `CACHE_TTL_SECONDS` | no | Default 900 (15 minutes) |
| `DASHBOARD_TZ` | no | IANA timezone for "today" and the daily buckets. Default: the sub-account's own timezone (America/New_York) |
| `MESSAGE_SOURCE` | no | `auto` (default), `export`, or `walk`. See "How calls and SMS are counted" |
| `FIELD_PRODUCT`, `FIELD_FACILITY`, `FIELD_STATE`, `FIELD_POSTAL` | no | Override which custom fields feed each slot (comma-separated field names or IDs) |

The token needs these scopes: `contacts.readonly`, `conversations.readonly`,
`conversations/message.readonly`, `users.readonly`, `locations.readonly`,
`locations/customFields.readonly`. A 401 (bad token) or 403 (missing scope) is
shown as a red banner on the page with the reason.

## Endpoints

| Path | What it returns |
|---|---|
| `/` | The dashboard |
| `/api/report?preset=today\|yesterday\|last7\|month` | The full JSON the page renders |
| `/api/report?from=YYYY-MM-DD&to=YYYY-MM-DD` | Same, custom range (max 92 days). Add `&refresh=1` to bypass the cache |
| `/api/data-quality.csv?from=&to=` | The "leads missing VA location or state" table as CSV |
| `/api/health` | Whether the secrets are present |

The server accepts GET only. Every request to GoHighLevel goes through
`lib/ghl.js`, which refuses anything that is not a GET or `POST /contacts/search`.
There is no code path that creates, updates, deletes, tags, or sends anything.

## What each number means

All dates are local days in the sub-account's timezone.

- **New leads**: contacts whose `dateAdded` falls in the range (`POST /contacts/search` with a `dateAdded` range filter, paginated with `searchAfter`).
- **Products requested**: device requests across those new leads. One lead asking for three devices counts three. Read from "00. Summary of Device Requested" (codes such as `vx, rlt, pmf, ene, vlt, nfb, mdc` are translated to product names); a lead with an empty field falls back to its product tags (`onlux`, `vx therapy`, ...).
- **Calls in / out, SMS in / out**: call and SMS message records dated in the range, by `direction`.
- **Postal mailers**: new leads with "00. Prefers Physical Packet" = Yes, or carrying the `physical mail` / `postcard mailer` / `manual physical mail` tag.
- **Activity per team member**: outbound calls and texts are credited to the `userId` GoHighLevel stamps on the message. Inbound messages carry no user ID, so each one is credited to the teammate who most recently called or texted that contact within the range. Everything else (workflow and bulk sends, inbound with no prior contact) sits in the "Automations / unattributed" row. The page says how many inbound messages were credited this way.
- **Devices by VA facility and product**: new leads grouped by "VA Facility - Standard Name", then "00. VA Medical Center in the State" (first non-empty wins). The note above the table shows what share of new leads have a facility at all; Community Care leads legitimately have none.
- **Data quality**: new leads with no VA facility or no state. State is resolved from "Reporting - VA Medical Center State", "00. VA Medical Center State", "00. Community Center State", then the contact's own State field. The checkbox hides Community Care leads; the CSV includes everything.

Not shown by design: unassigned leads, deals won, appointments, dollar values.

## How calls and SMS are counted

The brief describes `GET /conversations/search` followed by
`GET /conversations/{id}/messages` for each conversation. That works, but in
this account ~700 conversations have activity on a normal day (most of it
workflow email), so a month costs ~15,000 requests, or roughly 25 minutes at
GoHighLevel's limit of 100 requests per 10 seconds.

`GET /conversations/messages/export?channel=SMS|Call&startDate&endDate` returns
the same per-message records (`direction`, `userId`, `messageType`,
`dateAdded`, `conversationId`) 100 at a time, so a month is ~150 requests.
`MESSAGE_SOURCE=auto` (default) uses the export and falls back to the
conversation walk automatically if the export is refused (for example a token
without that scope). `MESSAGE_SOURCE=walk` forces the route from the brief;
the walk stops at 4,000 conversations and says so on the page.

Both routes classify a message as a call when `messageType` is `TYPE_CALL`
(numeric type 1) and as SMS when it is `TYPE_SMS` (type 2).

## Rate limits, caching, retries

- Sliding window of 85 requests per 10 seconds, 8 in flight at once. A month pulls in roughly a minute; a day in a few seconds.
- HTTP 429 and 5xx are retried with exponential backoff (honouring `Retry-After`), up to 4 times.
- Each range is cached in memory for 15 minutes. Concurrent requests for the same range share one pull. The Refresh button forces a new pull.
- The `Version` header is `2021-07-28` for contacts, users, locations and custom fields, and `2021-04-15` for the `/conversations` endpoints (the message export answers 422 with the newer header).

## GoHighLevel quirks found while building this

- The message export sometimes answers `{messages: [], total: 0}` for a query it answered correctly a moment earlier. It is the rule at `limit=200` on spans of a few days, and it still happens now and then at `limit=100`. So the client pulls one local day at a time (four days in flight per channel), retries an empty first page up to four more times with growing pauses, logs each occurrence, and lists any day that stayed empty in the page's warning banner.
- `/conversations/search` pages with `startAfterDate` (the previous page's last `lastMessageDate`), not an offset.
- Inbound calls and texts have no `userId`.
- The product field holds short codes, and the same product appears under several spellings (`onlux`, `rlt`, `red light therapy device`). `lib/fields.js` holds the alias table.

## Files

```
server.js         HTTP server, routes, CSV export, optional password
lib/env.js        secrets (process.env first, ../.env fallback for local dev)
lib/ghl.js        the read-only GoHighLevel client: allow-list, limiter, retries, pagination
lib/fields.js     custom-field resolution and contact decoding
lib/report.js     aggregation into the JSON the page renders
lib/cache.js      15-minute TTL cache with in-flight de-duplication
lib/tz.js         timezone-aware day math (no dependencies)
public/           index.html, style.css, app.js
```

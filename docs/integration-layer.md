# Integration Layer at runcore.sh

## Problem

Core instances run locally. Integrations (Google, Slack, etc.) require:
- Fixed callback URLs for OAuth
- Stable webhook endpoints for push notifications
- Internet-reachable servers for event delivery

Local instances can't provide any of these reliably. Ports change, IPs change, firewalls block inbound connections.

## Solution

runcore.sh becomes the integration layer. It handles the public-facing side of every integration — OAuth flows, webhook endpoints, push notification receivers — and relays everything to the correct Core instance through encrypted envelopes.

Core never needs to be internet-reachable. runcore.sh never sees decrypted brain data.

## Architecture

```
Google/Slack/etc.
       |
       v
  runcore.sh  (stable URLs, OAuth app registration, webhook receiver)
       |
       | encrypted envelopes
       v
  Core instance  (local, any port, any network)
       |
       v
    brain/  (vault stores tokens locally, encrypted)
```

## OAuth Flow

### Registration (one-time, by us)

- Register "Runcore" as an OAuth app with Google, Slack, etc.
- Redirect URI: `https://runcore.sh/oauth/{provider}/callback`
- Client ID and secret stored in runcore.sh's environment (Cloudflare Workers secrets)
- Individual users never create their own OAuth apps

### Connect Flow (per instance)

1. User clicks "Connect Gmail" in Core settings
2. Core generates a one-time `state` token: `{instanceHash}:{nonce}`
3. Core opens browser to `https://runcore.sh/oauth/google/start?state={state}`
4. runcore.sh builds the Google OAuth URL with its own client_id and redirect_uri
5. User completes Google consent screen
6. Google calls `https://runcore.sh/oauth/google/callback?code=...&state=...`
7. runcore.sh exchanges the code for tokens (access_token, refresh_token)
8. runcore.sh encrypts the tokens into an envelope addressed to the instance hash
9. runcore.sh stores the envelope in KV: `oauth-result:{instanceHash}:{nonce}`
10. Core polls `GET /api/relay/oauth-result?instance={hash}&nonce={nonce}`
11. Core receives encrypted envelope, decrypts, stores tokens in local vault
12. Done. Core has Google tokens. runcore.sh discards them.

### Token Refresh

- Core handles refresh locally using the refresh_token
- Core has the client_id (public, safe to embed) but NOT the client_secret
- For refresh, Core calls `POST https://runcore.sh/oauth/google/refresh` with encrypted refresh_token
- runcore.sh decrypts, uses its client_secret to refresh, encrypts new tokens, returns them
- Alternative: runcore.sh sends client_secret to instance once during initial OAuth (encrypted). Instance refreshes directly with Google. Simpler but means client_secret exists on local machine.

### Decision: Where does client_secret live?

Option A: **runcore.sh only** (more secure, runcore.sh mediates all token ops)
- Pro: client_secret never on user machine
- Con: refresh requires roundtrip to runcore.sh, offline = no refresh

Option B: **Sent to instance during OAuth** (simpler, instance is self-sufficient)
- Pro: instance handles refresh independently, works offline
- Con: client_secret on user machine (in encrypted vault)

**Recommendation: Option B.** The vault is encrypted. The machine is the user's own. Local-first means the instance should be self-sufficient. If the vault is compromised, the attacker has the user's Google tokens anyway — the client_secret adds no additional exposure.

## Webhook Flow

### Problem

Google Gmail push notifications, Slack events, and calendar webhooks need a stable URL to POST to. Core instances are local.

### Solution

1. Core registers webhook subscriptions through runcore.sh:
   `POST https://runcore.sh/api/webhooks/register`
   ```json
   {
     "instanceHash": "abc123",
     "provider": "google",
     "type": "gmail-push",
     "topic": "projects/runcore/topics/gmail"
   }
   ```

2. runcore.sh creates the webhook endpoint:
   `https://runcore.sh/webhooks/{instanceHash}/{provider}/{type}`

3. runcore.sh registers this URL with the provider (e.g., Gmail watch API)

4. When a webhook fires:
   - Provider POSTs to `https://runcore.sh/webhooks/{instanceHash}/google/gmail-push`
   - runcore.sh wraps the payload in an encrypted envelope
   - Stores in KV: `webhook:{instanceHash}` (append to queue)
   - Core picks up on next relay poll

5. Core processes the webhook payload locally (fetch new emails, update calendar, etc.)

### Latency

- Relay poll interval: 1.5s
- Worst case webhook delivery: ~1.5s after provider fires
- Acceptable for email/calendar. For real-time needs (Slack messages), consider WebSocket upgrade later.

## Supported Integrations (Phase 1)

| Provider | OAuth Scopes | Webhooks |
|----------|-------------|----------|
| Google Workspace | gmail.modify, calendar.events, drive.file, tasks | Gmail push, calendar push |
| Slack | channels:read, chat:write, users:read | Event subscriptions |

## API Endpoints (runcore.sh)

### OAuth

```
GET  /oauth/{provider}/start?state={instanceHash}:{nonce}
     → Redirects to provider's OAuth consent screen

GET  /oauth/{provider}/callback?code=...&state=...
     → Exchanges code for tokens, stores encrypted result in KV

GET  /api/relay/oauth-result?instance={hash}&nonce={nonce}
     → Core polls for OAuth result, returns encrypted envelope
```

### Webhooks

```
POST /api/webhooks/register
     → Register a webhook subscription for an instance

POST /webhooks/{instanceHash}/{provider}/{type}
     → Receives webhook from provider, queues as encrypted envelope

GET  /api/relay/webhooks?instance={hash}
     → Core drains pending webhook payloads
```

## Security

- **runcore.sh sees tokens momentarily** during the OAuth exchange (code → tokens). This is unavoidable — the code-for-token exchange requires the client_secret which lives on runcore.sh.
- **Tokens are encrypted immediately** after exchange and stored as opaque envelopes. runcore.sh discards the plaintext.
- **Webhook payloads are NOT encrypted** by the provider, so runcore.sh sees them in plaintext. It wraps them in an encrypted envelope before queueing. For truly sensitive webhooks, the payload itself should be a notification ID that Core uses to fetch the full data directly from the provider.
- **Gmail push notifications** only contain a historyId, not email content. Core uses the historyId to fetch actual emails directly from Gmail API. runcore.sh never sees email content.

## Core-side Changes

### Settings UI

Replace the current vault-based credential entry with:

```
Connect Gmail    [Connect]  → opens runcore.sh/oauth/google/start
Connect Slack    [Connect]  → opens runcore.sh/oauth/slack/start
Connect Calendar [Connect]  → (part of Google, same OAuth)
```

Status indicators: Connected (green dot), Not connected (gray), Expired (amber — needs re-auth).

### Token Storage

Tokens stored in vault as before:
- `GOOGLE_ACCESS_TOKEN`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_CLIENT_ID` (public, safe)
- `GOOGLE_CLIENT_SECRET` (Option B: sent during OAuth, encrypted in vault)
- `GOOGLE_TOKEN_EXPIRY`

### Refresh Logic

Existing refresh logic in `src/google/auth.ts` stays the same. It already handles token refresh using stored credentials. Only change: initial token acquisition goes through runcore.sh instead of a local OAuth flow.

### Relay Poll Extension

The existing relay poll loop already checks for envelopes. Add:
- Check for `oauth-result` envelopes → store tokens in vault
- Check for `webhook` envelopes → dispatch to appropriate handler (gmail-timer, slack handler, etc.)

## Identity Model: Agents and Accounts

### Problem

An agent might have its own email (agent@pqrsystems.com) or share email with its human (bryant@...). Same for calendar, Slack, etc. The integration layer needs to support both without hardcoding the relationship.

### Model

Each integration connection is scoped to an **instance**, not a person. An instance is an agent. The agent's identity determines which account it connects to.

```
Bryant (human)
  └─ Dash (instance, shares bryant@gmail.com)
  └─ Cora (instance, own cora@pqrsystems.com)
  └─ Wendy (instance, shares bryant@gmail.com, read-only)
```

### How It Works

- **Own account:** Agent connects OAuth with its own Google account (e.g., agent@pqrsystems.com). Standard flow — one instance, one connection, one set of tokens.

- **Shared account:** Multiple agents connect the same Google account (e.g., bryant@gmail.com). Each instance does its own OAuth flow with the same Google account. Google issues separate tokens per OAuth grant. Each agent has independent access to the same mailbox.

- **Scoped access:** An agent sharing a human's email can be limited by the instance's access manifest — e.g., Wendy gets gmail.readonly, Dash gets gmail.modify. The OAuth scope requested during the connect flow is determined by the agent's role, not the account.

### OAuth Scope per Agent Role

| Role | Gmail | Calendar | Drive |
|------|-------|----------|-------|
| Founder (Dash) | modify | events | file |
| Template (Cora) | modify (own account) | events | file |
| Operator (Wendy) | readonly (shared) | events.readonly | — |
| Observer (Marvin) | readonly | readonly | — |

The scope is passed in the OAuth start request:
```
GET /oauth/google/start?state={instanceHash}:{nonce}&scopes=gmail.readonly,calendar.events.readonly
```

runcore.sh includes the requested scopes in the Google OAuth URL. Google's consent screen shows exactly what access is being granted.

### Webhook Routing

When multiple agents share an account, webhooks (Gmail push, calendar changes) fire once per account. runcore.sh needs to know which instances are subscribed to that account.

```
POST /api/webhooks/register
{
  "instanceHash": "abc123",
  "provider": "google",
  "type": "gmail-push",
  "accountEmail": "bryant@gmail.com"
}
```

When a Gmail push arrives for bryant@gmail.com, runcore.sh fans out the notification to all instances subscribed to that account. Each instance independently fetches what it needs based on its own tokens and access level.

### Dev/UAT/Prod Environments

Every environment is just another instance hash. A dev instance on localhost and a prod instance on a server both go through the same runcore.sh OAuth flow. No separate Google Cloud projects, no ngrok, no port forwarding.

```
Dev  (localhost:4001) → instanceHash: dev_abc  → runcore.sh/oauth/google/start
UAT  (localhost:4002) → instanceHash: uat_def  → runcore.sh/oauth/google/start
Prod (server:3577)    → instanceHash: prod_ghi → runcore.sh/oauth/google/start
```

Google sees one registered app. Each environment gets its own tokens. Tear down a dev instance, its tokens expire naturally.

## Migration

1. Keep existing direct OAuth flow as fallback (for users who self-host or don't use runcore.sh)
2. Default new connections to runcore.sh OAuth
3. Existing vault credentials continue to work — no migration needed

## Not In Scope

- Multi-tenant OAuth (each user gets their own Google Cloud project) — we're one app, one registration
- OAuth for providers beyond Google and Slack (Phase 1)
- Real-time WebSocket relay for low-latency webhooks (future)
- Consent/permission UI for what data the integration accesses (Google's consent screen handles this)

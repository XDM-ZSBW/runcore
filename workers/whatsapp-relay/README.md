# WhatsApp Relay Worker

Cloudflare Worker that sits between Twilio and the Dash server. It receives
WhatsApp webhook events at the edge, verifies the Twilio signature, and relays
the payload to the Dash server over a secure channel.

## Architecture

```
WhatsApp User
     │
     ▼
  Twilio
     │  POST /api/twilio/whatsapp (signed with HMAC-SHA1)
     ▼
  Cloudflare Worker (this)
     │  1. Verify Twilio signature
     │  2. Sign payload with RELAY_SECRET
     │  3. POST /api/relay/whatsapp to Dash server
     │  4. Return empty TwiML to Twilio immediately
     ▼
  Dash Server
     │  1. Verify relay signature (HMAC-SHA256)
     │  2. Process message through Brain/LLM pipeline
     │  3. Send reply via Twilio REST API
     ▼
WhatsApp User (receives reply)
```

## Why a relay?

- **Edge verification**: Twilio signatures are verified at Cloudflare's edge,
  reducing load and latency on the Dash server.
- **No public exposure**: The Dash server doesn't need to be directly exposed
  to the internet. Only the Worker's URL is public-facing.
- **Instant TwiML response**: The Worker responds to Twilio immediately (empty
  TwiML), avoiding the 15-second timeout. The Dash server processes
  asynchronously and sends the reply via the Twilio REST API.
- **Decoupled scaling**: The Worker scales independently at Cloudflare's edge.

## Setup

### 1. Install dependencies

```bash
cd workers/whatsapp-relay
npm install
```

### 2. Configure secrets

```bash
# Twilio auth token (same one used by Dash server)
npx wrangler secret put TWILIO_AUTH_TOKEN

# Shared secret between Worker and Dash server (generate with: openssl rand -hex 32)
npx wrangler secret put RELAY_SECRET

# Dash server origin (where the Worker relays messages to)
npx wrangler secret put DASH_SERVER_URL
```

**Important**: The same `RELAY_SECRET` value must be set in both the Worker
secrets and the Dash server's environment/vault.

### 3. Add RELAY_SECRET to Dash server

Add `RELAY_SECRET` to the Dash vault so the server can verify relay signatures:

```bash
# Via the Dash API (if server is running):
curl -X POST http://localhost:3000/api/vault/set?sessionId=YOUR_SESSION \
  -H "Content-Type: application/json" \
  -d '{"name": "RELAY_SECRET", "value": "your-shared-secret-here"}'
```

Or set it as an environment variable: `RELAY_SECRET=your-shared-secret-here`

### 4. Deploy

```bash
npx wrangler deploy
```

This outputs the Worker URL, e.g. `https://dash-whatsapp-relay.<your-subdomain>.workers.dev`

### 5. Configure Twilio

In the Twilio Console:
1. Go to **Messaging > WhatsApp > Sandbox** (or your production sender)
2. Set the webhook URL to: `https://dash-whatsapp-relay.<subdomain>.workers.dev/api/twilio/whatsapp`
3. Method: **POST**

## Development

```bash
# Run locally (proxied through Cloudflare's runtime)
npx wrangler dev

# View live logs from deployed Worker
npx wrangler tail
```

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/api/twilio/whatsapp` | POST | Twilio webhook (receives WhatsApp messages) |
| `/health` | GET | Health check (`{ ok: true, service: "whatsapp-relay" }`) |

## How it works

1. **Twilio sends** a POST to `/api/twilio/whatsapp` with the message payload
   and an `X-Twilio-Signature` header.

2. **The Worker verifies** the Twilio signature using HMAC-SHA1 (Web Crypto API)
   with `TWILIO_AUTH_TOKEN`.

3. **The Worker relays** the raw form body to the Dash server at
   `{DASH_SERVER_URL}/api/relay/whatsapp` with:
   - `X-Relay-Signature`: HMAC-SHA256 hex of `{timestamp}.{body}` using `RELAY_SECRET`
   - `X-Relay-Timestamp`: Unix timestamp (seconds)
   - The relay is fire-and-forget via `ctx.waitUntil()`.

4. **The Worker responds** to Twilio with empty TwiML immediately.

5. **The Dash server** verifies the relay signature, processes the message
   through the Brain/LLM pipeline, and sends the reply via the Twilio REST API.

## Compared to direct Twilio integration

The Dash server still supports direct Twilio webhooks at `/api/twilio/whatsapp`.
The relay is an alternative deployment option — you can use either or both:

| Feature | Direct (`/api/twilio/whatsapp`) | Relay (`/api/relay/whatsapp`) |
|---------|-------------------------------|------------------------------|
| Twilio webhook URL | Dash server URL | Worker URL |
| Signature verification | Twilio HMAC-SHA1 | Relay HMAC-SHA256 |
| Server exposure | Public internet | Can be private/tunneled |
| Response to Twilio | Inline (within 15s) | Immediate (empty TwiML) |
| Processing | Synchronous | Asynchronous |

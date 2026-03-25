# OpenAI Compat Proxy

A small Cloudflare Worker that exposes OpenAI-compatible endpoints and forwards
client auth.

## What It Does

- Exposes `GET /v1/models`
- Exposes `POST /v1/chat/completions`
- Converts OpenAI Chat Completions requests into upstream `responses` requests
- Converts upstream `responses` streaming events back into OpenAI chat chunks
- Forwards the client's own auth headers upstream directly

## Auth Behavior

This project does not use local API key config anymore.

The Worker simply forwards these headers from the client to the upstream:

- `Authorization`
- `x-api-key`
- `x-goog-api-key`

So the client must send a valid upstream key on every request.

## Environment Variables

- `UPSTREAM_BASE_URL`
  - "https://api.example.com"
- `ALLOWED_ORIGIN`
  - Optional
  - Defaults to `*`

## Supported Endpoints

- `GET /v1/models`
- `POST /v1/chat/completions`

## Current Limitations

- Only supports `n = 1`
- No `response_format`
- No `logprobs`
- No `seed`
- No audio or other non-chat OpenAI endpoints

## Local Development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

## Example

```bash
curl https://your-worker.example.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_UPSTREAM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [
      { "role": "user", "content": "Say hello in one sentence." }
    ],
    "stream": false
  }'
```

## Notes

- The Worker does protocol conversion only.
- Authentication is entirely controlled by the client request.
- If the client does not send a valid upstream key, the upstream will return an error.

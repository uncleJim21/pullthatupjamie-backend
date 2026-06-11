# Tape v2 — Frontend Auth & Personalization Guide

How Tape auth works after v2 (accounts-only), and what the frontend needs to change.

## TL;DR for the frontend

1. **No Tape login, no shared password, no token exchange.** There is no `/api/tape/auth`.
2. **Send the main-app JWT** (the `auth_token` from the auth server, in `localStorage`) as `Authorization: Bearer <auth_token>` on **every** `/api/tape/*` request — exactly like any other authenticated app API.
3. **Access is gated by an entitlement.** The user must have the **`tape-basic-user`** grant (admin-granted, server-side). Without it → **403 `not-entitled`**. Invalid/missing token → **401**.
4. **New endpoint:** `GET /api/tape/feed` → personalized "for you" (recommended tickers + Brief topics).
5. **Persona** is saved via the existing `PUT /api/preferences` (`tapePersona`); it steers *what's recommended and kept warm*, not the wording of results.

## Auth flow

```
auth server ──> main-app auth_token (localStorage, already exists)
        │
        ▼  send on EVERY tape call
GET/POST /api/tape/*    Headers: Authorization: Bearer <auth_token>
        ├─ 200  → normal response
        ├─ 401  → token missing/invalid/expired  → send user to login
        └─ 403 not-entitled → valid user without the tape-basic-user grant
```

That's the whole flow — no exchange step, no second token to store/refresh. You reuse the same `auth_token` you already attach to other authenticated endpoints.

### Pseudocode
```js
function tapeFetch(path, opts = {}) {
  const appToken = localStorage.getItem("auth_token");
  return fetch(`${API}/api/tape${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${appToken}`, ...(opts.headers||{}) },
  });
}

const r = await tapeFetch("/feed");
if (r.status === 401) return goToLogin();
if (r.status === 403) return showTapeNotEnabled();   // lacks tape-basic-user
const feed = await r.json();
```

## Entitlement gating (the 403 to handle)

Only users with **`tape-basic-user`** may use Tape. Every `/api/tape/*` route enforces it:
- Missing/invalid main-app token → **401 `auth-failed`**.
- Valid user without the grant → **403 `not-entitled`**.

Treat 403 `not-entitled` as "this account isn't enabled for Tape" — show an explainer / request-access CTA, not a generic error. Granting is server-side per account; the frontend can't self-serve it. Gate the Tape entry point in the UI on whether the user is signed in (you won't know entitlement until the first call returns 200 vs 403 — handle both).

## Persona (personalization)

Free text the user writes (e.g. *"I trade NVDA & MSFT, watch Macro Voices, bearish on AI capex"*), saved on the existing preferences endpoint (main-app auth — same `auth_token`):

```
PUT /api/preferences   { "preferences": { "tapePersona": "I trade NVDA, watch Macro Voices, bearish on AI capex" } }
GET /api/preferences   → preferences.tapePersona + preferences.tapePersonaSignals { tickers, shows, themes }
```
- Backend sanitizes (PII/markup/length) and extracts the signals.
- Saving a persona **auto-warms** that user's tickers (their Read-Ins go hot within minutes) — no frontend action.
- It does **not** rewrite the synthesis — the NVDA Read-In is the same shared artifact for everyone. Persona changes *what we recommend and pre-warm*, not the prose. (A "written-for-me" mode is a future premium tier.)

### Persona drawer UX (suggested)
- Show the persona textarea for signed-in (entitled) users.
- Open it on first use when `tapePersona` is empty.
- Re-fetch `/api/tape/feed` after a persona save.

## The feed

```
GET /api/tape/feed
→ {
    personaApplied: true|false,
    tickers: [ { ticker, name, reason: "persona"|"generic", ready: true|false }, ... ],
    briefs:  [ { title, query, personalized: true|false, matched?: [...] }, ... ]
  }
```
- `tickers[].ready === true` → that Read-In is cached (instant on click) — surface/flag these first.
- `tickers[].reason === "persona"` → surfaced from the user's persona.
- `briefs[].query` → pass to `POST /api/tape/brief` when the user opens it.
- No persona → a sensible generic list.

## What changed for the frontend — checklist
- [ ] **Remove** any `/api/tape/auth` call + Tape-token storage. Just attach the main-app `auth_token` to every `/api/tape/*` request.
- [ ] **Handle 403 `not-entitled`** (and 401) → "Tape not enabled" / login UI.
- [ ] Persona drawer → `PUT /api/preferences { preferences: { tapePersona } }`.
- [ ] New **`GET /api/tape/feed`** home/"for you" surface; re-fetch after persona save; honor `ready`.
- [ ] Optional: "personalized" indicator when `feed.personaApplied` is true.

## Error shapes (RFC-7807-ish)
```
401 { type:".../tape/auth-failed",  title, status:401, detail }   // missing/invalid main-app token
403 { type:".../tape/not-entitled", title, status:403, detail }   // no tape-basic-user grant
```

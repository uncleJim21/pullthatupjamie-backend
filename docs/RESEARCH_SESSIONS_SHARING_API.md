## Research Sessions Sharing API

This document describes how a client (CLI, backend, or headless script) should create and analyze shared research sessions.

Shared sessions are **immutable snapshots** of an existing `ResearchSession` and include a static layout plus a generated preview image suitable for social link previews.

---

## 1. Terminology

- **ResearchSession**: The working session created and updated via `/api/research-sessions`.
- **SharedResearchSession**: An immutable snapshot created from a `ResearchSession` via `/api/research-sessions/:id/share`.
- **Owner**: Either an authenticated `userId` (JWT) or an anonymous `clientId`.

---

## 2. Ownership & auth

All research-session routes share the same ownership model:

- **Authenticated owner**: Provide a `Bearer` JWT in the `Authorization` header. The email in the token must match the `User` associated with the `ResearchSession`.
- **Anonymous owner**: Provide a `clientId` string (stable browser/device ID) via:
  - Query string: `?clientId=clientid1234`, or
  - Header: `X-Client-Id: clientid1234`, or
  - JSON body field: `{ "clientId": "clientid1234" }`.

The share endpoint will return `404`/`403` if the resolved owner does not match the underlying `ResearchSession`.

---

## 3. Creating a research session (prerequisite)

You must first create a `ResearchSession`.

### Endpoint

- **POST** `/api/research-sessions`

### Request body

```json
{
  "clientId": "clientid1234",           // optional when using JWT auth
  "pineconeIds": ["clip-1", "clip-2"], // ordered list
  "lastItemMetadata": {                   // optional
    "title": "Last item title",
    "episode": "Episode name"
  }
}
```

Notes:

- `pineconeIds` must be a **non-empty array of strings**.
- The backend will **de-duplicate** IDs while preserving order and enforce a **hard limit of 50 unique IDs** per session.

### Example (anonymous owner)

```bash
curl -s -X POST "http://localhost:4132/api/research-sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "clientid1234",
    "pineconeIds": ["clip-1", "clip-2"],
    "lastItemMetadata": {"title": "Test Session Last Item","episode": "Test Episode"}
  }'
```

Successful response (truncated):

```json
{
  "success": true,
  "data": {
    "id": "<RESEARCH_SESSION_ID>",
    "ownerType": "client",
    "clientId": "clientid1234",
    "pineconeIds": ["clip-1", "clip-2"],
    "items": [
      {"pineconeId": "clip-1", "metadata": null},
      {"pineconeId": "clip-2", "metadata": null}
    ],
    ...
  }
}
```

You will use `<RESEARCH_SESSION_ID>` in the sharing call.

---

## 4. Creating a shared session snapshot

### Endpoint

- **POST** `/api/research-sessions/:id/share`

Where `:id` is the `ResearchSession` id.

### Request body

```json
{
  "title": "Optional share title",  // optional; backend can derive a title
  "visibility": "unlisted",         // "public" | "unlisted" (default: "unlisted")
  "nodes": [                         // REQUIRED, final layout from client
    {
      "pineconeId": "clip-1",      // must match an id from the ResearchSession
      "x": 10,
      "y": 5,
      "z": -3,
      "color": "#ffcc00"           // #RRGGBB or #RRGGBBAA
    },
    {
      "pineconeId": "clip-2",
      "x": -8,
      "y": -2,
      "z": 4,
      "color": "#00aaff"
    }
  ],
  "camera": {                        // optional
    "distance": 4.0,
    "tilt": 35,
    "rotation": 45
  }
}
```

### Validation rules

- **Node count**:
  - `nodes` must be a **non-empty array**.
  - Maximum node count is controlled by `RESEARCH_SESSION_SHARE_MAX_NODES` (default `100`).
  - Duplicate `pineconeId` entries are **removed**; if all nodes are duplicates, the request fails.
- **Coordinates**:
  - `x`, `y`, `z` must be finite numbers.
  - Each coordinate must be within `[-RESEARCH_SESSION_SHARE_MAX_COORD, RESEARCH_SESSION_SHARE_MAX_COORD]` (default `[-10000, 10000]`).
- **Color**:
  - Only `#RRGGBB` and `#RRGGBBAA` hex strings are accepted.
- **Visibility**:
  - If not provided or invalid, defaults to `"unlisted"`.
- **Ownership**:
  - The caller must resolve to the same owner (`userId` or `clientId`) as the base `ResearchSession`.

### Title resolution

- If you pass a non-empty `title`, that value is used.
- Otherwise, the backend derives a default using the `ResearchSession`’s `lastItemMetadata`:
  - Prefer `headline` or `title`
  - Then `episode`
  - Then `summary`
  - Finally, fallback: `"Podcast Research Session"`

### Behavior

1. Validate owner and load the base `ResearchSession`.
2. Validate and sanitize `nodes` (de-duplicate, bounds, color format).
3. Resolve the share `title`.
4. Create a `SharedResearchSession` snapshot with:
   - `researchSessionId`, `userId`, `clientId`
   - `shareId` (short, URL-safe id) and `shareUrl`
   - `title`, `visibility`
   - `nodes` and optional `camera`
   - `lastItemMetadata` copied from the base session
   - `previewImageUrl: null` initially
5. Generate a preview PNG and upload to Spaces/CDN under:
   - `shared-sessions/{shareId}/preview.png`
6. Update the snapshot with `previewImageUrl`.
7. Return a 201 response.

### Example (anonymous owner)

```bash
curl -i -X POST "http://localhost:4132/api/research-sessions/RESEARCH_SESSION_ID/share?clientId=clientid1234" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Sunlight & Mitochondria Session",
    "visibility": "unlisted",
    "nodes": [
      {"pineconeId": "clip-1", "x": 10, "y": 5, "z": -3, "color": "#ffcc00"},
      {"pineconeId": "clip-2", "x": -8, "y": -2, "z": 4, "color": "#00aaff"}
    ]
  }'
```

Successful response (example):

```json
{
  "success": true,
  "data": {
    "shareId": "5c49cc14ab83",
    "shareUrl": "https://pullthatupjamie.ai/share-session/5c49cc14ab83",
    "previewImageUrl": "https://<spaces-bucket>/shared-sessions/5c49cc14ab83/preview.png"
  }
}
```

The **shareId** and URLs are stable and the snapshot is immutable.

---

## 5. Preview image semantics

The preview image generated for each shared session has these characteristics:

- **Rendering**:
  - Fixed canvas size: `1200x630` (Open Graph friendly).
  - **Constellation**: nodes plotted from the provided `x,y,z` using a fixed normalization and projection.
  - Background is a dark, minimal theme with no UI chrome.
- **Bottom banner**:
  - Left: circular thumbnail derived from the last item’s cover art (`episodeImage` or similar).
  - If cover art cannot be fetched quickly, a local placeholder image is used.
  - Right: resolved `title` and a subtitle line exactly:
    - `Podcast Mind Map`

The `previewImageUrl` returned in the share response can be used directly in `og:image` or similar meta tags on your frontend.

---

## 6. Analyzing a research session with AI

Although not strictly part of sharing, you can analyze the underlying `ResearchSession` using a streaming AI endpoint.

### Endpoint

- **POST** `/api/research-sessions/:id/analyze`

### Request body

```json
{
  "instructions": "Optional extra instructions for the analysis."
}
```

### Output format

The endpoint streams plain text in this format:

```text
TITLE: <concise title, max 8 words>

<streamed analysis...>
```

- Line 1: `TITLE: ...` – easy for clients to parse and show immediately.
- Line 2: blank.
- Subsequent lines: full analysis.
- When the model references specific items and both audio URL and start time are known, it appends inline sources like:

```text
... discussion of mitochondrial activation https://example-bucket/clip.mp3#t=1919
```

### Example (anonymous owner)

```bash
curl -N -X POST "http://localhost:4132/api/research-sessions/RESEARCH_SESSION_ID/analyze?clientId=clientid1234" \
  -H "Content-Type: application/json" \
  -d '{"instructions":"Summarize main themes and suggest next research questions."}'
```

Clients should read the first line as the title, then stream/accumulate the rest as the body of the analysis.

# Interpretive Lens

The Interpretive Lens lets you tell the AI which medical experts, researchers, or scientific frameworks to draw on when analyzing your results. Instead of a one-size-fits-all interpretation, the AI considers the perspective of the thinkers and paradigms you care about.

## Where to Find It

The Interpretive Lens appears as a **full-width card with a purple left border** near the top of the dashboard, just above the Focus Card. Click it to open the editor.

## What to Write

The lens is a free-form text field. Write the names of experts, schools of thought, or scientific paradigms you want the AI to keep in mind. Examples:

- Names of specific researchers or clinicians (e.g., practitioners focused on functional medicine, mitochondrial biology, hormesis, or longevity research)
- Scientific frameworks (e.g., circadian biology, evolutionary medicine, ancestral health)
- Dietary or lifestyle philosophies you follow
- Any combination of the above

::: tip
The AI does not need you to explain who these people are. If it knows their published work, it will apply their perspective to your data automatically.
:::

## How It Shapes AI Analysis

Every AI interaction in getbased — the Focus Card, the chat panel, and per-marker explanations — includes your Interpretive Lens in the context. The AI will:

- Frame its analysis through the paradigms you listed
- Draw on the research traditions those experts represent
- Flag where your results align or conflict with those frameworks
- Prioritize the markers and factors those frameworks consider important

## Example

If you write something like *"circadian biology, UV and mitochondrial health, ancestral diet"* in your lens, the AI will consider light exposure, vitamin D, and metabolic markers through that framework rather than giving you a standard conventional-medicine reading.

## Editing and Saving

Click the card to open the editor. Type or paste your lens text, then click **Save**. The card updates immediately on the dashboard.

The Interpretive Lens is included in your [JSON export](/guide/json-export-import) and restored on import.

## Custom Knowledge Source (RAG)

The lens text is a name-level bias. If you want the AI to reason from actual framework excerpts — textbook passages, essays, clinical notes — point it at your own Retrieval-Augmented Generation (RAG) endpoint.

When configured, every chat question and focus card insight triggers a query to your endpoint. getbased sends the question verbatim, receives the most relevant framework chunks, and splices them into the Interpretive Lens block before the AI reads your lab data. The AI then interprets your results through those excerpts and cites them back to you.

### Setup

1. Open **Settings → AI → Custom Knowledge Source**
2. Toggle **Enable Custom Knowledge Source**
3. Enter a display name (e.g., *Bredesen Protocol*)
4. Enter your endpoint URL (HTTPS, or `http://localhost` for development)
5. Enter your API key (encrypted at rest)
6. Set the number of chunks to retrieve per query (`top_k`, default 5)
7. Click **Save & Test** — a check query runs and confirms connectivity

When active, a **Lens** badge appears in the chat header. Click it to jump to settings.

### What leaves your browser

Each AI question (the user message in chat, or a compact summary of your focus card state) is sent to your endpoint with `Bearer` auth. No lab values, profile details, or other private data go to the RAG — only the question itself. Choose an endpoint you control or trust.

### Endpoint contract

Your server must implement a single `POST` route returning relevant chunks.

**Request:**
```http
POST /your-endpoint
Authorization: Bearer <your-api-key>
Content-Type: application/json

{ "version": 1, "query": "what could drive a rising ferritin?", "top_k": 5 }
```

**Response (200):**
```json
{
  "chunks": [
    { "text": "Elevated ferritin in the absence of anemia often...", "source": "Bredesen 2020, p.142" },
    { "text": "Inflammatory ferritin elevation is typically...", "source": "Case study #47" }
  ]
}
```

**Error response (non-200):**
```json
{ "error": "rate limit exceeded" }
```

**Constraints:**
- **HTTPS required** except for `localhost` / `127.0.0.1`
- **Max response size**: 32 KB (larger responses are rejected)
- **Max chunks**: 10 (client truncates)
- **CORS**: your server must send `Access-Control-Allow-Origin: *` (or the getbased origin)
- **Timeout**: 5 seconds — slower responses fall back to unenriched AI
- **No redirects**: 3xx responses are rejected (prevents Bearer header leaking)

### Example server (FastAPI)

```python
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST"], allow_headers=["*"])

API_KEY = "your-shared-secret"

class Query(BaseModel):
    version: int = 1
    query: str
    top_k: int = 5

@app.post("/query")
def query(q: Query, authorization: str = Header(None)):
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(401, "unauthorized")
    # Your retrieval logic here — embed q.query, search your vector DB, return top_k
    chunks = [{"text": "...", "source": "..."}]
    return {"chunks": chunks[:q.top_k]}
```

### Example server (Express)

```javascript
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*', methods: ['POST'] }));
app.use(express.json());

const API_KEY = 'your-shared-secret';

app.post('/query', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) return res.status(401).json({ error: 'unauthorized' });
  const { query, top_k = 5 } = req.body;
  // Your retrieval logic here
  const chunks = [{ text: '...', source: '...' }];
  res.json({ chunks: chunks.slice(0, top_k) });
});

app.listen(8000);
```

### Caching

getbased caches each query for 5 minutes (up to 20 entries, scoped per profile). Switching profiles, changing the config, or clicking **Clear cache** in settings flushes the cache.

### Disabling

Toggle **Enable Custom Knowledge Source** off to pause retrieval without losing your config. The lens badge disappears from the chat header, and subsequent AI calls use only the name-level lens text above.

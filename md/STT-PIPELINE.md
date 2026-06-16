# June — STT Pipeline Handoff

Speech-to-text path for June: browser mic capture → WebSocket → Deepgram Flux → turn
events → session state machine → downstream LLM. This doc covers **STT only** (not LLM/TTS).

See also: [`PIPELINE.md`](./PIPELINE.md) for the full voice loop.

---

## Summary

June uses **Deepgram Flux** (`flux-general-en`) on the **`/v2/listen`** WebSocket endpoint.
Flux replaces a separate VAD + endpointing stack: it emits conversation-native turn events
(`StartOfTurn`, `Update`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`) that drive when
the agent listens, thinks, and responds.

Audio is captured in the browser at the device sample rate, resampled to **16 kHz linear16**,
chunked at **~80 ms**, and streamed to the Node server, which forwards raw bytes to Deepgram.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Browser — js/voice-client.js                                                │
│                                                                             │
│  getUserMedia (echoCancellation, noiseSuppression, autoGainControl)         │
│       │                                                                     │
│       ▼                                                                     │
│  AudioWorklet capture-processor  →  Float32 frames @ device rate            │
│       │                                                                     │
│       ▼                                                                     │
│  Resample → Int16 linear16 @ 16 kHz, ~1280 samples/chunk (80 ms)          │
│       │                                                                     │
│       │  gated when: paused | suppressMic (SPEAKING) | ws closed           │
│       ▼                                                                     │
│  WebSocket /voice  (binary frames)                                          │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Server — server.js → lib/session.js → lib/sttFlux.js                        │
│                                                                             │
│  handleAudio(chunk) → FluxStream.sendAudio(chunk)                           │
│       │                                                                     │
│       ▼                                                                     │
│  wss://api.deepgram.com/v2/listen?model=flux-general-en&...                 │
│       │                                                                     │
│       ▼                                                                     │
│  TurnInfo JSON events → #onTurn() → transcript + state updates to client    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File map

| File | Role |
| --- | --- |
| `js/voice-client.js` | Mic permission, capture, resample, chunking, mic gating, interim/final UI |
| `server.js` | WebSocket `/voice`; routes binary → `session.handleAudio()` |
| `lib/sttFlux.js` | Deepgram Flux WebSocket client; emits `turn` events |
| `lib/session.js` | Turn event handler, duplicate guards, speculative LLM kickoff, client transcripts |
| `lib/states.js` | `FluxEvent` constants, STT env config (`sttSampleRate`, EOT thresholds) |
| `lib/thought-agent.js` | Background agent fed by partial transcripts (not STT itself) |

---

## Browser capture (`js/voice-client.js`)

### Mic permission & constraints

Triggered when the user clicks the orb (or sends typed text with no active session).

```javascript
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
});
```

| Constraint | Purpose |
| --- | --- |
| `echoCancellation` | Browser AEC — reduces speaker→mic bleed when June plays TTS through the same device |
| `noiseSuppression` | Browser NS — attenuates steady background noise |
| `autoGainControl` | Browser AGC — normalizes input level |
| `channelCount: 1` | Mono downmix before encode |

These are **WebRTC/browser DSP**, not custom DSP in this repo. Quality varies by browser/OS
(Chrome on macOS generally strongest). There is no server-side echo reference signal.

### AudioWorklet capture

An inline worklet (`capture-processor`) reads float32 PCM from the mic graph and posts
frames to the main thread. The worklet is **not** connected to speakers (capture-only path).

### Resampling & encoding

Constants:

```javascript
const STT_RATE = 16000;
const CHUNK_SAMPLES = STT_RATE * 0.08;  // 1280 samples = 80 ms @ 16 kHz
```

Pipeline per frame:

1. Accumulate float32 samples from worklet at `inCtx.sampleRate` (often 44100 or 48000).
2. Downsample to 16 kHz via nearest-neighbor pick (`Math.floor(i * ratio)`).
3. Clamp to [-1, 1], convert to **Int16 linear16** (little-endian).
4. Send when buffer ≥ `CHUNK_SAMPLES`.

Deepgram recommends **~80 ms chunks** for Flux latency and model performance. This project
matches that target.

### Mic gating (echo / feedback prevention)

Mic frames are **not sent** when any of these are true:

| Gate | Where set | Why |
| --- | --- | --- |
| `!running` | `stopVoice()` | Session ended |
| `paused` | `pauseVoice()`, orb pause, server `PAUSED` | User paused voice |
| `suppressMic` | `handleState('SPEAKING')` | Half-duplex while June speaks — stops TTS from re-entering STT |
| WebSocket not open | connection loss | Avoid orphaned audio |

`suppressMic` is cleared on `LISTENING` and `pauseVoice()`.

**Server-side mirror:** while `state === SPEAKING`, `session.js` ignores
`StartOfTurn` and `EagerEndOfTurn` so late-arriving Deepgram events from buffered audio
do not abort playback.

Together, browser AEC + half-duplex gating + server SPEAKING guard reduce the classic
“June hears herself” failure mode.

### Client duplicate transcript guard

Before rendering a user message, the client dedupes identical normalized text within **4 s**
(mirrors server logic). Prevents double bubbles from duplicate final events.

---

## WebSocket transport

**Endpoint:** `ws://localhost:3000/voice` (or `wss://` behind TLS)

### Client → server

| Payload | Type | Handler |
| --- | --- | --- |
| Raw mic PCM | **binary** | `session.handleAudio()` → Deepgram |
| `{ type: "init", memory, context }` | JSON | Session memory bootstrap |
| `{ type: "text", text }` | JSON | **Bypass STT** — inject user turn as if transcribed |
| `{ type: "resume" }` | JSON | Unpause server session |

### Server → client (STT-related)

| Message | When |
| --- | --- |
| `{ type: "ready", capabilities: { stt, llm, tts } }` | Session start |
| `{ type: "state", state, turnId }` | `LISTENING` / `THINKING` / `SPEAKING` / `PAUSED` |
| `{ type: "transcript", role: "user", text, final }` | Partial (`final: false`) or final transcript |
| `{ type: "error", source: "stt", message }` | Deepgram connection/parse errors |
| `{ type: "interrupt", turnId }` | Generation aborted (barge-in, new turn, etc.) |

Partial transcripts render in `#interim`; finals clear interim and append a chat bubble.

---

## Deepgram Flux API (`lib/sttFlux.js`)

### Connection

```
wss://api.deepgram.com/v2/listen
  ?model=flux-general-en
  &encoding=linear16
  &sample_rate=16000
  &eager_eot_threshold=0.5
  &eot_threshold=0.7
  &eot_timeout_ms=3000
```

**Auth header:**

```
Authorization: Token <DEEPGRAM_API_KEY>
```

**Important:** Flux requires **`/v2/listen`**. `/v1/listen` will not work.

Docs: [Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart),
[EOT parameters](https://developers.deepgram.com/docs/flux/configuration),
[Eager EOT guide](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot)

### Audio format

| Field | Value in June |
| --- | --- |
| Encoding | `linear16` (16-bit signed LE PCM) |
| Sample rate | `16000` Hz (`STT_SAMPLE_RATE`) |
| Channels | Mono |
| Container | None (raw bytes on WebSocket) |
| Chunk size | ~80 ms (1280 samples) |

### Inbound messages (Deepgram → server)

Flux sends JSON. June handles:

```json
{
  "type": "TurnInfo",
  "event": "EndOfTurn",
  "transcript": "hey june what's up",
  "turn_index": 3,
  "end_of_turn_confidence": 0.82
}
```

`sttFlux.js` maps this to a `turn` event:

```javascript
{
  event,           // FluxEvent string
  transcript,      // string
  turnIndex,       // number
  endConfidence,   // from end_of_turn_confidence
}
```

Errors:

```json
{ "type": "Error", "description": "..." }
```

### Outbound audio (server → Deepgram)

Raw binary chunks via `ws.send(chunk)`. Pre-connect audio is queued in `preBuffer` until
the socket opens.

### Close

On session end, sends `{ type: "CloseStream" }` then closes the WebSocket.

---

## Turn events → session actions (`lib/session.js`)

Defined in `lib/states.js` as `FluxEvent`:

| Deepgram event | Session action |
| --- | --- |
| `StartOfTurn` | **Barge-in** (unless `SPEAKING`): abort LLM/TTS, abort thought agent → `LISTENING` |
| `Update` | Forward partial transcript to client; schedule background thought agent |
| `EagerEndOfTurn` | Start **speculative** LLM (buffer tokens, no TTS yet) if not duplicate |
| `TurnResumed` | Discard speculative draft, abort LLM → `LISTENING` |
| `EndOfTurn` | Emit final transcript; confirm speculative gen if transcript matches, else restart |

### Speculative (eager) flow

```
User speaking
    │
    ├─ EagerEndOfTurn ──▶ #processUserTurn({ speculative: true })
    │                         LLM streams into gen.buffer (no TTS, no client deltas)
    │
    ├─ TurnResumed ─────▶ #abortGeneration() — user kept talking
    │
    └─ EndOfTurn ───────▶ if gen.userText === transcript → #confirmGeneration()
                              else abort + #processUserTurn({ speculative: false })
```

On confirm: commit user to history, open TTS, flush buffer to client/TTS.

**Cost note:** Eager mode can increase LLM calls ~50–70% (Deepgram guidance) due to
cancelled drafts.

### Text input bypass

`handleText()` skips Deepgram entirely:

1. Sends `{ type: "transcript", role: "user", text, final: true }` to client.
2. Calls `#processUserTurn(text, { speculative: false, fromText: true })`.
3. If session is paused, `keepPaused: true` — LLM runs but TTS may be suppressed.

---

## Echo & duplicate guards (`lib/session.js`)

### Duplicate turn suppression

Prevents the same utterance from triggering twice (echo, Flux retries, eager+final overlap).

```javascript
#normalizeTranscript(text)  // trim, lower, collapse whitespace
#isRecentDuplicate(text, lastText, lastAt, windowMs = 4000)
```

Applied in:

- `#isRecentDuplicateTurn()` — blocks `EagerEndOfTurn` / `EndOfTurn` processing
- `#emitFinalTranscript()` — skips duplicate final client messages; tracks `emittedFinalTurnIndex`

After a user turn is committed, `lastCommittedUserText` / `lastCommittedUserAt` are updated.

### Barge-in vs echo during playback

| Layer | Mechanism |
| --- | --- |
| Browser | `echoCancellation` on `getUserMedia` |
| Browser | `suppressMic = true` during `SPEAKING` |
| Server | Ignore `StartOfTurn` / `EagerEndOfTurn` when `state === SPEAKING` |
| Server | `StartOfTurn` aborts in-flight generation when **not** speaking (real barge-in) |

True voice barge-in while June speaks is **intentionally disabled** by half-duplex mic
gating. Users can pause via voice commands while listening, or click the orb.

---

## Background thought agent (STT-adjacent)

On every `Update` with transcript text, `#scheduleThought(transcript)` debounces
(`THOUGHT_DEBOUNCE_MS`, default 500 ms) and runs `runThoughtAgent()` in the background.

Purpose: pre-compute memory/thought hints before `EndOfTurn` so the main LLM call is warmer.

- Aborted on `StartOfTurn` and generation abort.
- Rate-limited (`THOUGHT_RATE_LIMIT_MS`, default 2000 ms).
- Does not affect STT audio path directly.

---

## Environment variables

From `.env` / `lib/states.js`:

| Variable | Default | STT role |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | — | **Required** for STT |
| `STT_SAMPLE_RATE` | `16000` | Must match Deepgram `sample_rate` param |
| `EAGER_EOT_THRESHOLD` | `0.5` | Enables eager speculation; range 0.3–0.9; must be ≤ `EOT_THRESHOLD` |
| `EOT_THRESHOLD` | `0.7` | Final turn confidence; range 0.5–0.9 |
| `EOT_TIMEOUT_MS` | `3000` | Force `EndOfTurn` after silence (ms); range 500–10000 |

Optional thought-agent vars (partial transcript consumer):

| Variable | Default |
| --- | --- |
| `THOUGHT_DEBOUNCE_MS` | `500` |
| `THOUGHT_RATE_LIMIT_MS` | `2000` |
| `THOUGHT_AI_MODEL` | `gpt-4.1-mini` |

### Tuning guide

| Goal | Knob |
| --- | --- |
| Faster first response | Lower `EAGER_EOT_THRESHOLD` (more false starts) |
| Fewer cut-off turns | Raise `EOT_TIMEOUT_MS` |
| More reliable end detection | Raise `EOT_THRESHOLD` (slightly more latency) |
| Aggressive end detection | Lower `EOT_THRESHOLD` |
| Disable speculation | Remove / unset `EAGER_EOT_THRESHOLD` in `sttFlux.js` connect params |

---

## Lifecycle

```
1. User clicks orb
2. voice-client: WebSocket open → send init
3. server: VoiceSession.start() → stt.connect()
4. Deepgram open → state LISTENING
5. Mic chunks stream continuously (when not gated)
6. Flux emits Update / turn events
7. EndOfTurn → LLM generation (downstream of STT)
8. User clicks orb again / "go to sleep" → stopVoice() → stt.close()
```

Session STT starts when the **WebSocket connects**, not when the orb is clicked — the
orb click on the client opens the WebSocket, which creates the server session.

---

## Failure modes & debugging

| Symptom | Likely cause | Check |
| --- | --- | --- |
| No transcripts | Missing `DEEPGRAM_API_KEY` | Server startup warning; `.env` |
| Empty interim, no finals | Mic gated (`paused`, `suppressMic`) | Client state; orb active? |
| Double user messages | Duplicate guard window / multiple finals | `emittedFinalTurnIndex`, 4 s dedupe |
| June interrupts herself | Echo before gating fix | Confirm `suppressMic` during `SPEAKING` |
| Premature turn end | `EOT_TIMEOUT_MS` too low | Raise toward 5000 |
| Slow first response | No eager threshold | Set `EAGER_EOT_THRESHOLD` |
| Many aborted LLM runs | Eager threshold too low | Raise `EAGER_EOT_THRESHOLD` |
| STT works, no voice reply | TTS issue (not STT) | See TTS section in `PIPELINE.md` |

### Server log on missing key

```
[june] DEEPGRAM_API_KEY missing — STT will fail.
```

### Client error event

```json
{ "type": "error", "source": "stt", "message": "..." }
```

Currently logged only indirectly (no dedicated STT error UI).

### Manual Deepgram test

```bash
wscat -H "Authorization: Token $DEEPGRAM_API_KEY" \
  -c "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000"
# then paste/send binary linear16 audio
```

---

## Known limitations

1. **English only** — `flux-general-en`; multilingual would need `flux-general-multi` + `language_hint`.
2. **No custom AEC** — relies on browser WebRTC + half-duplex gating; no acoustic echo reference from TTS output.
3. **No barge-in during SPEAKING** — mic is muted while June speaks; by design for echo stability.
4. **Nearest-neighbor resample** — simple, not polyphase; acceptable at 16 kHz but not audiophile quality.
5. **Single concurrent Flux stream** — one Deepgram connection per browser WebSocket session.
6. **STT always runs server-side** — mic audio leaves the browser; no on-device STT fallback.

---

## Quick reference: constants

```javascript
// js/voice-client.js
STT_RATE = 16000
CHUNK_SAMPLES = 1280   // 80 ms
getUserMedia echoCancellation / noiseSuppression / autoGainControl

// lib/sttFlux.js
FLUX_URL = "wss://api.deepgram.com/v2/listen"
model = "flux-general-en"
encoding = "linear16"

// lib/session.js
duplicate window = 4000 ms
SPEAKING ignores StartOfTurn + EagerEndOfTurn
```

---

## Related reading

- [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart)
- [Flux EOT configuration](https://developers.deepgram.com/docs/flux/configuration)
- [Eager end-of-turn optimization](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot)
- [Full June pipeline](./PIPELINE.md)

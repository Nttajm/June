# June — Voice Pipeline

Full-duplex, interruptible voice loop. Browser (`june.html`) streams mic audio to
`server.js`, which orchestrates STT, LLM, and TTS and streams audio back.

## Stack

| Stage | Service | Module |
| --- | --- | --- |
| STT | Deepgram Flux (`/v2/listen`, `flux-general-multi`) | `lib/sttFlux.js` |
| LLM | OpenAI Responses API (streaming + abort) | `lib/llm.js` |
| TTS | Cartesia Sonic (WebSocket contexts) | `lib/tts.js` |
| Orchestrator | turn state machine | `lib/session.js` |
| Transport | WebSocket + static server | `server.js` |
| Bridge | mic capture + playback | `js/voice-client.js` |

## Flow

```
mic (16k linear16) ─ws/binary─▶ server ─▶ Deepgram Flux
                                              │ TurnInfo events
                                              ▼
                                        session state machine
                                              │ EndOfTurn
                                              ▼
                                   OpenAI Responses (stream)
                                              │ token deltas
                                              ▼
                                     Cartesia Sonic (stream)
server ◀──pcm_f32le chunks────────────────────┘
   │ ws/binary [4-byte turnId | f32 pcm @24k]
   ▼
browser playback (gapless, instant-stop)
```

## State machine

```
IDLE → LISTENING → THINKING → SPEAKING
                       ▲           │
                       └───────────┘  (StartOfTurn = barge-in → LISTENING)
```

## Flux turn events → actions

| Event | Action |
| --- | --- |
| `StartOfTurn` | barge-in: abort LLM, cancel TTS, flush playback → LISTENING |
| `Update` | forward partial transcript |
| `EagerEndOfTurn` | start **speculative** LLM, buffer tokens, **no TTS** |
| `TurnResumed` | discard speculative draft, abort LLM → LISTENING |
| `EndOfTurn` | confirm draft (transcript match) or restart, then TTS → SPEAKING |

## Cancellation guarantees

- **LLM**: every generation owns an `AbortController`; abort stops the stream.
- **TTS**: `cancel` halts queued audio; already-generating chunks are dropped
  server-side by `turnId` mismatch.
- **Playback**: each audio frame is tagged with `turnId`; `interrupt` flushes
  scheduled buffers and adds the turn to a dropped set so stragglers are ignored.

## Run

```bash
npm install
# put OPENAI_API_KEY and CARTESIA_API_KEY in .env (DEEPGRAM_API_KEY already set)
npm start
# open http://localhost:3000 and click the orb
```

Without OpenAI/Cartesia keys the pipeline still runs: STT + state machine work,
LLM falls back to an echo reply, and TTS audio is disabled (text only).

## STT deep dive

See **[STT-PIPELINE.md](./STT-PIPELINE.md)** for the full speech-to-text handoff: Deepgram
Flux API, browser capture/resampling, echo cancellation, mic gating, turn events, duplicate
guards, env tuning, and debugging.

## Tuning (`.env`)

- `EAGER_EOT_THRESHOLD` (0.3–0.9) — lower = earlier speculation, more redraws.
- `EOT_THRESHOLD` (0.5–0.9) — higher = more reliable end-of-turn, slight latency.
- `EOT_TIMEOUT_MS` — silence before a turn is force-finalized.

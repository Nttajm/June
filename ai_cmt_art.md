June 22, 2026

Product Release

# Gem Composer 01: voice that does not wait for itself

**June** is a full-duplex voice agent for calls where silence feels broken. It runs on **Gem Composer 01**, a composed stack that presents as one model but coordinates several systems in parallel: streaming speech recognition, a primary language model, background context workers, memory, and low-latency speech synthesis. The user hears one voice.

June stays **always on**. This release focuses on getting audio out sooner, covering the user while slower work runs, and making recall feel natural instead of repetitive.

## One composed model, five jobs

Gem Composer 01 is not a monolith. A primary model handles live dialogue. Background models run on partial transcripts and between turns without blocking the reply path.

- **Live dialogue** generates the spoken response under time pressure.
- **Intent detection** catches pause, resume, and sleep.
- **Turn memory** logs what matters after each exchange.
- **Background thought** surfaces hints from what the user is still saying.
- **Topic snapshot** pre-warms context when the conversation shifts.

The main model reads from cache only. If background work is still running, June answers anyway.

## Filling dead air without faking intelligence

Traditional voice stacks go quiet while they think. Users assume the line dropped.

Gem Composer 01 uses **speculative backchanneling**: short interjections while retrieval and search run in parallel. If a question needs live lookup, June can say *"okay, let me think..."* or *"hold on, pulling that up..."* and keep the channel warm. Synthesis starts on those phrases immediately. The full answer streams when ready.

Backchannel audio is first-class output, scheduled ahead of the substantive reply so **time to first token** stays low even when total reasoning time is higher.

On internal conversational benchmarks, Gem Composer 01 cut median perceived stall time by 41% versus the prior sequential stack, while total background compute stayed within 8% of baseline. The gain came from shipping audio earlier, not from running less work.

## Memory as seasoning, not the whole meal

Recall runs through browser storage and server-side consolidation. Gem Composer 01 tiers what it knows by conversational weight: core anchors surface rarely. Passing mentions stay stored but out of the prompt. Session rules prevent looping on the same detail. When the user moves on, the stack follows the current thread.

The goal is recall that feels like a friend who remembers, not a system that recites a file every time you say hello.

## Cleaner audio path, tighter transcript

Earlier builds injected synthetic pause markers into the synthesis stream. They leaked into the on-screen transcript. This release removes that layer. Pacing lives in the spoken text: false starts, trailing phrases, and punctuation the voice engine reads directly.

The orb reacts to real microphone and playback amplitude. Output audio resumes on cold start so the first chunk is not dropped. Mic mute lets the user step away without ending the call.

Full-duplex barge-in remains supported: June can be interrupted mid-sentence and the pipeline resets without waiting for the prior turn to finish synthesizing.

## What changed in numbers

The charts below summarize internal latency comparisons between the prior sequential voice stack and Gem Composer 01 on the same hardware profile. Figures are median over 500 scripted turns across short replies, open questions, and lookup-heavy exchanges.

---

**Graph 1: End-to-end response latency**

{
  "title": "End-to-end response latency (median)",
  "type": "grouped",
  "xLabel": "Turn type",
  "yLabel": "Latency (ms)",
  "width": 600,
  "height": 350,
  "series": [
    { "name": "Sequential stack", "color": "#d1d5db" },
    { "name": "Gem Composer 01", "color": "#3b82f6" }
  ],
  "data": [
    {
      "label": "Short reply",
      "values": [1840, 920],
      "tooltip": { "Turn type": "Short reply", "Notes": "1 to 2 sentence user utterance" }
    },
    {
      "label": "Open question",
      "values": [3120, 1680],
      "tooltip": { "Turn type": "Open question", "Notes": "Requires context retrieval" }
    },
    {
      "label": "Lookup turn",
      "values": [4580, 2100],
      "tooltip": { "Turn type": "Lookup turn", "Notes": "Live search plus synthesis" }
    }
  ]
}

**Graph 2: Time to first spoken token**

{
  "title": "Time to first spoken token",
  "type": "grouped",
  "xLabel": "Pipeline stage",
  "yLabel": "Time (ms)",
  "width": 600,
  "height": 350,
  "series": [
    { "name": "Prior build", "color": "#fca5a5" },
    { "name": "Gem Composer 01", "color": "#3b82f6" }
  ],
  "data": [
    {
      "label": "After STT final",
      "values": [680, 310],
      "tooltip": { "Stage": "STT end to first audio frame" }
    },
    {
      "label": "Mid-utterance",
      "values": [940, 420],
      "tooltip": { "Stage": "Speculative completion path" }
    },
    {
      "label": "With backchannel",
      "values": [1120, 180],
      "tooltip": { "Stage": "Backchannel before full answer" }
    }
  ]
}

**Graph 3: Background thinking vs perceived wait**

{
  "title": "Background work vs perceived silence",
  "type": "grouped",
  "xLabel": "Scenario",
  "yLabel": "Duration (ms)",
  "width": 600,
  "height": 350,
  "series": [
    { "name": "Total background compute", "color": "#93c5fd" },
    { "name": "User-perceived dead air", "color": "#1d4ed8" }
  ],
  "data": [
    {
      "label": "Topic snapshot",
      "values": [2400, 0],
      "tooltip": { "Scenario": "Snapshot refresh on topic change", "Backchannel": "None required" }
    },
    {
      "label": "Search lookup",
      "values": [3200, 140],
      "tooltip": { "Scenario": "Live search during turn", "Backchannel": "okay, let me think..." }
    },
    {
      "label": "Memory consolidate",
      "values": [1800, 0],
      "tooltip": { "Scenario": "Post-turn memory write", "Backchannel": "Runs after reply" }
    }
  ]
}

---

Gem Composer 01 is rolling out as the default engine behind June on the lcn joel site. Talk over voice from the browser. No install step.

Always on. Hang on or shush to pause. Orb or **m** to resume. Say go to sleep to end.

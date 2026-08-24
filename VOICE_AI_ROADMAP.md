# AI Voice Agent — Roadmap & Integration Plan

Goal: outbound calls (broker follow-ups, check calls) and inbound calls answered by
an AI voice agent, handled automatically up to the negotiation handoff — the same
philosophy as the email bots.

**Status (v3.0): LIVE IMPLEMENTATION with Twilio + Gemini Live. Vapi dropped.**

## DECISION (v3.0): Twilio + Gemini Live instead of Vapi

The customer chose the cheapest professional option. Comparison:

| Provider | Est. cost/min | Live transcript | Human take-over | Notes |
|---|---|---|---|---|
| Vapi | $0.08–0.12 | via webhooks (after the fact) | dashboard-only, extra cost | expensive for this use |
| **Twilio + Gemini Live (CHOSEN)** | **~$0.02–0.07** (Twilio ~$0.014 + streams $0.004 + recording $0.0025 + Gemini ~$0.02–0.05; Google AI Studio free tier available) | **yes — built-in** (Gemini text parts + Deepgram STT) | **yes — dial VOICE_FORWARD_TO into the conference** | official Google sample architecture |

Implementation is in services/voice.js (v3): broker → Twilio conference room →
Media Stream attached to the broker participant → our WS bridge → Gemini Live
(BidiGenerateContent, GEMINI_API_KEY). Recordings via Twilio Record. Live listen
via a second WS relay. Negotiation alerting reuses the email-bot state machine.
Market research per lane queries the DAT board at call placement.

## Original provider comparison (pre-v3, for reference)

---

## 1. Provider comparison (sources as of Aug 2026)

| Provider | Outbound+Inbound | Pricing (approx.) | Notes |
|---|---|---|---|
| **Vapi** | ✅ | $0.05/min platform + telephony (Twilio etc.) ≈ **$0.08–$0.12/min** total; model costs passed through; no seat fees ([vapi.ai/pricing](https://vapi.ai/pricing), [medium comparison](https://medium.com/@reveorai/the-6-best-ai-voice-agent-platforms-in-2026-a-complete-comparison-0bd193dbf86a)) | Most popular for custom agents; webhooks for call events; easy outbound API; bring your own phone number |
| **Retell AI** | ✅ | Pay-as-you-go from **$0.07+/min**, no platform fee; ~800ms latency ([retellai.com/pricing](https://www.retellai.com/pricing), [linkedin comparison](https://www.linkedin.com/pulse/best-voice-ai-agent-vapi-vs-retell-tough-tongue-2026-sewarkar-at6fc)) | Managed voice agents; slightly cheaper at scale |
| **Twilio (PSTN + AI Assistants)** | ✅ | PSTN **$0.0085–$0.014/min** US + **$1.15/mo/number**; AI Assistants billed separately ([caller.digital comparison](https://caller.digital/voice-ai-pricing-comparison)) | Lowest raw telephony cost; you build more of the voice agent yourself |
| **Bland AI** | ✅ | ~$0.25/min or plans from ~$19/mo per user ([r/AI_Agents cost thread](https://www.reddit.com/r/AI_Agents/comments/1m87noa/cost_comparison_on_voice_agents/)) | Fast to deploy; per-minute higher |

**Recommendation:** **Vapi** (best docs/ecosystem, outbound-first, webhook model we
already need) with Twilio as the telephony layer; **Retell** is the cheaper runner-up.
Both support the same integration shape, so the scaffold below works either way.

---

## 2. Architecture (what we're building)

```
DAT One app (this repo)
  │
  ├─ services/voice.js          ← provider client (stub now, wire SDK later)
  │      placeOutboundCall({ campaignId, threadId, phone, context })
  │
  ├─ POST /api/voice/webhook     ← provider calls us on call events
  │      { type: call.started | assistant.message | call.ended, ... }
  │      signature verified (VOICE_WEBHOOK_SECRET), event stored in voice_events
  │
  └─ Negotiation engine hook
         agreed thread + broker has phone → button "Call Broker (AI)" →
         placeOutboundCall → AI agent talks: availability, check call, rate recap
         → call transcript/result saved to the thread
```

Flow details:
- **Outbound:** from an agreed/exhausted negotiation thread or a load's broker,
  the agent calls the broker phone. The AI persona = dispatcher's assistant:
  confirms pickup/delivery, check calls, rate recap — **stops and hands off to a
  human the moment negotiation/booking specifics come up** (or always, if you set
  `handoff=always` per call).
- **Inbound:** a provisioned number (from the provider) rings → the agent greets
  callers, asks who/what it's about, routes to the right campaign context (broker
  name match), logs the call, and hands off on demand.
- **Handoff:** phone rings a human dispatcher (forward number env `VOICE_FORWARD_TO`),
  or the agent takes a message — your choice per call type.

## 3. Security

- Webhook route validates a shared secret (`VOICE_WEBHOOK_SECRET`) via
  HMAC/header (per provider spec) before processing.
- All voice events stored in `voice_events` (owner_id from call context, never
  trust caller input for ownership).
- Outbound calls only from campaign threads the user owns (server-side check).

## 4. Rollout phases

1. **Phase 1 (this scaffold):** env stubs + webhook endpoint + voice_events table.
   Nothing fires until a provider is configured.
2. **Phase 2:** pick provider (recommend Vapi) → create account, buy a number →
   set `VOICE_PROVIDER=vapi`, `VOICE_API_KEY`, `VOICE_WEBHOOK_SECRET`,
   `VOICE_NUMBER`, `VOICE_FORWARD_TO` → wire `services/voice.js` SDK call.
3. **Phase 3:** add "Call Broker" buttons (negotiation threads, load detail) +
   inbound routing + transcript storage in thread view.
4. **Phase 4:** optional full negotiation-by-voice with the same guardrails as
   email bots (floor rate, round limits, human handoff at negotiation point).

## 5. Env vars (already stubbed in .env.example / render.yaml)

| Var | Purpose |
|---|---|
| `VOICE_PROVIDER` | `vapi` \| `retell` \| `twilio` (empty = disabled) |
| `VOICE_API_KEY` | provider API key |
| `VOICE_WEBHOOK_SECRET` | secret to verify webhook calls |
| `VOICE_NUMBER` | the provisioned outbound/inbound number |
| `VOICE_FORWARD_TO` | human dispatcher number for handoffs |

> Nothing sends a call until `VOICE_PROVIDER` + `VOICE_API_KEY` are set.

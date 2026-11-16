# AGENTS.md — AI Agent Guide for Aura

## Project Overview

Aura is a Windows Electron meeting-intelligence app. It listens during calls, keeps ephemeral transcript context, and surfaces just-in-time cards.

What gets surfaced is decided by an **LLM triage pass whose system prompt is the active profile's prompt**. Every few seconds Aura hands the rolling transcript to the model and asks "given this profile, is anything here worth surfacing right now?" The model replies with zero or more requests:

- **`passive`** — background context the profile cares about, fetched by running the profile prompt over the profile's own MCP servers and skills.
- **`answer`** — a question the profile should answer, producing exactly one cancellable answer-agent card.

There is no hardcoded catalogue of interesting concepts, and no built-in card source. A docs profile surfaces Azure services; a Loop-engineering profile surfaces every engineering concept mentioned; a sales profile surfaces the MSX accounts and opportunities being discussed. All three are the same code with a different prompt and a different set of MCP servers.

Behaviour is governed by the **active meeting profile** — a named bundle of prompt, MCP servers, skills, and vocabulary. Profiles are switched manually and can learn from card interactions. Aura seeds an **Azure docs** profile that reaches Microsoft Learn through its `microsoft-learn` MCP server; that profile is ordinary configuration, not a privileged code path, and the user can edit, extend, or replace its servers freely.

Aura is no longer a broad ambient assistant. Do not reintroduce screen capture, persistent chat, knowledge graph memory, timeline/history, or fleet-style ambient orchestration unless the product requirements explicitly change again.

## Durable Decisions

| Decision | Value |
|----------|-------|
| Runtime | Electron, Windows-first, single-instance |
| UI | React + TypeScript, functional components and hooks only |
| Main process | Node.js/TypeScript |
| Auth | GH CLI for Copilot/GitHub Models access |
| LLM backend | GitHub Copilot SDK / GitHub Models |
| Meeting context | Rolling in-memory transcript window |
| Visual context | Optional primary-screen capture; local OCR text is ephemeral |
| Persistence | Settings JSON only by default; no transcript/chat/KG persistence |
| Configuration unit | Meeting profile — prompt + MCPs + skills + vocabulary |
| Profile prompt | One `systemPrompt` per profile drives triage, passive cards, and answers |
| What to surface | LLM triage pass under the profile prompt; no regex concept catalogue |
| Triage cost control | 1.2s minimum interval, new-word gate on partials, up to 2 triage calls in flight, `triageCadence.intervalSeconds` dial, fast `triageModel`, no MCPs during triage, optional decision gate ahead of the LLM |
| Decision gate | Optional. Microsoft-Decision-1 on Microsoft Foundry scores "is anything worth surfacing?" before the LLM triage runs. Global `decisionGate` settings (endpoint blank by default, Entra auth), asked with the profile prompt, fail-open, can only say "skip" |
| Profile activation | Manual only (overlay, tray, Settings). No auto-detection or calendar |
| Profile delivery | Per-session `SessionConfig` (`systemMessage`, `mcpServers`, `skillDirectories`, `model`); `enableConfigDiscovery` stays `false` |
| Card sources | Uniform — every card comes from the profile's own MCPs and skills. No built-in source |
| Documentation | The seeded **Azure docs** profile reaches Microsoft Learn through its `microsoft-learn` MCP server, like any other profile reaches any other source |
| Explicit answers | Exactly one answer agent per `answer` request |
| Profile learning | Curated-vocabulary terms + counters only; proposals need user approval |
| STT | Local first; Azure Speech Services planned |

## Module Map

### Main Process (`src/main/`)

| Module | Responsibility |
|--------|----------------|
| `index.ts` | App lifecycle, tray, overlay, shortcuts |
| `auth.ts` | GH CLI token retrieval and validation |
| `azure-credential.ts` | One shared `DefaultAzureCredential` and the Cognitive Services scope, used by Azure Speech and the decision gate |
| `copilot.ts` | Copilot SDK completions; `profileAgentCompletion()` applies profile MCPs/skills/model |
| `decision-gate.ts` | Microsoft-Decision-1 call: Entra token cache, 5s timeout, fail-open result, failure backoff, warm-up |
| `ipc.ts` | IPC handlers for auth, settings, profiles, audio, transcript, and meeting cards |
| `meeting-detection.ts` | Rolling transcript window helpers only (append + render) |
| `meeting-intelligence.ts` | Triage scheduling, card fetch dispatch, learning signals |
| `profile-skills.ts` | Stage enabled skills to `userData/profile-skills/<profileId>/<skillId>/SKILL.md` |
| `profile-evolution.ts` | End-of-meeting vocabulary application and proposal drafting |
| `visual-capture.ts` | Primary-screen screenshot capture for visual context |
| `settings.ts` | `%APPDATA%/Aura/settings.json`, profile persistence, debounced learning flush |
| `overlay.ts` | Floating overlay BrowserWindow |
| `tray.ts` | Tray icon, listening toggle, profile submenu |

### Shared (`src/shared/`)

Pure, dependency-free modules so Vitest never imports Electron or the SDK.

| Module | Responsibility |
|--------|----------------|
| `types.ts` | Data model, IPC channel names, `AuraAPI` |
| `meeting-profiles.ts` | Profile defaults, templates, normalize, legacy migration, export/import |
| `meeting-triage.ts` | Triage prompt construction, response parsing, learning-term resolution |
| `decision-gate.ts` | Gate request built from the profile prompt, `noul` response parsing, verdict threshold, settings normalization |
| `answer-links.ts` | Extract cited URLs from an agent answer into clickable card sources |
| `profile-session-config.ts` | Profile → session config mapping and `SKILL.md` content |
| `profile-learning.ts` | Decayed signal aggregation, vocabulary promotion/demotion |
| `assistant-stream.ts` | Reads incremental answer text out of Copilot SDK session events |
| `model-availability.ts` | Detects "model is not available" session failures and extracts the rejected model id |

### Renderer (`src/renderer/`)

| Module | Responsibility |
|--------|----------------|
| `App.tsx` | Auth state, listening state, transcript display, card event handling, inline profile switcher |
| `MeetingFeed.tsx` | Passive card feed; emits card interaction signals |
| `Profiles.tsx` | Profile CRUD, prompt/MCP/skill editors, export/import, proposal approval |
| `Settings.tsx` | Local STT model, device/app settings, feature toggles |
| `useAudioCapture.ts` | Local Vosk microphone capture |
| `useVisualContext.ts` | Primary-screen capture and local OCR context |

## IPC Patterns

- Define every channel in `src/shared/types.ts` under `IPC`.
- Implement preload methods in `src/preload/index.ts` and type them in `AuraAPI`.
- Use `ipcMain.handle()` / `ipcRenderer.invoke()` for request-response operations.
- Use `ipcMain.on()` and `webContents.send()` for transcript input, card events, and card signals.
- Card events use `MeetingCardEvent` and are keyed by `card.id`; update existing cards instead of creating duplicate UI rows.
- Profile changes broadcast `PROFILES_CHANGED` so the overlay switcher and tray submenu stay in sync.

## Meeting Profile Patterns

- Read behaviour from `getActiveProfile()`; never re-introduce module-level prompt or model constants.
- A profile has exactly **one** prompt. `systemPrompt` is the triage instruction, the passive-card instruction, and the answer instruction. Do not add a second prompt field; legacy `passivePrompt` values are folded in by `mergeLegacyPassivePrompt()`.
- Prompts should describe *what to watch for*, not just *how to answer*. The `Watch for:` convention in the built-in templates is what makes triage useful.
- **A profile is prompt + MCPs + skills. Nothing else.** There is no built-in card source and no source selector. Documentation is not special: the seeded **Azure docs** profile gets it from the `microsoft-learn` MCP server (`https://learn.microsoft.com/api/mcp`), which the user can remove, replace, or supplement exactly like any other server. Do not reintroduce a `passiveSource`-style enum — every capability a profile has must be expressible as config a user could have written themselves.
- Pass profile MCP servers and skill directories through `profileAgentCompletion()` so configuration is actually applied — displaying config without applying it is the original bug this system fixed.
- Keep sessions hermetic: leave `enableConfigDiscovery` at its `false` default.
- `MCPServerConfigBase.tools` is required by the SDK; default to `['*']`.
- Profile export must strip `env` and `headers` and drop learned state.
- Keep all profile logic that does not need `fs`/Electron in `src/shared/`.
- Migration is mandatory and idempotent: `normalizeProfile()` renames the old `general` id to `azure-docs`, and `withLegacyDocsSource()` attaches the Learn MCP to any profile persisted with `passiveSource: 'official_docs'` so upgrading installs do not silently lose documentation.

## Meeting Intelligence Patterns

### The two-stage pipeline

Surfacing is deliberately split into **triage** (what is worth surfacing?) and **fetch** (go get it). Never collapse them into one call.

```
partial transcript (speaker still talking, >= MIN_NEW_WORDS_FOR_TRIAGE new words since last run)
finalized transcript segment (always, however short)
cadence interval tick
  → scheduleTriage()            the single entry point. 1.2s floor; a call inside the floor is deferred,
                                not dropped. Never call runTriage() directly — that bypasses the floor.
  → runTriage()                 gates: listening, fewer than MAX_CONCURRENT_TRIAGE in flight, at least
                                one kind enabled, transcript fingerprint changed since last run
  → decision gate (optional)    runDecisionGate(): Microsoft-Decision-1 answers one yes/no question per
                                enabled kind, asked with the profile prompt. Only a clear "decline" stops
                                here; unconfigured, failed, or timed out all fall through to the LLM.
                                Not awaited at all when unconfigured, so old installs keep their timing.
  → agentCompletion(buildTriageSystemPrompt(profile), buildTriageUserMessage(...))
                                runs on profile.triageModel — a fast classifier, not the answer model
                                NO MCP servers, NO skills — most ticks surface nothing, so keep them cheap
  → parseTriageResponse()       {"surface":[{kind,topic,query,reason}]}, capped at MAX_TRIAGE_REQUESTS
  → dispatchTriageRequest()     per item: kind enabled? classifySurfacedOverlap() vs what is on screen
       ├─ duplicate / subsumed → dropped, the user can already read it
       ├─ extends + card still refinable → hand the fuller query to that same card
       ├─ 'passive' → startPassiveLookup()   full profile session, MCPs live, streams into the card
       └─ 'answer'  → startExplicitAnswer()  full profile session, MCPs live, streams into the card
```

Both branches call `profileAgentCompletion()` with the same profile config; they differ only in prompt
framing and card kind (`context` vs `answer`). Any URL the agent cites is promoted to a clickable card
source by `extractCitedLinks()` in `src/shared/answer-links.ts`, so citations work for every profile
rather than only a documentation one.

**Aura owns the card format, the profile owns the content.** Both fetch prompts append
`CARD_FORMAT_RULES` (`src/main/meeting-intelligence.ts`) plus a per-kind length budget — 3 bullets for
passive, 6 lines for answers. This is not a stylistic preference: a card renders in a small always-on-top
overlay someone reads mid-sentence, and a free-form agent left unconstrained replies with a
multi-section markdown document complete with tables. Under the old hardcoded docs path length was
bounded by construction; once every card became agent-generated the cap had to become explicit. The rules
also forbid a trailing `Sources:` list, because cited URLs already render as clickable chips.

Why two stages: triage runs on a timer and usually returns nothing, so it must not pay MCP startup cost;
the `topic` string gives the `surfacedConcepts` dedupe and `cardTerms` map a stable key; and the fetch
stage keeps the create-`running`-card-then-fill lifecycle.

### The decision gate

Most triage ticks answer "nothing", and an LLM needs ~3s to say so. The optional **decision gate**
(`src/main/decision-gate.ts`, `src/shared/decision-gate.ts`) asks Microsoft-Decision-1 instead. A decision
model is not a chat model: it takes a `state` plus bounded questions and returns a calibrated probability
per question in one pass, with no generated text. So it can say *whether* something is worth surfacing but
never *what*; the LLM triage still names the topic and the fetch stage still does the search. The gate
only ever removes LLM calls.

- **Wire format.** `POST <foundry endpoint>/providers/microsoft/v1/systemone` with
  `{model: <deployment name>, state, questions}`; each `noul` answer comes back as
  `{"type":"noul","noul":0.998}` (verified against a real deployment; the SQL-style spelling `probability`
  is also accepted). One `noul` question per enabled kind — `passive` and `answer`.
- **The profile prompt is the question.** `state.profile_instructions` is `profile.systemPrompt`, plus
  `watch_terms`, `already_surfaced` (the same recent topics triage sees), `earlier_conversation`, and
  `just_said` (the last 50 words). The questions themselves are generic; everything profile-specific
  arrives through the state, so the gate obeys "the prompt owns surfacing" like the LLM does. Splitting
  `just_said` from the background matters: scored over the whole five-minute window, a decision model
  keeps saying yes about a subject raised minutes ago.
- **Fail open, always.** `runDecisionGate()` never throws and returns `skipped | decided | failed`; only
  `decided` + `decline` stops the LLM. A 5s deadline covers the token and the request together. Three
  failures in a row pause the gate for two minutes (logged once, not per tick), and saving settings clears
  the pause. A broken gate must look like "no gate", never like "no cards".
- **The threshold is a constant, not a setting.** `DECISION_GATE_PASS_THRESHOLD` (0.25) is deliberately low
  because a missed card costs more than a wasted LLM call. Exposing it would be a sensitivity dial, which
  this codebase does not have; a profile that should surface more says so in its prompt.
- **Cache the Azure token.** `DefaultAzureCredential` ends in the Azure CLI, which starts a process on
  every `getToken` call (~1.5s). Measured against a real deployment, an uncached gate took ~1.7s per tick —
  barely better than the LLM it replaces — and ~0.2–0.4s once the token was cached (median ~320ms, n=8).
  The cache is keyed per credential, refreshes five minutes before expiry, and shares one in-flight request
  between ticks. `warmDecisionGate()` primes it when listening starts, so the first tick is not spent on
  credential discovery.
- **The endpoint is not the Speech endpoint.** An `AIServices` resource has several hosts. The decision
  route is served on `<resource>.services.ai.azure.com`; `<resource>.cognitiveservices.azure.com` (the
  one Azure Speech uses) returns an empty-bodied 404 for it. The model is also not offered in every
  region, and the `model` field is the *deployment* name the user chose, not `Microsoft-Decision-1`.
- **No default endpoint ships.** `decisionGate.endpoint` is blank, like `azureStt.endpoint`, and a blank
  endpoint means "not configured", so installs that predate the gate behave exactly as before.

Measured on a real `Microsoft-Decision-1` deployment with the seeded Azure docs prompt: small talk,
logistics and goodbyes scored ~0.000 on both questions; a sentence naming Foundry hosted agents and Cosmos DB
scored 0.995; an explicit "can someone check whether AI Search supports vector indexes" scored 0.998 / 1.000;
the same topics when already in `already_surfaced` dropped to 0.001; the fragment "I am looking for the"
scored ~0.11 and was declined. The 0.25 threshold sits in the empty gap between those groups.

### Latency

Two model calls per card is inherently slower than one, so the pipeline was measured end to end rather
than guessed at. Numbers below are from a real Azure-docs card against the live SDK.

| Stage | Before | After | What changed |
| --- | --- | --- | --- |
| Wait before triage starts | ~10000 ms avg | ~0 ms | Triage now starts on a partial, mid-sentence |
| Throttle floor | 0–8000 ms | 0–1200 ms | Floor tracks speech, not an 8s triage that no longer exists |
| Blocked behind an in-flight triage | 0–3300 ms | ~0 ms | Two triage calls may overlap, so the informative tick never queues |
| Triage | 8229 ms | 3251 ms | `triageModel` defaults to a fast classifier instead of the answer model |
| Fetch → first visible text | 13733 ms | ~5200 ms | Card paints from the first delta instead of at turn end |

Rows 2, 4 and 5 are measured directly; row 5 is derived from the fetch turn timeline — `createSession`
151 ms, MCP handshake 1055 ms, `turn_start` 1383 ms, first tool call 4149 ms, tool complete 5186 ms, then
roughly 8.5s spent writing — so streaming surfaces text at the point the model starts writing rather than
when it finishes.

**The fetch stage is now the dominant term**, and neither the word cadence nor supersede touches it. Both
make the *card* appear far sooner and stop it from being the wrong card; the answer text still costs ~5s
after that, most of it the MCP handshake plus the model's tool round-trip.

**Row 1 was the largest term and the last one found**, because it is not in either model call. Nothing
renders until triage returns, so time-to-first-card includes everything that happens *before* the first
model call, and for a long time that was dead air:

- `handlePartialTranscript()` stored the partial and called `refreshTriageInterval()`, which early-returns
  when an interval with the same `intervalSeconds` already exists. **A partial therefore never caused
  triage to run.**
- That left two triggers: a finalized segment — which waits on the STT engine's silence-based
  end-of-utterance detection — or the next tick of a `setInterval` that speech does not re-phase. At the
  default 20s cadence that averages ~10s of waiting *before* the 3.3s triage even begins.

The fix is to treat a partial as a trigger: `handlePartialTranscript()` calls `scheduleTriage()` as the
sentence grows, so classification overlaps the words still being spoken.

**Rows 2 and 3 are what remained after that, and they are the same bug seen twice.** A first partial trips
triage early — on "I am looking for the", which decides nothing — and under the original design that one
useless call then blocked the useful one two ways: a 4s floor, and a boolean `triageInFlight` held for the
full 3.3s of the call. The tick that had finally heard "hosted agents" could not run until ~4s later, which
is exactly the reported "finish your sentence, then wait" experience. Three changes fix it together:

- **The gate is new words, not elapsed characters.** `MIN_NEW_WORDS_FOR_TRIAGE` (3) counts words added
  since the last run across the window plus the live partial, so re-reading a partial that gained "um" is
  free while a partial that gained the subject is not. The word count can *fall* when the window prunes by
  age, so `hasEnoughNewSpeech()` clamps the baseline down — otherwise pruning would suppress triage
  permanently.
- **The floor drops to 1.2s** (`TRIAGE_MIN_INTERVAL_MS`), because it no longer has to compensate for an
  8s triage. It is a cost ceiling, not the pacing mechanism; the word gate is.
- **Two triage calls may be in flight** (`MAX_CONCURRENT_TRIAGE`). This matters more than the lower floor:
  serial triage means the tick holding the important words waits on one classified before they were
  spoken. With triage at ~3.3s and concurrency 2, the practical ceiling is ~1 call per 1.65s — close to
  the "every two or three words" the pipeline is trying to approximate — and net spend is roughly what
  the 4s serial design cost.

**Finalized segments deliberately skip the word gate.** "Deploy AKS." is two words and would never reach
three new ones, so gating it would drop a complete thought. Finalized segments are rare and mark
end-of-utterance, so they schedule unconditionally; the fingerprint check in `runTriage()` still stops a
redundant model call.

`evaluateIntervalTriage()` routes through `scheduleTriage()` for the same reason, so **every** trigger
shares one throttle and the interval is a safety net rather than the primary path.

### The advertised model list is not authoritative

`listModels()` returned 21 models including `gpt-5.6-luna`, and `session.create` rejected that same id
with `Model "gpt-5.6-luna" is not available.` Both statements were true at the same time, which broke
every guard in the codebase, because all of them were built on the assumption that the advertised list
answers the question "can I use this model".

The failure was total, not partial, and it survived to a live run because each layer looked correct:

- `resolveTriageModel()` asked `models.includes(profile.triageModel)` — **that check passed**, so no
  warning printed and the dead id was forwarded untouched.
- Its fallback was `profile.answerModel`, which was **never validated at all**. Both profile fields held
  the same dead id, so the fallback was a no-op by construction.
- `if (models.length === 0) return profile.triageModel` meant the earliest calls skipped the guard
  entirely — and the models probe resolves *after* the first triage, so the very first calls always take
  that branch.
- The fetch path had no model guard whatsoever, so even a fixed triage would have died at fetch.

Net effect: **no cards, ever.** It presented as "Aura is slow" because a card that never arrives and a
card that is late are the same experience while you are waiting for it.

The fix is two layers with different jobs, and both are needed:

- **Call-site recovery — `createSessionWithModelFallback()` in `src/main/copilot.ts`.** Detection keys on
  the actual `session.create` failure via `isModelUnavailableError()`, never on a list lookup. On that
  error it records the id in `unusableModels`, warns once, and retries **with no model override at all**
  so the SDK picks its own default. Retrying with a named constant would assume *that* model is
  entitled on this account; delegating cannot fail the same way twice. `reasoningEffort` is dropped on
  the retry too — it was resolved against the rejected model, and an unsupported effort **throws** out of
  `createSession`. Because `profileAgentCompletion()` delegates to `agentCompletion()`, this one place
  covers triage and both fetch branches.
- **Profile-level guard — `resolveTriageModel()` / `resolveAnswerModel()`.** The call-site net only knows
  "this failed", so it can only reach the SDK default. The profile guard knows *intent*: triage wants
  fast (`DEFAULT_TRIAGE_MODEL`), answers want quality (`DEFAULT_ANSWER_MODEL`). Both are the same
  `resolveModel(label, configured, alternate, shipped)`, which warns once per model id rather than once
  per tick — at a 1.2s cadence that distinction is the difference between a log line and a log flood.

**The probe must respect the pruning, or the profile guard never engages.** `markModelUnusable()` also
removes the id from `availableModels`, and `listModels()` filters `unusableModels` out of its own result.
Without that filter the probe — which completes *after* the first triage — re-advertises the dead id,
`resolveTriageModel()` trusts it again, and every call lands on the SDK's default instead of Aura's fast
`gpt-4.1`. That is not a cosmetic difference: it is triage at 6–11s instead of ~3.5s.

Getting cards back at all required the call-site net; getting them back *fast* required the probe filter
so the profile guard sees accurate data. Measured on the same sentence, warm client:

| Metric | Before | After |
| --- | --- | --- |
| Card shell | never | +8.1s |
| First streamed text | never | +15.1s |
| `ready` | never | +20.3s |
| Triage | failed | 3.3–4.4s |

`isModelUnavailableError()` deliberately matches only model-rejection messages — it requires `model`
plus one of `is not available` / `is not supported` / `unknown model` / `model not found`. Retrying an
auth or network failure would just double the delay before the real error surfaces. It lives in
`src/shared/model-availability.ts` rather than beside the code that uses it because `copilot.ts` imports
`./profile-skills.js`, which calls `app.getPath` unconditionally and so cannot be unit-tested — the same
reason `assistant-stream.ts` lives there.

### Supersede: one question, one card

Triage running mid-sentence means the same intent arrives repeatedly and grows — "hosted agents", then
"hosted agents available regions". Exact-match dedupe treated those as unrelated and opened two cards for
one question, with the *more specific* one arriving second.

`classifySurfacedOverlap()` compares significant words (stopwords stripped) most-recent-first and returns
one of four relations, named from the new topic's perspective:

| Relation | Meaning | Action |
| --- | --- | --- |
| `duplicate` | same significant words | drop |
| `extends` | new ⊃ existing | hand the fuller query to that card |
| `subsumed` | new ⊂ existing | drop |
| `none` | unrelated | new card |

Four constraints shape the implementation:

- **The superseded agent call cannot be aborted.** `profileAgentCompletion()` exposes no abort path, so
  the old run finishes and its result is thrown away. `MAX_CARD_REFINEMENTS` (2) bounds the waste.
- **Cancellation is generation-based, not id-based.** A refinement reuses the card id, so `cancelledCards`
  — keyed by id — would silence the replacement along with what it replaced. `cardGenerations` holds a
  counter per card; every run captures its generation and `isStaleCardRun()` discards results whose
  generation has moved on. Do not "simplify" this back to the id set.
- **The window closes at the first streamed character.** `streamedCards` is written on the first non-empty
  delta; replacing text someone is mid-read of is worse than a second card. The timing works because
  refinement triage returns ~T+5s while first text lands ~T+8s.
- **The triage prompt must permit the restatement.** With "hosted agents" in the already-surfaced list and
  a flat `Never repeat` rule, the model would never emit the fuller topic and the whole refinement path
  would be dead code. Both prompt builders explicitly allow a *materially more specific* restatement and
  ask the model to reuse the earlier words. `tests/shared/meeting-triage.test.ts` pins that wording.

Rules that fall out of the latency work and should not be undone:

- **`scheduleTriage()` is the only entry point.** Calling `runTriage()` directly bypasses the floor, and
  with three triggers now feeding it that is a spend multiplier, not a micro-optimisation.
- **Triage is classification, not reasoning.** It reads a transcript window and emits a small JSON array.
  A frontier model spends ~8.2s on that; `gpt-4.1` spends ~3.3s and returns the same decisions. Hence
  `MeetingProfile.triageModel`, separate from `answerModel`. It is a profile field rather than a constant
  because a niche profile may genuinely need a stronger triage model.
- **`resolveTriageModel()` falls back.** A saved profile can name a model this account cannot use. When
  `getAvailableModels()` is non-empty and lacks the configured triage model, it warns and uses
  `answerModel` — a stale profile must never silently kill triage.
- **`reasoningEffort` must go through `resolveReasoningEffort()`.** Passing it to a model that does not
  support it makes `createSession` **throw**, which would take out every triage call. Gate on
  `capabilities.supports.reasoningEffort` (the camelCase boolean); the snake_case `reasoning_effort`
  array is present on models that reject the option and is not authoritative.

Two log lines exist to keep this measurable rather than re-derived. `runTriage()` emits
`Triage: waited {n}ms after speech, ran {n}ms, surfaced {n}` — `waited` is measured from the *oldest*
un-triaged speech, so it is the user-visible dead air, not the age of the newest partial. `streamIntoCard()`
emits `Card "{title}": first text after {n}ms` once per card. Together they split time-to-first-card into
its three real terms without a profiler.

**A stale profile prompt is a latency bug too.** Profiles persisted before the uniform refactor carry a
prompt that tells the agent to ground in documentation URLs Aura no longer injects, and the oldest variant
has no `Watch for:` section at all. Since that same prompt *is* the triage prompt, triage was classifying
with instructions written for an answer agent and surfaced almost nothing — cards were rarer as well as
later. `refreshLegacyAnswerPrompt()` in `src/shared/meeting-profiles.ts` replaces a byte-exact match
against a shipped legacy default; anything the user edited is left alone.

Streaming: `profileAgentCompletion({ onPartial })` sets `SessionConfig.streaming: true` and forwards the
text from `assistant.message_delta`. `streamIntoCard()` throttles those to one card update every 200 ms,
emitting `status: 'running'` with the text so far. `CARD_FORMAT_RULES`, `extractCitedLinks()`, and the
length budget still apply to the **final** text only — partials are raw. Deltas do not fire at all unless
`streaming: true` is set, so `onPartial` is what opts a call in.

**`assistant.streaming_delta` is not the text channel**, despite the name. It fires hundreds of times per
turn, which makes it look like the token feed, but its payload is `{ totalResponseSizeBytes }` — a byte
counter. Text lives only in `assistant.message_delta.data.deltaContent`, and that field is incremental, so
accumulating is correct. This shipped wrong once: subscribing to the plausible-looking event and reading
`data.delta` / `data.content` / `data.text` yielded 208 events and zero characters, and nothing caught it
because a card that never streams is indistinguishable from one that streams and finishes fast. The
extraction now lives in `src/shared/assistant-stream.ts` with `tests/shared/assistant-stream.test.ts`
pinning the event name and field. Deltas carrying `parentToolCallId` come from a sub-agent and are
dropped, so tool-internal reasoning never paints into a user's card.

Not done, deliberately: **session pre-warming**. A warm `createSession` is 129–173 ms and the MCP
handshake ~850 ms, so it saves ~1s while adding lifecycle, staleness, and never-reuse-a-session
constraints. Also rejected: merging triage and fetch into one call (undoes the two-stage design above),
and having Aura call `microsoft_docs_search` directly to skip the model's tool-decision turn (re-adds the
hardcoded docs source that Pitfall #12 exists to prevent).

### Rules

- Keep transcript context ephemeral unless a future requirement explicitly adds persistence.
- Keep visual context ephemeral; do not persist screenshots or OCR text.
- **All surfacing decisions come from the profile prompt.** Do not add regex concept catalogues, keyword lists, or sensitivity dials — a profile that should surface more says so in its prompt.
- **Every trigger goes through `scheduleTriage()`; nothing calls `runTriage()` directly.** Partials, finalized segments, and the cadence interval all schedule, so they share one 1.2s floor. Calling `runTriage()` directly is how the interval path used to bypass it.
- **Triage starts on partials, not only on finalized speech.** Waiting for end-of-utterance plus the next interval tick was the single largest term in time-to-first-card.
- **The partial gate counts new words, not characters, and applies to partials only.** `MIN_NEW_WORDS_FOR_TRIAGE` keeps filler from consuming a tick while letting a growing sentence re-triage. Finalized segments always schedule — "Deploy AKS." is two words and gating it would drop a complete thought.
- **Allow `MAX_CONCURRENT_TRIAGE` triage calls in flight.** Serialising them means an early, uninformative tick blocks the one that has finally heard the subject for the full duration of a triage call. Do not collapse this back to a boolean.
- De-dupe through `classifySurfacedOverlap()`, not exact string match: `duplicate` and `subsumed` are dropped, `extends` refines the existing card in place, `none` opens a new one.
- **Refinement is generation-based and closes at the first streamed character.** `cardGenerations` + `isStaleCardRun()` discard the superseded run; `cancelledCards` cannot express this because a refinement reuses the card id. Once `streamedCards` has the card, open a new one instead of rewriting text under the reader.
- `passiveCardsEnabled` / `explicitAnswersEnabled` are hard kill switches, not tuning knobs. They matter more than before because triage streams transcript to a model on a timer; when both are off, triage never runs at all.
- De-dupe on `topic` for **both** kinds, so an explicit ask cannot re-fire every tick.
- Start exactly one answer agent per `answer` request.
- **Card format is Aura's, not the profile's.** Keep `CARD_FORMAT_RULES` and the per-kind length budget on both fetch prompts; a profile prompt decides *what* to surface, never how much of it fits on screen.
- **Triage runs on `profile.triageModel`, answers on `profile.answerModel`.** Route triage through `resolveTriageModel()` and **both fetch calls through `resolveAnswerModel()`** so an unavailable model falls back instead of silently landing on the SDK default, and never pass `reasoningEffort` without `resolveReasoningEffort()`.
- **Never treat `listModels()` as proof a model works.** A model can be advertised and still be rejected by `session.create`. Recovery belongs at the call site (`createSessionWithModelFallback()`), and `listModels()` must filter `unusableModels` out of its own result or the probe resurrects the dead id.
- **Fetch calls pass `onPartial`.** Cards are meant to paint incrementally; dropping `onPartial` silently triples time to first text because the SDK only emits deltas when `streaming: true`.
- If an answer depends on connector data that is not available, say what still needs verification. This is prompt-enforced, not code-enforced — there is no hardcoded refusal gate.
- Triage or external API failures should log and leave the meeting running — never throw into the transcript path.
- **The decision gate can only say "skip".** It never names a topic, and it never blocks on its own failure: unconfigured, disabled, errored, timed out, malformed, and cooling down all fall through to the LLM. Keep the verdict threshold a constant and keep the gate's questions generic with the profile prompt carried in `state`.
- **Do not `await` the gate when it is not configured.** `runTriage()` checks `isDecisionGateConfigured()` first so an unconfigured install keeps its old synchronous timing, which the existing tests rely on.
- **Never call `credential.getToken` per request on the gate path.** Go through `getAccessToken()` in `decision-gate.ts`, which caches by credential and shares the in-flight request.
- **Only passive cards carry a `learningTerm`.** `startContextLookup()`'s learning-term argument is the privacy boundary: `startPassiveLookup()` passes a term only when `resolveLearningTerm()` matches the profile's curated vocabulary, `startExplicitAnswer()` deliberately passes none. Triage topics are model-generated from raw transcript, so an unmatched topic must never reach disk. Do not change this.
- Learning writes only terms and counters, is debounced, and is skipped when `profile.learningEnabled` is false.
- Evolution proposals are stored on `profile.pendingProposal` and applied only when the user accepts. Because vocabulary can no longer auto-grow from triage topics, **prompt evolution is the primary self-evolution channel**.

## TypeScript Rules

- Strict mode is enabled.
- Do not use `any`; use `unknown` and narrow.
- Main-process relative imports must include `.js` extensions.
- Renderer imports do not need `.js` extensions.
- Prefer `const`; never use `var`.
- Use `interface` for object shapes and `type` for unions/intersections.

## React / Renderer Patterns

- Functional components only.
- Use hooks and clean up IPC listeners in `useEffect` returns.
- Access main process only through `window.aura`.
- Keep the overlay passive and non-intrusive during meetings.
- Support dark/light mode through CSS variables in `global.css`.

## Testing

- Use Vitest.
- Prefer pure tests for triage prompt/parsing helpers — `src/shared/meeting-triage.ts` and `src/shared/answer-links.ts` are fully coverable without mocks.
- Do not add Electron imports to tests.

### Testing `meeting-intelligence.ts`

Three non-obvious requirements, each of which has cost real debugging time:

1. **Transcript segments need live timestamps.** `handleTranscriptSegment` prunes the rolling window by age, so a helper returning `startedAt: 100` puts the segment in 1970 and it is discarded on arrival — `buildIntervalContext()` then returns `null` and triage never runs. Use `Math.floor(Date.now() / 1000)`.
2. **Call `setMeetingListeningState(true)` in `beforeEach`.** `runTriage()` early-returns when not listening.
3. **A second segment within 1.2s is deferred, not dropped.** Multi-tick tests need `vi.useFakeTimers()` plus `await vi.advanceTimersByTimeAsync(1_200)`; set `triageCadence` to a long `interval` so the interval tick does not pollute call counts.
4. **`handlePartialTranscript` now schedules triage.** A partial that adds `MIN_NEW_WORDS_FOR_TRIAGE` words fires a model call on its own, so a test that feeds partials as passive setup will see call counts it did not expect. Feed a one- or two-word partial when you want it to be inert.

Two mocking traps specific to this file:

- **`vi.clearAllMocks()` does not reset `mockReturnValue` or `mockResolvedValue`.** It clears calls, not implementations. `getAvailableModels` is re-stubbed after every `clearAllMocks()` because a value set in one test otherwise leaks into the next. The same trap bites card refinement: a `profileAgentCompletion.mockResolvedValue(...)` left over from another block resolves the fetch immediately, so the card leaves `running`, `canRefineCard()` goes false, and a supersede test silently gets two cards instead of one. Any block that needs a card to stay in flight must pin `mockImplementation(() => new Promise(() => {}))` itself.
- **Adding an import to `meeting-intelligence.ts` breaks every test here.** The `vi.mock('../../src/main/copilot.js')` factory must export it too, or all ~30 tests fail with `No "<name>" export is defined on the mock`. The same goes for `settings.js` (which now needs `getSettings`) and `decision-gate.js` (`runDecisionGate`, `warmDecisionGate`, `resetDecisionGateFailures`).
- **Gate state leaks between `describe` blocks for the same reason as every other mock.** A file-level `beforeEach` resets `mocks.settings` to an unconfigured gate and `runDecisionGate` to `skipped`, so the older blocks keep exercising the LLM-only path. A gate test must configure both the settings *and* the `runDecisionGate` result.

Drive tests by stubbing `agentCompletion` to return `JSON.stringify({ surface: [...] })` rather than by crafting transcript text — the model decides what to surface, so transcript wording proves nothing.

## Common Pitfalls

1. Do not re-add the old chat input as the primary UX.
2. Do not persist transcripts by default.
3. Do not add screen capture or vision paths.
4. Do not recreate knowledge graph tables or entity extraction.
5. Do not spawn multiple agents for one `answer` request.
6. Never pass a learning term from `startExplicitAnswer()`, and never pass an unmatched triage topic from `startPassiveLookup()` — both are raw transcript-derived text.
7. Do not store profile config without wiring it into the SDK session; cosmetic config is a defect.
8. Do not auto-apply evolution proposals or auto-switch profiles.
9. Do not import Electron or the Copilot SDK from `src/shared/`.
10. Do not attach MCP servers or skills to the triage call; that is the fetch stage's job.
11. Do not reintroduce concept regexes, keyword catalogues, or a sensitivity setting — the prompt owns surfacing.
12. Do not special-case any card source in code. If documentation, or CRM, or anything else needs to reach a profile, it does so as an MCP server or a skill the user could have added themselves.
13. Do not run triage on the answer model, and do not pass `reasoningEffort` unguarded — the first costs ~5s per card, the second throws out of `createSession` on models that do not support it.
14. Do not subscribe to `assistant.streaming_delta` for answer text — it carries a byte count, not words. Read `deltaContent` off `assistant.message_delta` through `readAssistantDelta()`, which also drops sub-agent deltas.
15. Run `npx tsc -p tsconfig.main.json --noEmit` and `npx tsc -p tsconfig.renderer.json --noEmit` separately; bare `tsc --noEmit` uses the root config and reports bogus JSX errors. The renderer check has one known pre-existing failure — `useAudioCapture.ts` `ArrayBuffer | SharedArrayBuffer` — that predates the profiles work and does not affect `vite build`. Main must be clean; renderer must show only that one error.
16. Do not call `runTriage()` from a new trigger — go through `scheduleTriage()`, or that trigger silently escapes the 1.2s floor.
17. Do not assume `%APPDATA%\Aura\settings.json` when debugging a dev build. Unpackaged Electron uses the default product name, so the live file is **`%APPDATA%\Electron\settings.json`**; the documented path is only correct for a packaged build. Read the file raw rather than picking fields off `ConvertFrom-Json` — a legacy blob simply lacks the new keys, which looks like corruption otherwise, and settings are written only on change, so disk can legitimately lag the normalized in-memory profile.
18. Do not cancel a superseded card run through `cancelledCards`. It is keyed by card id and a refinement reuses that id, so it would kill the replacement too. Use `bumpCardGeneration()` / `isStaleCardRun()`.
19. Do not tighten the triage prompt back to a flat "never repeat what was already surfaced". Triage runs mid-sentence, so the fuller topic always arrives after the shorter one; a flat rule suppresses it and makes card refinement dead code. `tests/shared/meeting-triage.test.ts` pins the wording that keeps it alive.
20. Do not add a model guard that only consults `listModels()`. The advertised list is **not** authoritative — `gpt-5.6-luna` was advertised and rejected at `session.create`, every list-based guard passed, and the app produced **zero cards** while appearing merely slow. Detect the real failure with `isModelUnavailableError()`, recover by retrying with no model override, and prune the id from `availableModels` **and** from `listModels()`'s own result so the models probe cannot re-advertise it.
21. Do not validate only the triage model. `profileAgentCompletion()` reaches the same `createSession`, so an unguarded `profile.answerModel` fails identically — pass `resolveAnswerModel(profile)` at both fetch call sites.
22. Do not make the decision gate load-bearing. If a gate failure can suppress a card, the gate is wrong: only `decided` + `decline` may stop the LLM, and everything else must fall through. Do not give it a user-facing threshold either — that is a sensitivity dial in disguise.
23. Do not point the decision gate at the Speech endpoint. The same `AIServices` resource serves the decision route only on `*.services.ai.azure.com`; `*.cognitiveservices.azure.com` answers with an empty-bodied 404 that looks like a missing deployment. The gate's `model` is the user's *deployment* name, and a resource can lack the model entirely (it is not offered in every region).
24. Do not hand `getToken` to the gate per request. A credential chain ending in the Azure CLI starts a process each call (~1.5s), which turned a ~0.3s decision into ~1.7s when measured. Use the cached `getAccessToken()` and warm it when listening starts.

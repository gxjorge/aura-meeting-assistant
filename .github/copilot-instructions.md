# Copilot Instructions — Aura

Aura is a Windows Electron meeting-intelligence app. It listens during calls and surfaces a passive card feed.

## Product Scope

- Meeting-only assistant.
- Behaviour is governed by the active **meeting profile**: prompt + MCP servers + skills + vocabulary. There is no built-in card source — documentation, CRM, and everything else arrive as MCP servers.
- **The profile prompt decides what gets surfaced.** A periodic LLM triage pass runs the profile prompt over the rolling transcript and returns `passive` requests (background context) and `answer` requests (research one question). There is no hardcoded concept catalogue and no sensitivity setting.
- Transcript context is ephemeral by default.
- No screen capture, persistent chat, knowledge graph, timeline, or fleet-style ambient agent orchestration.

## TypeScript Rules

- Strict mode is enabled.
- Never use `any`; use `unknown` and narrow.
- Use functional style; no classes except where Electron APIs require them.
- Main-process relative imports need `.js` extensions.
- Renderer imports do not need `.js` extensions.
- Prefer `const` over `let`; never use `var`.
- Use `interface` for object shapes and `type` for unions/intersections.

## IPC Patterns

- Register channels in `src/shared/types.ts` under `IPC`.
- Add preload methods to `AuraAPI` and implement them in `src/preload/index.ts`.
- Use request-response IPC for auth/settings/profiles/status.
- Use event IPC for transcript input, meeting card create/update events, and card interaction signals.
- Card updates should replace by `card.id`.

## Meeting Profile Patterns

- Read prompt, model, MCPs, and skills from `getActiveProfile()` — no module-level behaviour constants.
- One prompt per profile: `systemPrompt` governs triage, passive cards, and answers. There is no separate passive prompt.
- **A profile is prompt + MCPs + skills, and nothing else.** Never special-case a card source in code. The seeded `azure-docs` profile gets documentation from the `microsoft-learn` MCP server (`https://learn.microsoft.com/api/mcp`) — ordinary config the user can edit or remove.
- Apply profile config through `profileAgentCompletion()`; config that is stored but never handed to the SDK is a bug.
- Keep sessions hermetic (`enableConfigDiscovery` stays `false`); MCP `tools` defaults to `['*']`.
- Profile activation is manual only — no auto-detection or calendar integration.
- Export strips `env`/`headers` and drops learned state.
- Keep profile logic that needs no `fs`/Electron in `src/shared/` (`meeting-profiles.ts`, `profile-session-config.ts`, `profile-learning.ts`, `answer-links.ts`).

## Meeting Intelligence Patterns

- Keep transcript context in memory.
- Keep visual context in memory; never persist screenshots or OCR text.
- Detect cards only through triage: `buildTriageSystemPrompt()` puts the profile prompt first, and the model returns `{"surface":[{kind,topic,query,reason}]}`. Never reintroduce hardcoded concept regexes.
- Triage runs without MCP servers or skills; only the fetch stage that follows gets the full profile session.
- **An optional decision gate (Microsoft-Decision-1 on Foundry) runs ahead of the LLM triage and can only say "skip".** It is asked with the profile prompt, never names a topic, and fails open: unconfigured, disabled, errored, timed out, or cooling down all fall through to the LLM. Its verdict threshold is a constant, not a setting. Its endpoint is the Foundry host (`*.services.ai.azure.com`), not the Speech one, and ships blank. Go through the cached `getAccessToken()` — an uncached Azure CLI token costs ~1.5s per call. Do not `await` it when unconfigured.
- Both fetch branches are the same call: `startPassiveLookup()` renders a `context` card, `startExplicitAnswer()` an `answer` card, and both run the profile prompt over the profile's MCPs and skills.
- Any URL an agent cites becomes a clickable card source via `extractCitedLinks()` — citations are universal, not documentation-specific.
- De-dupe through `classifySurfacedOverlap()` (`duplicate`/`subsumed` dropped, `extends` refines that card in place) and respect the 1.2s triage floor plus `triageCadence`.
- **Every trigger goes through `scheduleTriage()` — never call `runTriage()` directly.** Partials, finalized segments, and the cadence interval all share the one 1.2s floor.
- **Triage starts on a partial once it adds `MIN_NEW_WORDS_FOR_TRIAGE` words, not only on finalized speech.** Waiting for end-of-utterance plus the next interval tick was the biggest term in time-to-first-card; the word delta keeps filler from consuming a tick. Finalized segments skip the gate — a two-word utterance would never reach it.
- **Allow `MAX_CONCURRENT_TRIAGE` (2) triage calls in flight.** Serial triage lets an early, uninformative tick block the one that finally heard the subject for the full ~3.3s of a call.
- **Superseding a card is generation-based (`bumpCardGeneration()` / `isStaleCardRun()`), never `cancelledCards`** — a refinement reuses the card id, so an id-keyed cancel would kill the replacement too. The window closes at the first streamed character (`streamedCards`); after that, open a new card rather than rewriting text mid-read.
- **Do not tighten the triage prompt back to a flat "never repeat".** Triage runs mid-sentence, so the fuller topic always follows the shorter one; suppressing it makes refinement dead code.
- **Triage runs on `profile.triageModel`, answers on `profile.answerModel`.** Triage only classifies, so it uses a fast model; route triage through `resolveTriageModel()` and both fetch calls through `resolveAnswerModel()` so a model this account cannot use falls back instead of silently landing on the SDK default.
- **`listModels()` is not proof a model works.** A model can be advertised and still rejected by `session.create` — that combination produced zero cards while looking like slowness, because every guard was a list lookup. Detect the real failure with `isModelUnavailableError()` (`src/shared/model-availability.ts`), retry with no model override, and filter `unusableModels` out of `listModels()`'s own result so the models probe cannot re-advertise a dead id.
- **Both fetch calls pass `onPartial`, so cards paint incrementally** — `streamIntoCard()` emits `status: 'running'` with the text so far, throttled to 200ms. `CARD_FORMAT_RULES` and `extractCitedLinks()` still apply to the final text only. Deltas do not fire unless `streaming: true`, which `onPartial` sets.
- **Answer text comes from `assistant.message_delta.data.deltaContent` only.** `assistant.streaming_delta` fires far more often but carries `{ totalResponseSizeBytes }` — a byte counter with no text. Go through `readAssistantDelta()` in `src/shared/assistant-stream.ts`; it also drops sub-agent deltas (`parentToolCallId`) so tool-internal reasoning never paints into a card.
- **Never pass `reasoningEffort` without `resolveReasoningEffort()`** — an unsupported model makes `createSession` throw, taking out every call.
- Start exactly one explicit-answer agent per `answer` request and expose cancellation.
- Card format is Aura's, not the profile's: both fetch prompts append `CARD_FORMAT_RULES` plus a per-kind length budget (3 bullets passive, 6 lines answer). A profile prompt decides what to surface, never how much of it fits in the overlay.
- If connector-backed data is unavailable, say what still needs verification. This is prompt-enforced; there is no hardcoded refusal gate.
- Catch external API failures and return empty/failed-card states.
- **Only passive cards carry a `learningTerm`, and only when `resolveLearningTerm()` matches the profile's curated vocabulary.** Triage topics are model-generated from transcript, so an unmatched topic must never reach disk. Never pass a term from `startExplicitAnswer()`.
- Evolution proposals live on `profile.pendingProposal` and are applied only on explicit user approval.

## React Patterns

- Functional components only.
- Use hooks and clean up IPC listeners.
- Access main process through `window.aura`.
- Keep the overlay non-intrusive during meetings.
- Support dark/light mode with CSS variables in `global.css`.

## Testing

- Use Vitest.
- Prefer pure tests for triage, profile, parser, and citation-link logic.
- Do not import Electron modules in tests.
- **`vi.clearAllMocks()` clears calls, not implementations.** A stale `profileAgentCompletion.mockResolvedValue(...)` from another block resolves the fetch instantly, so the card leaves `running` and refinement silently stops working. Blocks that need a card in flight must pin `mockImplementation(() => new Promise(() => {}))`.
- Typecheck with `npx tsc -p tsconfig.main.json --noEmit` and `npx tsc -p tsconfig.renderer.json --noEmit` separately; bare `tsc --noEmit` uses the root config and reports bogus JSX errors.
- When debugging a dev build, live settings are at `%APPDATA%\Electron\settings.json` — unpackaged Electron uses the default product name, not `Aura`.

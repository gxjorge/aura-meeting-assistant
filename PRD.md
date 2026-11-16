# PRD: Aura Meeting Intelligence Assistant

## Summary

Aura is a Windows Electron app that listens during calls and surfaces just-in-time information based on the meeting discussion. The overlay is a passive card feed, not a chat window.

## Product Boundary

Aura is meeting-only.

In scope:

- Transcribe meeting audio.
- Keep a rolling, ephemeral transcript context.
- Decide what is worth surfacing by running the active profile's prompt over the transcript, not by pattern-matching a fixed concept list.
- Surface background context cards by running the active profile's prompt over its own MCP servers and skills.
- Run exactly one answer agent when the profile decides a question needs answering.
- Use configured connectors for explicit-answer research as they become available.
- Let users start/stop listening clearly.
- Let users minimize Aura like a normal app; layover/always-on-top behavior must be opt-in.
- Let users pick a **meeting profile** that determines the prompt, MCP servers, and skills Aura uses for that call.
- Show connected MCPs/connectors in Settings and let users add additional MCP endpoints.

Out of scope:

- Screen capture and vision.
- Persistent knowledge graph memory.
- Generic chat assistant behavior.
- Timeline/history view.
- Fleet-style ambient agent orchestration.
- Aura as a Copilot Extension.
- A profile marketplace (profiles export/import as credential-stripped JSON; distribution is deferred).

## User Stories

1. As a meeting participant, I want Aura to listen during calls so I do not need to type prompts while speaking.
2. As someone explaining a technical concept, I want Aura to surface relevant official docs automatically, using a profile I can point at a different documentation source if I need to.
3. As someone who says “I need to check that,” I want Aura to start one answer agent without interrupting the meeting.
4. As a privacy-conscious user, I want transcript context to be ephemeral by default.
5. As a user in Microsoft-heavy meetings, I want explicit answers to be able to use configured work connectors when available.
6. As a user tuning meeting noise, I want passive checks to run on finalized transcript, a fixed interval, or both.
7. As someone who runs different kinds of calls, I want to switch Aura between a sales-review profile, a training profile, and a document-review profile so each call gets the right tools and framing.
8. As a profile author, I want to edit the profile's prompt, MCP servers, and skills directly, and export the profile as JSON without leaking my credentials.
9. As a repeat user of a profile, I want Aura to quietly learn which cards I actually engage with, and to propose prompt improvements I can accept or reject.
10. As someone in a Loop engineering session, I want to write a prompt that says "surface every engineering concept mentioned" and have Aura do exactly that, without waiting for those concepts to be added to Aura's code.
11. As someone reviewing a sales pipeline, I want to write a prompt that says "when an account or opportunity is discussed, pull it from MSX" and have Aura recognise account names it has never seen.

## Functional Requirements

### Meeting Profiles

- A meeting profile bundles a single system prompt, an answer model, a triage model, MCP servers, skills, and optional trigger vocabulary. **That is the whole configuration surface** — Aura has no built-in card source, so every capability a profile has is something a user could have configured themselves.
- **The profile prompt decides what Aura surfaces, not just how it answers.** A prompt should describe what to watch for in the conversation; Aura runs it over the transcript to make surfacing decisions.
- Exactly one profile is active at a time. Activation is **manual only** — from the overlay switcher, the tray submenu, or Settings. Aura must not auto-detect meeting type or read the calendar.
- The `azure-docs` profile ships as the default. It is an ordinary profile whose MCP list contains the public Microsoft Learn server, so Aura's documentation behaviour is configuration rather than code. It is non-deletable so a fresh install always has something that works, but every field including its prompt and MCP servers is editable.
- Users can add starter profiles (Sales review, Training, Document review), create blank profiles, edit every field including the prompt, and delete any non-built-in profile.
- Profile MCP servers and skills must be handed to the Copilot SDK per session. Configuration that is displayed but not applied is a defect.
- Sessions are hermetic: Aura must not inherit MCP or skill configuration from the working directory.
- Profiles export and import as JSON with a `schemaVersion`. **Export must strip `env` and `headers`** so shared profiles never carry credentials, and must drop learned state.

### Profile Self-Evolution

- Each profile can learn from card interaction signals (`opened`, `link_opened`, `dismissed`, `cancelled`), which decay over time.
- Learning must persist **only derived terms and numeric counters** — never transcript text. A term is persisted only when it already appears in the profile's own curated vocabulary; because triage topics are model-generated from raw transcript, an unmatched topic contributes nothing.
- Repeatedly rejected vocabulary terms are demoted. Vocabulary is a user-curated "always watch for these" hint list, hard-capped in size.
- After a meeting, once enough signal has accumulated, an agent may propose prompt changes. Proposals are stored as `pendingProposal` and require explicit user approval; nothing is applied automatically. Prompt evolution is the primary self-evolution channel.
- Learning is per-profile and can be switched off.

### Listening and Transcription

- Aura must expose a visible listening toggle in the overlay and tray.
- Aura must target both microphone and system meeting audio.
- Local transcription is the default path.
- Azure Speech real-time transcription and Azure MAI-Transcribe through Azure Speech LLM Speech are opt-in cloud STT options.
- Transcript context is stored in memory only by default.
- Visual context is optional, disabled by default, and stored in memory only.
- When enabled, Aura captures primary-screen context on finalized transcript segments and can run local OCR.

### Deciding What to Surface

- Aura periodically hands the rolling transcript to a model whose system prompt is the active profile's prompt, and asks what — if anything — is worth surfacing right now.
- The model returns zero or more requests, each either a `passive` context card or an `answer` to research. Aura caps how many it will act on per pass.
- **There is no built-in list of interesting concepts.** What counts as interesting is entirely what the profile prompt says. Changing behaviour means editing a prompt, not shipping code.
- The profile's vocabulary, if set, is passed to the model as terms that are always worth watching for. It is a hint, not a trigger.
- Aura must de-dupe repeated topics so the same subject does not resurface every pass.
- This pass runs without the profile's MCP servers or skills. Most passes surface nothing, so it must stay cheap.
- This pass only classifies, so it runs on its own fast model rather than the profile's answer model. Both are user-editable per profile, and an unavailable triage model must fall back rather than stop triage.
- Users can choose whether the pass runs on finalized transcript, a fixed interval, or both, and can disable passive cards or answers independently. Disabling both stops transcript from being sent to a model at all.

### Latency

- A card is two model calls, so the wait before something appears is the product's main quality risk. Time to *first visible text* is the number that matters, not time to the finished card.
- Cards must paint incrementally: an agent's answer streams into the card body while it is still being written, so the user sees text in a few seconds rather than waiting for the whole answer.
- Aura should not make the user wait on work that adds nothing. Triage classifies and therefore runs on a fast model; the throttle floor between passes tracks how long triage actually takes.

### Passive Cards

- Passive cards come from the active profile running its own prompt against its own MCP servers and skills. There is no built-in card source and no source selector.
- Cards render as `context` cards: a title taken from the triage topic, a body from the agent, and clickable links for any URL the agent cited.
- A card is visible while it is still filling in, showing partial text; formatting and link extraction apply to the finished answer.

### Answers

- Aura should auto-start exactly one answer agent per requested answer.
- Aura should show a cancellable “researching” card while the agent works.
- The answer comes from the profile's own MCP tools and skills. Aura should surface any source the agent cited as a clickable link on the card.
- The profile prompt is responsible for requiring the agent to state explicitly what it could not verify. Aura does not hardcode a refusal.
- Aura should let users remove cards that were not helpful; removing a running card should cancel its in-flight updates.
- The answer agent may use configured connectors for GitHub, Azure DevOps, Teams, Email, Calendar, and documentation once those adapters are implemented.
- If connector data is unavailable, Aura must say what still needs verification instead of pretending it checked it.

### Visual Context

- Aura should let users choose Off, screenshot-to-agent, local OCR, or both.
- Local OCR should run on-device and attach extracted screen text to meeting intelligence.
- Screenshots and OCR text should remain ephemeral and not be persisted.
- If direct image attachment is unavailable in the agent transport, Aura should use OCR text and say image-native support is not active.

## Non-Functional Requirements

- Meeting flow must stay non-intrusive.
- Users must be able to stop listening quickly.
- No long-term transcript persistence by default.
- Profile learning must never persist transcript text — only curated-vocabulary terms and counters.
- Network/API failures should produce failed cards, not crashes.
- Main-process external API calls should catch errors and return empty/error states.

## Current State

Implemented:

- Electron shell, tray, overlay, and GH CLI auth.
- Local microphone and system-audio transcription path with Vosk and one-time model caching.
- Optional Azure Speech real-time and Azure MAI-Transcribe-1.5 transcription paths with local Vosk fallback.
- Source-aware capture planning for microphone, system audio, or both.
- Normal minimizable app window with opt-in layover mode.
- Settings section for connected MCPs/connectors.
- Ephemeral transcript handling.
- Prompt-driven triage: the active profile's prompt decides what is worth surfacing, replacing the previous hardcoded concept heuristics and sensitivity setting.
- Uniform card sourcing: every card is fetched by running the profile prompt over the profile's own MCP servers and skills, replacing the previous hardcoded `official_docs` source.
- Seeded **Azure docs** profile wired to the public Microsoft Learn MCP server (`https://learn.microsoft.com/api/mcp`).
- Clickable citation links extracted from any agent answer, for any profile.
- Passive-check cadence setting for finalized transcript, fixed interval, or both, with a 4s floor between triage passes.
- Custom MCP endpoint configuration in Settings.
- Meeting profiles with per-profile prompt, answer model, triage model, MCP servers, skills, and vocabulary.
- Streaming card bodies: agent answers paint into the card as they are written, so text appears with the first chunk instead of at the end of the turn.
- Real per-session Copilot SDK wiring for profile MCP servers and staged `SKILL.md` skill directories.
- Profile switcher in the overlay and tray, profile CRUD UI, and credential-stripped JSON export/import.
- Legacy flat-settings migration into the seeded `azure-docs` profile, including attaching the Learn MCP server to profiles that were persisted with the old `official_docs` source.
- Profile-driven passive `context` cards.
- Per-profile learning from card signals, vocabulary demotion, and approval-gated prompt evolution proposals.
- Single source-backed answer-agent cards, started only when triage requests an answer.
- Chat, KG, persisted session, and old agent-sidebar surfaces removed.

Not implemented yet:

- Microsoft Entra auth for Microsoft-side connectors.
- Connector adapters for Teams, Email, Calendar, Azure DevOps, and GitHub-backed explicit research.
- Profile marketplace / distribution.

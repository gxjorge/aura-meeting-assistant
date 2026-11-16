# Plan: Aura — Meeting Intelligence Assistant

## Product Decisions

- Aura is a meeting-only Electron app.
- The overlay is a passive card feed, not a chat UI.
- Transcript context is ephemeral by default.
- Implicit asks surface official documentation.
- Explicit asks auto-start exactly one answer agent and show a cancellable card.
- Full meeting audio means microphone + system audio.
- STT is local-first, with Azure Speech Services in Azure AI Foundry as the cloud option.
- Explicit-answer research should eventually use configured connectors: Microsoft Docs, custom MCPs, GitHub, Azure DevOps, Teams, Email, and Calendar.

## Architecture

```text
Meeting audio
  -> STT provider
  -> rolling transcript window
  -> trigger detection
       -> implicit docs cards
       -> explicit answer-agent card
```

## Phase 1: Clean Meeting Shell

**Goal:** Remove the old broad ambient-assistant surfaces and leave a focused meeting card feed.

Acceptance criteria:

- [x] Remove chat-first overlay UI.
- [x] Remove persisted chat sessions.
- [x] Remove knowledge graph and entity extraction modules.
- [x] Remove old agent sidebar/detail UI.
- [x] Add meeting card IPC events.
- [x] Add React meeting card feed.
- [x] Keep GH CLI auth and Copilot SDK access.

## Phase 2: Listening Foundation

**Goal:** Make Aura reliably hear the meeting.

Acceptance criteria:

- [x] Local microphone transcription tracer bullet.
- [x] Cache downloaded local STT model archives and reuse them on later starts.
- [x] Capture system meeting audio through the browser/Electron display-media path.
- [x] Merge mic + system transcript segments into one chronological stream.
- [x] Keep transcript context in memory only.
- [x] Add optional primary-screen visual context with local OCR.
- [x] Add visible listening indicators and quick stop controls.
- [ ] Add Azure Speech Services provider behind the STT interface.

## Phase 3: Implicit Documentation Surfacing

**Goal:** Surface docs when technical concepts are being discussed, without keyword spam.

Acceptance criteria:

- [x] Detect concept + detail context.
- [x] Search Microsoft Docs and GitHub Docs.
- [x] Render docs as passive cards.
- [x] De-dupe repeated concepts.
- [x] Add docs proposal sensitivity setting for all mentions vs implicit/explicit asks.
- [ ] Improve ranking with transcript context.
- [ ] Add throttling controls and user feedback for noisy concepts.

## Phase 4: Explicit Answer Agent

**Goal:** When the meeting contains an explicit “I need to check that” moment, run one agent and surface the result.

Acceptance criteria:

- [x] Detect explicit ask phrases.
- [x] Auto-start one answer card.
- [x] Allow cancellation from the card feed.
- [x] Surface related official docs while the answer runs.
- [ ] Add connector adapter interface.
- [ ] Add Microsoft Entra auth for Graph/ADO connectors.
- [ ] Add connector adapters for Teams, Email, Calendar, Azure DevOps, and GitHub.
- [ ] Make the answer cite which sources/connectors were actually checked.

## Phase 5: Meeting Polish and Privacy

**Goal:** Make the app safe and useful in real meetings.

Acceptance criteria:

- [x] Show exactly what Aura is listening to: mic, system audio, or both.
- [ ] Add a temporary pause/snooze control.
- [ ] Add clear failure cards for STT, docs, connector, and answer-agent failures.
- [x] Add settings for local STT model, meeting audio source, docs surfacing, and explicit-answer automation.
- [x] Add settings for visual context mode, local OCR, and ephemeral screen context.
- [x] Add opt-in layover mode while keeping Aura minimizable as a normal taskbar app.
- [x] Show connected MCPs/connectors in Settings.
- [x] Add custom MCP endpoints from Settings.
- [ ] Add settings for Azure Speech provider.
- [ ] Add optional user-triggered export/save later; keep default ephemeral.

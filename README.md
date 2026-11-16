# Aura — Meeting Intelligence Assistant

> Aura listens during calls and surfaces just-in-time information without turning the meeting into a chat session.

> **Demo project.** Aura is a proof of concept shared as-is, without warranty or support. The author is not responsible for how it is used. See the [Disclaimer](#disclaimer).

## What is Aura?

Aura is a Windows Electron desktop app for live meetings. It transcribes meeting audio, keeps a short ephemeral transcript window, and shows a passive overlay feed of useful cards.

What Aura considers worth surfacing is decided by the **active meeting profile's prompt**, not by anything hardcoded. Every few seconds Aura hands the rolling transcript to a model along with that prompt and asks: *given this profile, is anything here worth surfacing right now?* The model can reply with background context to pull, or a question to go research.

That makes behaviour a matter of writing a prompt rather than changing code:

| Profile prompt says | Aura surfaces |
|---|---|
| "Watch for Azure and GitHub products being discussed" | Official docs cards for those products, via the Microsoft Learn MCP server |
| "Watch for engineering concepts mentioned in this session" | Context on every concept as it comes up |
| "Watch for accounts and opportunities being discussed" | The matching MSX records, via the profile's MCP servers |

Every row above is the same code path. A profile is just **a prompt plus MCP servers plus skills** — Aura has no privileged built-in card source. Documentation is not a special case: the profile Aura ships with, **Azure docs**, reaches Microsoft Learn through its public MCP server (`https://learn.microsoft.com/api/mcp`), which you can edit, extend, or swap out like any other server.

Aura has two card types:

| Card | Raised when | Result |
|--------|---------|--------|
| **Passive context** | The profile prompt says the current discussion is worth background context. | Aura runs the profile prompt over the profile's MCP servers and skills and surfaces the result as a context card. |
| **Answer** | The profile prompt says there is a question worth researching. | Aura auto-starts one cancellable answer card, using the same profile config, and shows any source the agent cited as a clickable link. |

The product is intentionally meeting-only. Aura does **not** watch the screen, maintain a knowledge graph, persist chat history, run a fleet of ambient agents, or act as a generic assistant.

## Positioning

Aura explores a customer pattern for proactive, meeting-native assistance: bring the right context into the live conversation at the moment it is needed, while keeping the experience passive and non-intrusive.

This is adjacent to proactive and continuous work patterns: rather than waiting for a user to open chat and prompt explicitly, Aura listens to the meeting context, detects moments where information would help, and proposes just-in-time cards. Future versions can learn from user interactions, such as cards opened, dismissed, acted on, or followed up on, to improve relevance, timing, and personalization while keeping transcript context ephemeral by default.

## Current Implementation

- Electron shell with tray and overlay window.
- GitHub CLI auth for Copilot/GitHub Models access.
- Local Vosk-based microphone and system-audio transcription path with one-time model caching.
- Optional Azure MAI-Transcribe-1.5 cloud transcription through Azure Speech LLM Speech.
- Optional Azure Speech real-time transcription through the browser Speech SDK.
- Ephemeral in-memory transcript window.
- Meeting audio source setting: microphone, system audio, or both.
- Optional visual context setting that captures the primary screen per transcript segment and can attach local OCR text.
- Meeting profiles: a named bundle of prompt, answer model, MCP servers, skills, and vocabulary, switchable from the overlay, tray, or Settings.
- Prompt-driven triage: the active profile's prompt decides what is worth surfacing, so profiles are not limited to a fixed list of recognized concepts.
- Optional decision gate: Microsoft-Decision-1 on Microsoft Foundry makes the fast "is anything here worth surfacing?" call, so the LLM only wakes up when something probably is.
- Per-session Copilot SDK wiring so profile MCP servers and staged `SKILL.md` skills are actually applied, not just displayed.
- Starter profiles for sales review, training, and document review, plus blank-profile creation and credential-stripped JSON export/import.
- Seeded **Azure docs** profile wired to the public Microsoft Learn MCP server, so documentation is configuration rather than a hardcoded source.
- `context` cards for passive surfacing, with clickable links for any source the agent cited.
- Passive-check cadence setting: finalized transcript, fixed interval, or both, with an 8s floor between triage passes.
- Independent kill switches for passive cards and answers; turning both off stops transcript being sent to a model at all.
- Single answer agent powered by the Copilot SDK, started only when the profile asks for one.
- Per-profile learning from card signals, plus approval-gated prompt evolution proposals.
- Cards can be removed from the feed when they are not useful; removing a running card cancels its in-flight updates.
- React card feed UI with no chat input.
- Normal minimizable app window by default, with an optional layover mode to keep Aura above other windows.
- Settings shows connected MCP/documentation sources and lets users add custom HTTP MCP endpoints.

Richer connector adapters and profile distribution are planned next.

## Work IQ setup

Aura can connect a meeting profile to the hosted Work IQ MCP server and authenticate with your
Microsoft 365 identity. In **Meeting profiles**, add the Work IQ preset and select **Connect Work IQ**.
Aura opens Microsoft sign-in in your system browser and receives the authorization response on
`http://localhost`. Work IQ tokens stay in memory and are discarded when Aura exits.

Aura's **Add Work IQ** MCP server preset ships with this single-tenant public-client configuration:

| Setting | Default |
| --- | --- |
| Application (client) ID | `ba081686-5d24-4bc6-a0d6-d034ecffed87` |
| Directory (tenant) ID | `72f988bf-86f1-41af-91ab-2d7cd011db47` |

The app registration must be configured as a **Mobile and desktop application** with
`http://localhost` as a redirect URI. It also needs the delegated Work IQ permission
`WorkIQAgent.Ask` with tenant admin consent.

Both public identifiers are stored on the Work IQ MCP server and can be overridden in that server's
entry under **Meeting profiles → MCP servers**. A connection is scoped to that exact client/tenant
pair, so changing either value requires reconnecting. Aura does not fall back to the Azure CLI client
because Microsoft Entra rejects that first-party client/resource combination with `AADSTS65002`.

No client secret is used or stored. Each caller needs the required Microsoft 365 Copilot/Work IQ
entitlement, and Work IQ continues to enforce that user's Microsoft 365 permissions, sensitivity
labels, and tenant policies. The initial Aura preset allows only read-oriented Work IQ tools.

## Prerequisites

- **Node.js** >= 20
- **GitHub CLI** authenticated via `gh auth login`
- **Azure CLI** authenticated via `az login` when using Azure MAI-Transcribe
- **Windows** 10/11

## Azure Speech setup

Azure transcription is optional and local Vosk remains the default STT provider. To enable cloud transcription, open Settings and choose either **Azure Speech real-time** for low-latency continuous recognition or **Azure MAI-Transcribe-1.5 (preview)** for buffered LLM Speech transcription, then enter your own Speech/Foundry resource endpoint (the field starts blank).

Aura authenticates with Microsoft Entra from the Electron main process and does not store Speech API keys. The signed-in Azure user must have Cognitive Services User access on the configured Speech/Foundry resource. For Azure MAI, Aura retries transient network failures, HTTP 408/429 responses, and HTTP 5xx responses twice before falling back to local Vosk. Authentication, authorization, endpoint, and other permanent request failures fail fast. If local fallback also fails, the status preserves both the Azure error and the Vosk error so the original cause remains visible.

## Decision gate setup

Triage normally asks an LLM, on every pass, whether anything in the transcript is worth surfacing. That call takes about three seconds, and most passes answer "no". The optional **decision gate** replaces that first question with [Microsoft-Decision-1](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision), a decision model that returns a calibrated probability, typically in a few hundred milliseconds. The LLM then runs only when the gate says something is probably worth surfacing, names the topic, and the profile's MCP servers and skills do the search, exactly as before. The gate is asked using the same profile prompt, so the profile still decides what counts.

To turn it on:

1. Deploy **Microsoft-Decision-1** to a Microsoft Foundry resource in a region that offers it. Availability varies by region, so check the model catalog.
2. In Settings, open **Decision gate** and enter the resource's **Foundry endpoint** (`https://<resource>.services.ai.azure.com`) and the **name you gave the deployment**. This is not the Speech endpoint (`*.cognitiveservices.azure.com`) that the same resource also has; that host does not serve the decision route.
3. Run `az login` and make sure your user has **Cognitive Services User** access on the resource.

The endpoint starts blank, so nothing changes until you set it. The gate never blocks a card: if it is switched off, misconfigured, or unreachable, the LLM decides as before, and after three failures in a row Aura stops calling it for two minutes. Aura authenticates with Microsoft Entra and does not store keys. Transcript excerpts are sent to the resource you configure.

## Triage and answers

Aura can run its triage pass when STT finalizes an utterance, every configured number of seconds, or both. The interval path uses only the current in-memory transcript and partial recognition text. There is an 8s floor between passes, and the pass itself runs without MCP servers so it stays cheap. With a decision gate configured, each pass starts with the gate, and the LLM only runs when the gate does not say no.

Answers are backed by whatever the active profile is connected to. The Azure docs profile answers from Microsoft Learn because that profile has the Learn MCP server attached; a sales profile answers from MSX for the same reason. Aura promotes any URL the agent cites into a clickable link on the card, and the profile prompt — not hardcoded logic — is what requires the agent to state explicitly what it could not verify.

Cards are sized for a glance, not for reading. Whatever the profile prompt says, Aura caps each card at roughly three bullets for passive context or six lines for an answer, and strips the usual chat-assistant furniture — no headings, no tables, no trailing "Sources" list, since cited links already render as clickable chips.

## Quick Start

```bash
npm install
npm test
npm run dev
```

## Project Structure

```text
src/
├── main/
│   ├── index.ts                 # Electron lifecycle, tray, shortcuts
│   ├── auth.ts                  # GH CLI auth validation
│   ├── azure-credential.ts      # Shared Entra credential for Azure Speech and the decision gate
│   ├── copilot.ts               # Copilot SDK completions + profile session config
│   ├── decision-gate.ts         # Microsoft-Decision-1 call: fail-open, token cache, backoff
│   ├── ipc.ts                   # Meeting-card and profile IPC handlers
│   ├── meeting-detection.ts     # Rolling transcript window helpers
│   ├── meeting-intelligence.ts  # Triage scheduling + card orchestration
│   ├── profile-skills.ts        # Stage profile skills as SKILL.md on disk
│   ├── profile-evolution.ts     # End-of-meeting prompt proposals
│   ├── visual-capture.ts        # Optional primary-screen capture
│   ├── overlay.ts               # Floating overlay window
│   ├── settings.ts              # User settings JSON + profile persistence
│   └── tray.ts                  # Tray icon, listening toggle, profile submenu
├── preload/
│   └── index.ts                 # contextBridge API
├── renderer/
│   ├── App.tsx                  # Auth + listening state + card feed
│   ├── components/
│   │   ├── AuthError.tsx
│   │   ├── MeetingFeed.tsx
│   │   ├── Profiles.tsx         # Profile CRUD, prompt/MCP/skill editors
│   │   └── Settings.tsx
│   ├── hooks/
│   │   ├── useAudioCapture.ts   # Local Vosk, Azure Speech realtime, or Azure MAI capture
│   │   └── useVisualContext.ts  # Optional screen capture + local OCR
│   └── styles/
│       └── global.css
└── shared/
    ├── types.ts                 # IPC, settings, transcript, card, profile types
    ├── meeting-profiles.ts      # Profile defaults, templates, migration, export
    ├── meeting-triage.ts        # Triage prompts, response parsing, learning gate
    ├── decision-gate.ts         # Decision-gate request/response mapping from the profile prompt
    ├── answer-links.ts          # Cited-URL extraction for card links
    ├── profile-session-config.ts# Profile -> SDK session config mapping
    └── profile-learning.ts      # Decayed card-signal aggregation
```

## Architecture

```text
Meeting Audio -> STT -> Ephemeral Transcript Window
                        |
                        v
        Decision gate  (optional; Microsoft-Decision-1, asked using the profile prompt)
                        |
          "anything here?"  -- clearly no --> wait for more speech
                        |
         yes, or no gate configured, or gate unreachable
                        v
              Triage pass  (active profile prompt as system prompt, no MCPs)
                        |
          "what, if anything, is worth surfacing right now?"
                        |
        +---------------+---------------+
        v                               v
  passive request                  answer request
        |                               |
        v                               v
  Passive context card            One answer-agent card
  (profile MCPs + skills live)    (profile MCPs + skills live,
                                   cancellable)
```

## Development

| Command | Description |
|---------|-------------|
| `npm run dev` | Build main process, start Vite, launch Electron |
| `npm run build` | Full production build |
| `npm run build:main` | Compile Electron main/preload TypeScript |
| `npm run build:renderer` | Build renderer with Vite |
| `npm test` | Run Vitest tests |

## Roadmap

See [`plans/aura.md`](plans/aura.md) for the simplified meeting-only roadmap.

## Disclaimer

Aura is a demo and proof of concept, not production software. It is provided as is, with no warranty and no support, and the author is not responsible for how it is used or for any consequences of using it. You are responsible for getting consent before recording or transcribing anyone and for following the laws and policies that apply to you. See [SECURITY.md](SECURITY.md) for details and for how to report a vulnerability.

## License

Released under the [MIT License](LICENSE). Bundled third-party material keeps its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

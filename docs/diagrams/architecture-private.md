# Architecture Diagrams (Private)

Full-detail diagrams including integrations, service names, ports, encryption,
and implementation specifics. For internal planning, partnership discussions,
and cost analysis.

---

## 1. System Overview — Full Integration Map

```mermaid
flowchart TD
    subgraph UI["User Interface — Port 3577"]
        Web["Web App<br/>(Hono static)"]
        Observatory["Observatory<br/>(ops dashboard)"]
        Board["Board View<br/>(kanban)"]
    end

    subgraph Server["HTTP Server (Hono + @hono/node-server)"]
        Auth["Auth Routes<br/>(pair/recover)"]
        ChatRoutes["Chat Routes<br/>(SSE streaming)"]
        BoardRoutes["Board Routes<br/>(CRUD + Linear sync)"]
        AgentRoutes["Agent Routes<br/>(spawn/cancel/status)"]
        ScheduleRoutes["Scheduling Routes"]
        ContactRoutes["Contact Routes"]
        GoogleRoutes["Google Routes<br/>(Calendar/Gmail/Tasks/Docs)"]
        VaultRoutes["Vault Routes"]
        MetricsRoutes["Metrics + Prometheus"]
    end

    subgraph Core["Core Services"]
        Brain["Brain<br/>src/brain.ts"]
        Identity["Identity<br/>AES-256-GCM<br/>PBKDF2 600k iter"]
        Vault["Vault<br/>Encrypted key-value<br/>brain/vault.enc"]
        Settings["Settings<br/>brain/settings.json"]
        Modules["Module Registry<br/>src/modules/registry.ts"]
        Skills["Skill Registry<br/>src/skills/registry.ts"]
        Capabilities["Capability Registry<br/>src/capabilities/"]
    end

    subgraph BrainFS["File-Based Brain (brain/)"]
        Memory["memory/<br/>*.jsonl (encrypted)"]
        OpsDir["operations/<br/>goals.yaml, queue.jsonl"]
        KnowledgeDir["knowledge/<br/>research/, notes/"]
        ContentDir["content/<br/>templates/, drafts/"]
        IdentityDir["identity/<br/>tone-of-voice.md, brand.md"]
        SchedulingDir["scheduling/<br/>blocks.jsonl"]
        ContactsDir["contacts/<br/>entities.jsonl, edges.jsonl<br/>(encrypted)"]
        TrainingDir["training/<br/>progress.json, proficiency.jsonl"]
        AgentsDir["agents/<br/>tasks/, runtime/, logs/"]
        MetricsDir["metrics/<br/>metrics.jsonl"]
        OpsLog["ops/<br/>activity.jsonl (encrypted)"]
    end

    subgraph CloudAPIs["Cloud APIs (cost-bearing)"]
        OpenRouter["OpenRouter API<br/>anthropic/claude-sonnet-4<br/>meta-llama/llama-3.1-8b"]
        Linear["Linear API<br/>@linear/sdk<br/>Bidirectional sync"]
        Perplexity["Perplexity Sonar API<br/>Web search (primary)"]
        Twilio["Twilio REST API<br/>Phone calls"]
        Resend["Resend<br/>Transactional email"]
    end

    subgraph LocalAPIs["Local Services"]
        Ollama["Ollama API<br/>localhost:11434<br/>Offline LLM"]
    end

    subgraph Sidecars["Sidecars (Python, optional)"]
        TTS["TTS Sidecar<br/>Port 3579<br/>Piper xtts-v2"]
        STT["STT Sidecar<br/>Port 3580<br/>Whisper"]
        Avatar["Avatar Sidecar<br/>Port 3581<br/>MuseTalk"]
        SearchSC["Search Sidecar<br/>Port 3578<br/>DuckDuckGo fallback"]
    end

    subgraph Channels["Communication Channels"]
        Slack["Slack<br/>OAuth + Webhooks"]
        WhatsApp["WhatsApp<br/>Gateway"]
        GitHub["GitHub<br/>Webhooks + API"]
    end

    UI --> Server
    Server --> Core
    Core --> BrainFS
    Server --> CloudAPIs
    Server --> LocalAPIs
    Server --> Sidecars
    Server --> Channels
```

---

## 2. Data Flow — Chat Request Lifecycle (Full Detail)

```mermaid
sequenceDiagram
    participant Client as Client (browser)
    participant Hono as Hono Server :3577
    participant Auth as auth/identity.ts
    participant Search as search/classify.ts
    participant Brain as brain.ts
    participant LTM as FileSystemLTM<br/>(memory/*.jsonl)
    participant Assembler as context/assembler.ts
    participant LLM as OpenRouter / Ollama
    participant Extractor as learning/extractor.ts
    participant Activity as activity/log.ts

    Client->>Hono: POST /api/chat {message, sessionId}
    Hono->>Auth: validateSession(sessionId)
    Auth-->>Hono: session + decrypted vault

    par Pre-processing (fire-and-forget)
        Hono->>Search: classifySearchNeed(message)
        Note over Search: Tier 1: regex<br/>Tier 2: heuristic<br/>Tier 3: LLM classifier
        Search-->>Hono: searchResult (if needed)
        Hono->>Hono: detectUrl() → browseUrl()
        Hono->>Hono: processIngestFolder()
        Hono->>Hono: drainNotifications()
    end

    Hono->>Brain: getContextForTurn(options)
    Brain->>LTM: retrieve(query, types)
    LTM-->>Brain: MemoryItem[]
    Brain->>Assembler: buildSections(workingMemory)
    Assembler-->>Brain: ContextSections
    Brain-->>Hono: ContextMessage[]

    alt history > 20 messages
        Hono->>Hono: compactHistory()
    end

    Hono->>LLM: streamChat(messages)
    loop SSE tokens
        LLM-->>Client: data: {chunk}
    end

    par Post-processing (fire-and-forget)
        Hono->>Extractor: extractAndLearn(response)
        Hono->>Hono: saveSession(encrypted)
        Hono->>Activity: logActivity(source, summary)
    end
```

---

## 3. Brain Modules — Full Module Map

```mermaid
flowchart LR
    UserMsg["User Message"] --> Registry["ModuleRegistry<br/>src/modules/registry.ts<br/>Keyword regex matching"]

    Registry --> M1["memory<br/>promptOrder: 50"]
    Registry --> M2["agents<br/>promptOrder: 55"]
    Registry --> M3["training<br/>promptOrder: 60"]
    Registry --> M4["ops<br/>promptOrder: 65"]
    Registry --> M5["metrics<br/>promptOrder: 70"]
    Registry --> M6["contacts<br/>promptOrder: 40"]
    Registry --> M7["scheduling<br/>promptOrder: 45"]

    subgraph Files["Data Files"]
        M1 --> F1["experiences.jsonl ⚷<br/>decisions.jsonl ⚷<br/>failures.jsonl ⚷<br/>semantic.jsonl ⚷"]
        M2 --> F2["tasks/*.json<br/>runtime/*.json<br/>logs/"]
        M3 --> F3["progress.json<br/>proficiency.jsonl"]
        M4 --> F4["activity.jsonl ⚷"]
        M5 --> F5["metrics.jsonl"]
        M6 --> F6["entities.jsonl ⚷<br/>edges.jsonl ⚷"]
        M7 --> F7["blocks.jsonl"]
    end

    style F1 fill:#ff9999
    style F4 fill:#ff9999
    style F6 fill:#ff9999
```

---

## 4. Activation System — Full Pressure Configuration

```mermaid
flowchart TD
    subgraph Sources["Event Sources → Base mV"]
        Board["board: 70mV<br/>keywords: created, todo"]
        Agent["agent: 50mV<br/>keywords: fail, error, crash"]
        Schedule["scheduling: 40mV<br/>keywords: overdue, missed, deadline"]
        UserChat["user chat: 30mV"]
        OpenLoop["open-loop: 25mV"]
        System["system: 20mV<br/>keywords: commit, push, merge"]
        Autonomous["autonomous: 5mV"]
        Default["default: 5mV<br/>(unmatched sources)"]
    end

    Sources --> Integrator["PressureIntegrator<br/>src/pulse/pressure.ts"]

    subgraph Config["Configuration"]
        Theta["Θ = 60mV (threshold)"]
        CooldownCfg["Cooldown: 60s abs<br/>300s relative (2Θ)"]
        DecayRate["λ = 0.000001/ms<br/>half-life ≈ 11.5 min"]
        Basal["Basal leak: 10mV/hr"]
    end

    Config --> Integrator
    Integrator --> Pressure["Current Pressure"]
    Pressure --> Check{"V ≥ Θ?"}
    Check -->|Yes| Fire["triggerPulse()<br/>→ continueAfterBatch()"]
    Check -->|No| Accumulate["Wait + Decay"]

    Fire --> AbsCooldown["Absolute Cooldown<br/>(60s, no firing)"]
    AbsCooldown --> RelCooldown["Relative Cooldown<br/>(300s, need 2Θ)"]
    RelCooldown --> Ready["Ready State"]
    Ready --> Check

    subgraph Listeners["Activation Listeners"]
        CDT["CDT Events<br/>(contextual data trigger)"]
        PressureEvt["Pressure Events<br/>(standard fire)"]
        ActivationLog["activation-log.ts<br/>brain/ops/activations.jsonl"]
    end

    Fire --> Listeners
```

---

## 5. Memory Architecture — Full Implementation

```mermaid
flowchart LR
    subgraph WM["Working Memory (per-turn)"]
        ActiveGoal["activeGoal: string"]
        RetrievedItems["retrievedItems: MemoryItem[]"]
        ScratchPad["scratch: Record<string,any>"]
    end

    subgraph LTM["Long-Term Memory"]
        subgraph FSLTM["FileSystemLongTermMemory"]
            direction TB
            Episodic["episodic → experiences.jsonl ⚷"]
            Semantic["semantic → semantic.jsonl ⚷"]
            Procedural["procedural → procedural.jsonl"]
        end
        subgraph Vector["VectorIndex"]
            Embeddings["embeddings.jsonl ⚷<br/>(cosine similarity search)"]
        end
    end

    subgraph Assembly["Context Assembler<br/>src/context/assembler.ts"]
        SC["supportingContent"]
        Inst["instructions"]
        Ex["examples"]
        Cu["cues"]
        PC["primaryContent"]
    end

    Input["User Input"] --> WM
    WM -->|"retrieve(query)"| FSLTM
    WM -->|"search(embedding)"| Vector
    FSLTM -->|"MemoryItem[]"| WM
    Vector -->|"MemoryItem[]"| WM
    WM --> Assembly
    Assembly --> Messages["ContextMessage[]<br/>[system, ...history, user]"]

    Learn["Brain.learn(input)"] -->|"append-only"| FSLTM

    subgraph Encryption["Encryption at Rest"]
        direction TB
        E1["AES-256-GCM per line"]
        E2["Key: PBKDF2(safeWord)"]
        E3["600k iterations, SHA-256"]
    end

    FSLTM -.-> Encryption
```

---

## 6. Authentication & Encryption Flow

```mermaid
sequenceDiagram
    participant User
    participant Server
    participant Identity as auth/identity.ts
    participant Vault as vault/store.ts
    participant BrainIO as lib/brain-io.ts

    Note over User, BrainIO: First Visit (Pairing)
    Server->>Identity: ensurePairingCode()
    Identity-->>User: 6-word code displayed

    User->>Server: pair(code, name, safeWord)
    Server->>Identity: PBKDF2(safeWord, salt, 600k, SHA-256)
    Identity-->>Identity: 256-bit derived key
    Identity->>Identity: Create human.json
    Identity->>Identity: Create session
    Identity->>Vault: Encrypt vault (AES-256-GCM)
    Vault->>Vault: Hydrate env vars from vault

    Note over User, BrainIO: Return Visit
    User->>Server: authenticate(safeWord)
    Server->>Identity: PBKDF2(safeWord) → session key
    Identity->>Identity: Validate session
    Identity->>Vault: Decrypt vault → hydrate env
    Identity->>BrainIO: Set encryption key in key-store
    BrainIO->>BrainIO: All brain file I/O now encrypted

    Note over BrainIO: File Encryption Modes
    BrainIO->>BrainIO: JSONL: per-line AES-256-GCM
    BrainIO->>BrainIO: YAML/MD/JSON: whole-file blob
    BrainIO->>BrainIO: Encrypted files: experiences,<br/>decisions, failures, triads,<br/>semantic, embeddings,<br/>open-loops, resonances,<br/>entities, edges
```

---

## 7. Board & Queue — Bidirectional Linear Sync

```mermaid
flowchart TD
    subgraph Local["Local Queue (source of truth)"]
        QueueStore["QueueStore<br/>brain/operations/queue.jsonl"]
        QueueBoard["QueueBoardProvider<br/>(always available)"]
    end

    subgraph LinearSync["Linear Sync (every 5 min)"]
        SyncEngine["syncWithLinear()"]
        LinearSDK["@linear/sdk"]
        LinearAPI["Linear API"]
    end

    subgraph Grooming["Queue Grooming (every 5 min)"]
        Vague["Flag vague items"]
        Stale["Clear stale in_progress > 24h"]
        Promote["Auto-promote backlog → todo<br/>(max 3/cycle, needs 2+ signals)"]
        Compact["Auto-compact > 200 lines"]
    end

    subgraph Projects["Project Prefixes"]
        TRI["TRI — Triage"]
        CORE["CORE — Core Dev"]
        DASH["DASH — Dash Agent"]
    end

    QueueStore --> QueueBoard
    QueueBoard --> BoardProvider["BoardProvider interface"]

    QueueStore <-->|"push unsynced / pull new"| SyncEngine
    SyncEngine <--> LinearAPI

    QueueStore --> Grooming

    Projects --> QueueStore
```

---

## 8. Agent Runtime — Full Architecture

```mermaid
flowchart TD
    subgraph Input["Task Input"]
        Chat["Chat command"]
        Autonomous["Autonomous pulse"]
        Batch["Batch planner"]
    end

    Input --> Pool["AgentPool<br/>src/agents/runtime.ts"]

    subgraph Pool
        Queue["Task Queue"]
        Slots["Concurrent Slots<br/>(configurable)"]
    end

    Pool --> Spawn["spawnAgent()<br/>claude --print CLI"]

    subgraph Lifecycle["Agent Lifecycle"]
        Task["brain/agents/tasks/{id}.json"]
        Runtime["brain/agents/runtime/{id}.json"]
        Stdout["brain/agents/logs/{id}.stdout"]
        Stderr["brain/agents/logs/{id}.stderr"]
        Prompt["brain/agents/logs/{id}.prompt.txt"]
    end

    Spawn --> Lifecycle

    subgraph Monitor["Health Monitor"]
        PIDCheck["PID poll (15s)"]
        Recovery["RecoverAndStartMonitor()"]
        Timeout["Stuck agent detection"]
    end

    Monitor --> Lifecycle

    subgraph Completion["On Completion"]
        RememberOutcome["rememberTaskOutcome()<br/>→ episodic LTM"]
        StateTransition["Task state → done/failed"]
        BatchCallback["onBatchComplete()<br/>→ continueAfterBatch()"]
    end

    Lifecycle --> Completion

    subgraph Workflow["Workflow Engine"]
        WorkflowDef["Workflow definitions"]
        StepExec["Step execution"]
        CondBranch["Conditional branching"]
    end

    Batch --> Workflow
    Workflow --> Pool
```

---

## 9. Google Workspace Integration

```mermaid
flowchart LR
    subgraph Auth["OAuth2 Flow"]
        AuthURL["GET /api/google/auth<br/>→ consent URL"]
        Callback["GET /api/google/callback<br/>→ exchange code"]
        Tokens["Token cache<br/>(encrypted in vault)"]
    end

    subgraph Calendar["Calendar"]
        CalTimer["calendar-timer.ts<br/>Poll every 5 min"]
        CalAPI["Calendar v3 API"]
        Events["CRUD events<br/>Free/busy check"]
    end

    subgraph Gmail["Gmail"]
        GmailTimer["gmail-timer.ts<br/>Poll every 5 min"]
        GmailAPI["Gmail v1 API"]
        Messages["Read/send/search<br/>Categorize + prioritize"]
    end

    subgraph Tasks["Tasks"]
        TasksTimer["tasks-timer.ts<br/>Poll for updates"]
        TasksAPI["Tasks v1 API"]
        TaskLists["CRUD task lists<br/>Complete/uncomplete"]
    end

    subgraph Docs["Docs"]
        DocsAPI["Docs + Sheets API"]
        Create["Create documents<br/>Backlog review docs"]
    end

    Auth --> Calendar
    Auth --> Gmail
    Auth --> Tasks
    Auth --> Docs

    CalTimer -->|"Upcoming < 30 min"| Notify["Push notification"]
    GmailTimer -->|"New email"| Notify
```

---

## 10. Timer & Background Process Map

```mermaid
flowchart TD
    subgraph Timers["Background Timers"]
        T1["Calendar Timer<br/>5 min — upcoming events"]
        T2["Gmail Timer<br/>5 min — new messages"]
        T3["Tasks Timer<br/>5 min — task updates"]
        T4["Goal Timer<br/>30 min — goal check"]
        T5["Grooming Timer<br/>5 min — queue maintenance"]
        T6["Scheduling Timer<br/>5 min — block transitions"]
        T7["Autonomous Timer<br/>60 min — coma failsafe"]
        T8["Backlog Review<br/>Weekly (Friday)"]
        T9["Morning Briefing<br/>Daily (configurable hour)"]
        T10["Insights Timer<br/>Periodic — trace analysis"]
        T11["Open Loop Scanner<br/>Ambient resonance"]
        T12["Metrics Collector<br/>30s — system metrics"]
    end

    subgraph Effects["Side Effects"]
        Notify["Push Notification"]
        Activity["Log Activity"]
        AddPressure["Add Pressure<br/>(pressure integrator)"]
        StateChange["State Transitions<br/>(blocks, tasks)"]
        Compact["JSONL Compaction"]
    end

    T1 --> Notify
    T2 --> Notify
    T3 --> Activity
    T4 --> Notify
    T4 --> Activity
    T5 --> StateChange
    T5 --> Compact
    T6 --> Notify
    T6 --> AddPressure
    T6 --> StateChange
    T7 --> AddPressure
    T8 --> Activity
    T9 --> Notify
    T10 --> Activity
    T11 --> Activity
    T11 --> AddPressure
    T12 --> Activity

    subgraph Shutdown["Graceful Shutdown"]
        SIGINT["SIGINT / SIGTERM"]
        SIGINT --> StopAll["Stop all timers<br/>Drain agent pool<br/>Stop sidecars<br/>Close browser<br/>Shutdown LLM cache"]
    end
```

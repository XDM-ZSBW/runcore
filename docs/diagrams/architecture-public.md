# Architecture Diagrams (Public)

De-identified diagrams suitable for blog posts, the whitepaper, and herrmangroup.com.
Shows the *pattern* without revealing proprietary implementation details.

---

## 1. System Overview

```mermaid
flowchart TD
    subgraph UI["User Interface"]
        Web["Web App"]
        Voice["Voice I/O"]
        Chat["Chat Interface"]
    end

    subgraph Server["HTTP Server"]
        Auth["Auth & Session"]
        ChatRoutes["Chat Routes"]
        BoardRoutes["Board Routes"]
        AgentRoutes["Agent Routes"]
        ScheduleRoutes["Scheduling Routes"]
        ContactRoutes["Contacts Routes"]
    end

    subgraph Core["Core Services"]
        Brain["Brain<br/>(Memory + Context)"]
        Identity["Identity<br/>(Pairing + Crypto)"]
        Vault["Vault<br/>(Encrypted Key Store)"]
        Settings["Settings<br/>(Config + Models)"]
    end

    subgraph BrainModules["File-Based Brain"]
        Memory["Memory<br/>(Episodic + Semantic)"]
        Ops["Operations<br/>(Goals + Tasks)"]
        Knowledge["Knowledge<br/>(Research + Notes)"]
        Content["Content<br/>(Templates + Drafts)"]
        IDMod["Identity<br/>(Voice + Brand)"]
        Scheduling["Scheduling<br/>(Time Blocks)"]
        Contacts["Contacts<br/>(Entity Graph)"]
    end

    subgraph Integrations["Integrations"]
        LLM["LLM Provider<br/>(Local + Cloud)"]
        TaskBoard["Task Board<br/>(Bidirectional Sync)"]
        Search["Web Search"]
        Sidecars["Sidecars<br/>(TTS / STT / Avatar)"]
    end

    UI --> Server
    Server --> Core
    Core --> BrainModules
    Core --> Integrations
    Brain --> Memory
    Brain --> Ops
    Brain --> Knowledge
```

---

## 2. Data Flow — Chat Request Lifecycle

```mermaid
sequenceDiagram
    participant User
    participant Server
    participant Auth
    participant PreProcess as Pre-Processing
    participant Brain
    participant LTM as Long-Term Memory
    participant LLM
    participant PostProcess as Post-Processing

    User->>Server: POST /chat {message}
    Server->>Auth: Validate session
    Auth-->>Server: Session OK

    par Fire-and-forget
        Server->>PreProcess: Classify search need
        Server->>PreProcess: Check for URL to browse
        Server->>PreProcess: Process ingest folder
        Server->>PreProcess: Drain notifications
    end

    Server->>Brain: getContextForTurn()
    Brain->>LTM: Retrieve relevant memories
    LTM-->>Brain: Matching entries
    Brain->>Brain: Assemble context sections
    Brain-->>Server: LLM-ready messages

    Server->>LLM: Stream chat request
    LLM-->>User: SSE token stream

    par Post-processing
        Server->>PostProcess: Extract & learn durable facts
        Server->>PostProcess: Save session (encrypted)
        Server->>PostProcess: Log activity
    end
```

---

## 3. Brain Modules — Structure & Routing

```mermaid
flowchart LR
    UserMsg["User Message"] --> Router["Module Router<br/>(Keyword Matching)"]

    Router --> Memory["Memory Module<br/>experiences, decisions,<br/>failures, semantic"]
    Router --> Ops["Operations Module<br/>goals, tasks, queue"]
    Router --> Knowledge["Knowledge Module<br/>research, notes"]
    Router --> Content["Content Module<br/>templates, drafts"]
    Router --> Identity["Identity Module<br/>voice, brand"]
    Router --> Scheduling["Scheduling Module<br/>time blocks, deadlines"]
    Router --> Contacts["Contacts Module<br/>entities, relationships"]
    Router --> Training["Training Module<br/>skill proficiency"]
    Router --> Agents["Agents Module<br/>task execution, logs"]

    Memory --> DataFiles["Append-Only<br/>JSONL Files"]
    Ops --> DataFiles
    Knowledge --> MDFiles["Markdown Files"]
    Content --> MDFiles
    Scheduling --> DataFiles
    Contacts --> EncFiles["Encrypted<br/>JSONL Files"]
```

---

## 4. Pulse System — Tension / Voltage / Activation

```mermaid
flowchart TD
    subgraph Sources["Event Sources"]
        BoardEvent["Board Events<br/>(new tasks, state changes)"]
        AgentEvent["Agent Events<br/>(failures, completions)"]
        ScheduleEvent["Schedule Events<br/>(overdue blocks, missed deadlines)"]
        SystemEvent["System Events<br/>(commits, deploys)"]
        LoopEvent["Open Loop Events<br/>(unresolved tensions)"]
        UserChat["User Chat<br/>(direct interaction)"]
    end

    Sources --> Weights["Voltage Weight Resolution<br/>(source → base mV)"]
    Weights --> Accumulator["Voltage Accumulator"]
    Accumulator --> Decay["Exponential Decay<br/>(half-life ~12 min)"]
    Decay --> Threshold{"V ≥ Θ?"}

    Threshold -->|Yes| Pulse["FIRE PULSE<br/>(Check for Work)"]
    Threshold -->|No| Wait["Continue Accumulating"]

    Pulse --> Refractory["Refractory Period<br/>(Absolute → Relative)"]
    Refractory --> Accumulator

    subgraph Legend["Metaphor: Action Potential"]
        direction LR
        L1["Events = Stimuli"]
        L2["Voltage = Tension"]
        L3["Threshold = Breaking Point"]
        L4["Pulse = Response"]
        L5["Refractory = Cooldown"]
    end
```

---

## 5. Memory Architecture

```mermaid
flowchart LR
    subgraph WorkingMem["Working Memory<br/>(Per-Turn Scratchpad)"]
        Goal["Active Goal"]
        Retrieved["Retrieved Items"]
        Scratch["Scratch Space"]
    end

    subgraph LTM["Long-Term Memory<br/>(Persistent JSONL)"]
        Episodic["Episodic<br/>Experiences, Decisions,<br/>Failures"]
        Semantic["Semantic<br/>Facts, Preferences,<br/>Knowledge"]
        Procedural["Procedural<br/>How-To, Workflows"]
    end

    subgraph ContextAssembly["Context Assembly"]
        Support["Supporting Content<br/>(retrieved memories)"]
        Instructions["Instructions<br/>(system prompt)"]
        Examples["Examples<br/>(few-shot)"]
        Cues["Cues<br/>(output hints)"]
        Primary["Primary Content<br/>(user input)"]
    end

    Input["User Input"] --> WorkingMem
    WorkingMem -->|Retrieve| LTM
    LTM -->|Matches| WorkingMem
    WorkingMem --> ContextAssembly
    ContextAssembly --> Output["LLM Message Array<br/>[system, ...history, user]"]

    LTM -.->|Learn| NewEntry["New Entry<br/>(append-only)"]
```

---

## 6. Agent Lifecycle

```mermaid
flowchart TD
    Input["Task Input"] --> Submit["Submit Task"]
    Submit --> Create["Create Task Record"]
    Create --> Spawn["Spawn Agent<br/>(CLI Subprocess)"]

    Spawn --> Running["Running"]
    Running -->|stdout| Logs["Log Capture"]
    Running -->|Complete| Success["Success"]
    Running -->|Error| Failure["Failure"]

    Success --> Remember["Record Outcome<br/>(Episodic Memory)"]
    Failure --> Remember

    Monitor["Health Monitor<br/>(Poll every 15s)"] -->|Dead PID| Failure

    subgraph Pool["Agent Pool"]
        direction LR
        A1["Agent 1"]
        A2["Agent 2"]
        A3["Agent N"]
    end

    Submit --> Pool
    Pool --> Running
```

---

## 7. Module Discovery

```mermaid
flowchart TD
    Boot["Server Boot"] --> Scan["Scan brain/*/<br/>module.json"]
    Scan --> Registry["Module Registry<br/>(in-memory)"]

    UserMsg["User Message"] --> Match["Keyword Pattern<br/>Matching"]
    Match --> Registry
    Registry -->|Matches| Resolved["Resolved Modules<br/>(sorted by priority)"]
    Resolved --> Prompt["Build System Prompt<br/>(module prompts + vars)"]
    Prompt --> LLM["Send to LLM"]
```

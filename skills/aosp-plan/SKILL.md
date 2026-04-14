---
name: aosp-plan
description: AOSP investigation-driven planning with parallel code search and optional Codex integration
argument-hint: <AOSP investigation query>
pipeline: [aosp-plan, ralph]
next-skill: ralph
handoff: .omc/plans/aosp-*.md
level: 4
---

# AOSP Plan Skill

Investigation-first AOSP planning. Decomposes queries into facets, spawns parallel `aosp-investigator` subagents, optionally integrates Codex lanes, synthesizes all findings, and produces an evidence-backed plan saved to `.omc/plans/`.

## Usage

```
/oh-my-claudecode:aosp-plan "query about AOSP code"
/oh-my-claudecode:aosp-plan --agents 5 "query"
/oh-my-claudecode:aosp-plan --codex "query"
/oh-my-claudecode:aosp-plan --agents 4 --codex "query"
```

## Flags

- `--agents N`: Number of parallel investigator subagents (default: 3, max: 5)
- `--codex`: Enable additional Codex investigation lanes via `omc ask codex`
- `--deliberate`: Force deliberate mode for high-risk AOSP changes. Adds pre-mortem (3 failure scenarios) and expanded test plan. Auto-enables when query involves: SELinux policy, Binder/AIDL interfaces, CTS/VTS tests, public/@SystemApi changes, init/boot sequence, Treble boundaries, kernel/DT changes, or multi-partition modifications.
- `--interactive`: Enable user prompts at synthesis review and final approval. Without this flag, the workflow outputs the final plan and stops (no auto-execution).

## Protocol

### Step 0: State Initialization

Call `state_write(mode="aosp-plan", active=true)` before any other action. This enables stop-hook enforcement during parallel investigation.

### Step 1: MCP Health Check

Call `aosp_code_search` with `tool: "list_tools"` once at startup to verify the MCP server is reachable and discover available remote tool names.

If the call fails, call `state_clear(mode="aosp-plan")` and abort immediately with:

```
AOSP MCP server unreachable. Check AOSP_MCP_URL and AOSP_MCP_KEY environment variables.
```

Do NOT proceed to spawn agents if this check fails.

### Step 2: Facet Decomposition

Given the user query, decompose into 2–N independent investigation facets. Each facet targets a different aspect of the AOSP codebase. Show the decomposition to the user:

```markdown
## AOSP Investigation Decomposition

**Query:** <original query>

### Facet 1: <facet-name>
- **Search focus:** What to search for in AOSP
- **Expected areas:** Framework, HAL, kernel, etc.

### Facet 2: <facet-name>
- **Search focus:** ...
- **Expected areas:** ...
```

### Step 3: Spawn Investigators

Fire N `aosp-investigator` subagents in parallel (one per facet). N comes from `--agents` (default 3, max 5):

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  model="sonnet",
  prompt="Investigate AOSP facet: <facet description>. Use aosp_code_search tool. Report structured findings with file paths, code snippets, and architectural observations."
)
```

Cap at 5 agents regardless of `--agents` value.

### Step 4: Codex Lanes (--codex only)

If `--codex` flag is set, spawn additional investigation lanes for each facet via Codex. These run in parallel with the Claude investigators and are additive (not counted against the agent cap):

```bash
omc ask codex "Analyze AOSP code for: <facet description>. Focus on: <specific aspects>. Report file paths, code patterns, and architectural notes."
```

Codex artifacts land in `.omc/artifacts/ask/codex-*.md`.

### Step 5: Codex Result Normalization (--codex only)

Read all Codex artifacts from `.omc/artifacts/ask/codex-*.md`. Normalize each into the same structured format as Claude investigator results:

```markdown
### Codex Findings: <facet>

**Source:** Codex analysis
**Findings:**
- <finding with file path and context>
- <finding with file path and context>

**Architectural Notes:**
- <observation about code structure, design patterns, or AOSP conventions>
```

### Step 6: Synthesis

Merge all investigation results (Claude investigators + Codex findings if applicable):

- Deduplicate overlapping findings across sources
- Resolve conflicts between sources (prefer AOSP source-based evidence)
- Rank findings by relevance and evidence strength
- Note gaps where investigation was inconclusive or returned no results

### Step 6.5: Synthesis Review (--interactive only)

If running with `--interactive`, use `AskUserQuestion` to present the synthesis results with these options:
- **Proceed to plan generation** (Recommended) — generate the structured plan
- **Request additional investigation** — spawn more investigators for identified gaps
- **Refine scope** — narrow or broaden the investigation, return to Step 2

If NOT running with `--interactive`, automatically proceed to Step 7.

### Step 7: Plan Generation

Generate a structured plan based on investigation evidence. The plan MUST include an AOSP-DR (Decision Rationale) section that articulates explicit reasoning, not just steps.

```markdown
# AOSP Plan: <query>

## Investigation Summary

[Key findings from all investigators, grouped by facet]

## AOSP-DR: Decision Rationale

### Principles (3-5)
1. [AOSP-grounded principle, e.g., "Respect AOSP layer boundaries"]
2. [Compatibility principle, e.g., "Maintain CTS/VTS test compatibility"]
3. [Investigation-derived principle]

### Decision Drivers (top 3)
1. [Most important factor, with evidence reference]
2. [Second factor]
3. [Third factor]

### Viable Options (>=2, or explicit invalidation rationale)
#### Option A: [Name]
- **Approach:** [1-2 sentences]
- **Evidence:** [Investigation findings supporting this]
- **AOSP files:** [Key source files]
- **Pros:** [Bounded, evidence-grounded]
- **Cons:** [Bounded, evidence-grounded]

#### Option B: [Name]
- **Approach:** [1-2 sentences]
- **Evidence:** [Investigation findings supporting this]
- **AOSP files:** [Key source files]
- **Pros:** [Bounded, evidence-grounded]
- **Cons:** [Bounded, evidence-grounded]

### Selected Option: [A/B]
**Why:** [Reasoning referencing drivers and principles]

### Invalidated Alternatives (if < 2 viable options)
- [Option C]: [Why invalidated — e.g., "Requires @hide API deprecated in API level 34"]

## Evidence-Based Plan

### Step 1: <action>
- **Evidence:** [which investigation findings support this step]
- **AOSP files:** [relevant AOSP source files]
- **Acceptance criteria:** [how to verify this step is complete]

### Step 2: <action>
- **Evidence:** ...
- **AOSP files:** ...
- **Acceptance criteria:** ...

## Risks and Mitigations

- **Risk:** [AOSP-specific risk] → **Mitigation:** [concrete action]
- **Risk:** [AOSP-specific risk] → **Mitigation:** [concrete action]

## Open Questions

[Items where investigation was inconclusive or returned no results — flag for further investigation]

## Sources

[All AOSP file paths and references cited across all investigator results]
```

In **deliberate mode** (triggered by `--deliberate` or auto-detected high-risk signals), additionally include after Sources:

```markdown
## Pre-Mortem (Deliberate Mode)
1. [AOSP-specific failure scenario]
2. [AOSP-specific failure scenario]
3. [AOSP-specific failure scenario]

## Expanded Test Plan (Deliberate Mode)
| Layer | Tests |
|-------|-------|
| Unit | [Framework JUnit / native gtest] |
| Integration | [CTS module / instrumentation tests] |
| E2E | [Full device boot / VTS for HAL] |
| Observability | [Logcat / dumpsys / perfetto] |
```

### Step 7.5: Quality Gate — Architect + Critic Review

Review the generated plan for AOSP-specific quality. This step runs automatically (not gated by `--interactive`).

**Sequential enforcement**: Architect MUST complete before Critic starts. Do NOT run both in parallel.

**a. Architect review** via `Agent(subagent_type="oh-my-claudecode:architect", ...)`:

Review focus:
- Architectural soundness of proposed AOSP modifications
- Subsystem ownership correctness (Framework, HAL, Kernel, etc.)
- Treble/HIDL boundary compliance
- Cross-layer impact (e.g., Framework change requiring SELinux update)
- AOSP version consistency across cited source files
- Steelman antithesis: strongest argument against the proposed approach
- At least one meaningful tradeoff tension

Wait for Architect completion before proceeding to Critic.

**b. Critic evaluation** via `Agent(subagent_type="oh-my-claudecode:critic", ...)`:

Quality criteria:
- 80%+ plan steps cite AOSP source files from investigation results
- 90%+ acceptance criteria reference verifiable outcomes (CTS, VTS, build, adb)
- Each step backed by investigation evidence (no unsupported claims)
- Subsystem boundaries acknowledged at crossing points
- @hide/@SystemApi stability risks explicitly flagged
- Build system references (Android.bp/mk) included for code-modifying steps
- Open Questions section honestly reflects investigation gaps

Critic MUST reject: uncited AOSP file references, unverifiable acceptance criteria, missing @hide API risk flags, mixed AOSP version references without acknowledgment.

**c. Re-review loop** (max 3 iterations):
If Critic rejects: collect feedback → revise plan (re-run Step 7) → Architect → Critic → repeat.
If 3 iterations reached without approval: present best version to user via `AskUserQuestion`.

**d. Apply improvements**:
On approval with suggestions: deduplicate, merge into plan, add changelog section.
Final plan output MUST include an **Architecture Decision Record** section appended after Sources:

```markdown
## Architecture Decision Record
- **Decision:** [What was decided]
- **Drivers:** [Top 3 drivers from AOSP-DR]
- **Alternatives considered:** [All evaluated options]
- **Why chosen:** [Reasoning referencing principles and drivers]
- **Consequences:** [Positive outcomes + accepted tradeoffs + acknowledged risks]
- **Follow-ups:** [Post-implementation verification actions]
```

### Step 8: Save

Derive a slug from the query (lowercase, spaces→hyphens, strip special chars). Save to:

```
.omc/plans/aosp-<slug>.md
```

Confirm the save path to the user after writing.

If NOT running with `--interactive`, call `state_clear(mode="aosp-plan")` after confirming the save path. The skill stops here in non-interactive mode.

### Step 9: Execution Approval (--interactive only)

Use `AskUserQuestion` to present the saved plan with these options:
- **Approve and implement via team** (Recommended) — proceed to implementation via coordinated parallel team agents
- **Approve and execute via ralph** — proceed to implementation via ralph sequential execution
- **Clear context and implement** — compact context first, then ralph (recommended when context is large after investigation)
- **Request changes** — return to Step 7 with user feedback
- **Reject** — discard plan, call `state_clear(mode="aosp-plan")`, stop

On approval: Call `state_write(mode="aosp-plan", active=false)` before invoking the execution skill. Do NOT use `state_clear` — its cancel signal disables stop-hook enforcement for the newly launched mode.

- **Approve and implement via team**: Invoke `Skill("oh-my-claudecode:team")` with the plan path
- **Approve and execute via ralph**: Invoke `Skill("oh-my-claudecode:ralph")` with the plan path
- **Clear context and implement**: `state_write(active=false)` → `Skill("compact")` → `Skill("oh-my-claudecode:ralph")` with plan path

## Risk-Adaptive Mode

AOSP-DR uses **short mode** by default (Principles + Drivers + Options only). Switch to **deliberate mode** with `--deliberate` or when the query involves any of these high-risk areas:

- SELinux policy changes (neverallow, sepolicy, *.te files)
- Binder/AIDL/HIDL interface modifications
- CTS or VTS test changes
- Public API or @SystemApi modifications
- Init/boot sequence changes (init.rc, early boot services)
- Treble vendor/system boundary crossings
- Kernel driver or device tree changes
- Multi-partition changes (system + vendor + product)

Deliberate mode adds:
- **Pre-mortem**: 3 AOSP-specific failure scenarios
- **Expanded test plan**: Unit / Integration (CTS) / E2E (VTS/device) / Observability (logcat/dumpsys/perfetto)

## State Lifecycle

The stop hook uses `aosp-plan` state to enforce continuation during parallel investigation. The skill MUST manage this state:

- **On entry**: `state_write(mode="aosp-plan", active=true)` before Step 1
- **On MCP failure**: `state_clear(mode="aosp-plan")` — terminal exit
- **On non-interactive completion** (Step 8): `state_clear(mode="aosp-plan")` — plan output only, no execution follows
- **On execution handoff** (Step 9 approval): `state_write(mode="aosp-plan", active=false)` — preserves stop-hook enforcement for the execution mode
- **On rejection** (Step 9 reject): `state_clear(mode="aosp-plan")` — terminal exit

Critical: Never use `state_clear` before launching an execution mode. The 30-second cancel signal disables stop-hook enforcement for ALL modes.

## Configuration

- Maximum 5 parallel `aosp-investigator` agents (matches `external-context` precedent)
- Codex lanes are additive (not counted against the agent limit)
- Keyword trigger: `"aosp plan"` or `"aosp_plan"`
- State mode name: `aosp-plan` (for state_write/state_clear calls)
- Non-interactive mode (default): outputs plan and stops after Step 8
- Interactive mode (`--interactive`): adds synthesis review (Step 6.5) and execution approval (Step 9) gates

## Tool Usage

- Use `Agent(subagent_type="oh-my-claudecode:architect", ...)` for Architect review in Step 7.5a
- Use `Agent(subagent_type="oh-my-claudecode:critic", ...)` for Critic evaluation in Step 7.5b
- **CRITICAL**: Architect and Critic calls MUST be sequential, never parallel. Always await the Architect result before issuing the Critic call.
- Quality gate runs automatically on all plans (not gated by `--interactive`)
- Re-review loop capped at 3 iterations (narrower scope than general plans)

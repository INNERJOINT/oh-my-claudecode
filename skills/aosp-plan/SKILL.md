---
name: aosp-plan
description: AOSP investigation-driven planning with parallel code search and optional Codex integration
argument-hint: <AOSP investigation query>
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

## Protocol

### Step 1: MCP Health Check

Call `aosp_code_search` with `tool: "list_tools"` once at startup to verify the MCP server is reachable and discover available remote tool names.

If the call fails, abort immediately with:

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

### Step 7: Plan Generation

Generate a structured plan based on investigation evidence:

```markdown
# AOSP Plan: <query>

## Investigation Summary

[Key findings from all investigators, grouped by facet]

## Evidence-Based Plan

### Step 1: <action>
- **Evidence:** [which investigation findings support this step]
- **AOSP files:** [relevant AOSP source files]
- **Acceptance criteria:** [how to verify this step is complete]

### Step 2: <action>
- **Evidence:** ...
- **AOSP files:** ...
- **Acceptance criteria:** ...

## Open Questions

[Items where investigation was inconclusive or returned no results — flag for further investigation]

## Sources

[All AOSP file paths and references cited across all investigator results]
```

### Step 8: Save

Derive a slug from the query (lowercase, spaces→hyphens, strip special chars). Save to:

```
.omc/plans/aosp-<slug>.md
```

Confirm the save path to the user after writing.

## Configuration

- Maximum 5 parallel `aosp-investigator` agents (matches `external-context` precedent)
- Codex lanes are additive (not counted against the agent limit)
- Keyword trigger: `"aosp plan"` or `"aosp_plan"`

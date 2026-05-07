---
name: aosp-feature-export
description: Export AOSP feature element documentation by iteratively searching related code across all AOSP projects
argument-hint: "<feature description>" --commits <hash1,hash2,...>
level: 3
---

# AOSP Feature Export Skill

Takes a feature point description and related git commit hashes as input, iteratively discovers all related AOSP projects via `sourcepilot`, and outputs a comprehensive markdown document archived to `.omc/aosp-exports/`.

## Usage

```
/oh-my-claudecode:aosp-feature-export "夜景模式" --commits abc123,def456
/oh-my-claudecode:aosp-feature-export "fingerprint unlock" --commits a1b2c3
/oh-my-claudecode:aosp-feature-export "USB audio routing"
```

## Flags

- `--commits <hash1,hash2,...>`: Comma-separated git commit hashes as starting points for keyword extraction
- Without `--commits`: Uses only the description text for keyword extraction

## Protocol

### Step 0: State Initialization

```
state_write(mode="aosp-feature-export", active=true, task_description="<description>")
```

### Step 1: Health Check

Call `sourcepilot` with `tool: "list_tools"` to verify MCP server reachability. Then issue one lightweight search query to confirm upstream is responding.

On failure:
```
state_clear(mode="aosp-feature-export")
```
Abort with: `AOSP MCP server unreachable. Check AOSP_MCP_URL and AOSP_MCP_KEY environment variables.`

### Step 2: Keyword Extraction

1. If `--commits` provided, run `git show --stat <hash>` for each commit:
   - Extract changed file paths (strip extensions to get class/module names)
   - Extract class/interface names from path components
   - Extract noun phrases from commit messages
2. If commits are unavailable locally, fall back to description text only
3. From description text: extract noun phrases, domain terms, subsystem names
4. Deduplicate all keywords, cap at 10-15
5. Group into 3 keyword groups by subsystem area (e.g., HAL-related, Framework-related, App-related)

### Step 3: Phase 1 — Project Discovery

Spawn 3 `aosp-investigator` subagents in parallel. Each investigator is given the full feature context and independently decides what/how to search. The orchestrator does NOT pre-generate search queries — investigators handle search strategy themselves:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  prompt="Investigate AOSP for the feature: '<description>'.
  
  Context from git commits (if available):
  <commit messages, changed file paths, and diff summaries from Step 2>
  
  Your mission: Search AOSP comprehensively to find ALL source code related to this feature.
  - Search by feature keywords, class names, interface names, subsystem names
  - Follow cross-references: if you find an interface, search for its implementations and callers
  - Cover multiple AOSP layers: HAL, native, framework, system services, apps
  - For each finding, document: file path, code snippet, architectural role, and any interfaces it exposes/consumes
  
  Report ALL discovered AOSP file paths grouped by theme. Include architectural observations about how the components connect."
)
```

Collect all investigator reports. Extract unique second-level directory prefixes (first two path segments from AOSP root, e.g., `frameworks/base`, `hardware/interfaces`, `packages/modules/Connectivity`). Store in `discovered_prefixes` set.

### Step 4: Phase 2 — Iterative Expansion

Loop up to 5 rounds (max 15 total successful agent spawns across all rounds including Phase 1).

Each round, spawn 2 `aosp-investigator` subagents. Pass them the accumulated findings so far and let them independently decide how to expand the search — the orchestrator provides context, not queries:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  prompt="Continue investigating AOSP for the feature: '<description>'.
  
  Previously discovered AOSP paths (DO NOT re-search these):
  <list of discovered_prefixes>
  
  Key interfaces and classes found so far:
  <extracted interface names, class names, AIDL/HIDL definitions from prior rounds>
  
  Your mission: Find AOSP code OUTSIDE the already-discovered areas that is related to this feature.
  - Search for callers/implementors of the interfaces found so far
  - Look for related subsystems that interact with the known components
  - Check for configuration, SELinux policies, init scripts, or test code related to this feature
  - Explore upstream/downstream dependencies not yet covered
  
  Report only NEW findings (paths not in the already-discovered list). Group by theme with architectural observations."
)
```

After each round:
1. Collect results, extract new second-level prefixes
2. **Convergence check:** If this round added fewer than 3 never-before-seen prefixes to `discovered_prefixes`, stop iterating
3. **Partial failure handling:** Failed agents don't count toward the 15-spawn cap. If >50% of agents in a round fail, halt and emit partial results with warning. No retries.
4. Emit progress to user: `Round N: +X new prefixes (total: Y unique prefixes, Z files discovered)`

### Step 5: Synthesis

The orchestrator's only heavy-lifting phase — merge and structure all investigator reports into the final document:

1. Concatenate all investigator findings across all rounds
2. Deduplicate overlapping file paths
3. Group findings by second-level AOSP directory prefix (these become the "projects" in the output)
4. For each project group: collect key interfaces, code patterns, and design decisions reported by investigators
5. Synthesize an overall "Design Principles" section from investigators' architectural observations
6. Map cross-project dependencies from investigators' interface-caller/implementor findings
7. Build the output document using the template below

### Step 6: Save

1. Generate slug from description: lowercase, replace spaces/special chars with hyphens, max 50 chars
2. Create `.omc/aosp-exports/` directory if it doesn't exist
3. Write output to `.omc/aosp-exports/<slug>.md`
4. Call `state_clear(mode="aosp-feature-export")`
5. Confirm to user: `Feature export saved to .omc/aosp-exports/<slug>.md`

### Error Recovery

On any unrecoverable error after Step 0:
- If agent data has been collected, write partial results to `.omc/aosp-exports/<slug>-partial.md`
- Call `state_clear(mode="aosp-feature-export")`
- Report the error to the user

Skill is idempotent — re-running with the same inputs overwrites the output file.

## Output Template

```markdown
# AOSP Feature Export: {feature_name}

## Overview
- **Feature:** {description}
- **Export Date:** {date}
- **Input Commits:** {commit_list or "None"}
- **Keywords Extracted:** {keyword_list}
- **Search Rounds:** {n}/5
- **Projects Found:** {count}
- **Convergence:** {converged at round X / hit max rounds}

## Design Principles

{AI-synthesized explanation of how this feature is designed and implemented across AOSP layers. Cover the architectural rationale, key abstractions, and cross-layer communication patterns.}

## Related AOSP Projects

| Project | Path | Layer | Relevance |
|---------|------|-------|-----------|
| {name} | {aosp_path} | {HAL/Framework/System/App} | {why related} |
| ... | ... | ... | ... |

## Key Interfaces

### {Interface Name}
- **File:** {aosp/path/to/file}
- **Type:** AIDL / HIDL / Java API / Native / JNI
- **Purpose:** {what this interface does for the feature}
- **Snippet:**
  ```
  {relevant code excerpt}
  ```

## Code Paths Per Project

### {Project Name} ({aosp_path_prefix})
- **Key Files:**
  - `{file_path}`: {purpose}
  - `{file_path}`: {purpose}
- **Related Commits:**
  - `{hash}` {message} ({date}) [if available]
- **Design Notes:** {observations about this project's role}

## Architecture Overview

{How the feature spans across Android layers: App → Framework → Native → HAL → Kernel. Include data flow and control flow descriptions.}

## Dependencies

- {project A} depends on {project B} via {interface/mechanism}
- ...

## Investigation Log

| Round | Queries | New Prefixes | Total Prefixes | Total Files |
|-------|---------|--------------|----------------|-------------|
| 1 (Discovery) | {keyword groups} | {n} | {n} | {n} |
| 2 | {new queries} | {n} | {n} | {n} |
| ... | ... | ... | ... | ... |
| {final} | {queries} | {n} | {n} | {n} |

**Termination reason:** {converged (< 3 new prefixes) / max rounds reached / partial failure}
```

## Keyword Triggers

- `"aosp export"`, `"aosp feature export"`, `"功能元导出"`, `"feature export"`

## Configuration

- Output directory: `.omc/aosp-exports/` (fixed)
- Max iteration rounds: 5
- Max total agent spawns: 15
- Convergence threshold: < 3 new second-level prefixes per round
- State mode: `aosp-feature-export`

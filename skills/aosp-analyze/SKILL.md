---
name: aosp-analyze
description: Android crash log root-cause analysis via local log files, AOSP source search, and parallel hypothesis investigation. Report in Chinese, saved locally.
argument-hint: <log directory path> [--project <name>] [--title <description>]
triggers:
  - "aosp analyze"
  - "aosp_analyze"
  - "aosp rca"
  - "analyze logs"
  - "crash analyze"
handoff: .omc/specs/aosp-analyze-{slug}.md
level: 3
---

<Purpose>
Automates Android crash root-cause analysis from a local directory of extracted Android system logs (logcat, tombstone, ANR traces, kernel logs). Parses logs into a chronological timeline, searches AOSP source code for crash-related context, generates and investigates hypotheses in parallel, and produces a structured 7-section Chinese RCA report saved to `.omc/specs/`.
</Purpose>

<Use_When>
- User has Android crash logs (logcat, tombstone, ANR, kernel) in a local directory and wants root-cause analysis
- User says "aosp analyze", "aosp_analyze", "aosp rca", "analyze logs", "crash analyze"
- User provides a directory path containing extracted Android log files
- User wants to correlate Android system logs with AOSP source code
</Use_When>

<Do_Not_Use_When>
- Logs are from iOS or non-Android platforms
- User wants to fetch logs from JIRA — use jira-analyze instead
- User wants interactive conversational analysis — this produces a static report
- User already has parsed logs and just needs AOSP source lookup — use aosp-plan directly
- No log directory provided
</Do_Not_Use_When>

<Steps>

## Phase 1: Initialize

1. **Parse `{{ARGUMENTS}}`** to extract the input path and optional flags:

   - `--project <value>` (pattern `--project\s+(\S+)`): Store as project override (or null if absent). Strip the flag from arguments.
   - `--title <value>` (pattern `--title\s+(.+?)(?:\s+--|\s*$)`): Store as user-provided issue description. Strip the flag.
   - `--dir <path>`: Directory containing extracted Android log files.

   **Input path resolution**:
   1. If `--dir <path>` is provided and the path exists: use as the log directory.
   2. If the first positional argument (after stripping flags) is a valid path to a directory: treat as `--dir`.
   3. Otherwise, abort with:
      ```
      No valid log directory found. Provide one of:
        --dir <path>          Directory of extracted Android logs
        <path>                Shorthand for --dir
      ```

2. **Generate a slug** from the input for naming temp files and reports:
   - slug = basename of the directory (lowercase, special chars → hyphens)
   - Max 40 chars, truncate if needed.

3. **MCP health check**:
   - AOSP: call `sourcepilot(tool="list_tools")` — if fails, abort with "sourcepilot MCP unreachable. Check AOSP_MCP_URL and AOSP_MCP_KEY env vars."

4. **Display active AOSP project**:
   - If `--project` override was provided: display `**AOSP Project: <name> (命令行指定)**` and use this value for all subsequent phases. Skip reading `.omc/aosp-config.json`.
   - Otherwise, read `.omc/aosp-config.json`:
     - If configured: display `**AOSP Project: <project_name>**` prominently
     - If not configured: display `**未配置 AOSP 项目** — 搜索将不限定项目范围。运行 /oh-my-claudecode:aosp-project 设置项目。`

5. **Initialize state**:
```
state_write(mode="aosp-analyze", active=true, current_phase="initialize", state={
  "slug": "<slug>",
  "temp_dir": "/tmp/aosp-analyze-<slug>",
  "input_path": "<absolute path to log directory>",
  "issue_title": "<user-provided title or null>",
  "log_file_types": "{}",
  "anomaly_count": "0",
  "hypothesis_count": "0",
  "report_path": null,
  "project_override": "<name>|null"
})
```

6. **Create temp directory**:
```bash
mkdir -p /tmp/aosp-analyze-<slug>/extracted
```

## Phase 2: Log Collection

1. **Copy or symlink** files from the input directory into the working extracted directory:
   ```bash
   cp -r <input_path>/* /tmp/aosp-analyze-<slug>/extracted/
   ```
   (Use `ln -s` if the source directory is large and on the same filesystem.)

2. **Classify extracted files via subagent**:

```
Agent(
  subagent_type="Explore",
  model="haiku",
  prompt="Classify Android log files in /tmp/aosp-analyze-<slug>/extracted/.

For each file, determine its type by scanning the filename AND the first 20 lines of content:
- `logcat*`, `*logcat*`, files starting with `--------- beginning of` → **logcat**
- `tombstone_*`, files starting with `*** *** ***` → **tombstone**
- `*traces.txt`, `*anr*`, files containing `\"main\" prio=` → **ANR trace**
- `*dmesg*`, `*kmsg*`, `*kernel*` → **kernel log**
- Everything else → **other**

Output a JSON mapping: {\"filename\": \"logcat|tombstone|anr|kernel|other\", ...}
Save the result to /tmp/aosp-analyze-<slug>/file-classification.json"
)
```

3. **Read classification result** from `/tmp/aosp-analyze-<slug>/file-classification.json`.

4. **Validate**: If no logcat, tombstone, ANR, or kernel files found, abort with:
   "No Android log files found in the directory. Supported types: logcat, tombstone, ANR traces, kernel logs."

5. **Update state**: `current_phase: "data-collected"`, persist `log_file_types`.

## Phase 3: Log Parsing and Timeline Construction (via aosp-log-parser Agent)

Delegate all log parsing to a single `aosp-log-parser` agent. This agent handles file classification reading, all 4 log type parsers, and the merge/synthesis step internally.

1. **Spawn the aosp-log-parser agent**:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-log-parser",
  model="sonnet",
  prompt="Parse Android log files for analysis <slug>.

Temp directory: /tmp/aosp-analyze-<slug>/
Source files directory: /tmp/aosp-analyze-<slug>/extracted/

The file classification is at /tmp/aosp-analyze-<slug>/file-classification.json.

Follow your Parsing Protocol: read the classification, parse each log type, then merge into unified timeline.md and anomalies.md.

Report the total anomaly count at the end of your response."
)
```

2. **Verify output**: After the agent completes, check that `/tmp/aosp-analyze-<slug>/timeline.md` and `/tmp/aosp-analyze-<slug>/anomalies.md` exist. If not, abort with "Log parsing failed — timeline or anomalies output missing."

3. **Update state**: `current_phase: "parsed"`, `anomaly_count: <N>` (from the agent's summary).

## Phase 4: AOSP Source Context Analysis

Before hypothesis investigation, perform a dedicated AOSP source search based on crash signatures extracted from anomalies. This phase is **mandatory** — skip only if you are absolutely certain the issue has zero relevance to AOSP code (e.g., purely app-layer business logic with no framework/system interaction).

### Extract Search Targets

Read `/tmp/aosp-analyze-<slug>/anomalies.md` and extract:
- Java/native class names from stack traces (e.g., `SurfaceFlinger`, `ActivityManagerService`, `InputDispatcher`)
- Native library names (e.g., `libsurfaceflinger.so`, `libbinder.so`)
- Kernel subsystem identifiers (e.g., `mm/slub.c`, `drivers/gpu/`)
- Signal/error patterns (e.g., `SIGSEGV`, `SIGABRT`, specific error messages)

### Parallel AOSP Search (via Subagents)

Group search targets into 2-3 clusters by subsystem, then spawn one aosp-investigator per cluster **in parallel**:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  model="sonnet",
  prompt="[If --project override is active, prepend: **AOSP Project Override:** Use project `<name>` for ALL sourcepilot search calls. Do NOT read `.omc/aosp-config.json` — the project has been specified explicitly via CLI flag.]

Search AOSP source code for the following crash-related classes/functions from analysis <slug>.

Search targets:
<list of class names, function names, native libraries from anomalies>

For each target:
1. Use sourcepilot — first call {tool: 'list_tools'} to discover available tools
2. Search for the class/function definition in AOSP
3. Find error handling code paths, especially around the crash point
4. Look for related comments, TODOs, known limitations
5. Check if there are CTS tests or known failure patterns

Report for each target:
- **AOSP file path** and relevant line numbers
- **Code snippet** (the function/method containing the crash point)
- **Error handling analysis**: how does this code handle the failure mode seen in the crash?
- **Related patterns**: similar crash patterns, known issues, defensive checks"
)
```

### Collect AOSP Context

- Merge all AOSP investigator results into `/tmp/aosp-analyze-<slug>/aosp-context.md`
- This file feeds into both hypothesis investigation (Phase 5) and the final report (Section 4)
- If AOSP search returns no results for a target, note it as a gap — do not silently omit

Update state: `current_phase: "aosp-searched"`.

## Phase 5: Hypothesis Generation and Parallel Investigation

### Hypothesis Generation (via Subagent)

Spawn an analyst subagent to generate hypotheses from the anomalies:

```
Agent(
  subagent_type="oh-my-claudecode:analyst",
  model="sonnet",
  prompt="Analyze Android crash anomalies for analysis <slug> and generate root-cause hypotheses.

Read the anomalies file: /tmp/aosp-analyze-<slug>/anomalies.md
Read the timeline file: /tmp/aosp-analyze-<slug>/timeline.md
Read the AOSP context file: /tmp/aosp-analyze-<slug>/aosp-context.md (use AOSP findings to inform and strengthen hypotheses)

Generate 2-3 root-cause hypotheses. Each hypothesis must have:
- Title (one-line description)
- Supporting anomaly references (which timeline events support it)
- Relevant AOSP source context (which AOSP code paths are involved, error handling gaps found in Phase 4)
- Key stack frames to investigate in AOSP source code

Prioritize hypotheses by:
1. Fatal/crash events over warnings
2. Earliest anomaly in timeline over later ones
3. System-level crashes over app-level

Save output to /tmp/aosp-analyze-<slug>/hypotheses.md in this format:

## Hypothesis 1: <title>
**Supporting anomalies:** <list of anomaly references>
**Stack frames to investigate:**
- <frame1>
- <frame2>

## Hypothesis 2: ...
(repeat for each hypothesis)"
)
```

Read the generated hypotheses from `/tmp/aosp-analyze-<slug>/hypotheses.md`.

### Parallel Investigation via Agent Tool

Spawn one agent per hypothesis (max 3). Each agent:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  model="sonnet",
  prompt="[If --project override is active, prepend: **AOSP Project Override:** Use project `<name>` for ALL sourcepilot search calls. Do NOT read `.omc/aosp-config.json` — the project has been specified explicitly via CLI flag.]

Investigate this Android crash hypothesis for analysis <slug>:

Hypothesis: <hypothesis_title>

Stack frames to investigate:
<stack_frames>

Timeline context:
<relevant_timeline_events>

Your task:
1. Use sourcepilot — first call {tool: 'list_tools'} to discover available tools
2. Search for each crash-related function/class in AOSP source
3. Find the code path that leads to the crash
4. Look for known issues, TODOs, or error handling gaps in the source

Report format:
- AOSP source files and line numbers relevant to this crash
- Code context (what the function does, error handling patterns)
- Evidence FOR this hypothesis
- Evidence AGAINST this hypothesis
- Confidence: high/medium/low with rationale"
)
```

**IMPORTANT:** Spawn all hypothesis agents in parallel (they are independent).

### Collect Results

- Wait for all agents to complete
- Parse each agent's findings into structured format
- Save to `/tmp/aosp-analyze-<slug>/investigation-<N>.md`
- If an agent fails or times out, mark that hypothesis as "investigation incomplete" — do not fail the entire skill
- Update state: `current_phase: "investigated"`, `hypothesis_count: <N>`

## Phase 6: Synthesis and Report

1. **Read investigation results** from `/tmp/aosp-analyze-<slug>/investigation-*.md` and `/tmp/aosp-analyze-<slug>/aosp-context.md`

2. **Rank hypotheses** by confidence (from investigation results)

3. **Determine the report title**:
   - If `--title` was provided: use it as the issue description
   - Otherwise, derive from the most severe anomaly (e.g., "SIGSEGV in SurfaceFlinger")
   - Format: `{slug} — {derived_or_provided_description}`

4. **Build the 7-section Chinese report** and save to `.omc/specs/aosp-analyze-{slug}.md`:

```markdown
# 根因分析报告: {slug} — {issue_title}

**生成时间:** {date}
**输入目录:** {input_path}
**分析项目:** {project_name or "未限定"}

## 1. 问题概述
{issue_description_summary — derived from anomalies or --title}

## 2. 事件时间线
| 时间 | 来源 | 严重程度 | 事件 |
|------|------|----------|------|
| {timestamp} | {logcat/tombstone/ANR/kernel} | {INFO/WARN/ERROR/FATAL} | {description} |

## 3. 关键异常/错误
### 异常 1: {title}
- **严重程度:** {FATAL/ERROR/WARN}
- **来源:** {file}:{line}
- **堆栈信息:**
  {stack_trace}

## 4. AOSP 源码分析
{从 Phase 4 AOSP 源码上下文分析阶段收集的完整源码分析结果}

### 4.1 关键代码路径
{针对每个崩溃相关的类/函数，列出 AOSP 源码路径、代码片段和功能说明}

#### {class_or_function_name} — {aosp_file_path}
- **源码位置:** `{aosp/path/to/file.java}:{line_range}`
- **代码片段:**
  ```java
  // 相关代码摘录（含行号）
  ```
- **功能说明:** {该函数/类的作用}
- **与崩溃的关联:** {此代码如何与日志中观察到的崩溃行为相关}
- **错误处理分析:** {该代码对故障模式的处理方式，是否存在处理缺口}

### 4.2 已知问题与模式
{AOSP 源码中发现的相关 TODO、FIXME、已知限制、相似崩溃模式}

### 4.3 源码搜索缺口
{搜索未返回结果的目标，可能需要进一步人工排查的部分}

## 5. 根因假设排名
| 排名 | 假设 | 置信度 | 关键证据 |
|------|------|--------|----------|
| 1 | {title} | {高/中/低} | {evidence_summary} |

### 假设 1: {title} (置信度: {level})
**支持证据:**
- {point}
**反对证据:**
- {point}
**AOSP 上下文:** {relevant_source_findings}

## 6. 受影响组件图
{ASCII diagram showing affected Android subsystems and their relationships}

## 7. 建议修复方案
1. {action with specific file/component reference}
2. {action}
```

5. **Finalize state and cleanup**:
   - On success: `state_clear(mode="aosp-analyze")` — terminal exit
   - On error-abort: `state_write(mode="aosp-analyze", active=false, current_phase="error")` — preserves state for debugging
   - Announce report location to user

</Steps>

<Error_Handling>
Embed these handlers throughout all phases:

- **AOSP MCP unreachable** → abort with "sourcepilot MCP unreachable. Check AOSP_MCP_URL and AOSP_MCP_KEY env vars."
- **Input path does not exist** → abort with "Path not found: <path>"
- **Input path is not a directory** → abort with "Path is not a directory: <path>. Provide a directory containing extracted Android logs."
- **No Android log files found** → abort with "No Android log files found in the directory. Supported types: logcat, tombstone, ANR traces, kernel logs."
- **Log parsing failed** → abort with "Log parsing failed — timeline or anomalies output missing. Check aosp-log-parser agent output."
- **AOSP search returns no results** → note "no AOSP source found" in report, do not fail
- **Agent timeout/failure** → mark hypothesis as "investigation incomplete", continue with others
- **All hypotheses fail investigation** → report with "insufficient evidence" conclusion
</Error_Handling>

<State_Schema>
```json
{
  "mode": "aosp-analyze",
  "active": true,
  "current_phase": "initialize | data-collected | parsed | aosp-searched | investigated | complete | error",
  "state": {
    "slug": "string",
    "temp_dir": "/tmp/aosp-analyze-<slug>",
    "input_path": "string",
    "issue_title": "string | null",
    "log_file_types": "{\"filename\": \"logcat|tombstone|anr|kernel|other\"}",
    "anomaly_count": "0",
    "hypothesis_count": "0",
    "report_path": "string | null",
    "project_override": "string | null"
  }
}
```

State is lightweight (<10KB). Parsed data lives in temp files (`/tmp/aosp-analyze-<slug>/`), not in state.

Update state at each phase boundary for resumability. On resume, read state via `state_read(mode="aosp-analyze")` and continue from `current_phase`.
</State_Schema>

<Tool_Usage>
- `sourcepilot` — search AOSP source for crash-related code (always, not conditional)
- `state_write` / `state_read` / `state_clear` — phase persistence (mode="aosp-analyze")
- `Agent(subagent_type="Explore", model="haiku")` — file classification (Phase 2)
- `Agent(subagent_type="oh-my-claudecode:aosp-log-parser", model="sonnet")` — log parsing and timeline construction (Phase 3)
- `Agent(subagent_type="oh-my-claudecode:analyst", model="sonnet")` — hypothesis generation (Phase 5)
- `Agent(subagent_type="oh-my-claudecode:aosp-investigator", model="sonnet")` — AOSP context search (Phase 4) + parallel hypothesis investigation (Phase 5)
- `Write` — save final report
- `Bash` — cp, temp directory management
</Tool_Usage>

<Examples>
<Good>
```
User: /aosp-analyze --dir /tmp/crash-logs --title "SystemUI crash after OTA"

[Phase 1] Input: directory /tmp/crash-logs. Slug: crash-logs. AOSP MCP health check pass.
          AOSP Project: android-14 (from .omc/aosp-config.json)
[Phase 2] Copied 8 files. Spawned Explore subagent for classification.
          Result: 2 logcat, 1 tombstone, 1 ANR, 0 kernel, 4 other.
[Phase 3] Spawned aosp-log-parser agent.
          Completed → 312 timeline events, 7 anomalies.
          Top anomalies: SIGSEGV in libsurfaceflinger.so, ANR in SystemUI.
[Phase 4] AOSP Source Context: Spawned 2 aosp-investigator agents in parallel.
          Cluster 1 (SurfaceFlinger): Found SurfaceFlinger::onMessageReceived null check gap.
          Cluster 2 (SystemUI): Found SystemUI binder thread pool config in ActivityManagerService.
          Saved aosp-context.md with 5 AOSP source findings.
[Phase 5] Spawned analyst subagent → generated 2 hypotheses:
          H1: SurfaceFlinger null pointer dereference (FATAL, earliest)
          H2: SystemUI ANR from binder thread exhaustion (ERROR)
          Spawned 2 aosp-investigator agents in parallel.
          H1: HIGH confidence — found matching code path in SurfaceFlinger::onMessageReceived
          H2: MEDIUM — thread pool config matches but no direct evidence
[Phase 6] Report saved to .omc/specs/aosp-analyze-crash-logs.md (Chinese, 7 sections).
```
Why good: All exploration delegated to subagents. Clear input (--dir). AOSP project configured. Full pipeline executed with aosp-log-parser agent handling parallel parsing.
</Good>

<Good>
```
User: /aosp-analyze /home/user/bugreport-logs

[Phase 1] Input: directory /home/user/bugreport-logs. Slug: bugreport-logs. AOSP MCP health check pass.
          No AOSP project configured — searching all projects.
[Phase 2] Copied 15 files. Classification → 4 logcat, 3 tombstone, 2 ANR, 1 kernel, 5 other.
[... rest of pipeline ...]
```
Why good: Positional path shorthand works. No project configured — searches all projects with clear warning.
</Good>

<Bad>
```
User: /aosp-analyze --sn ABC123456
[Phase 1] No valid log directory found.
```
Why bad: Does not support --sn. User should extract logs first or use the directory path directly.
</Bad>

<Bad>
```
User: /aosp-analyze /path/to/nonexistent
[Phase 1] Path not found: /path/to/nonexistent. Abort.
```
Why good: Correctly aborts early when path doesn't exist.
</Bad>
</Examples>

<Guardrails>
**Must have:**
- sourcepilot for AOSP source (always, not conditional) — **Phase 4 AOSP 源码分析是必选阶段**，除非十分确认问题与 AOSP 源码完全无关才可跳过
- aosp-investigator subagent for both Phase 4 (AOSP context) and Phase 5 (hypothesis investigation)
- Lightweight state (<10KB, file paths not data)
- All 7 report sections (in Chinese)
- Report saved to `.omc/specs/aosp-analyze-{slug}.md`
- All exploration/analysis delegated to subagents (file classification, log parsing, timeline merge, hypothesis generation, AOSP investigation)
- Lead only orchestrates: MCP calls, state management, subagent spawning, report assembly

**Must NOT have:**
- JIRA MCP dependency (no jira_get_issue, jira_download_attachments, jira_add_comment)
- zip/sn input modes (only --dir / directory path, not --zip or --sn)
- log-unboxer dependency
- Interactive/conversational mode (produces static report)
- iOS or non-Android log parsing
- Binary attachment processing (images, videos)
- Guessing of issue context — derive strictly from logs and --title
</Guardrails>

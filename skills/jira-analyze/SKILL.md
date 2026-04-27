---
name: jira-analyze
description: Android bug root-cause analysis via JIRA logs, AOSP source search, and parallel hypothesis investigation. Report in Chinese, posted as JIRA comment.
argument-hint: <JIRA URL or issue key, e.g. SPFB-535>
triggers:
  - "jira analyze"
  - "jira_analyze"
  - "jira rca"
  - "analyze jira"
handoff: .omc/specs/jira-analyze-{issue_key}.md
level: 3
---

<Purpose>
Automates Android bug root-cause analysis by fetching JIRA issue details via mcp-atlassian, downloading and decompressing zip attachments containing Android system logs (logcat, tombstone, ANR traces, kernel logs), parsing them into a chronological timeline, searching AOSP source code for crash-related context, generating and investigating hypotheses in parallel, and producing a structured 7-section Chinese RCA report posted as a JIRA comment.
</Purpose>

<Use_When>
- User has an Android JIRA bug with log attachments and wants root-cause analysis
- User says "jira analyze", "jira_analyze", "jira rca", or "analyze jira"
- User provides a JIRA URL or issue key containing Android crash/ANR/kernel panic logs
- User wants to correlate Android system logs with AOSP source code
</Use_When>

<Do_Not_Use_When>
- Issue has no log attachments — nothing to parse
- Logs are from iOS or non-Android platforms
- User wants interactive conversational analysis — this produces a static report
- User already has parsed logs and just needs AOSP source lookup — use aosp-plan directly
</Do_Not_Use_When>

<Steps>

## Phase 1: Initialize

1. **Parse `{{ARGUMENTS}}`** to extract the issue key:
   - URL pattern: extract key from `https://<domain>/browse/<KEY>` via regex
   - Direct key pattern: validate `^[A-Z][A-Z0-9_]+-\d+$`
   - If neither matches, abort with: "Could not parse JIRA issue key from input. Provide a URL (https://jira.example.com/browse/PROJ-123) or key (PROJ-123)."

2. **MCP health checks** (run both in parallel):
   - JIRA: call `jira_get_issue(issue_key=<KEY>, fields="summary")` — if fails, abort with "mcp-atlassian unreachable. Check JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN env vars."
   - AOSP: call `aosp_code_search(tool="list_tools")` — if fails, abort with "aosp_code_search MCP unreachable. Check AOSP_MCP_URL and AOSP_MCP_KEY env vars."

3. **Initialize state**:
```
state_write(mode="jira-analyze", active=true, current_phase="initialize", state={
  "issue_key": "<KEY>",
  "temp_dir": "/tmp/jira-analyze-<KEY>",
  "issue_summary": null,
  "attachment_meta": "[]",
  "log_file_types": "{}",
  "anomaly_count": "0",
  "hypothesis_count": "0",
  "report_path": null
})
```

4. **Create temp directory**:
```bash
mkdir -p /tmp/jira-analyze-<KEY>/extracted
```

## Phase 2: JIRA Data Collection

1. **Fetch issue details**: `jira_get_issue(issue_key=<KEY>, comment_limit=0)` — store title, status, assignee, priority, description. **Do NOT fetch or analyze comments/备注** — comments may contain noise or outdated information that interferes with log-based RCA.

2. **Pre-check attachments**: `jira_get_issue(issue_key=<KEY>, fields="attachment")` — inspect attachment metadata (filename, size, mimeType). Filter to zip files only. Skip files > 50MB (MCP transfer limit). If no zip attachments, warn and attempt to parse any `.txt`/`.log` files directly.

3. **Download attachments** — try methods in priority order:

   **Method A (preferred): MCP `jira_download_attachments`** — download zip attachments via mcp-atlassian:
   `jira_download_attachments(issue_key=<KEY>)` → returns base64-encoded EmbeddedResource objects.
   Save via file-based decode (NOT echo pipe — avoids ARG_MAX limit):
   ```bash
   # Step 1: Write base64 content to file using Write tool (mcp__filesystem__write_file)
   # Step 2: Decode via file redirection
   base64 -d < /tmp/jira-analyze-<KEY>/<filename>.b64 > /tmp/jira-analyze-<KEY>/<filename>.zip
   ```
   Then decompress using `log_unboxer unpack`:
   ```bash
   log_unboxer unpack /tmp/jira-analyze-<KEY>/<filename>.zip --output-dir /tmp/jira-analyze-<KEY>/extracted/
   ```
   If `log_unboxer unpack` is not available, fall back to:
   ```bash
   unzip -o /tmp/jira-analyze-<KEY>/<filename>.zip -d /tmp/jira-analyze-<KEY>/extracted/
   ```

   **Method B (fallback): `log_unboxer download --sn`** — if no zip attachments are found, check the issue description for a device serial number (SN). If found:
   ```bash
   log_unboxer download --sn <SERIAL_NUMBER> --output-dir /tmp/jira-analyze-<KEY>/extracted/ --days 90
   ```
   This downloads the last 90 days of device logs directly from the log server.

4. **Classify extracted files via subagent**:

```
Agent(
  subagent_type="Explore",
  model="haiku",
  prompt="Classify Android log files in /tmp/jira-analyze-<KEY>/extracted/.

For each file, determine its type by scanning the filename AND the first 20 lines of content:
- `logcat*`, `*logcat*`, files starting with `--------- beginning of` → **logcat**
- `tombstone_*`, files starting with `*** *** ***` → **tombstone**
- `*traces.txt`, `*anr*`, files containing `\"main\" prio=` → **ANR trace**
- `*dmesg*`, `*kmsg*`, `*kernel*` → **kernel log**
- Everything else → **other**

Output a JSON mapping: {\"filename\": \"logcat|tombstone|anr|kernel|other\", ...}
Save the result to /tmp/jira-analyze-<KEY>/file-classification.json"
)
```

5. **Read classification result** from `/tmp/jira-analyze-<KEY>/file-classification.json`.

6. **Update state**: `current_phase: "data-collected"`, persist `log_file_types` (from classification result) and `attachment_meta`.

## Phase 3: Log Parsing and Timeline Construction (via Subagents)

Delegate log parsing to parallel subagents — one per log type. Each subagent parses its log type independently and writes results to temp files. The lead then merges results.

### Spawn Log Parser Subagents

Read `log_file_types` from state. Group files by type, then spawn one subagent per type that has files (max 4: logcat, tombstone, ANR, kernel). **Spawn all in parallel.**

```
Agent(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="Parse Android LOGCAT log files for JIRA issue <KEY>.

Files to parse (in /tmp/jira-analyze-<KEY>/extracted/):
<list of logcat files>

Logcat line regex: ^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.+?):\s+(.*)$

For each file:
1. Extract: timestamp, PID, TID, level, tag, message
2. Flag entries with level E (error) or F (fatal) as anomalies
3. For each anomaly, extract the associated stack trace (next N lines after the anomaly marker)

Output:
- Save timeline events to /tmp/jira-analyze-<KEY>/parsed-logcat.md as a markdown table: | Time | PID | TID | Level | Tag | Message |
- Save anomalies to /tmp/jira-analyze-<KEY>/anomalies-logcat.md with stack traces
- Deduplicate repeated crashes (same stack trace within 1-second window)"
)
```

```
Agent(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="Parse Android TOMBSTONE files for JIRA issue <KEY>.

Files to parse (in /tmp/jira-analyze-<KEY>/extracted/):
<list of tombstone files>

Extract from each file:
- `pid: \d+, tid: \d+, name: .*` — crashed process
- `signal \d+ \(SIG\w+\)` — signal info
- `backtrace:` section — stack frames with `#\d+\s+pc\s+([0-9a-f]+)\s+(.+)` pattern
- `Build fingerprint:` — device/build info

Output:
- Save timeline events to /tmp/jira-analyze-<KEY>/parsed-tombstone.md as a markdown table: | Time | Source | Severity | Event |
- Save anomalies to /tmp/jira-analyze-<KEY>/anomalies-tombstone.md with full stack traces and signal info"
)
```

```
Agent(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="Parse Android ANR TRACE files for JIRA issue <KEY>.

Files to parse (in /tmp/jira-analyze-<KEY>/extracted/):
<list of ANR files>

Extract from each file:
- `\"main\" prio=\d+ tid=\d+` — main thread state
- `at (.+)\((.+:\d+)\)` — stack frames
- `- waiting to lock` / `- locked` — lock contention info

Output:
- Save timeline events to /tmp/jira-analyze-<KEY>/parsed-anr.md as a markdown table: | Time | Source | Severity | Event |
- Save anomalies to /tmp/jira-analyze-<KEY>/anomalies-anr.md with main thread stack and lock contention details"
)
```

```
Agent(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="Parse Android KERNEL LOG files for JIRA issue <KEY>.

Files to parse (in /tmp/jira-analyze-<KEY>/extracted/):
<list of kernel files>

Kernel log line regex: ^\[\s*(\d+\.\d+)\]\s+(.*)$

For each file:
1. Extract: timestamp (seconds since boot), message
2. Flag lines containing `panic`, `Oops`, `BUG`, `Unable to handle` as anomalies
3. For each anomaly, extract surrounding context (5 lines before and after)

Output:
- Save timeline events to /tmp/jira-analyze-<KEY>/parsed-kernel.md as a markdown table: | Time | Source | Severity | Event |
- Save anomalies to /tmp/jira-analyze-<KEY>/anomalies-kernel.md with context"
)
```

### Merge and Synthesize (via Subagent)

After all parser subagents complete, spawn a synthesis subagent:

```
Agent(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="Merge parsed Android log data into a unified timeline for JIRA issue <KEY>.

Input files (read all that exist in /tmp/jira-analyze-<KEY>/):
- parsed-logcat.md, parsed-tombstone.md, parsed-anr.md, parsed-kernel.md
- anomalies-logcat.md, anomalies-tombstone.md, anomalies-anr.md, anomalies-kernel.md

Tasks:
1. Normalize all timestamps to a common epoch (use logcat timestamps as reference where available; kernel timestamps are seconds-since-boot — offset them using the earliest logcat timestamp if possible)
2. Merge all timeline events and sort chronologically
3. Merge all anomalies, deduplicate repeated crashes (same stack trace within 1-second window)
4. Mark anomalies with severity tags: FATAL, ERROR, WARN

Output:
- Save /tmp/jira-analyze-<KEY>/timeline.md — full chronological timeline as markdown table
- Save /tmp/jira-analyze-<KEY>/anomalies.md — deduplicated anomalies with stack traces, sorted by severity then time
- Print the total anomaly count at the end of your response"
)
```

Update state: `current_phase: "parsed"`, `anomaly_count: <N>` (from synthesis agent's output).

## Phase 4: AOSP Source Context Analysis

Before hypothesis investigation, perform a dedicated AOSP source search based on crash signatures extracted from anomalies. This phase is **mandatory** — skip only if you are absolutely certain the issue has zero relevance to AOSP code (e.g., purely app-layer business logic with no framework/system interaction).

### Extract Search Targets

Read `/tmp/jira-analyze-<KEY>/anomalies.md` and extract:
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
  prompt="Search AOSP source code for the following crash-related classes/functions from JIRA issue <KEY>.

Search targets:
<list of class names, function names, native libraries from anomalies>

For each target:
1. Use aosp_code_search — first call {tool: 'list_tools'} to discover available tools
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

- Merge all AOSP investigator results into `/tmp/jira-analyze-<KEY>/aosp-context.md`
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
  prompt="Analyze Android crash anomalies for JIRA issue <KEY> and generate root-cause hypotheses.

Read the anomalies file: /tmp/jira-analyze-<KEY>/anomalies.md
Read the timeline file: /tmp/jira-analyze-<KEY>/timeline.md
Read the AOSP context file: /tmp/jira-analyze-<KEY>/aosp-context.md (use AOSP findings to inform and strengthen hypotheses)

Generate 2-3 root-cause hypotheses. Each hypothesis must have:
- Title (one-line description)
- Supporting anomaly references (which timeline events support it)
- Relevant AOSP source context (which AOSP code paths are involved, error handling gaps found in Phase 4)
- Key stack frames to investigate in AOSP source code

Prioritize hypotheses by:
1. Fatal/crash events over warnings
2. Earliest anomaly in timeline over later ones
3. System-level crashes over app-level

Save output to /tmp/jira-analyze-<KEY>/hypotheses.md in this format:

## Hypothesis 1: <title>
**Supporting anomalies:** <list of anomaly references>
**Stack frames to investigate:**
- <frame1>
- <frame2>

## Hypothesis 2: ...
(repeat for each hypothesis)"
)
```

Read the generated hypotheses from `/tmp/jira-analyze-<KEY>/hypotheses.md`.

### Parallel Investigation via Agent Tool

Spawn one agent per hypothesis (max 3). Each agent:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  model="sonnet",
  prompt="Investigate this Android crash hypothesis for JIRA issue <KEY>:

Hypothesis: <hypothesis_title>

Stack frames to investigate:
<stack_frames>

Timeline context:
<relevant_timeline_events>

Your task:
1. Use aosp_code_search — first call {tool: 'list_tools'} to discover available tools
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
- Save to `/tmp/jira-analyze-<KEY>/investigation-<N>.md`
- If an agent fails or times out, mark that hypothesis as "investigation incomplete" — do not fail the entire skill
- Update state: `current_phase: "investigated"`, `hypothesis_count: <N>`

## Phase 6: Synthesis and Report

1. **Read investigation results** from `/tmp/jira-analyze-<KEY>/investigation-*.md` and `/tmp/jira-analyze-<KEY>/aosp-context.md`

2. **Rank hypotheses** by confidence (from investigation results)

3. **Build the 7-section Chinese report** and save to `.omc/specs/jira-analyze-{issue_key}.md`:

```markdown
# 根因分析报告: {issue_key} — {issue_title}

**生成时间:** {date}
**问题链接:** {jira_url}
**状态:** {status} | **经办人:** {assignee} | **优先级:** {priority}

## 1. 问题概述
{issue_description_summary}

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

5. **Post report as JIRA comment**: `jira_add_comment(issue_key=<KEY>, body=<report_content>)` — post the full report content as a comment on the JIRA issue. If this fails, warn but do not abort (the local report file is still available).

6. **Finalize state and cleanup**:
   - On success: `state_clear(mode="jira-analyze")` — terminal exit
   - On error-abort: `state_write(mode="jira-analyze", active=false, current_phase="error")` — preserves state for debugging
   - Announce report location to user

</Steps>

<Error_Handling>
Embed these handlers throughout all phases:

- **MCP unreachable** → abort with specific message naming which MCP failed and env vars to check
- **No zip attachments found** → warn, attempt to parse any .txt/.log attachments directly
- **Attachment > 50MB** → skip with warning (MCP transfer limit)
- **Zip decompression fails** → log error, continue with other attachments
- **No parseable logs found** → abort with "No Android log files found in attachments"
- **AOSP search returns no results** → note "no AOSP source found" in report, do not fail
- **Agent timeout/failure** → mark hypothesis as "investigation incomplete", continue with others
- **All hypotheses fail investigation** → report with "insufficient evidence" conclusion
- **JIRA comment post fails** → warn user, do not abort (local report file is still available)
</Error_Handling>

<State_Schema>
```json
{
  "mode": "jira-analyze",
  "active": true,
  "current_phase": "initialize | data-collected | parsed | aosp-searched | investigated | complete | error",
  "state": {
    "issue_key": "string",
    "temp_dir": "/tmp/jira-analyze-<KEY>",
    "issue_summary": "string (title only)",
    "attachment_meta": "[{\"filename\": \"\", \"type\": \"\", \"size_bytes\": 0}]",
    "log_file_types": "{\"filename\": \"logcat|tombstone|anr|kernel|other\"}",
    "anomaly_count": "0",
    "hypothesis_count": "0",
    "report_path": "string|null"
  }
}
```

State is lightweight (<10KB). Parsed data lives in temp files (`/tmp/jira-analyze-<KEY>/`), not in state.

Update state at each phase boundary for resumability. On resume, read state via `state_read(mode="jira-analyze")` and continue from `current_phase`.
</State_Schema>

<Tool_Usage>
- `jira_get_issue` — fetch issue details and attachment metadata (mcp-atlassian)
- `jira_download_attachments` — primary attachment download method (mcp-atlassian)
- `log_unboxer unpack` — decompress downloaded zip/archive files (preferred over plain unzip)
- `log_unboxer download --sn` — fallback: download device logs by serial number from log server (last 90 days). Do NOT use `--url`.
- `jira_add_comment` — post RCA report as comment on JIRA issue (mcp-atlassian)
- `aosp_code_search` — search AOSP source for crash-related code (always, not conditional)
- `state_write` / `state_read` / `state_clear` — phase persistence (mode="jira-analyze")
- `Agent(subagent_type="Explore", model="haiku")` — file classification (Phase 2)
- `Agent(subagent_type="oh-my-claudecode:executor", model="sonnet")` — log parsing per type + timeline merge (Phase 3)
- `Agent(subagent_type="oh-my-claudecode:analyst", model="sonnet")` — hypothesis generation (Phase 4)
- `Agent(subagent_type="oh-my-claudecode:aosp-investigator", model="sonnet")` — parallel hypothesis investigation lanes (Phase 4)
- `Write` tool — save base64 files and final report
- `Bash` — base64 decode (file-based), unzip, temp directory management
</Tool_Usage>

<Examples>
<Good>
```
User: /jira-analyze https://jira.cvte.com/browse/SPFB-535

[Phase 1] Parsed key: SPFB-535. MCP health checks pass (jira + aosp).
[Phase 2] Fetched issue. Found 2 zip attachments (logs_2026.zip, bugreport.zip).
         Decompressed → 12 files. Spawned Explore subagent for classification.
         Result: 3 logcat, 2 tombstone, 1 ANR, 1 kernel, 5 other.
[Phase 3] Spawned 4 parser subagents in parallel (logcat, tombstone, ANR, kernel).
         All complete. Spawned merge subagent → 847 timeline events, 23 anomalies.
         Top anomalies: SIGSEGV in libsurfaceflinger.so, ANR in SystemUI, kernel BUG at mm/slub.c.
[Phase 4] AOSP Source Context: Spawned 2 aosp-investigator agents in parallel.
         Cluster 1 (SurfaceFlinger/SystemUI): Found SurfaceFlinger::onMessageReceived null check gap,
         SystemUI binder thread pool config in ActivityManagerService.
         Cluster 2 (kernel/mm): Found mm/slub.c slab corruption detection path, related TODO comments.
         Saved aosp-context.md with 8 AOSP source findings.
[Phase 5] Spawned analyst subagent → generated 3 hypotheses (informed by AOSP context):
         H1: SurfaceFlinger null pointer dereference (FATAL, earliest)
         H2: SystemUI ANR from binder thread exhaustion (ERROR)
         H3: Kernel slab corruption causing downstream crashes (FATAL)
         Spawned 3 aosp-investigator agents in parallel.
         H1: HIGH confidence — found matching code path in SurfaceFlinger::onMessageReceived
         H2: MEDIUM — binder thread pool config matches but no direct evidence
         H3: LOW — kernel log timing doesn't correlate with userspace crashes
[Phase 5] Report saved to .omc/specs/jira-analyze-SPFB-535.md (Chinese, 7 sections).
         Posted report as JIRA comment on SPFB-535.
```
Why good: All exploration delegated to subagents. File classification (Explore/haiku), log parsing (4 executor/sonnet in parallel), timeline merge (executor/sonnet), hypothesis generation (analyst/sonnet), AOSP investigation (3 aosp-investigator/sonnet in parallel). Lead only orchestrates. Report in Chinese, posted to JIRA.
</Good>

<Bad>
```
User: /jira-analyze SPFB-535
[Phase 2] Downloaded attachments.
[Phase 2] echo "$BASE64_CONTENT" | base64 -d > file.zip   # ARG_MAX exceeded!
```
Why bad: Used echo pipe for base64 decode instead of file-based approach. Large attachments will fail with argument list too long.
</Bad>

<Bad>
```
[Phase 4] Only searched AOSP for the top hypothesis, skipped others.
```
Why bad: AOSP search must run for ALL hypotheses, not just the highest-ranked one.
</Bad>
</Examples>

<Guardrails>
**Must have:**
- **log_unboxer 优先**: 解压日志必须优先使用 `log_unboxer unpack`，仅当 log_unboxer 不可用时才回退到 `unzip`
- mcp-atlassian for JIRA access (not jira-cli)
- aosp_code_search for AOSP source (always, not conditional) — **Phase 4 AOSP 源码分析是必选阶段**，除非十分确认问题与 AOSP 源码完全无关才可跳过
- aosp-investigator subagent for both Phase 4 (AOSP context) and Phase 5 (hypothesis investigation)
- File-based base64 decode (not echo pipe)
- Lightweight state (<10KB, file paths not data)
- All 7 report sections (in Chinese)
- Report posted as JIRA comment via jira_add_comment
- All exploration/analysis delegated to subagents (file classification, log parsing, timeline merge, hypothesis generation, AOSP investigation)
- Lead only orchestrates: MCP calls, state management, subagent spawning, report assembly

**Must NOT have:**
- Interactive/conversational mode (produces static report)
- iOS or non-Android log parsing
- Binary attachment processing (images, videos)
- Base64 content piped through echo/shell arguments
</Guardrails>

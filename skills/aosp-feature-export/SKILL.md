---
name: aosp-feature-export
description: Export AOSP feature element documentation by iteratively searching related code across all AOSP projects
argument-hint: "<feature description>" --links <url1,url2,...>
level: 3
---

# AOSP Feature Export Skill

Documents vendor/third-party features added on top of AOSP. Takes a feature description and GitLab MR/commit URLs (vendor changes) as input, fetches diffs via GitLab MCP tools to identify modification points, then uses `sourcepilot` to search the AOSP codebase for the original code being modified or extended. Outputs a comprehensive Chinese-language markdown document that maps the vendor feature across AOSP layers, archived to `.omc/aosp-exports/`.

**Key distinction:** The feature being documented is NOT an AOSP built-in feature. It is a vendor customization — code added or modified by the third-party vendor on top of AOSP. The AOSP search phase finds the original context that the vendor code interacts with.

## Usage

```
/oh-my-claudecode:aosp-feature-export "公共DNS" --links https://gitlab.gz.cvte.cn/mt8781_androidu/platform/packages/modules/Connectivity/-/merge_requests/3/diffs
/oh-my-claudecode:aosp-feature-export "fingerprint unlock" --links https://gitlab.gz.cvte.cn/project/path/-/commit/d2794bf5a8132dc9
/oh-my-claudecode:aosp-feature-export "USB audio routing" --links <mr-url1>,<commit-url2>
/oh-my-claudecode:aosp-feature-export "夜景模式" --commits abc123,def456
/oh-my-claudecode:aosp-feature-export "USB audio routing"
```

## Flags

- `--links <url1,url2,...>`: Comma-separated GitLab MR diff or commit URLs as starting points for keyword extraction (primary input mode)
- `--commits <hash1,hash2,...>`: Comma-separated local git commit hashes as starting points (secondary, for local-only workflows)
- Without either flag: Uses only the description text for keyword extraction

### Supported URL Formats

- **MR diffs:** `https://{host}/{project_path}/-/merge_requests/{iid}/diffs` (trailing `/diffs` optional)
- **Commit:** `https://{host}/{project_path}/-/commit/{sha}`

Future: URL routing is provider-dispatched. Currently supports GitLab only. GitHub/Gerrit patterns may be added later.

## Protocol

### Step 0: State Initialization

```
state_write(mode="aosp-feature-export", active=true, task_description="<description>")
```

### Step 1: Health Check

Call `sourcepilot` with `tool: "list_tools"` to verify MCP server reachability. Then issue one lightweight search query to confirm upstream is responding.

After health check passes, read `.omc/aosp-config.json` to display the active AOSP project:
- If configured: display `**🔍 AOSP Project: <project_name>**` prominently
- If not configured: display `**⚠ 未配置 AOSP 项目** — 搜索将不限定项目范围。运行 /oh-my-claudecode:aosp-project 设置项目。`

(The `aosp-investigator` subagent reads this config and passes `project` to search calls automatically — no need to inject it into spawn prompts.)

On failure:
```
state_clear(mode="aosp-feature-export")
```
Abort with: `AOSP MCP server unreachable. Check AOSP_MCP_URL and AOSP_MCP_KEY environment variables.`

### Step 2: Keyword Extraction

#### 2a: Fetch change data from links or commits

**If `--links` provided**, parse each URL and call GitLab MCP tools:

1. For each URL, determine type by pattern matching:
   - **MR URL** (`{host}/{project_path}/-/merge_requests/{iid}` with optional `/diffs`):
     - Extract `project_id` = `{project_path}` (e.g., `mt8781_androidu/platform/packages/modules/Connectivity`)
     - Extract `merge_request_iid` = `{iid}`
     - Call `mcp__gitlab__get_merge_request(project_id, merge_request_iid)` → extract MR title and description
     - Call `mcp__gitlab__get_merge_request_diffs(project_id, merge_request_iid)` → extract changed file paths (old_path, new_path) and diff content
   - **Commit URL** (`{host}/{project_path}/-/commit/{sha}`):
     - Extract `project_id` = `{project_path}`
     - Extract `sha` = `{sha}`
     - Call `mcp__gitlab__get_commit(project_id, sha)` → extract commit message
     - Call `mcp__gitlab__get_commit_diff(project_id, sha, full_diff=true)` → extract changed file paths and diff content

2. From fetched data, extract:
   - Changed file paths (strip extensions to get class/module names)
   - Class/interface names from path components
   - Noun phrases from MR title/description or commit messages
   - Key identifiers from diff additions (class declarations, method names, constants)

3. **Error handling:** If any URL returns an error (unreachable, 404, permission denied), log it and continue with remaining URLs. If ALL URLs fail, fall back to description-only mode.

**If `--commits` provided** (secondary mode for local-only workflows), run `git show --stat <hash>` for each commit:
   - Extract changed file paths (strip extensions to get class/module names)
   - Extract class/interface names from path components
   - Extract noun phrases from commit messages
   - If commits are unavailable locally, fall back to description text only

#### 2b: Build keyword set

1. From description text: extract noun phrases, domain terms, subsystem names
2. Merge with keywords extracted from links/commits (if any)
3. Deduplicate all keywords, cap at 10-15
4. Group into 3 keyword groups by subsystem area (e.g., HAL-related, Framework-related, App-related)

### Step 3: Phase 1 — Project Discovery

Spawn 3 `aosp-investigator` subagents in parallel. Each investigator is given the full feature context and independently decides what/how to search. The orchestrator does NOT pre-generate search queries — investigators handle search strategy themselves:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  prompt="Investigate AOSP for the original code related to a VENDOR feature: '<description>'.
  
  This is a third-party/vendor customization, NOT an AOSP built-in feature. The vendor has modified or extended AOSP code to implement this feature.
  
  Vendor modification points (from GitLab diffs):
  <changed file paths, class names, method names, and diff summaries from Step 2>
  
  Your mission: Search AOSP to find the ORIGINAL code that the vendor modifications interact with.
  - Search for the original AOSP classes/interfaces that the vendor code modifies, extends, or calls
  - Follow cross-references: if the vendor modifies an interface, find its original definition, implementations, and callers in AOSP
  - Cover multiple AOSP layers: HAL, native, framework, system services, apps
  - For each finding, document: file path, code snippet, architectural role, and how it relates to the vendor modification points
  
  Report ALL discovered AOSP file paths grouped by theme. Include architectural observations about how the vendor changes hook into the AOSP architecture."
)
```

Collect all investigator reports. Extract unique second-level directory prefixes (first two path segments from AOSP root, e.g., `frameworks/base`, `hardware/interfaces`, `packages/modules/Connectivity`). Store in `discovered_prefixes` set.

### Step 4: Phase 2 — Iterative Expansion

Loop up to 5 rounds (max 15 total successful agent spawns across all rounds including Phase 1).

Each round, spawn 2 `aosp-investigator` subagents. Pass them the accumulated findings so far and let them independently decide how to expand the search — the orchestrator provides context, not queries:

```
Agent(
  subagent_type="oh-my-claudecode:aosp-investigator",
  prompt="Continue investigating AOSP for the original code related to a VENDOR feature: '<description>'.
  
  This is a third-party/vendor customization. The vendor has modified or extended AOSP code.
  
  Previously discovered AOSP paths (DO NOT re-search these):
  <list of discovered_prefixes>
  
  Key interfaces and classes found so far:
  <extracted interface names, class names, AIDL/HIDL definitions from prior rounds>
  
  Your mission: Find AOSP code OUTSIDE the already-discovered areas that the vendor modifications interact with.
  - Search for callers/implementors of the interfaces found so far
  - Look for related AOSP subsystems that the vendor feature depends on or extends
  - Check for configuration, SELinux policies, init scripts, or test code in AOSP related to the modified components
  - Explore upstream/downstream AOSP dependencies not yet covered
  
  Report only NEW findings (paths not in the already-discovered list). Group by theme with observations about how vendor changes hook into these AOSP components."
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
7. **Construct commit URLs:** For each input link's project, build browsable commit URLs using format `https://{host}/{project_path}/-/commit/{sha}`. If the input was an MR, use the MR's source commits. Include these URLs in the output under "Related Commits".
8. Build the output document **in Chinese** using the template below

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
# Vendor功能元导出: {feature_name}

## 概览
- **功能:** {description}
- **类型:** Vendor/第三方定制功能
- **导出日期:** {date}
- **输入链接:** {url_list or "无"}
- **输入提交:** {commit_list or "无"}
- **提取关键词:** {keyword_list}
- **搜索轮次:** {n}/5
- **发现AOSP关联项目数:** {count}
- **收敛情况:** {在第X轮收敛 / 达到最大轮次}

## Vendor修改概述

{基于GitLab diff的vendor改动摘要。说明vendor修改了哪些文件、增加了什么逻辑、修改的入口点在哪里。}

## 设计原理

{AI综合说明该vendor功能如何嵌入AOSP架构。涵盖vendor代码的hook点、对AOSP原有逻辑的修改方式、跨层交互模式。}

## 相关AOSP项目

| 项目 | 路径 | 层级 | 与Vendor功能的关系 |
|------|------|------|-------------------|
| {name} | {aosp_path} | {HAL/Framework/System/App} | {vendor如何修改或依赖此项目} |
| ... | ... | ... | ... |

## 关键接口

### {接口名称}
- **文件:** {aosp/path/to/file}
- **类型:** AIDL / HIDL / Java API / Native / JNI
- **AOSP原始用途:** {该接口在AOSP中的原始作用}
- **Vendor修改方式:** {vendor如何修改、扩展或调用此接口}
- **代码片段:**
  ```
  {relevant code excerpt}
  ```

## 各项目代码路径

### {项目名称} ({aosp_path_prefix})
- **关键文件:**
  - `{file_path}`: {用途}
  - `{file_path}`: {用途}
- **Vendor相关提交:**
  - [{commit_message}]({https://gitlab.host/project_path/-/commit/full_sha}) ({date})
- **设计说明:** {vendor代码如何hook进此AOSP项目}

## 架构总览

{Vendor功能如何跨越Android各层嵌入: App → Framework → Native → HAL → Kernel。标注vendor修改点与AOSP原始代码的边界。}

## 依赖关系

- Vendor功能依赖 {AOSP项目A} 的 {接口/机制}
- Vendor功能修改了 {AOSP项目B} 的 {类/方法}
- ...

## 调查日志

| 轮次 | 查询 | 新增前缀 | 总前缀数 | 总文件数 |
|------|------|----------|----------|----------|
| 1 (发现) | {keyword groups} | {n} | {n} | {n} |
| 2 | {new queries} | {n} | {n} | {n} |
| ... | ... | ... | ... | ... |
| {final} | {queries} | {n} | {n} | {n} |

**终止原因:** {收敛 (< 3个新前缀) / 达到最大轮次 / 部分失败}
```

## Keyword Triggers

- `"aosp export"`, `"aosp feature export"`, `"功能元导出"`, `"feature export"`

## Configuration

- Output directory: `.omc/aosp-exports/` (fixed)
- Max iteration rounds: 5
- Max total agent spawns: 15
- Convergence threshold: < 3 new second-level prefixes per round
- State mode: `aosp-feature-export`

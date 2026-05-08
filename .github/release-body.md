# oh-my-claudecode v4.13.5: add cursor-agent as, add narrow elementOrder

## Release Notes

Release with **2 new features**, **18 bug fixes**, **29 other changes** across **51 merged PRs**.

### Highlights

- **feat(team): add cursor-agent as 4th tmux worker type (executor-only)** (#2736)
- **feat(hud): add narrow elementOrder config for main-line ordering** (#2655)

### New Features

- **feat(team): add cursor-agent as 4th tmux worker type (executor-only)** (#2736)
- **feat(hud): add narrow elementOrder config for main-line ordering** (#2655)

### Bug Fixes

- **fix(hud): scope hud-stdin-cache.json to session to prevent cross-session corruption (v2)** (#2802)
- **fix(keyword-detector): prevent re-entry from pasted system-echo blocks** (#2795)
- **fix(shell): portable shebangs + POSIX /bin/sh fallback** (#2783)
- **fix: align .omc/skills persistence contract across ignore rules, setup, and docs** (#2787)
- **fix(cleanup-orphans): unref SIGKILL escalation timer to avoid 5s CLI hang** (#2774)
- **fix: preserve weekly HUD quotas when stdin rate limits are present** (#2751)
- **fix: avoid wait-pane blocking on transient usage API 429s** (#2746)
- **fix(keyword-detector): stop false-positive autopilot on "autonomous"** (#2739)
- **fix(installer): Copy hooks lib modules during update** (#2728)
- **fix(hooks, windows): pass shell:true to plugin-patterns npm/npx spawns** (#2722)
- **fix: stop OMX ralplan/team follow-ups from re-entering planning** (#2718)
- **fix(installer): reject cache-repair roots that escape plugins/cache** (#2706)
- **fix(agents): replace scanner-bait commit placeholders** (#2682)
- **fix(team): close #2659 with the clean prompt tag sanitizer diff** (#2673)
- **fix(notifications): close #2660 with the clean tmux-tail diff** (#2674)
- **fix(hooks): ignore workflow keywords inside delegated ask prompts** (#2672)
- **fix: escape pipe characters in markdown table cells** (#2670)
- **fix: align persistent stop hook and tighten agent output contracts** (#2653)

### Documentation

- **docs: fix broken /docs/concepts link in Getting Started** (#2796)
- **docs: add Discord link to navigation in all README translations** (#2696)

### Other Changes

- **Make native team cleanup fail closed** (#2803)
- **Guard write/edit success envelopes in post-tool verifier** (#2793)
- **Fix outdated Codex/Gemini team worker launch contracts** (#2791)
- **Clarify bundled agent effort inheritance** (#2788)
- **Preserve provider routing guidance across SessionStart hooks** (#2780)
- **Centralize ultrawork protocol routing** (#2761)
- **Reduce prompt token melting at hook ingress** (#2778)
- **Make learned custom skills visible to Claude Code** (#2775)
- **Fix broken published docs links** (#2766)
- **Prevent project-memory hook noise from object tool results** (#2760)
- **Keep deep-interview summary gating on AskUserQuestion path** (#2756)
- **Fix Windows Claude CLI .cmd launch detection** (#2753)
- **Fix Codex MCP config duplicate table sync** (#2749)
- **Fix Ralph cross-session cancel state resurrection** (#2744)
- **Release v4.13.1 - Cursor Support & Bug Fixes** (#2742)
- **Fix self-improve topic-scoped path resolution** (#2732)
- **Reland: autoresearch-as-a-skill migration (fixes conflicts vs #2716)** (#2727)
- **Fix deep-interview threshold on native skill path** (#2724)
- **Fix Windows HUD npm.cmd EINVAL fallback** (#2719)
- **Fix Windows tmux login-shell wrapping for issue #2711** (#2713)
- **Fix OMC state root resolution for nested working directories** (#2712)
- **Fix omc-teams multi-repo Codex handoff contract** (#2709)
- **Narrow company-context MCP interface to prompt-level contract** (#2694)
- **Fix ScheduleWakeup persistent-mode self-cancel on stop** (#2698)
- **Prefer stdin rate limits over cold-start HUD API fetches** (#2699)
- **Prevent HUD read spikes from inflating fallback context** (#2703)
- **Align built-in Opus HIGH default with Claude Opus 4.7** (#2685)
- **Fix MCP registry type round-trip for remote servers** (#2680)
- **Preserve Gemini team lanes when preflight path probing false-negatives** (#2676)

### Stats

- **51 PRs merged** | **2 new features** | **18 bug fixes** | **0 security/hardening improvements** | **29 other changes**

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.13.5
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.9.10...v4.13.5

## Contributors

Thank you to all contributors who made this release possible!

@50sotero @aryateja2106 @deepshwang @Gujiassh @hohoShin @hongsu @jiseongnoh @lifrary @milo417 @myro-june @shaun0927 @stefan-matic @wonhyo-e @Yeachan-Heo

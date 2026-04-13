# Scripts Inventory

This document maps the source and helper scripts under `scripts/` to their role in the OMC toolchain.
It focuses on three questions:

- what the script is for
- how it is usually triggered
- whether it mostly mutates repo files, `.omc` state, or external processes

Many `scripts/*.mjs` hook entrypoints are intentionally thin wrappers around logic in `dist/hooks/**`.
Those wrappers exist so Claude Code can invoke stable Node entrypoints from `hooks/hooks.json`.
Build scripts and manual utilities do more of their work directly.

## Trigger Surfaces

- `package.json` invokes build, docs, metadata, and release scripts.
- `hooks/hooks.json` invokes lifecycle hook entrypoints during `UserPromptSubmit`, `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, and related events.
- Several scripts are manual developer utilities, demos, QA harnesses, or shared helpers.

## TypeScript Maintenance and Regression Scripts

- `scripts/generate-featured-contributors.ts`: CLI wrapper around the featured contributors library. Used by `npm run sync-featured-contributors*` to refresh the README featured contributors block.
- `scripts/sync-metadata.ts`: Synchronizes package metadata, badges, version markers, doc counters, and featured contributors across docs. Used by `npm run sync-metadata*` and by the release flow.
- `scripts/release.ts`: Automates version bumps, changelog generation, release-body generation, lockfile refresh, and metadata sync. Used by `npm run release -- <patch|minor|major|X.Y.Z>`.
- `scripts/test-max-attempts.ts`: Manual regression script for todo continuation attempt counters and persistent-mode reset behavior.
- `scripts/test-remember-tags.ts`: Manual integration test for `<remember>` and `<remember priority>` parsing through the post-tool verifier hook.
- `scripts/test-notepad-integration.ts`: Comprehensive manual integration suite for the notepad subsystem using built `dist` outputs.
- `scripts/test-session-injection.ts`: Small smoke test for extracting `Priority Context` from `.omc/notepad.md` during session startup.
- `scripts/test-mutual-exclusion.ts`: Manual test that verifies Ralph Loop and UltraQA cannot be active at the same time.

## Build and Packaging Scripts

- `scripts/build-skill-bridge.mjs`: Bundles `src/hooks/learner/bridge.ts` into `dist/hooks/skill-bridge.cjs` so skill injection can reuse compiled discovery logic.
- `scripts/build-mcp-server.mjs`: Bundles the standalone MCP server into `bridge/mcp-server.cjs`, including runtime path bootstrapping for native dependencies.
- `scripts/build-bridge-entry.mjs`: Bundles the Team bridge entry into `bridge/team-bridge.cjs`.
- `scripts/build-runtime-cli.mjs`: Bundles the runtime CLI into `bridge/runtime-cli.cjs` with selected heavy or native dependencies externalized.
- `scripts/build-team-server.mjs`: Bundles the Team MCP runtime server into `bridge/team-mcp.cjs`.
- `scripts/build-cli.mjs`: Builds the main CLI entrypoints such as `bridge/cli.cjs` and team-facing CLI files.
- `scripts/compose-docs.mjs`: Synchronizes shared docs fragments from `docs/partials/` into `docs/shared/` as part of build and publish preparation.

## Setup, Install, and Maintenance Utilities

- `scripts/plugin-setup.mjs`: Performs post-install style setup for the Claude plugin, including HUD bootstrap, `settings.json` updates, optional local config writes, hook command normalization, and a fallback production dependency install when needed.
- `scripts/setup-init.mjs`: `SessionStart` hook wrapper for the `init` setup path. Delegates to compiled setup logic in `dist/hooks/setup`.
- `scripts/setup-maintenance.mjs`: `SessionStart` hook wrapper for the `maintenance` setup path. Delegates to compiled maintenance logic in `dist/hooks/setup`.
- `scripts/cleanup-orphans.mjs`: Finds and optionally kills orphaned team worker processes whose owning team config no longer exists. Used as an operational cleanup tool rather than a normal build step.

## Hook Entrypoints Triggered from `hooks/hooks.json`

### User Prompt Hooks

- `scripts/keyword-detector.mjs`: Detects magic keywords, activates or clears OMC modes, and injects execution guidance into the prompt context.
- `scripts/skill-injector.mjs`: Loads matching learned or custom skills from user and project locations and injects them into prompt context.

### Session Hooks

- `scripts/session-start.mjs`: Rehydrates persistent context at session start, including mode state, todos, notepad priority context, project memory summaries, and update notices.
- `scripts/project-memory-session.mjs`: Registers project memory context for the new session through the compiled project-memory hook.
- `scripts/session-end.mjs`: Session end wrapper that delegates cleanup and summary work to `dist/hooks/session-end`.
- `scripts/session-summary.mjs`: Standalone CLI utility that analyzes a transcript and caches a generated short summary label. Despite the name, it is not a Claude lifecycle hook.

### Tool Lifecycle Hooks

- `scripts/pre-tool-enforcer.mjs`: Pre-tool guard that injects reminders, routing rules, team or mode enforcement, and high-context safety checks before tool execution.
- `scripts/permission-handler.mjs`: Permission request wrapper, mainly for Bash auto-allow or auto-deny decisions.
- `scripts/post-tool-verifier.mjs`: Post-tool hook that tracks tool usage, captures `<remember>` tags into `.omc/notepad.md`, and emits follow-up guidance for failures or background tasks.
- `scripts/project-memory-posttool.mjs`: Learns project memory from tool inputs and outputs after successful tool execution.
- `scripts/post-tool-use-failure.mjs`: Records recent tool failures in `.omc/state/last-tool-error.json` so stop and continuation hooks can react.

### Subagent and Compaction Hooks

- `scripts/subagent-tracker.mjs`: Handles `SubagentStart` and `SubagentStop` tracking by delegating to compiled tracker logic.
- `scripts/verify-deliverables.mjs`: Advisory `SubagentStop` hook that checks expected deliverables, files, and patterns for the current team stage.
- `scripts/pre-compact.mjs`: Generic `PreCompact` hook wrapper for pre-compaction preservation work.
- `scripts/project-memory-precompact.mjs`: Project-memory specific `PreCompact` hook wrapper to preserve learned project memory before compaction.

### Stop Hooks and Stop-Related Compatibility

- `scripts/context-guard-stop.mjs`: Prevents a normal stop when transcript context usage is too high and a compaction step should happen first.
- `scripts/persistent-mode.mjs`: Implements the persistent-mode stop guard that keeps OMC modes running until their work is complete. The current shipped hook wiring references `scripts/persistent-mode.cjs`, but this file documents the same stop-guard role in the source tree.
- `scripts/code-simplifier.mjs`: Optional `Stop` hook that inspects modified source files and, when enabled, asks Claude to delegate cleanup to the `code-simplifier` agent.

### Legacy Compatibility Helpers

- `scripts/context-safety.mjs`: Legacy `PreToolUse` compatibility shim that currently just returns `continue` so older hook paths remain safe. It is kept for compatibility and is not part of the current active hook wiring in `hooks/hooks.json`.

## Manual Tools, Demos, and QA Harnesses

- `scripts/status.mjs`: Manual CLI for listing active `omc-team-*` tmux sessions and pane state.
- `scripts/demo-team.mjs`: Developer demo that launches a small sample Team runtime job.
- `scripts/openclaw-gateway-demo.mjs`: Reference local HTTP gateway that receives OpenClaw-style payloads and forwards them to a Clawdbot gateway.
- `scripts/eval-autoresearch-json.mjs`: Automation script that runs autoresearch test and build commands and emits a JSON score report.
- `scripts/eval-autoresearch-timed-json.mjs`: Timed variant of the autoresearch evaluator that includes duration-based scoring.
- `scripts/qa-tests/test-custom-integration.mjs`: Manual QA script that exercises custom notification webhook and CLI dispatch behavior against a local test server.

## Shared Helper Modules

- `scripts/lib/stdin.mjs`: Shared stdin reader with timeout protection so hook processes do not hang forever.
- `scripts/lib/atomic-write.mjs`: Shared helper for atomic file writes used by hook-side state management.

## Practical Reading Guide

- If you want to understand the published build artifacts, start with `build-*.mjs`, `compose-docs.mjs`, `sync-metadata.ts`, and `release.ts`.
- If you want to understand hook behavior at runtime, start with `hooks/hooks.json`, then read the corresponding `scripts/*.mjs` wrapper, and finally inspect the delegated `dist/hooks/**` implementation when the wrapper is thin.
- If you are debugging `.omc` state changes, focus on `session-start.mjs`, `keyword-detector.mjs`, `pre-tool-enforcer.mjs`, `post-tool-verifier.mjs`, `post-tool-use-failure.mjs`, `persistent-mode.mjs`, and the project-memory hook wrappers.

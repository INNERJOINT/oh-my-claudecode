#!/usr/bin/env bash
# lint-rca-sync.sh — Detect drift between jira-analyze and aosp-analyze shared sections
# Compares content between SYNC markers in both SKILL.md files after token normalization.

set -euo pipefail

JIRA_SKILL="skills/jira-analyze/SKILL.md"
AOSP_SKILL="skills/aosp-analyze/SKILL.md"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

drift_found=0

extract_section() {
  local file="$1"
  local section="$2"
  local in_section=0

  while IFS= read -r line; do
    if [[ "$line" == *"SYNC: skills/_shared/rca-pipeline.md#${section}"* ]]; then
      in_section=1
      continue
    fi
    if [[ $in_section -eq 1 && "$line" == *"/SYNC"* ]]; then
      in_section=0
      break
    fi
    if [[ $in_section -eq 1 ]]; then
      echo "$line"
    fi
  done < "$file"
}

normalize_tokens() {
  sed \
    -e 's/<KEY>/<ID>/g' \
    -e 's/<slug>/<ID>/g' \
    -e 's/\/tmp\/jira-analyze-/\/tmp\/<mode>-/g' \
    -e 's/\/tmp\/aosp-analyze-/\/tmp\/<mode>-/g' \
    -e 's/mode="jira-analyze"/mode="<MODE>"/g' \
    -e 's/mode="aosp-analyze"/mode="<MODE>"/g' \
    -e 's/for JIRA issue <ID>/for <MODE> analysis <ID>/g' \
    -e 's/for analysis <ID>/for <MODE> analysis <ID>/g' \
    -e 's/jira-analyze-{issue_key}/<mode>-<ID>/g' \
    -e 's/aosp-analyze-{slug}/<mode>-<ID>/g' \
    -e 's/{issue_key}/{id}/g' \
    -e 's/{slug}/{id}/g'
}

strip_mode_gates() {
  # Remove content between MODE-GATE markers (mode-specific sections)
  # Also remove lines that are clearly mode-specific patterns
  awk '
    /<!-- MODE-GATE:/ { skip=1; next }
    /<!-- \/MODE-GATE -->/ { skip=0; next }
    !skip { print }
  ' | sed \
    -e '/^{log-based mode:}$/d' \
    -e '/^{no-log mode:}$/d' \
    -e '/^\*\*Log-based mode.*:$/d' \
    -e '/^\*\*No-log mode.*:$/d' \
    -e '/^> \*\*Mode gate:\*\*/d'
}

sections=("phase-3" "phase-4" "phase-5" "phase-6")

for section in "${sections[@]}"; do
  jira_content=$(extract_section "$JIRA_SKILL" "$section")
  aosp_content=$(extract_section "$AOSP_SKILL" "$section")

  if [[ -z "$jira_content" ]]; then
    echo -e "${RED}ERROR: No SYNC section '$section' found in $JIRA_SKILL${NC}"
    drift_found=1
    continue
  fi

  if [[ -z "$aosp_content" ]]; then
    echo -e "${RED}ERROR: No SYNC section '$section' found in $AOSP_SKILL${NC}"
    drift_found=1
    continue
  fi

  jira_normalized=$(echo "$jira_content" | strip_mode_gates | normalize_tokens)
  aosp_normalized=$(echo "$aosp_content" | strip_mode_gates | normalize_tokens)

  diff_output=$(diff <(echo "$jira_normalized") <(echo "$aosp_normalized") || true)

  if [[ -n "$diff_output" ]]; then
    echo -e "${RED}DRIFT in section: $section${NC}"
    echo "$diff_output"
    echo "---"
    drift_found=1
  else
    echo -e "${GREEN}OK: $section${NC}"
  fi
done

if [[ $drift_found -eq 0 ]]; then
  echo -e "\n${GREEN}All shared sections are in sync.${NC}"
  exit 0
else
  echo -e "\n${RED}Drift detected. Sync the sections above.${NC}"
  exit 1
fi

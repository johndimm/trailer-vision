#!/usr/bin/env bash
# Run dual-mode taste tests (All channel vs channel hint) for LLM-generated profiles.
# Usage: ./scripts/taste-test-all.sh [base-url] [max-rounds] [count]

BASE=${1:-http://localhost:3000}
MAX=${2:-20}
COUNT=${3:-7}
SCRIPT="$(dirname "$0")/taste-test-all.ts"

exec npx tsx "$SCRIPT" "$BASE" "$MAX" "$COUNT"

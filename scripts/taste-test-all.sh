#!/usr/bin/env bash
# Run taste adaptation test for several categories until each converges.
# Usage: ./scripts/taste-test-all.sh [base-url] [max-rounds]

BASE=${1:-http://localhost:3000}
MAX=${2:-20}
SCRIPT="$(dirname "$0")/taste-test.ts"

echo "Taste adaptation tests (server: ${BASE}, max ${MAX} rounds each)"
echo ""

for category in "crime thriller" "animated family" "romantic comedy" "horror" "science fiction" "bollywood" "persian cinema"; do
  npx tsx "$SCRIPT" "$category" "$BASE" "$MAX"
  echo ""
done

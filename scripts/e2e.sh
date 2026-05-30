#!/usr/bin/env bash
# TB-13 e2e smoke entry point.
#
# Thin wrapper around scripts/e2e.ts. We honour the spec literal
# `scripts/e2e.sh` while keeping the real logic in TypeScript where it can
# import the app's own modules and produce clear failure messages.
#
# Sets up:
#   - tmpdir + tmp DB path so the e2e never touches the local working DB
#   - trap so the tmpdir is cleaned up even on failure
#   - propagates child exit code via `set -e`

set -euo pipefail

TMP_DIR=$(mktemp -d -t startup-leads-e2e-XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT
export STARTUP_LEADS_DB="$TMP_DIR/e2e.db"

bun run scripts/e2e.ts "$@"

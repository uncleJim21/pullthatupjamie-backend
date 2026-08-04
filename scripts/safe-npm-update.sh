#!/usr/bin/env bash
#
# Credential-safe npm install/update.
#
# Threat model: the Shai-Hulud npm worm ships its payload in a `preinstall` hook
# and, on execution, reads .env files, SSH keys, npm tokens, and cloud creds from
# the developer machine, then self-propagates. This repo keeps .env and
# .l402-creds in the working directory, so an executed install script is an
# immediate credential compromise.
#
# Defense, in order of how much it actually buys us:
#   1. --ignore-scripts     — the payload never executes at all
#   2. min-release-age      — (.npmrc) malicious versions are never resolved
#   3. lockfile diff review — human eyes on what actually changed
#   4. targeted rebuild     — only our 4 known native deps get to run scripts
#
# Usage:
#   scripts/safe-npm-update.sh              # install from lockfile
#   scripts/safe-npm-update.sh update       # update within semver ranges
#   scripts/safe-npm-update.sh add <pkg>    # add a new dependency

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Native deps that legitimately need build scripts. Anything NOT on this list
# never gets to execute code during an install.
TRUSTED_SCRIPT_PKGS=(canvas sharp secp256k1)

MODE="${1:-install}"
shift || true

echo "==> Verifying the quarantine window is in effect"
node scripts/check-npm-hardening.js

echo "==> Snapshotting lockfile"
cp package-lock.json /tmp/package-lock.before.json

# Run npm with a scrubbed environment. Even though --ignore-scripts should stop
# execution, we don't hand the process our secrets as a second line of defense.
# PATH/HOME/registry auth-free env only.
run_npm() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    npm "$@" --ignore-scripts --legacy-peer-deps
}

echo "==> Resolving dependencies (scripts disabled)"
case "$MODE" in
  install) run_npm ci ;;
  update)  run_npm update ;;
  add)     run_npm install "$@" ;;
  *) echo "!! Unknown mode: $MODE" >&2; exit 1 ;;
esac

echo "==> Scanning installed tree for known worm indicators"
FOUND=0
if find node_modules -name "setup.mjs" -o -name "math_init.js" | grep -q .; then
  echo "!! DROPPER FILE FOUND — do not proceed, treat machine as compromised" >&2
  find node_modules -name "setup.mjs" -o -name "math_init.js" >&2
  FOUND=1
fi
if grep -rl "npm-cache\.com\|IfYouBlockThisAPIKey\|0xE1f2395ee43e45A1556EC6438a88c31B83493103" \
     node_modules --include="*.js" --include="*.mjs" --include="*.json" 2>/dev/null | grep -q .; then
  echo "!! C2 INDICATOR FOUND — do not proceed" >&2
  FOUND=1
fi
if [[ "$FOUND" -ne 0 ]]; then
  echo "!! Restoring lockfile and aborting." >&2
  cp /tmp/package-lock.before.json package-lock.json
  exit 2
fi
echo "    no indicators found"

echo "==> Checking for newly introduced install hooks"
UNTRUSTED=$(grep -l '"preinstall"\|"postinstall"\|"install"' \
  node_modules/*/package.json node_modules/@*/*/package.json 2>/dev/null \
  | sed -E 's|node_modules/(.*)/package.json|\1|' \
  | grep -vxF "$(printf '%s\n' "${TRUSTED_SCRIPT_PKGS[@]}")" || true)
if [[ -n "$UNTRUSTED" ]]; then
  echo "!! Packages with install scripts outside the trusted list:" >&2
  echo "$UNTRUSTED" >&2
  echo "!! Review these before running the rebuild step." >&2
fi

echo "==> Lockfile changes"
diff <(grep -o '"node_modules/[^"]*"' /tmp/package-lock.before.json | sort -u) \
     <(grep -o '"node_modules/[^"]*"' package-lock.json | sort -u) \
     || true

echo "==> Audit"
npm audit --audit-level=high || true

cat <<'EOF'

Dependencies are installed with all lifecycle scripts blocked.
Review the lockfile diff above, then build the native deps explicitly:

    npm rebuild canvas sharp secp256k1

EOF

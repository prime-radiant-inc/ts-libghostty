#!/usr/bin/env bash
# Pack the current package into a tarball, install it into a throwaway
# directory, and run a minimal import-and-use script. Exits non-zero on any
# failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ensure dist/ exists (the tarball relies on dist/ being built).
bun run build:ts

# Ensure tarball output directory exists.
mkdir -p "$ROOT/.tmp"

# Pack. Resolve the resulting tarball path relative to $ROOT, then make it
# absolute before using it as `file:` in the downstream package.json.
PACK_OUTPUT=$(bun pm pack --destination "$ROOT/.tmp" 2>&1)
REL=$(echo "$PACK_OUTPUT" | tail -n 1 | awk '{print $NF}')
if [ -z "${REL:-}" ] || [ ! -f "$REL" ]; then
  # Fallback — `bun pm pack` output format may vary. Find the most-recently-
  # created .tgz in .tmp/.
  REL=$(ls -1t "$ROOT/.tmp"/*.tgz 2>/dev/null | head -n 1)
fi
if [ -z "${REL:-}" ] || [ ! -f "$REL" ]; then
  echo "bun pm pack did not produce a tarball" >&2
  echo "$PACK_OUTPUT" >&2
  exit 1
fi
TGZ=$(cd "$(dirname "$REL")" && pwd)/$(basename "$REL")
echo "packed: $TGZ"

# Install into a temp project outside the repo.
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
cd "$TMP"

cat > package.json <<EOF
{
  "name": "tarball-smoke",
  "type": "module",
  "dependencies": {
    "ts-libghostty": "file:$TGZ"
  }
}
EOF

bun install --silent

cat > run.ts <<'EOF'
import { Terminal, Formatter } from "ts-libghostty";

using term = new Terminal({ cols: 10, rows: 3 });
term.vtWrite(new TextEncoder().encode("hi"));
using fmt = new Formatter({ format: "plain" });
const s = fmt.formatString(term);
if (!s.includes("hi")) {
  console.error("expected 'hi' in output, got:", JSON.stringify(s));
  process.exit(1);
}
console.log("OK");
EOF

bun run.ts

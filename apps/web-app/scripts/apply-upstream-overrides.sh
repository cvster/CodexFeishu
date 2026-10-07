#!/usr/bin/env bash
set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="$workspace/upstream-overrides/claudecodeui-1.25.2"
target_root="${MOBILE_CODEX_UPSTREAM_DIR:-$workspace/vendor/claudecodeui-1.25.2}"

if [[ ! -d "$source_root" ]]; then
  echo "Override source not found: $source_root" >&2
  exit 1
fi

if [[ ! -d "$target_root" ]]; then
  echo "Upstream checkout not found: $target_root" >&2
  exit 1
fi

copied=0
if [[ ! -f "$source_root/server/codex-core/index.js" ]]; then
  echo "Shared Codex core is not prepared. Run pnpm build from the monorepo root before applying web overrides." >&2
  exit 1
fi
if [[ ! -f "$source_root/shared/codex-core-models.js" ]]; then
  echo "Shared model module is not prepared. Run pnpm build from the monorepo root." >&2
  exit 1
fi
while IFS= read -r -d '' source_file; do
  relative_path="${source_file#"$source_root"/}"
  destination="$target_root/$relative_path"
  install -D -m 0644 "$source_file" "$destination"
  copied=$((copied + 1))
done < <(find "$source_root" -type f -print0)

echo "Applied $copied override files to $target_root"

#!/bin/sh
# Dependency-free check: every third-party GitHub Action `uses:` must be pinned to
# a full 40-character commit SHA with a trailing `# vX.Y.Z` version comment.
# Local (`./` or `../`) uses are exempt.
set -eu

status=0
found=0

for f in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -e "$f" ] || continue
  found=1
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    case "$line" in
      *uses:*) : ;;
      *) continue ;;
    esac

    # Value after 'uses:'
    val=${line#*uses:}
    val=$(printf '%s' "$val" | sed 's/^[[:space:]]*//; s/^["'\'']//; s/["'\'']//g')

    # First whitespace-delimited token is the action reference.
    target=$(printf '%s' "$val" | awk '{print $1}')
    [ -n "$target" ] || continue

    # Local action references are exempt.
    case "$target" in
      ./* | ../*) continue ;;
    esac

    sha=$(printf '%s' "$target" | sed -n 's/.*@\([0-9a-fA-F]\{40\}\)$/\1/p')
    if [ -z "$sha" ]; then
      printf '✖ %s:%s not pinned to a 40-char commit SHA: %s\n' "$f" "$lineno" "$target" >&2
      status=1
      continue
    fi

    case "$val" in
      *"#"*v[0-9]*) : ;;
      *)
        printf '✖ %s:%s missing trailing version comment (# vX.Y.Z): %s\n' "$f" "$lineno" "$val" >&2
        status=1
        ;;
    esac
  done <"$f"
done

if [ "$found" -eq 0 ]; then
  echo "No workflow files found; nothing to check."
  exit 0
fi

if [ "$status" -eq 0 ]; then
  echo "✓ All third-party actions are SHA-pinned with version comments."
fi
exit "$status"

#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:-}"
tag_name="${GITHUB_REF_NAME:-}"

if [[ -z "$archive_path" ]]; then
  echo "::error::Usage: $0 <archive-path>"
  exit 1
fi

if [[ -z "$tag_name" ]]; then
  echo "::error::Missing GITHUB_REF_NAME."
  exit 1
fi

if [[ ! -f "$archive_path" ]]; then
  echo "::error::Release archive not found: ${archive_path}"
  exit 1
fi

if ! gh release view "$tag_name" >/dev/null 2>&1; then
  if ! gh release create "$tag_name" --title "$tag_name" --generate-notes; then
    echo "Release ${tag_name} may have been created by a parallel workflow; continuing."
  fi
fi

for _ in 1 2 3 4 5; do
  if gh release view "$tag_name" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! gh release view "$tag_name" >/dev/null 2>&1; then
  echo "::error::GitHub release is not discoverable for tag ${tag_name}."
  exit 1
fi

gh release upload "$tag_name" "$archive_path" --clobber

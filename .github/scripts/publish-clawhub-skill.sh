#!/usr/bin/env bash
set -euo pipefail

skill_dir="${1:-}"
skill_slug="${2:-}"
version="${3:-${GITHUB_REF_NAME:-}}"
version="${version#v}"

clawhub_cli_version="${CLAWHUB_CLI_VERSION:-0.18.0}"
clawhub_package="clawhub@${clawhub_cli_version}"
skill_file="${skill_dir}/SKILL.md"

if [[ -z "$skill_dir" ]]; then
  echo "::error::Usage: $0 <skill-dir> <skill-slug> [version]"
  exit 1
fi

if [[ -z "$skill_slug" ]]; then
  echo "::error::Missing skill slug. Usage: $0 <skill-dir> <skill-slug> [version]"
  exit 1
fi

if [[ -z "${CLAWHUB_TOKEN:-}" ]]; then
  echo "::error::Missing CLAWHUB_TOKEN. Add it as a repository secret before publishing to ClawHub."
  exit 1
fi

if [[ -z "$version" ]]; then
  echo "::error::Missing skill version. Use a vX.Y.Z tag or pass a version explicitly."
  exit 1
fi

if [[ ! -d "$skill_dir" ]]; then
  echo "::error::Skill directory not found: ${skill_dir}"
  exit 1
fi

if [[ ! -f "$skill_file" ]]; then
  echo "::error::SKILL.md not found: ${skill_file}"
  exit 1
fi

skill_name="$(
  awk '
    /^---[[:space:]]*$/ {
      in_frontmatter = !in_frontmatter
      next
    }
    in_frontmatter && /^name:[[:space:]]*/ {
      sub(/^name:[[:space:]]*/, "")
      print
      exit
    }
  ' "$skill_file"
)"

skill_name="${skill_name%\"}"
skill_name="${skill_name#\"}"
skill_name="${skill_name%\'}"
skill_name="${skill_name#\'}"

export CLAWHUB_CONFIG_PATH="${CLAWHUB_CONFIG_PATH:-${RUNNER_TEMP:-/tmp}/clawhub/config.json}"

npx -y "$clawhub_package" --no-input login --token "$CLAWHUB_TOKEN" --no-browser

publish_args=(
  --no-input
  skill publish "$skill_dir"
  --slug "$skill_slug"
  --version "$version"
  --changelog "${CLAWHUB_CHANGELOG:-Release ${GITHUB_REF_NAME:-$version}}"
)

if [[ -n "$skill_name" ]]; then
  publish_args+=(--name "$skill_name")
fi

if [[ -n "${CLAWHUB_OWNER:-}" ]]; then
  publish_args+=(--owner "${CLAWHUB_OWNER#@}")
fi

if [[ -n "${CLAWHUB_TAGS:-}" ]]; then
  publish_args+=(--tags "$CLAWHUB_TAGS")
fi

if [[ -n "${CLAWHUB_CLAWSCAN_NOTE:-}" ]]; then
  publish_args+=(--clawscan-note "$CLAWHUB_CLAWSCAN_NOTE")
fi

npx -y "$clawhub_package" "${publish_args[@]}"

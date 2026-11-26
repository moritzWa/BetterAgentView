#!/usr/bin/env bash
set -euo pipefail

classifier=$(cd "$(dirname "$0")" && pwd)/ci-docs-only.sh
repo=$(mktemp -d)
trap 'rm -rf -- "$repo"' EXIT
cd "$repo"
git init -q
git config user.name CI
git config user.email ci@example.invalid
git commit -qm base --allow-empty
base=$(git rev-parse HEAD)

add_file() {
  mkdir -p "$(dirname "$1")"
  printf 'change\n' > "$1"
  git add -- "$1"
  git commit -qm "add $1"
}

expect_full_ci() {
  if bash "$classifier" "$1" HEAD 2>/dev/null; then
    echo "Expected full CI for $1..HEAD" >&2
    exit 1
  fi
}

add_file CHANGELOG.md
add_file site/nested/pixel.png
bash "$classifier" "$base" HEAD
expect_full_ci missing-base

for path in README.md LICENSE docs/SETUP-PROMPT.md Cargo.lock tests/fixture.md \
  src/example.rs bridge/package-lock.json scripts/package-release.sh .github/workflows/ci.yml; do
  before=$(git rev-parse HEAD)
  add_file "$path"
  expect_full_ci "$before"
  expect_full_ci "$base" # Mixed changes across multiple commits still run Rust.
done

before=$(git rev-parse HEAD)
git mv -- src/example.rs site/example.rs
git commit -qm 'move source into site'
expect_full_ci "$before"

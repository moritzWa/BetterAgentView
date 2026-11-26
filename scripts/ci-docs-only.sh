#!/usr/bin/env bash
# Success permits skipping Rust CI. Unknown paths or unavailable history run everything.
set -euo pipefail

base=$(git rev-parse --verify "${1:?base commit required}^{commit}")
head=$(git rev-parse --verify "${2:?head commit required}^{commit}")

# Compare both sides of renames. Paths used by Rust, installer or packaging
# tests (including README.md, LICENSE and docs/SETUP-PROMPT.md) are not excluded.
# The Node checks still run for the static site.
git diff --quiet --no-ext-diff --no-renames --ignore-submodules=none "$base" "$head" -- . \
  ':(exclude,top,literal)CHANGELOG.md' \
  ':(exclude,top,literal)CONTRIBUTING.md' \
  ':(exclude,top,literal)SECURITY.md' \
  ':(exclude,top,glob)site/**'

#!/usr/bin/env bash
#
# Republishes the gh-pages branch as a single orphan commit.
#
#   publish-pages.sh dev <src-dir>   replace gh-pages:/dev/ with <src-dir>
#   publish-pages.sh promote         copy gh-pages:/dev/ over the gh-pages ROOT
#
# sloppyCAN has no build step, so "the artifact" is just the checkout. Promotion
# still copies the already-published /dev/ bytes rather than re-copying from the
# branch, so it stays byte-for-byte what you approved on dev - same rule as
# carlito, and it keeps the two promote rituals identical.
#
# Stable lives at the gh-pages ROOT, not in a stable/ subdirectory (this is the
# one place this script differs from carlito's). carlito needs sibling dirs under
# a redirect page because its PWA service worker's scope would otherwise nest and
# intercept the other channel; sloppyCAN ships no service worker, so there is no
# scope to nest and stable can keep the root URL already published in its README.
#
# gh-pages is ALWAYS rewritten as one orphan commit and force-pushed: nothing in
# that history is worth keeping, the source history lives on dev/main, and every
# published copy is reproducible from it.
#
# Both callers hold the same `concurrency: gh-pages` group, because two
# force-pushes racing here would silently drop one channel's update.
#
# Requires GITHUB_TOKEN, GITHUB_REPOSITORY, and SITE_SHA (the commit the published
# bytes came from) in the environment. SITE_SHA is passed explicitly rather than
# read from GITHUB_SHA: on a workflow_dispatch that is the ref the run was
# dispatched from, which is not necessarily the tip of dev being promoted.
set -euo pipefail

MODE="${1:-}"
: "${SITE_SHA:?SITE_SHA must name the commit these bytes came from}"

# Validate arguments before cloning gh-pages.
case "$MODE" in
  dev)
    SRC="$(cd "${2:?usage: publish-pages.sh dev <src-dir>}" && pwd)"
    [ -f "$SRC/index.html" ] || { echo "no index.html in $SRC - nothing to publish"; exit 1; }
    ;;
  promote) ;;
  *) echo "usage: publish-pages.sh dev <src-dir> | promote"; exit 1 ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
WORK="$(mktemp -d)"
GHP="$WORK/ghp"

# Shallow clone of the branch as it stands, so the channel we are NOT touching
# survives the rewrite. On the very first publish the branch does not exist yet.
if [ -n "$(git ls-remote --heads "$REMOTE" gh-pages)" ]; then
  git clone --quiet --depth 1 --branch gh-pages "$REMOTE" "$GHP"
else
  echo "gh-pages does not exist yet - starting from an empty tree"
  mkdir -p "$GHP"
  git -C "$GHP" init --quiet
  git -C "$GHP" remote add origin "$REMOTE"
fi

if [ "$MODE" = dev ]; then
  # Replace, never merge: a file deleted on dev must disappear from the channel.
  rm -rf "$GHP/dev"
  mkdir -p "$GHP/dev"
  cp -r "$SRC/." "$GHP/dev/"
  MSG="deploy dev @ ${SITE_SHA}"
else
  [ -f "$GHP/dev/index.html" ] || { echo "gh-pages:/dev/ is empty - push to dev and let CI publish before promoting"; exit 1; }
  # Clear the root but keep .git and the dev channel, then copy dev over it.
  find "$GHP" -mindepth 1 -maxdepth 1 \
    -not -name .git -not -name dev -exec rm -rf {} +
  cp -r "$GHP/dev/." "$GHP/"
  # dev/ is copied INTO the root, so a nested dev/dev/ appears; drop it.
  rm -rf "$GHP/dev/dev"
  MSG="promote dev -> stable @ ${SITE_SHA}"
fi

# .nojekyll comes from the repo every time, so gh-pages never becomes the source
# of truth for it. (Jekyll would eat any `_`-prefixed path.)
cp -r "$REPO_ROOT/.github/pages-root/." "$GHP/"

cd "$GHP"
git checkout --quiet --orphan deploy
git add -A
git -c user.name='sloppycan-ci' -c user.email='sloppycan-ci@users.noreply.github.com' \
    commit --quiet -m "$MSG"
git push --force --quiet origin deploy:gh-pages
echo "published: $MSG"

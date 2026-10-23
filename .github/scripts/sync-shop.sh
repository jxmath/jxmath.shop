#!/usr/bin/env bash
set -euo pipefail

SHOP_URL="${SHOP_URL:-https://github.com/jxmath/jxmath.shop.git}"
SHOP_BRANCH="${SHOP_BRANCH:-main}"
KEEP=(CNAME .github)

git remote remove shop 2>/dev/null || true
git remote add shop "$SHOP_URL"

if ! git fetch --no-tags shop "$SHOP_BRANCH" 2>/dev/null; then
  echo "nothing to sync: jxmath.shop has no $SHOP_BRANCH yet"
  exit 0
fi

SRC=$(git rev-parse FETCH_HEAD)
LAST=$(git log --format=%B --grep='^Synced-From: ' -n 1 | sed -n 's/^Synced-From: //p' | head -n 1 || true)

if [ "$LAST" = "$SRC" ]; then
  echo "already up to date at $SRC"
  exit 0
fi

if [ -n "$LAST" ] && git cat-file -e "$LAST^{commit}" 2>/dev/null && git merge-base --is-ancestor "$LAST" "$SRC"; then
  RANGE="$LAST..$SRC"
else
  RANGE="$SRC"
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

COUNT=0
for C in $(git rev-list --reverse --topo-order $RANGE); do
  git read-tree -u --reset "$C"
  for k in "${KEEP[@]}"; do
    git rm -rq --cached --ignore-unmatch -- "$k"
    rm -rf -- "$k"
  done
  OLDHEAD=$(git rev-parse HEAD)
  for k in "${KEEP[@]}"; do
    if git cat-file -e "$OLDHEAD:$k" 2>/dev/null; then
      git checkout "$OLDHEAD" -- "$k"
    fi
  done
  for k in "${KEEP[@]}"; do
    if ! git cat-file -e "$OLDHEAD:$k" 2>/dev/null; then
      git rm -rq --cached --ignore-unmatch -- "$k"
      rm -rf -- "$k"
    fi
  done
  if git diff --cached --quiet; then
    continue
  fi
  MSG=$(mktemp)
  { git log -1 --format=%B "$C"; echo; echo "Synced-From: $C"; } > "$MSG"
  GIT_AUTHOR_NAME=$(git log -1 --format=%an "$C") \
  GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae "$C") \
  GIT_AUTHOR_DATE=$(git log -1 --format=%aI "$C") \
  git commit -q -F "$MSG"
  rm -f "$MSG"
  COUNT=$((COUNT + 1))
done

echo "replayed $COUNT commit(s)"
if [ "$COUNT" -gt 0 ]; then
  git push origin HEAD:"$(git rev-parse --abbrev-ref HEAD | sed 's/^HEAD$/main/')"
  echo "pushed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
fi

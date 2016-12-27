#!/bin/sh

if [[ -n `git status --porcelain --ignore-submodules=dirty 2> /dev/null | tail -n1` ]]; then
  echo "Working directory is unclean!"
  exit 1
fi

ZIPS=`ls *.zip`

if [[ `echo "$ZIPS" | wc -l` -ne 1 ]]; then
  echo "Looks like there is not exactly one zip in this directory!"
  exit 1
fi

echo "Checking status..."
LOCAL=`echo "$ZIPS" | sed 's/tc39-test262-\(.*\).zip/\1/'`
REMOTE=`curl --silent https://api.github.com/repos/tc39/test262/git/refs/heads/master | grep '"sha"' | cut -d\" -f4 | cut -c1-7`
echo Local commit: $LOCAL
echo Remote commit: $REMOTE
if [[ "$LOCAL" == "$REMOTE" ]]; then
  echo "Up to date; nothing to do."
  exit 0
fi

echo "Rolling..."
git rm $ZIPS

curl -L -J -O https://api.github.com/repos/tc39/test262/zipball
ZIPS=`ls *.zip`
if [[ `echo "$ZIPS" | wc -l` -ne 1 ]]; then
  echo "Something's wrong - after fetching there is not exactly one .zip."
  exit 1
fi

sed -e "s/^\(The hosted copy was last updated on \).*\./\1`date +"%d %B, %Y"`./" README.md > README.md-new
mv README.md-new README.md # Why not just use -i, you ask? Because the macOS version's -i is incompatible with the GNU version's -i. Grr.
sed -e "s/$LOCAL/$REMOTE/" main.js > main.js-new
mv main.js-new main.js
git add "$ZIPS" README.md main.js
git commit -m "Roll test262: $REMOTE"

echo "Committed!"

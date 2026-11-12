#!/usr/bin/env bash
set -euo pipefail
stage=$(realpath -e "${1:?usage: view/build.sh STAGE}")
cd "$stage/view"
"${ASTRA_BUN_BINARY:-$HOME/.bun/bin/bun}" install --frozen-lockfile --production --ignore-scripts --backend=copyfile

for launcher in step poll; do
  "$stage/view/$launcher" --help > /dev/null || { echo "view/build.sh: view/$launcher didn't run the stage's $launcher" >&2; exit 1; }
done

found=0
kept=$(grep -rlF "$stage" "$stage") || found=$?
if [ "$found" -ne 1 ]; then
  echo "view/build.sh: a file in the stage names the stage's path, so it would break once moved into place:" \
    "${kept:-grep could not read $stage}" >&2
  exit 1
fi
linked=$(find "$stage" -type l -lname "$stage*")
if [ -n "$linked" ]; then
  echo "view/build.sh: a symbolic link in the stage points into the stage's path, so it would break once moved into place: $linked" >&2
  exit 1
fi
echo "view/build.sh: $stage/view installs from bun.lock, and its launchers run the stage's steps and poll"

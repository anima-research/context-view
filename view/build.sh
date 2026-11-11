#!/usr/bin/env bash
# view/build.sh STAGE: builds the view's environment into a release being staged, STAGE being the release's root, a copy
# of this repository at the commit being promoted. It syncs STAGE/view/.venv from uv.lock as it stands, with the view
# itself installed rather than linked, then imports each module the view's steps run with the stage's own interpreter,
# so a release that can't run the view stops here, before anything switches to it. No .py or .pth file in the
# environment may name STAGE's path, which it checks. The console scripts, activate and the install's own metadata name
# it, and so does the bytecode the import check below writes; the view runs none of the first three, and Python takes
# a compiled module's file name from where it loads it, so the release can be moved after it's built.
set -euo pipefail
stage=$(realpath -e "${1:?usage: view/build.sh STAGE}")
cd "$stage/view"

# Only the two packages that can't come from a wheel are built: review-workflow, pinned to a commit, and the view itself.
# Every package from the index must install from one of its wheels, as a host's UV_NO_BUILD=1 asks of all the rest.
listed=$(python3 -c '
import tomllib
with open("uv.lock", "rb") as f:
    for p in tomllib.load(f)["package"]:
        if "registry" in p.get("source", {}):
            print("--no-build-package=" + p["name"])
')
[ -n "$listed" ] || { echo "view/build.sh: uv.lock names no package from the index, so there's nothing to hold to its wheels" >&2; exit 1; }
mapfile -t wheels_only <<< "$listed"
UV_NO_BUILD=0 UV_PROJECT_ENVIRONMENT="$stage/view/.venv" uv sync --locked --no-editable --no-dev "${wheels_only[@]}"

found=0
kept=$(grep -rlF --include='*.py' --include='*.pth' "$stage" "$stage/view/.venv") || found=$?
if [ "$found" -ne 1 ]; then
  echo "view/build.sh: the environment's code names the stage's path, so it would break once moved into place:" \
    "${kept:-grep could not read $stage/view/.venv}" >&2
  exit 1
fi
"$stage/view/.venv/bin/python" -I -c '
import poll, pr_review, view, view_reach, view_read, view_usage, view_words
outside = [m.__name__ for m in (poll, pr_review, view, view_reach, view_read, view_usage, view_words) if "/site-packages/" not in m.__file__]
assert not outside, f"imported from outside the environment: {outside}"'
echo "view/build.sh: $stage/view/.venv imports view, view_reach, view_read, view_usage, view_words, poll and pr_review from its own site-packages"
for launcher in step poll; do
  "$stage/view/$launcher" --help > /dev/null || { echo "view/build.sh: view/$launcher didn't run the stage's $launcher" >&2; exit 1; }
done

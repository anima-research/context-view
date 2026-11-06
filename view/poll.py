#!/usr/bin/env python3
"""The context view's poll, a Jobs job's condition: it prints at most one line, {"key", "args"}, for the head of an open
pull request that has waited longest for its view, while no view's run is unsettled. Exit 0 with a line, 1 with none, 2
on a failure, said on stderr."""
import argparse, contextlib, fcntl, json, os, subprocess, sys, traceback

import pr_poll
import pr_review
import pr_run
from pr_run import Failed, need

import view

STATE = os.path.expanduser('~/.local/state/context-view')
WORKFLOWS = os.path.expanduser('~/.local/bin/astra-workflows')


def state_path():
    return os.path.join(STATE, 'poll.json')


@contextlib.contextmanager
def locked():
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, 'poll.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = state_path()
        if os.path.exists(path):
            state = pr_run.read_json(path)
        else:
            state = {'seq': 0, 'line': None, 'waiting': {}, 'seen': [], 'repos': {}, 'known': [], 'tokens': {}}
        yield state
        pr_run.write_json(path, state)


def heads(name, token, seen):
    """The heads of the repository's open pull requests, drafts marked, from a listing its ETag keeps."""
    pulls, tag = pr_poll.every(f'/repos/{name}/pulls?state=open&per_page={pr_poll.PER_PAGE}', token=token, tag=seen.get('tag'))
    if pulls is not None:
        seen['heads'] = [{'number': p['number'], 'head': p['head']['sha'], 'draft': bool(p.get('draft'))} for p in pulls]
        seen['tag'] = tag
    return seen.get('heads', [])


def runs():
    """Every view's run the workflows store still holds, by key, in one listing however many heads wait."""
    p = subprocess.run([WORKFLOWS, 'runs', '--key-prefix', view.KEY], capture_output=True, text=True)
    need(p.returncode == 0, f"astra-workflows runs couldn't list the views' runs: {(p.stderr or p.stdout).strip()[:300]}")
    return {r['key']: r for r in (json.loads(l) for l in p.stdout.splitlines() if l.strip())}


def pull_of(key):
    return key.rsplit('@', 1)[0]


def repo_of(key):
    return key[len(view.KEY):].split('#', 1)[0]


def look(state, taken, at):
    """At most one line, for the head that has waited longest for its view, while no view's run is unsettled when the
    pass lists them; it isn't a lock across Jobs' start, so a view started by hand meanwhile can run beside it. A head
    in `seen` is never run. It holds two kinds of head, each only while its pull request stays open: those of the pull
    requests open the first time the poll ever sees their repository, so such a pull request gets its first view at its
    next push, and each head whose view has run, kept since the workflows store clears a settled run a week after it
    settles. A pull request a pass finds closed leaves `seen`, so if it reopens, its head gets a view, unless the
    workflows store still holds a run of that head's view."""
    state['seq'] = max(state['seq'], taken)
    if state['line'] and state['line']['seq'] <= taken:
        state['line'] = None
    cfg = pr_review.app()
    jwt = pr_review.app_jwt(cfg)
    installations, _ = pr_poll.every(f'/app/installations?per_page={pr_poll.PER_PAGE}', bearer=jwt)
    waiting, pulls, looked, first = {}, set(), set(), set()
    for inst in installations:
        if inst['account']['id'] not in pr_review.ACCOUNTS:
            continue
        token = pr_poll.token_of(state, inst['id'], jwt)
        repos, _ = pr_poll.every(f'/installation/repositories?per_page={pr_poll.PER_PAGE}', token=token, field='repositories')
        for repo in repos:
            if repo['id'] not in view.VIEWED or repo.get('archived') or repo.get('disabled') or str(repo['id']) in looked:
                continue
            looked.add(str(repo['id']))
            new = str(repo['id']) not in state['known']
            for h in heads(repo['full_name'], token, state['repos'].setdefault(str(repo['id']), {})):
                key = view.key_of(repo['id'], h['number'], h['head'])
                pulls.add(pull_of(key))
                if new:
                    first.add(key)
                if not h.get('draft'):
                    waiting[key] = {'repo': repo['full_name'], 'number': h['number'], 'head': h['head']}
    state['repos'] = {rid: seen for rid, seen in state['repos'].items() if rid in looked}
    state['known'] = sorted(set(state['known']) | looked)
    held = runs()
    state['seen'] = sorted(k for k in set(state['seen']) | first | set(held) if pull_of(k) in pulls or repo_of(k) not in looked)
    state['waiting'] = {**{key: t for key, t in state['waiting'].items() if repo_of(key) not in looked},
                        **{key: state['waiting'].get(key, at) for key in waiting}}
    line = state['line']
    if line and (line['key'] not in waiting or line['key'] in state['seen']):
        if repo_of(line['key']) not in looked:
            print(f"poll.py: {line['key']}'s line is dropped, since its repository isn't in this pass's listing; its head "
                  "waits as it was when the repository is listed again", file=sys.stderr)
        state['line'] = None
    elif line:
        line['args'] = waiting[line['key']]
    busy = [f"{r['run']} ({r['state']}, {key})" for key, r in sorted(held.items()) if r['state'] not in pr_poll.ENDED]
    if busy:
        print(f"poll.py: waiting for {', '.join(busy)} to settle", file=sys.stderr)
        return [], taken
    if state['line'] is None:
        unseen = [key for key in waiting if key not in state['seen']]
        if not unseen:
            return [], taken
        key = min(unseen, key=lambda k: (state['waiting'][k], k))
        state['seq'] += 1
        state['line'] = {'seq': state['seq'], 'key': key, 'args': waiting[key]}
    return [json.dumps({'key': state['line']['key'], 'args': state['line']['args']}, separators=(',', ':'))], state['line']['seq']


def main(argv=None):
    p = argparse.ArgumentParser(prog='poll.py', description=__doc__.split('\n\n')[0])
    p.parse_args(argv)
    try:
        taken = pr_poll.cursor()
        with locked() as state:
            lines, last = look(state, taken, pr_run.now())
        if not lines:
            return 1
        pr_poll.give_cursor(last)
        print('\n'.join(lines))
        return 0
    except Failed as e:
        print(f'poll.py: {e}', file=sys.stderr)
        return 2
    except Exception:
        traceback.print_exc()
        return 2


if __name__ == '__main__':
    sys.exit(main())

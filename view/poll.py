#!/usr/bin/env python3
"""The context view's poll, a Jobs job's condition: it prints at most one line, {"key", "args"}, while no view's run is
unsettled when it lists them: again the line it printed before, while Jobs hasn't taken it and its head still waits, or
else one for the head of an open pull request that has waited longest for its view. Its asks step prints one the same
way for each /context-deltas comment that asks for a view, in the order they were asked. Exit 0 with a line, 1 with
none, 2 on a failure, said on stderr."""
import argparse, contextlib, fcntl, json, os, re, subprocess, sys, traceback, urllib.parse

import pr_poll
import pr_review
import pr_run
from pr_run import Failed, need

import view

STATE = os.path.expanduser('~/.local/state/context-view')
WORKFLOWS = os.path.expanduser('~/.local/bin/astra-workflows')
COMMAND = '/context-deltas'
# Who may ask for a view: this account alone, while views post nowhere else. Each ask also needs write access, as
# review-workflow's /review does.
ASKERS = ('nissa-seru',)


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
    """Every view's run the workflows store still holds, in one listing however many heads wait."""
    p = subprocess.run([WORKFLOWS, 'runs', '--key-prefix', view.KEY], capture_output=True, text=True)
    need(p.returncode == 0, f"astra-workflows runs couldn't list the views' runs: {(p.stderr or p.stdout).strip()[:300]}")
    return [json.loads(l) for l in p.stdout.splitlines() if l.strip()]


def pull_of(key):
    return key.rsplit('@', 1)[0]


def repo_of(key):
    return key[len(view.KEY):].split('#', 1)[0]


def look(state, taken, at):
    """At most one line, while no view's run is unsettled when the pass lists them: again the line printed before, while
    Jobs hasn't taken it and its head still waits, or else one for the head that has waited longest for its view. The
    listing isn't a lock across Jobs' start, so a view started by hand meanwhile can run beside it. A head in `seen` is
    never run. It holds two kinds of head, each only while its pull request stays open: those of the pull requests open
    the first time the poll ever sees their repository, so such a pull request gets its first view at its next push, and
    each head whose view has run, kept since the workflows store clears a settled run a week after it settles. A pull
    request a pass finds closed leaves `seen`, so if it reopens, its head gets a view, unless the workflows store still
    holds a run of that head's view."""
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
    state['seen'] = sorted(k for k in set(state['seen']) | first | {r['key'] for r in held}
                           if pull_of(k) in pulls or repo_of(k) not in looked)
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
    busy = sorted(f"{r['run']} ({r['state']}, {r['key']})" for r in held if r['state'] not in pr_poll.ENDED)
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


def asked(body):
    """Whether a comment asks for a view: its first line is the command alone."""
    return (body or '').strip().split('\n', 1)[0].split() == [COMMAND]


def asks_in(name, token, seen, app_id, at):
    """The asks among a repository's comments since its last look, each {number, comment}, from an account in ASKERS with
    write access, not the App's own. A repository's first look starts from now, so no comment before it is an ask. A
    comment GitHub stamps with the same second as the look it's read in is read again at the next look, once."""
    if 'since' not in seen:
        seen['since'], seen['handled'] = at, []
        return []
    since = seen['since']
    comments, tag = pr_poll.every(f"/repos/{name}/issues/comments?since={urllib.parse.quote(since)}&per_page={pr_poll.PER_PAGE}",
                                  token=token, tag=seen.get('commentsTag'))
    if comments is None:
        return []
    found, handled = [], set(seen.get('handled') or [])
    latest = max([since, *(c['updated_at'] for c in comments)])
    for c in comments:
        if c['id'] in handled and c['updated_at'] == since:
            continue
        number = re.fullmatch(rf'https://github\.com/{re.escape(name)}/pull/(\d+)#issuecomment-\d+', c.get('html_url') or '', re.I)
        login = (c.get('user') or {}).get('login') or ''
        if not number or not asked(c.get('body')) or (c.get('performed_via_github_app') or {}).get('id') == app_id or login not in ASKERS:
            continue
        status, value, _, _ = pr_poll.request('GET', f'/repos/{name}/collaborators/{urllib.parse.quote(login)}/permission', token=token)
        made = c.get('created_at') or ''
        if status == 200 and value.get('permission') in pr_review.WRITE and (made > since or (made == since and c['id'] not in handled)):
            found.append({'number': int(number.group(1)), 'comment': c['id']})
    seen['handled'] = [c['id'] for c in comments if c['updated_at'] == latest]
    seen['commentsTag'] = tag if latest == since else None
    seen['since'] = latest
    return found


def take(asks, state, held, at):
    """Each ask queued, a newer one on a pull request taking the place of one queued there, with its head then: one GitHub
    gives as closed is said on stderr and dropped, and each ask queued gets 👀."""
    queue = state['queue']
    for name, rid, token, found in asks:
        for a in found:
            status, pr, _, _ = pr_poll.request('GET', f"/repos/{name}/pulls/{a['number']}", token=token)
            need(status == 200, f"GitHub answered {status} to GET /repos/{name}/pulls/{a['number']}")
            if pr.get('state') != 'open':
                print(f"poll.py: {name}#{a['number']} is closed, so its ask in comment {a['comment']} gets no view", file=sys.stderr)
                continue
            key = f"{view.key_of(rid, a['number'], pr['head']['sha'])}:ask-{a['comment']}"
            if key in held:
                continue
            queue[:] = [q for q in queue if pull_of(q['key']) != pull_of(key)]
            queue.append({'key': key, 'args': {'repo': name, 'number': a['number'], 'head': pr['head']['sha']}, 'at': at})
            status, _, _, _ = pr_poll.request('POST', f"/repos/{name}/issues/comments/{a['comment']}/reactions", token=token,
                                              body={'content': 'eyes'})
            if status not in (200, 201):
                print(f"poll.py: no 👀 on {name} comment {a['comment']}: GitHub answered {status}", file=sys.stderr)


def ask(whole, taken, at):
    """At most one line, while no view's run is unsettled when the pass lists them: again the ask's line printed before,
    while Jobs hasn't taken it, or else the line of the ask queued first. The asks keep their own part of the state, beside
    the views', sharing only the App's tokens."""
    state = whole.setdefault('asks', {'seq': 0, 'line': None, 'queue': [], 'repos': {}})
    state['seq'] = max(state['seq'], taken)
    if state['line'] and state['line']['seq'] <= taken:
        state['queue'] = [q for q in state['queue'] if q['key'] != state['line']['key']]
        state['line'] = None
    cfg = pr_review.app()
    jwt = pr_review.app_jwt(cfg)
    installations, _ = pr_poll.every(f'/app/installations?per_page={pr_poll.PER_PAGE}', bearer=jwt)
    asks, looked = [], set()
    for inst in installations:
        if inst['account']['id'] not in pr_review.ACCOUNTS:
            continue
        token = pr_poll.token_of(whole, inst['id'], jwt)
        repos, _ = pr_poll.every(f'/installation/repositories?per_page={pr_poll.PER_PAGE}', token=token, field='repositories')
        for repo in repos:
            if repo['id'] not in view.VIEWED or repo.get('archived') or repo.get('disabled') or str(repo['id']) in looked:
                continue
            looked.add(str(repo['id']))
            seen = state['repos'].setdefault(str(repo['id']), {})
            asks.append((repo['full_name'], repo['id'], token, asks_in(repo['full_name'], token, seen, cfg['appId'], at)))
    held = runs()
    take(asks, state, {r['key'] for r in held}, at)
    busy = sorted(f"{r['run']} ({r['state']}, {r['key']})" for r in held if r['state'] not in pr_poll.ENDED)
    if busy:
        print(f"poll.py: waiting for {', '.join(busy)} to settle", file=sys.stderr)
        return [], taken
    if state['line'] is None:
        if not state['queue']:
            return [], taken
        first = state['queue'][0]
        state['seq'] += 1
        state['line'] = {'seq': state['seq'], 'key': first['key'], 'args': first['args']}
    return [json.dumps({'key': state['line']['key'], 'args': state['line']['args']}, separators=(',', ':'))], state['line']['seq']


def main(argv=None):
    if argv is None:
        view.refuse_checkout(__file__, '~/.local/lib/context-view/current/view/.venv/bin/python -I -m poll', 2)
    p = argparse.ArgumentParser(prog='poll.py', description=__doc__.split('\n\n')[0])
    p.add_argument('step', nargs='?', choices=('views', 'asks'), default='views',
                   help="views (the default): a line for each open pull request's new head; asks: one for each ask")
    step = p.parse_args(argv).step
    try:
        taken = pr_poll.cursor()
        with locked() as state:
            lines, last = (look if step == 'views' else ask)(state, taken, pr_run.now())
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

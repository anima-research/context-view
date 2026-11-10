#!/usr/bin/env python3
"""The context view's poll, a Jobs job's condition: it prints at most one line, {"key", "args"}, while no view's run
holds the account's runners when it lists them and no other step has a line out unstarted: again the line it printed
before, while Jobs hasn't taken it and its pull request still waits, or else, while no ask its asks step could start is
queued (one on a pull request it lists open whose head has no unsettled view), one for the pull request whose review
started first of those waiting for a view. Its asks step prints one the same way for each /context-deltas comment that
asks for a view, in the order they were asked, and its merges step one for each pull request merged in a covered
repository, oldest first, once neither of the others has one to start, though a merges line already out prints again
first. Exit 0 with a line, 1 with none, 2 on a failure, said on stderr."""
import argparse, contextlib, datetime, fcntl, http.client, json, os, re, subprocess, sys, traceback, urllib.parse

import pr_poll
import pr_review
import pr_run
from pr_run import Failed, need

# What a GitHub call can raise past pr_poll.request's own answers (a 2xx, a 304 or a 404): Failed for any other status or
# a host it can't reach, and what a cut-off or garbled answer raises.
CALL_FAILED = (Failed, OSError, ValueError, http.client.HTTPException)

import view

STATE = os.path.expanduser('~/.local/state/context-view')
WORKFLOWS = os.path.expanduser('~/.local/bin/astra-workflows')
COMMAND = '/context-deltas'
# Who may ask for a view: this account alone, while views post nowhere else. Each ask also needs write access, as
# review-workflow's /review does.
ASKERS = ('nissa-seru',)
# The keys review-workflow's poll starts an opening's review and an ask's review under, pr_review.request_key's: a
# pull request gets a view when one of these starts (Oscar-1005, room-203 #413015).
REVIEWS = ('pr-review/open:', 'pr-review/ask:')
RECORDS = ('workflow:context-view', 'workflow:context-view-merged')
VIEW_KEY = re.compile(r'context-view/([1-9][0-9]*)#([1-9][0-9]*)@([0-9a-f]{40})(?::ask-[0-9]+|:review-[A-Za-z0-9-]+|:again-[1-9][0-9]*)?')
REVIEWED = re.compile(r'pr-review/(?:open|ask):([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*)(?:@[0-9a-f]{40}|:comment-[0-9]+)')
MERGE_KEY = re.compile(r'context-view/([1-9][0-9]*)#([1-9][0-9]*)@merged:([0-9a-f]{40})(?::again-[1-9][0-9]*)?')
SINCE = '2026-11-09T10:57:53Z'


def state_path():
    return os.path.join(STATE, 'poll.json')


@contextlib.contextmanager
def locked(keep=True):
    """The state, under the poll's lock, written back after a clean pass where keep says so."""
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, 'poll.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = state_path()
        if os.path.exists(path):
            state = pr_run.read_json(path)
        else:
            state = {'seq': 0, 'line': None, 'views_line': None, 'queue': {}, 'seen': [], 'repos': {}, 'tokens': {}, 'known': [], 'waiting': {}}
        yield state
        if keep:
            pr_run.write_json(path, state)


def heads(name, token, seen):
    """The repository's open pull requests, each with its head, whether it's a draft and its author's association with
    the repository, from a listing its ETag keeps."""
    pulls, tag = pr_poll.every(f'/repos/{name}/pulls?state=open&per_page={pr_poll.PER_PAGE}', token=token, tag=seen.get('pullsTag'))
    if pulls is not None:
        seen['pulls'] = [{'number': p['number'], 'head': p['head']['sha'], 'draft': bool(p.get('draft')),
                          'association': p.get('author_association')} for p in pulls]
        seen['pullsTag'] = tag
    return seen.get('pulls', [])


def listed(selection, what):
    p = subprocess.run([WORKFLOWS, 'runs', *selection], capture_output=True, text=True)
    need(p.returncode == 0, f"astra-workflows runs couldn't list {what}: {(p.stderr or p.stdout).strip()[:300]}")
    return [json.loads(l) for l in p.stdout.splitlines() if l.strip()]


def runs():
    """Every run of RECORDS the workflows store still holds, whoever started it, one listing for each however many heads
    wait. A run a colleague started from a session has the key '', which no view key, merge key or line matches, and
    its own key as `session`."""
    return [r if r['house'] else {**r, 'key': '', 'session': r['key']}
            for record in RECORDS for r in listed(['--record', record], "the views' runs")]


def shown(run):
    key = f"a session's start under {run['session']}" if 'session' in run else run['key']
    return f"{run['run']} ({run['state']}, {key})"


def reviews():
    """Every opening's and ask's review the workflows store still holds, one listing for each."""
    return [r for prefix in REVIEWS for r in listed(['--key-prefix', prefix], 'the reviews')]


def reviewed(key):
    """The repository and pull request a review under KEY reviews, when the review poll started it for an opening or an
    ask; None for any other review, a release's, a pull request's before it opens, or a restart."""
    m = REVIEWED.fullmatch(key)
    return (m[1], int(m[2])) if m else None


def view_dir(repo, number, head):
    """The directory workflow:context-view keeps a posting view of HEAD in."""
    return os.path.join(STATE, 'views', f"{repo.replace('/', '.')}.{number}.{head[:12]}")


def merge_dir(repo, number, commit):
    """The directory workflow:context-view-merged keeps the view of a merge at COMMIT in, apart from any view of a head."""
    return os.path.join(STATE, 'views', f"merged.{repo.replace('/', '.')}.{number}.{commit[:12]}")


def merge_key(repo_id, number, commit):
    return f'{view.KEY}{repo_id}#{number}@merged:{commit}'


def instant(at):
    return datetime.datetime.fromisoformat(at.replace('Z', '+00:00')).timestamp()


def holds(run):
    """Whether a view's run holds the account's runners, the cap's resource: while it's unsettled and its run side
    hasn't written the manifest it writes once its jobs have ended, in its directory, since the run began. The workflow
    removes an earlier manifest before its run side starts, and one older than the run is that earlier one. A run whose
    directory can't be named, a dry view's among them, holds them until it settles (Oscar-1005, room-203 #413364,
    #413376)."""
    if run['state'] in pr_poll.ENDED:
        return False
    m = VIEW_KEY.fullmatch(run['key']) or MERGE_KEY.fullmatch(run['key'])
    if not m or int(m[1]) not in view.VIEWED:
        return True
    named = view_dir if m.re is VIEW_KEY else merge_dir
    try:
        written = os.stat(os.path.join(named(view.VIEWED[int(m[1])], int(m[2]), m[3]), 'manifest.json')).st_mtime
    except OSError:
        return True
    return written < instant(run['createdAt'])


def companion_stopped(repo, number, head):
    """Whether HEAD's view stopped because no stack of releases could run its arms, which is the releases' state and not
    the pull request's, so the head waits to be viewed again at its next review (Oscar-1005, room-203 #413022). One
    that's there but can't be read counts as stopped, said on stderr, so a damaged file costs a view rather than one lost."""
    path = os.path.join(view_dir(repo, number, head), 'view.json')
    try:
        with open(path) as f:
            return json.load(f).get('outcome') == 'needs-companion'
    except FileNotFoundError:
        return False
    except (OSError, ValueError, AttributeError) as e:
        print(f"poll.py: {path} can't be read ({e}), so its head is viewed again at its next review", file=sys.stderr)
        return True


def pull_of(key):
    return key.rsplit('@', 1)[0]


def repo_of(key):
    return key[len(view.KEY):].split('#', 1)[0]


def head_key(key):
    return key.split(':', 1)[0]


def asks_first(asks, opened, unsettled):
    return [q for q in asks.get('queue') or [] if (p := opened.get(f"{view.KEY}{q['rid']}#{q['number']}"))
            and view.key_of(p['rid'], p['number'], p['head']) not in unsettled]


def look(state, taken, at):
    """At most one line, while no view's run holds the account's runners when the pass lists them and no other step has a
    line out unstarted: again the line printed before, while Jobs hasn't taken it and its pull request still waits,
    or else, while no ask the asks step could start is queued (one on a pull request this pass lists open whose head has
    no unsettled view), one for the pull request whose review started first of those waiting. A pull request waits from
    a review of it starting, as the review poll starts one for an opening or an ask, until a view has run at its head as
    it is then: while any view of its head is unsettled it stays queued, not waiting, and once a view of it settles
    after its line was taken it leaves, so a push before then gives the new head a view after it; a newcomer's pull
    request is passed over, since its code would run as the house's account with no maintainer's say (Oscar-1005,
    room-203 #413015), and a draft waits until it's ready. The listing isn't a lock across Jobs' start, so a view
    started by hand meanwhile can run beside it. A head in `seen` is never run, unless its view stopped for want of a
    stack of releases, when it runs again under a key naming the review start that queued it, since the store answers a
    key it holds with its run. `seen` holds each head whose view has run, while its pull request stays open, since the
    workflows store clears a settled run a week after it settles. The review starts are read before the listing, so a
    start counted is of a pull request open before it. A pass with no `reviews` counts every review the store holds and
    starts nothing for them. The line is kept under `views_line`, since the release before kept it under `line`, where
    that release's asks step waits on it."""
    queue = state.setdefault('queue', {})
    state.setdefault('views_line', None)
    state['seq'] = max(state['seq'], taken)
    if state['views_line'] and state['views_line']['seq'] <= taken:
        if pull_of(state['views_line']['key']) in queue:
            queue[pull_of(state['views_line']['key'])]['taken'] = state['views_line']['args']['head']
        state['views_line'] = None
    cfg = pr_review.app()
    jwt = pr_review.app_jwt(cfg)
    installations, _ = pr_poll.every(f'/app/installations?per_page={pr_poll.PER_PAGE}', bearer=jwt)
    started = reviews()
    opened, looked, names = {}, set(), {}
    for inst in installations:
        if inst['account']['id'] not in pr_review.ACCOUNTS:
            continue
        token = pr_poll.token_of(state, inst['id'], jwt)
        repos, _ = pr_poll.every(f'/installation/repositories?per_page={pr_poll.PER_PAGE}', token=token, field='repositories')
        for repo in repos:
            if repo['id'] not in view.VIEWED or repo.get('archived') or repo.get('disabled') or str(repo['id']) in looked:
                continue
            looked.add(str(repo['id']))
            names[repo['full_name']] = repo['id']
            for p in heads(repo['full_name'], token, state['repos'].setdefault(str(repo['id']), {})):
                opened[f"{view.KEY}{repo['id']}#{p['number']}"] = {**p, 'repo': repo['full_name'], 'rid': repo['id']}
    state['repos'] = {rid: seen for rid, seen in state['repos'].items() if rid in looked}
    if 'reviews' not in state:
        state['reviews'] = sorted({r['key'] for r in started})
    counted = set(state['reviews'])
    covered = set(view.VIEWED.values())
    for r in sorted(started, key=lambda r: (r['createdAt'], r['key'])):
        found = reviewed(r['key'])
        if r['key'] in counted or not found:
            continue
        name, number = found
        if name not in names and name in covered:
            continue
        counted.add(r['key'])
        if name not in names:
            continue
        entry = queue.setdefault(f'{view.KEY}{names[name]}#{number}', {'since': r['createdAt']})
        entry.pop('taken', None)
        entry['review'] = r['run']
    state['reviews'] = sorted(counted & {r['key'] for r in started})
    held = runs()
    unsettled = {head_key(r['key']) for r in held if r['state'] not in pr_poll.ENDED}
    state['seen'] = sorted(k for k in set(state['seen']) | {head_key(r['key']) for r in held}
                           if VIEW_KEY.fullmatch(k) and (pull_of(k) in opened or repo_of(k) not in looked))
    waiting = {}
    for pk in list(queue):
        p = opened.get(pk)
        if p is None:
            if repo_of(pk) in looked:
                del queue[pk]
            continue
        key = view.key_of(p['rid'], p['number'], p['head'])
        if key in unsettled:
            continue
        if queue[pk].get('taken') == p['head']:
            del queue[pk]
        elif p['association'] not in pr_poll.KNOWN:
            print(f"poll.py: {p['repo']}#{p['number']}'s author is new to the repository ({p['association']}), so its head "
                  "runs only on a /context-deltas ask", file=sys.stderr)
            del queue[pk]
        elif key not in state['seen']:
            if not p['draft']:
                waiting[key] = {'repo': p['repo'], 'number': p['number'], 'head': p['head'], 'auto': True}
        elif companion_stopped(p['repo'], p['number'], p['head']):
            if not p['draft']:
                waiting[f"{key}:review-{queue[pk]['review']}"] = {'repo': p['repo'], 'number': p['number'], 'head': p['head'], 'auto': True}
        else:
            del queue[pk]
    state['views_waiting'] = len(waiting)
    line = state['views_line']
    if line and line['key'] not in waiting:
        if repo_of(line['key']) not in looked:
            print(f"poll.py: {line['key']}'s line is dropped, since its repository isn't in this pass's listing; its pull "
                  "request waits as it was when the repository is listed again", file=sys.stderr)
        state['views_line'] = None
    elif line:
        line['args'] = waiting[line['key']]
    busy = sorted(shown(r) for r in held if holds(r))
    if busy:
        print(f"poll.py: waiting for the runners, held by {', '.join(busy)}", file=sys.stderr)
        return [], taken
    asks = state.get('asks') or {}
    if pending(asks.get('line'), held):
        print(f"poll.py: waiting for the asks' line {asks['line']['key']} to start", file=sys.stderr)
        return [], taken
    if merges_pending(state, held):
        return [], taken
    if state['views_line'] is None:
        first = asks_first(asks, opened, unsettled)
        if first:
            print(f"poll.py: waiting for the asks' queue, which holds {len(first)} on a pull request this pass lists open "
                  "with no unsettled view of its head, since an ask goes first", file=sys.stderr)
            return [], taken
        if not waiting:
            return [], taken
        key = min(waiting, key=lambda k: (queue[pull_of(k)]['since'], k))
        state['seq'] += 1
        state['views_line'] = {'seq': state['seq'], 'key': key, 'args': waiting[key]}
    return [json.dumps({'key': state['views_line']['key'], 'args': state['views_line']['args']}, separators=(',', ':'))], state['views_line']['seq']


def asked(body):
    """Whether a comment asks for a view: its first line is the command alone."""
    return (body or '').strip().split('\n', 1)[0].split() == [COMMAND]


def asks_in(name, token, seen, app_id, at):
    """The asks among a repository's comments since its last look, each {number, comment, made}, from an account in ASKERS
    with write access, not the App's own. A repository's first look starts from now, so no comment before it is an ask. A
    comment GitHub stamps with the same second as the look it's read in is read again at the next look, once. A
    permission GitHub doesn't answer fails the pass, so the comment is read again; its 404 says the account isn't one."""
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
        made = c.get('created_at') or ''
        if (not number or not asked(c.get('body')) or (c.get('performed_via_github_app') or {}).get('id') == app_id
                or login not in ASKERS or not (made > since or (made == since and c['id'] not in handled))):
            continue
        path = f'/repos/{name}/collaborators/{urllib.parse.quote(login)}/permission'
        status, value, _, _ = pr_poll.request('GET', path, token=token)
        if status == 200 and value.get('permission') in pr_review.WRITE:
            found.append({'number': int(number.group(1)), 'comment': c['id'], 'made': made})
    seen['handled'] = [c['id'] for c in comments if c['updated_at'] == latest]
    seen['commentsTag'] = tag if latest == since else None
    seen['since'] = latest
    return found


def take(asks, state, react=True):
    """Each ask queued in the order asked, a newer one on a pull request taking the place of one queued there, and of its
    line where that is out and not yet taken: one GitHub gives no open pull request for is said on stderr and dropped,
    and each ask queued gets 👀 where react says so, a refusal said on stderr."""
    queue = state['queue']
    found = sorted(((name, rid, token, a) for name, rid, token, f in asks for a in f), key=lambda x: (x[3]['made'], x[3]['comment']))
    for name, rid, token, a in found:
        if pull(name, token, a)[0] != 'open':
            continue
        queue[:] = [q for q in queue if (q['rid'], q['number']) != (rid, a['number'])]
        queue.append({'rid': rid, 'number': a['number'], 'comment': a['comment'], 'made': a['made']})
        line = state['line']
        if line and (line['ask']['rid'], line['ask']['number']) == (rid, a['number']):
            state['line'] = None
        if not react:
            continue
        try:
            status, _, _, _ = pr_poll.request('POST', f"/repos/{name}/issues/comments/{a['comment']}/reactions", token=token,
                                              body={'content': 'eyes'})
            need(status in (200, 201), f'GitHub answered {status}')
        except CALL_FAILED as e:
            print(f"poll.py: no 👀 on {name} comment {a['comment']}: {e}", file=sys.stderr)


def pull(name, token, a, read=False):
    """An ask's pull request as GitHub gives it now: ('open', its head), or ('gone', None) when it's closed or GitHub has
    no pull request by that number, said on stderr. Where read is set, as when its line would print, a call that fails is
    ('unread', None), said on stderr; otherwise it fails the pass, so the ask is read again."""
    path = f"/repos/{name}/pulls/{a['number']}"
    try:
        status, pr, _, _ = pr_poll.request('GET', path, token=token)
    except CALL_FAILED as e:
        if not read:
            raise
        print(f"poll.py: GET {path} failed ({e}), so its ask in comment {a['comment']} waits", file=sys.stderr)
        return 'unread', None
    if status == 404 or pr.get('state') != 'open':
        said = 'is closed' if status != 404 else 'is no pull request GitHub gives'
        print(f"poll.py: {name}#{a['number']} {said}, so its ask in comment {a['comment']} gets no view", file=sys.stderr)
        return 'gone', None
    return 'open', pr['head']['sha']


def pending(line, held):
    """Whether a step's line is out with no run of it in the store yet, so Jobs may be starting it. A line Jobs took
    has its run there, unless its job stays paused before its next condition past the store's week: Jobs adopts a
    condition's cursor only once its action succeeds, or once a held action's effect is confirmed with evidence
    (astra-jobs' adoptFrozen, from store/outcomes.ts and store/control.ts), and the workflow action succeeds only
    once startHouse has made its runs (workflow-house's src/provider.ts). So a step's line ends at its own next pass
    after Jobs takes it."""
    return bool(line) and line['key'] not in {r['key'] for r in held}


def merges_pending(whole, held):
    line = (whole.get('merges') or {}).get('line')
    if not pending(line, held):
        return False
    print(f"poll.py: waiting for the merges' line {line['key']} to start", file=sys.stderr)
    return True


def ask(whole, taken, at, job=True):
    """At most one line, while no view's run holds the account's runners when the pass lists them and no other step's line
    is out with no run of it yet: again the ask's line printed before, while Jobs hasn't taken it, or else
    the line of the ask queued first whose repository this pass lists, whose pull request it reads and whose head has
    no unsettled view, each with its pull request's head as GitHub gives it in this pass. An ask whose line Jobs took
    leaves the queue, as does one whose pull request has gone or whose view of its head has run. The asks keep their
    own part of the state, beside the views'; each step reads the others' lines, and the views and merges steps read this queue."""
    state = whole.setdefault('asks', {'seq': 0, 'line': None, 'queue': [], 'repos': {}})
    state['seq'] = max(state['seq'], taken)
    if state['line'] and state['line']['seq'] <= taken:
        state['queue'] = [q for q in state['queue'] if q['comment'] != state['line']['ask']['comment']]
        state['line'] = None
    cfg = pr_review.app()
    jwt = pr_review.app_jwt(cfg)
    installations, _ = pr_poll.every(f'/app/installations?per_page={pr_poll.PER_PAGE}', bearer=jwt)
    asks, looked, where = [], set(), {}
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
            where[repo['id']] = (repo['full_name'], token)
            asks.append((repo['full_name'], repo['id'], token, asks_in(repo['full_name'], token, seen, cfg['appId'], at)))
    take(asks, state, react=job)
    held = runs()
    busy = sorted(shown(r) for r in held if holds(r))
    if busy:
        print(f"poll.py: waiting for the runners, held by {', '.join(busy)}", file=sys.stderr)
        return [], taken
    if pending(whole.get('views_line'), held):
        print(f"poll.py: waiting for the views' line {whole['views_line']['key']} to start", file=sys.stderr)
        return [], taken
    if merges_pending(whole, held):
        return [], taken
    ran = {r['key'] for r in held}
    unsettled = {head_key(r['key']): r['run'] for r in held if r['state'] not in pr_poll.ENDED}
    line = state['line']
    for q in ([line['ask']] if line else []) + [q for q in list(state['queue']) if not line or q['comment'] != line['ask']['comment']]:
        if q['rid'] not in where:
            print(f"poll.py: the ask in comment {q['comment']} waits, since its repository isn't in this pass's listing", file=sys.stderr)
            continue
        name, token = where[q['rid']]
        found, head = pull(name, token, q, read=True)
        if found == 'unread':
            continue
        key = f"{view.key_of(q['rid'], q['number'], head)}:ask-{q['comment']}" if found == 'open' else None
        if found == 'gone' or key in ran:
            state['queue'] = [x for x in state['queue'] if x['comment'] != q['comment']]
            state['line'] = None
            continue
        if head_key(key) in unsettled:
            print(f"poll.py: the ask in comment {q['comment']} waits for {unsettled[head_key(key)]}, a view of its head that hasn't "
                  "settled, since both would use the head's one directory", file=sys.stderr)
            continue
        if not state['line'] or state['line']['key'] != key:
            state['seq'] += 1
            state['line'] = {'seq': state['seq'], 'key': key, 'args': {'repo': name, 'number': q['number'], 'head': head}, 'ask': q}
        return [json.dumps({'key': key, 'args': state['line']['args']}, separators=(',', ':'))], state['line']['seq']
    state['line'] = None
    return [], taken


def merges_in(name, token, seen):
    """Paging can stop at a page that ends before `since` because GitHub lists closed pull requests last updated first,
    and a merge's last update is no earlier than the merge; a first page GitHub answers 304 to, by its ETag, has had no
    update since, so the merges the last listing found stand."""
    since, handled = seen['since'], set(seen['handled'])
    path = f'/repos/{name}/pulls?state=closed&sort=updated&direction=desc&per_page={pr_poll.PER_PAGE}'
    status, page, tag, following = pr_poll.request('GET', path, token=token, tag=seen.get('tag'))
    if status == 304:
        found = seen.get('found') or []
    else:
        found = []
        while True:
            need(status == 200, f'GitHub answered {status} to GET /repos/{name}/pulls')
            found += [{'number': p['number'], 'merged': p['merge_commit_sha'], 'at': p['merged_at']} for p in page
                      if p.get('merged_at') and p['merged_at'] >= since]
            if not following or not page or page[-1]['updated_at'] < since:
                break
            status, page, _, following = pr_poll.request('GET', following, token=token)
        seen['tag'], seen['found'] = tag, found
    return [m for m in found if m['at'] > since or (m['at'] == since and m['number'] not in handled)]


def passed(repos, merge):
    seen = repos.setdefault(str(merge['rid']), {'since': SINCE, 'handled': []})
    if merge['at'] > seen['since']:
        seen['since'], seen['handled'] = merge['at'], [merge['number']]
    elif merge['at'] == seen['since'] and merge['number'] not in seen['handled']:
        seen['handled'].append(merge['number'])


def merged(whole, taken):
    state = whole.setdefault('merges', {'seq': 0, 'line': None, 'repos': {}})
    state['seq'] = max(state['seq'], taken)
    if state['line'] and state['line']['seq'] <= taken:
        passed(state['repos'], state['line']['merge'])
        state['line'] = None
    cfg = pr_review.app()
    jwt = pr_review.app_jwt(cfg)
    installations, _ = pr_poll.every(f'/app/installations?per_page={pr_poll.PER_PAGE}', bearer=jwt)
    found, opened, looked = [], {}, {}
    for inst in installations:
        if inst['account']['id'] not in pr_review.ACCOUNTS:
            continue
        token = pr_poll.token_of(whole, inst['id'], jwt)
        repos, _ = pr_poll.every(f'/installation/repositories?per_page={pr_poll.PER_PAGE}', token=token, field='repositories')
        for repo in repos:
            if repo['id'] not in view.VIEWED or repo.get('archived') or repo.get('disabled') or str(repo['id']) in looked:
                continue
            looked[str(repo['id'])] = repo['full_name']
            seen = state['repos'].setdefault(str(repo['id']), {'since': SINCE, 'handled': []})
            found += [{**m, 'rid': repo['id'], 'repo': repo['full_name']} for m in merges_in(repo['full_name'], token, seen)]
            for p in heads(repo['full_name'], token, seen.setdefault('open', {})):
                opened[f"{view.KEY}{repo['id']}#{p['number']}"] = {**p, 'repo': repo['full_name'], 'rid': repo['id']}
    line = state['line']
    if line and str(line['merge']['rid']) not in looked:
        print(f"poll.py: {line['key']}'s line is dropped, since its repository isn't in this pass's listing; its merge "
              "waits as it was when the repository is listed again", file=sys.stderr)
        state['line'] = None
    elif line:
        line['args']['repo'] = looked[str(line['merge']['rid'])]
    held = runs()
    busy = sorted(shown(r) for r in held if holds(r))
    if busy:
        print(f"poll.py: waiting for the runners, held by {', '.join(busy)}", file=sys.stderr)
        return [], taken
    for step, line in (("views'", whole.get('views_line')), ("asks'", (whole.get('asks') or {}).get('line'))):
        if pending(line, held):
            print(f"poll.py: waiting for the {step} line {line['key']} to start", file=sys.stderr)
            return [], taken
    ran = {m.groups() for r in held if (m := MERGE_KEY.fullmatch(r['key']))}
    for rid in {m['rid'] for m in found}:
        for m in sorted((m for m in found if m['rid'] == rid), key=lambda m: (m['at'], m['number'])):
            if (str(m['rid']), str(m['number']), m['merged']) not in ran:
                break
            passed(state['repos'], m)
    line = state['line']
    if line and MERGE_KEY.fullmatch(line['key']).groups() not in ran:
        return [json.dumps({'key': line['key'], 'args': line['args']}, separators=(',', ':'))], line['seq']
    state['line'] = None
    unsettled = {head_key(r['key']) for r in held if r['state'] not in pr_poll.ENDED}
    first = asks_first(whole.get('asks') or {}, opened, unsettled)
    if first:
        print(f"poll.py: waiting for the asks' queue, which holds {len(first)} on a pull request this pass lists open "
              "with no unsettled view of its head, since an ask goes first", file=sys.stderr)
        return [], taken
    left = whole.get('views_waiting')
    if left is None:
        print("poll.py: waiting for the views step's first job pass, which counts the pull requests waiting for a view, "
              "since a pull request's view goes before a merge's", file=sys.stderr)
        return [], taken
    if left:
        print(f"poll.py: waiting for the views, since the views step left {left} pull request{'s' if left != 1 else ''} "
              "waiting at its last job pass, and a pull request's view goes before a merge's", file=sys.stderr)
        return [], taken
    todo = sorted((m for m in found if (str(m['rid']), str(m['number']), m['merged']) not in ran),
                  key=lambda m: (m['at'], m['rid'], m['number']))
    if not todo:
        return [], taken
    m = todo[0]
    state['seq'] += 1
    state['line'] = {'seq': state['seq'], 'key': merge_key(m['rid'], m['number'], m['merged']),
                     'args': {'repo': m['repo'], 'number': m['number'], 'merged': m['merged']},
                     'merge': {'rid': m['rid'], 'number': m['number'], 'at': m['at']}}
    return [json.dumps({'key': state['line']['key'], 'args': state['line']['args']}, separators=(',', ':'))], state['line']['seq']


def main(argv=None):
    if argv is None:
        view.refuse_checkout(__file__, '~/.local/lib/context-view/current/view/poll', 2)
    p = argparse.ArgumentParser(prog='poll.py', description=__doc__.split('\n\n')[0])
    p.add_argument('step', nargs='?', choices=('views', 'asks', 'merges'), default='views',
                   help="views (the default): a line for each pull request a review starts on; asks: one for each ask; "
                        "merges: one for each pull request merged in a covered repository")
    p.add_argument('--job', action='store_true',
                   help="the pass is its job's condition; without it, the pass prints what it would and changes nothing")
    given = p.parse_args(argv)
    try:
        taken = pr_poll.cursor()
        with locked(keep=given.job) as state:
            at = pr_run.now()
            lines, last = (look(state, taken, at) if given.step == 'views' else ask(state, taken, at, given.job)
                           if given.step == 'asks' else merged(state, taken))
        if not lines:
            return 1
        if given.job:
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

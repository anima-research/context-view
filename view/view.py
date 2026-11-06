#!/usr/bin/env python3
"""The context view's steps on the host, which the workflow running a view calls: each reads one JSON object on stdin and
prints one on its last line of stdout, or exits 1 with why on stderr, or 2 when the run's repository is one the App is
installed on that the context view doesn't cover, or when its command line names no step."""
import argparse, bisect, hashlib, html, json, os, re, sys, traceback

import pr_comment
import pr_review
from pr_comment import ACTIVE, COMMENT_MAX, MORE, VIEW_MARK, code, ended, inert, one_line
from pr_run import Failed, NotARequest, need, read_json, refuse, write_json

VIEWED = {1126567876: 'anima-research/context-manager', 1132522869: 'anima-research/agent-framework',
          1123531033: 'antra-tess/membrane', 1170978461: 'anima-research/connectome-host'}
KEY = 'context-view/'
# The repository whose harness/ a view's runs use, and whose CHECKS.md says what those runs drive and what their checks judge.
HARNESS = 'anima-research/context-view'
OUTCOMES = ('ran', 'moved', 'closed', 'couldnt-run', 'doesnt-merge', 'needs-companion', 'arm-missing')
# The arm an outcome's detail names, as the run side names it, and as the comment does: an arm-missing names a job's arm,
# a needs-companion the arm whose asks don't hold, in either shape (run/context-view-run.ts, plan() and share()).
ARMS = {'arm-missing': {'before': 'base', 'after': 'head'}, 'needs-companion': {'base': 'base', 'head': 'head'}}
CHECKS = ('same', 'differs', 'couldnt-run')
# A run's outcomes as the harness gives them.
RESULTS = ('pass', 'flags', 'invalid', 'couldnt-run')
FORMS = ('overlay', 'host')
SHA = re.compile(r'[0-9a-f]{40}')
MARK = re.compile(re.escape(VIEW_MARK) + r'(?:stopped:(?P<stopped>[0-9a-f]{40})|first:(?P<first>[0-9a-f]{40})'
                  r'(?: head:(?P<head>[0-9a-f]{40}))? result:(?P<result>[0-9a-f]{64})(?::(?P<part>[0-9]+))?) -->\Z')
ENTRIES = 'entries.json'


def full_sha(v):
    return isinstance(v, str) and SHA.fullmatch(v) is not None


def key_of(repo_id, number, head):
    """A view's run key, by the repository's GitHub ID, so a rename or a transfer keeps a head's view its own."""
    return f'{KEY}{repo_id}#{number}@{head}'


def counted(n, one, many):
    return f'{n:,} {one if n == 1 else many}'


def listed(names):
    names = list(names)
    return names[0] if len(names) == 1 else ', '.join(names[:-1]) + ' and ' + names[-1]


def facts(args):
    """view.json, the one file the reader, its check and post read: the manifest's facts, the pull request's title and
    description as GitHub gives them now, and each share's head arm read and merged."""
    d, repo = args['dir'], args['repo']
    m = read_json(os.path.join(d, 'manifest.json'))
    need(m.get('repo') == repo.split('/', 1)[1], f"manifest.json names {m.get('repo')!r}, not {repo}")
    token, _ = viewed(repo)
    need(m.get('outcome') in OUTCOMES, f"manifest.json: an outcome the view doesn't know, {m.get('outcome')!r}")
    need(full_sha(m.get('head')), f"manifest.json: head isn't a full commit sha, {m.get('head')!r}")
    need(type(m.get('number')) is int and m['number'] > 0, 'manifest.json: number')
    path = os.path.join(d, 'view.json')
    if m['outcome'] in ('moved', 'closed'):
        write_json(path, {'repo': repo, 'number': m['number'], 'head': m['head'], 'outcome': m['outcome'], 'detail': m.get('detail')})
        return {'path': path, 'changed': False}
    base = m.get('base') if isinstance(m.get('base'), dict) else {}
    need(full_sha(base.get('sha')), f"manifest.json: base.sha isn't a full commit sha, {base.get('sha')!r}")
    need(isinstance(base.get('ref'), str) and one_line(base['ref']), f"manifest.json: base.ref isn't a branch name, {base.get('ref')!r}")
    host = m.get('host') if isinstance(m.get('host'), dict) else {}
    need(full_sha(host.get('sha')), f"manifest.json: host.sha isn't a full commit sha, {host.get('sha')!r}")
    harness = m.get('harness') if isinstance(m.get('harness'), dict) else {}
    need(harness.get('repo') == HARNESS, f"manifest.json: harness.repo is {harness.get('repo')!r}, not {HARNESS}")
    need(full_sha(harness.get('sha')), f"manifest.json: harness.sha isn't a full commit sha, {harness.get('sha')!r}")
    need(m.get('form') in FORMS, f"manifest.json: a form the view doesn't know, {m.get('form')!r}")
    detail = m.get('detail') if isinstance(m.get('detail'), dict) else {}
    if m['outcome'] in ARMS:
        need(detail.get('arm') in ARMS[m['outcome']], f"manifest.json: an arm the {m['outcome']} doesn't name, {detail.get('arm')!r}")
    need(m['outcome'] != 'ran' or m.get('shares'), 'manifest.json: a run with no shares')
    view = {'repo': repo, 'number': m['number'], 'head': m['head'], 'base': m['base']['sha'], 'baseRef': base['ref'], 'form': m['form'],
            'host': m['host']['sha'], 'harness': {'repo': HARNESS, 'sha': harness['sha']}, 'outcome': m['outcome'],
            'detail': m.get('detail'), 'jobs': len(m.get('shares') or [])}
    pr = pr_review.api('GET', f"/repos/{repo}/pulls/{m['number']}", token)
    view['title'], view['body'] = pr.get('title') or '', pr.get('body') or ''
    if m['outcome'] == 'ran':
        view.update(arms(d, m))
    write_json(path, view)
    return {'path': path, 'changed': view['outcome'] == 'ran' and bool(view['entries'])}


def viewed(repo):
    """The App's token for one of the four repositories, which are known by their GitHub IDs, so a rename or a transfer
    keeps its place. Any other repository the App is installed on is refused; one it isn't installed on fails at its token,
    with GitHub's 404. Which repositories review-workflow's own review covers doesn't bear on it."""
    token, _, app_id = pr_review.app_token(repo)
    refuse(pr_review.api('GET', f'/repos/{repo}', token)['id'] in VIEWED, f"{repo} isn't one of the context view's repositories")
    return token, app_id


def parsed(d, path):
    """A share's file read as JSON, or a failure naming it."""
    try:
        return read_json(path)
    except ValueError as e:
        raise Failed(f"{os.path.relpath(path, d)} isn't JSON: {e}") from e


def arms(d, m):
    results, order, before, after, merged = {}, None, None, None, {}
    for share in m['shares']:
        paths = [os.path.join(d, share['dir'], arm, 'run.json') for arm in ('after', 'before')]
        need(all(os.path.exists(p) for p in paths), f"{share['dir']}: an arm wrote no run.json, though the run's outcome is ran")
        head, base = (parsed(d, p) for p in paths)
        need(order is None or head['runs'] == order, f"{share['dir']}: its run.json orders the runs differently")
        order = head['runs']
        versions = (base['candidate']['versions'], head['candidate']['versions'])
        need(before is None or versions == (before, after), f"{share['dir']}: its arms' versions differ from another share's")
        before, after = versions
        for r in head['results']:
            need(r['run'] not in results, f"run {r['run']} is in two shares")
            need(broken(r) or ('flags' in r and 'counts' in r), f"{share['dir']}: {r['run']}'s result has no flags or counts to compare")
            results[r['run']] = r
        entries = os.path.join(d, share['dir'], 'after', ENTRIES)
        need(os.path.exists(entries), f"{share['dir']}: the head arm wrote no {ENTRIES}")
        own = {r['run'] for r in head['results']}
        for e in parsed(d, entries):
            need(isinstance(e.get('places'), list) and all(isinstance(p, dict) for p in e['places']),
                 f"{share['dir']}: entry {e.get('id')}'s places aren't a list of places")
            need(all(p.get('run') in own for p in e['places']),
                 f"{share['dir']}: entry {e.get('id')} has a place in a run outside its share's results")
            need(isinstance(e.get('examples'), list) and all(isinstance(x, dict) for x in e['examples'])
                 and sorted(str(x.get('run')) for x in e['examples']) == sorted({str(p.get('run')) for p in e.get('places') or []}),
                 f"{share['dir']}: entry {e.get('id')}'s examples aren't one per run it occurs in")
            firsts = {}
            for p in e['places']:
                firsts.setdefault(p['run'], p.get('step'))
            need(all(x.get('step') == firsts[x['run']] for x in e['examples']),
                 f"{share['dir']}: entry {e.get('id')} has an example that isn't at its run's first place")
            held = merged.get(e['id'])
            if held is None:
                merged[e['id']] = {**e, 'places': list(e['places']), 'runs': list(e['runs']), 'examples': list(e['examples'])}
                continue
            held['places'] += [p for p in e['places'] if p not in held['places']]
            held['runs'] += [r for r in e['runs'] if r not in held['runs']]
            held['examples'] += e['examples']
            held['count'] += e['count']
    need(order and len(set(order)) == len(order), "run.json's runs are empty or name a run twice")
    need(set(results) == set(order), "the shares' results aren't every run once")
    for e in merged.values():
        e['places'].sort(key=lambda p: rank(order, p)[0])
        e['runs'].sort(key=order.index)
        e['examples'].sort(key=lambda x: order.index(x['run']))
    held = {name: v.split(' ')[0] for name, v in after.items()
            if v is not None and before.get(name) == v and name.startswith('@animalabs/') and name != '@animalabs/connectome-host'}
    ran = [results[r] for r in order]
    compared = [r for r in ran if not broken(r)]
    placed = {p['run'] for e in merged.values() for p in e['places']}
    for r in compared:
        need(r['record'] == ('differs' if r['run'] in placed else 'same'),
             f"run {r['run']}: its record says {r['record']!r}, but the entries have {'places' if r['run'] in placed else 'no place'} in it")
    for r in compared:
        for f in r['flags']['new'] + r['flags']['gone']:
            need(type(f.get('check')) is int and f['check'] >= 1, f"{r['run']}: a flag's check isn't a whole number of 1 or more, {f.get('check')!r}")
    kept = {r['run'] for r in compared}
    shown = []
    for e in merged.values():
        places = [p for p in e['places'] if p['run'] in kept]
        if places:
            x = next(x for x in e['examples'] if x['run'] in kept)
            shown.append({**{k: v for k, v in e.items() if k != 'examples'}, 'places': places, 'runs': [r for r in e['runs'] if r in kept],
                          'count': len(places),
                          'example': {'place': {'run': x['run'], 'step': x['step']}, 'before': x['before'], 'after': x['after']}})
    shown.sort(key=lambda e: (rank(order, e['places'][0]), e['id']))
    return {'held': {name.split('/', 1)[1]: v for name, v in sorted(held.items())},
            'runs': {'total': len(ran), 'compared': len(compared)}, 'order': order,
            'broken': [{'run': r['run'], 'what': broken(r), 'reason': why_not(r), **({'reads': reads(r)} if broken(r) == 'read' or any(reads(r).values()) else {}),
                        **({'unmeasured': unmeasured(r)} if broken(r) == 'unmeasured' else {}),
                        **({'unreadable': True} if unreadable(r) else {})}
                       for r in ran if broken(r)],
            'flags': [{'run': r['run'], 'new': r['flags']['new'], 'gone': r['flags']['gone']} for r in compared
                      if r['flags']['new'] or r['flags']['gone']],
            'reached': reached(compared), 'entries': shown}


def broken(r):
    """Why a run's records can't be compared, or None: the harness gave it an outcome the view doesn't know, the head
    couldn't run it, the base couldn't, a read failed on either arm, either arm didn't measure (it failed, its folds were
    clamped or a check judged nothing), the head wasn't self-checked, or the head's self-check, a second drive with
    recording off, didn't find the two drives' requests the same or couldn't run."""
    if r['outcome'] not in RESULTS:
        return 'outcome'
    if r['outcome'] == 'couldnt-run' or r['record'] is None:
        return 'head'
    if r['record'] == 'missing':
        return 'base'
    if r.get('unmeasured') or r.get('baseUnmeasured'):
        return 'unmeasured'
    if r.get('readsFailed') or r.get('baseReadsFailed'):
        return 'read'
    if unreadable(r):
        return 'read'
    if 'selfCheck' not in r:
        return 'unchecked'
    check = r['selfCheck'].get('outcome') if isinstance(r['selfCheck'], dict) else None
    need(check in CHECKS, f"{r['run']}: a self-check the view doesn't know, {r['selfCheck']!r}")
    return None if check == 'same' else 'varies' if check == 'differs' else 'drive'


def unreadable(r):
    q = (r.get('counts') or {}).get('quarantines')
    return isinstance(q, dict) and 'unreadable' in q.values()


def why_not(r):
    """What the run says of why it couldn't be compared: the self-check's own account where it didn't find its two
    drives' requests the same or its second drive couldn't show that recording changes nothing it sends, the base arm's own
    (`baseReason`, nothing where it's absent) where the base couldn't run it, since a result's `reason` is the head's, else
    the run's."""
    if broken(r) == 'varies':
        return str(r['selfCheck'].get('detail') or '')
    if broken(r) == 'drive':
        return str(r['selfCheck'].get('reason') or '')
    if broken(r) == 'base':
        return str(r.get('baseReason') or '')
    if broken(r) == 'outcome':
        return str(r['outcome'])
    return str(r.get('reason') or '')


def reads(r):
    """The reads that failed on each arm, named as the harness names them."""
    return {'head': [str(x) for x in r.get('readsFailed') or []], 'base': [str(x) for x in r.get('baseReadsFailed') or []]}


def unmeasured(r):
    """What didn't measure on each arm, named as the harness names it."""
    return {'head': [str(x) for x in r.get('unmeasured') or []], 'base': [str(x) for x in r.get('baseUnmeasured') or []]}


def rank(order, place):
    """A place's order: its run's, then its step id's, with the id's runs of digits compared by number and the rest as
    text, so '232330.9' comes before '232330.10'."""
    step = tuple((0, int(part), '') if part.isdecimal() else (1, 0, part) for part in re.split(r'(\d+)', str(place['step'])) if part)
    return order.index(place['run']), step


def is_count(n):
    return type(n) is int and n >= 0


def reached(results):
    out = {'runs': 0, 'requests': 0, 'compressions': [0, 0], 'merges': [0, 0], 'quarantines': {'compression': 0, 'merge': 0, 'runs': 0, 'not-reported': 0, 'uncounted': 0}}
    for r in results:
        c = r['counts']
        for kind in ('compiles', 'compressions', 'merges'):
            need(is_count(c.get(kind)), f"{r['run']}: its {kind[:-1]} count isn't a whole number of 0 or more, {c.get(kind)!r}")
        out['runs'] += 1
        out['requests'] += c['compiles']
        for kind in ('compressions', 'merges'):
            out[kind][0] += c[kind]
            out[kind][1] += bool(c[kind])
        q = c['quarantines']
        need(q in ('not-reported', None) or isinstance(q, dict) and all(is_count(q.get(k)) for k in ('compression', 'merge')),
             f"{r['run']}: a quarantine count the view doesn't know, {q!r}")
        if not isinstance(q, dict):
            out['quarantines']['not-reported' if q == 'not-reported' else 'uncounted'] += 1
            continue
        out['quarantines']['compression'] += q['compression']
        out['quarantines']['merge'] += q['merge']
        out['quarantines']['runs'] += bool(q['compression'] or q['merge'])
    return out


def words_of(files):
    """The sha256 of the files whose code writes a comment's fixed words, each file's bytes after its length."""
    h = hashlib.sha256()
    for path in files:
        with open(path, 'rb') as f:
            data = f.read()
        h.update(f'{len(data)}\n'.encode() + data)
    return h.hexdigest()


# The code that writes a comment's fixed words, view.py and the pinned review-workflow's pr_comment, so a comment is kept
# for the same result only by the code that wrote it: a release that changes either, or moves the pin, posts again at a
# head's next view.
WORDS = words_of((__file__, pr_comment.__file__))


def result_of(view, sources=None):
    """What a comment's fixed words and quotes rest on, apart from the heads its first lines name (this head, the head it
    was first posted at, and the pull request's head now): the same result at a later head edits the first line rather than
    posting again, and the reader's prose, written again at each run, isn't part of it. Every other word the comment prints
    comes from what this covers, and where the reader runs, so does everything it reads:
    the pull request's title and description, and its instructions and guide by their sha256 (sources, post's reads), and
    the code that writes them (WORDS)."""
    keep = ('base', 'baseRef', 'host', 'harness', 'form', 'outcome', 'detail', 'held', 'runs', 'broken', 'flags', 'reached')
    said = {k: view.get(k) for k in keep}
    if view.get('outcome') == 'arm-missing':
        said['jobs'] = view.get('jobs')
    said['entries'] = view.get('entries') or []
    said['words'] = WORDS
    if view.get('outcome') == 'ran' and said['entries']:
        said['pr'] = [view.get('title'), view.get('body')]
        said['reads'] = sources
    return hashlib.sha256(json.dumps(said, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def mark(view, first, digest, part=1):
    if part == 1:
        return f"{VIEW_MARK}first:{first} head:{view['head']} result:{digest} -->"
    return f"{VIEW_MARK}first:{first} result:{digest}:{part} -->"


def stopped_mark(head):
    return f'{VIEW_MARK}stopped:{head} -->'


def opening(view, first, head_now):
    joined = 'against' if view['outcome'] == 'doesnt-merge' else 'merged onto'
    text = f"**Automatic context view** of {code(view['head'][:12])} {joined} {code(view['base'][:12])}."
    if first != view['head']:
        text += since(view, f"as at {code(first[:12])}, where this comment was first posted.")
    if head_now != view['head']:
        text += f" The pull request's head has since moved to {code(head_now[:12])}."
    return text


def since(view, at):
    """What an edited first line says held at the head the comment was first posted at, by what the comment shows."""
    if view['outcome'] != 'ran' or not view['runs']['compared']:
        return f" It couldn't be compared for the same reasons {at}"
    if view.get('broken'):
        seen = 'the same differences from the base' if view['entries'] else 'no difference from the base'
        return f" Its runs show {seen}, and couldn't be compared at the same runs for the same reasons, {at}"
    if view['entries']:
        return f" Its runs show the same differences from the base {at}"
    return f" Its runs show no difference from the base, {at}"


def widest(view):
    return len(opening({**view, 'head': 'f' * 40}, '0' * 40, 'e' * 40))


def summary_text(text):
    """A <details> summary line is an HTML block, where Markdown isn't read: each token GitHub would turn into something
    else (`ACTIVE`) in <code>, which GitHub leaves as it is, and the rest escaped as HTML."""
    text, out, at = one_line(text), [], 0
    for m in ACTIVE.finditer(text):
        out += [html.escape(text[at:m.start()]), f'<code>{html.escape(m.group(0))}</code>']
        at = m.end()
    return ''.join(out + [html.escape(text[at:])])


def written(text):
    """text as a fence shows it: each control character but a tab or a newline written as its \\xNN."""
    return re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', lambda m: f'\\x{ord(m.group(0)):02x}', str(text))


def fence(text):
    text = written(text)
    ticks = max((len(t) for t in re.findall(r'`+', text)), default=0)
    f = '`' * max(3, ticks + 1)
    return f'{f}text\n{text}\n{f}'


def clipped(words, text, room):
    """words(shown, part) with all of text, as one_line() gives it, where it fits in room, else with its longest prefix whose
    words fit, part naming how many characters a reader sees of that prefix and of the whole text, both as seen() counts
    them, so a code span's backticks aren't counted. A prefix's end moves back as whole(text) moves it, so it never ends
    inside a code span or a run of backticks, and it ends before any whitespace there, which rendering takes out: what
    shows is then the whole text's first characters as they show.
    The prefix is found by bisection on the words' rendered length, since rendering escapes and fences text, so a
    character can take several: it's the longest where that length grows with the prefix, as it does but where a
    reference or code span completes."""
    said = words(text, '')
    if len(said) <= room:
        return said
    cut, total = whole(text), pr_comment.seen(text)

    def shown(k):
        k = len(text[:cut(k)].rstrip())
        return words(text[:k], f"'s first {pr_comment.seen(text[:k]):,} of {total:,} characters")
    need(len(shown(0)) <= room, f"a paragraph doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters even with its text cut")
    lo, hi = 0, len(text) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        lo, hi = (mid, hi) if len(shown(mid)) <= room else (lo, mid - 1)
    return shown(lo)


def whole(text):
    """cut(k) for text, as one_line() gives it: k, or where the code span inert() shows of the whole text, or the run of
    backticks it shows as text, that k falls inside begins, since a cut there could show what the whole doesn't, such as
    a backtick that closes no span, or pair an unclosed run anew. A token `ACTIVE` codes
    is one such span, so one longer than the room shows none of it."""
    spans = []
    for is_code, piece, start, end in pr_comment.runs(text):
        spans += [(start, end)] if is_code else [(start + m.start(), start + m.end()) for m in re.finditer(r'`+', piece)]
    starts = [start for start, _ in spans]

    def cut(k):
        at = bisect.bisect_left(starts, k) - 1
        return spans[at][0] if at >= 0 and spans[at][1] > k else k
    return cut


def could_not(view, room):
    """The fixed words for a head that couldn't be compared, each saying what the run found, each paragraph within room."""
    kind, detail = view['outcome'], view.get('detail') or {}
    if kind == 'doesnt-merge':
        return [f"This head couldn't be compared: it doesn't merge onto {code(view['base'][:12])}."]
    if kind == 'needs-companion' and 'hostHas' in detail:
        who = 'it' if detail['arm'] == 'head' else 'its base'
        return [f"This head couldn't be compared: {who} asks for {code(str(detail.get('package')))} {code(str(detail.get('range')))}, "
                f"and the host's lockfile has {code(str(detail.get('hostHas')))}."]
    if kind == 'needs-companion':
        arm = ARMS[kind][detail['arm']]
        has = (f"the {arm}'s is {code(str(detail['version']))}" if detail.get('version') is not None
               else f"the {arm}'s {code('package.json')} gives no version")
        wanted = str(detail.get('wantedBy')).rsplit('node_modules/', 1)[-1]
        return [f"This head couldn't be compared: {code(wanted)} in the host's stack asks for "
                f"{code(str(detail.get('package')))} {code(str(detail.get('range')))}, and {has}."]
    if kind == 'arm-missing':
        log = one_line(detail.get('log') or '')
        lead = (f"This head couldn't be compared: one of its {counted(view['jobs'], 'job', 'jobs')} came back without the "
                f"{ARMS[kind][detail['arm']]} arm's results")
        return [clipped(lambda shown, part: lead + f" (its last log line{part}: {inert(shown)}).", log, room) if log else lead + '.']
    said = {'head': "the head couldn't run it", 'base': "the base couldn't run it",
            'varies': "its self-check, which drives this head again with recording off, didn't find the two drives' requests the "
                      "same, so a difference from the base can't be put down to the change alone",
            'unchecked': "the head wasn't self-checked",
            'outcome': "the harness gave it an outcome the view doesn't know",
            'drive': "the head's second drive, with recording off, couldn't show that recording changes nothing it sends"}

    def why(b):
        parts = []
        if b['what'] == 'unmeasured':
            sides = [f"on the {arm}, {listed(inert(x) for x in names)}" for arm, names in b['unmeasured'].items() if names]
            parts.append(f"the run didn't measure ({'; '.join(sides)})")
        elif b['what'] != 'read':
            parts.append(said[b['what']])
        failed = [f"the {arm}'s {'read' if len(names) == 1 else 'reads'} of {listed(inert(x) for x in names)}"
                  for arm, names in (b.get('reads') or {}).items() if names]
        if failed:
            parts.append(f"{failed[0]} failed" if len(failed) == 1 else f"{', and '.join(failed)}, failed")
        if b.get('unreadable'):
            parts.append("the head's quarantine count couldn't be read")
        return ', and '.join(parts)

    def reason(b):
        def words(shown, part):
            said = [x for x in (inert(shown) if shown else '', f'the reason{part}' if part else '') if x]
            return f"This head couldn't be compared at {code(b['run'])}: {why(b)}" + (f" ({', '.join(said)})." if said else '.')
        return clipped(words, one_line(b['reason']), room)
    return [reason(b) for b in view.get('broken') or []]


def held_text(view):
    held = dict(view.get('held') or {})
    if view['form'] == 'overlay':
        held = {'connectome-host': view['host'][:12], **held}
    return 'Held the same in base and head: ' + ', '.join(f'{inert(k)} {code(v)}' for k, v in held.items()) + '.' if held else None


def flags_line(view, flagged):
    """What the flags fold holds, said apart from the records' differences: the checks' flags that differ between the base
    and the head, counted with the runs they're in."""
    flagged_runs = len({f['run'] for f in view.get('flags') or [] if f['new'] or f['gone']})
    differ, listed = ('differs', "it's") if flagged == 1 else ('differ', "they're")
    return (f"Separately, {flagged:,} of the checks' flags {differ} between the base and the head, in "
            f"{counted(flagged_runs, 'run', 'runs')}; {listed} listed under \"Checks' flags that differ\", below.")


def flags_text(view, room):
    """The flags that differ, a paragraph for each distinct flag, each flag's text cut to fit room where it doesn't. The
    harness pairs a head's flags with the base's one for one, so a `new` flag says only that the head raised it once more
    than the base; identical flags in one run, on one side (alike in check, step, what, detail and whole, as the harness's
    flagKey matches them), are one line saying how many more times one side raised it than the other. Lines of one run
    that would show the same check, step and text, on either side, stand for flags whose texts differ only past what's
    shown, and each says so."""
    out = []
    for f in view.get('flags') or []:
        groups = []
        for side, more, than in (('new', 'head', 'base'), ('gone', 'base', 'head')):
            times = {}
            for flag in f[side]:
                key = json.dumps([flag.get(k) for k in ('check', 'step', 'what', 'detail', 'whole')])
                times.setdefault(key, [flag, 0, more, than])[1] += 1
            groups += times.values()
        def face(flag):
            return json.dumps([flag.get(k) for k in ('check', 'step', 'what', 'detail')])
        alike = {}
        for flag, *_ in groups:
            alike.setdefault(face(flag), set()).add(json.dumps(flag.get('whole')))
        for flag, n, more, than in groups:
            step = flag.get('step')
            where = f" step {code(str(step))}" if step not in (None, '', 'the run') else ''
            often = '1 more time' if n == 1 else f'{n:,} more times'
            past = ' (the flags on these lines differ past the text shown)' if len(alike[face(flag)]) > 1 else ''
            line = (f"- {code(f['run'])}{where}, check {code(str(flag.get('check')))}{past} flagged on the {more} {often} "
                    f"than on the {than}")
            said_by = [t for t in (one_line(x) for x in (flag.get('what'), flag.get('detail')) if x) if t]
            if not said_by:
                out.append(line)
                continue

            def words(shown, part, line=line):
                return line + (f': {inert(shown)}' if shown else '') + (f' (the flag{part})' if part else '')
            # The name and the detail are rendered as one text, so nothing GitHub would make live can form across the ': '
            # between them, as `:smile` and `: ` make an emoji.
            out.append(clipped(words, ': '.join(said_by), room))
    return ["The checks' flags that differ between base and head:", *out] if out else []


def known(change, entries):
    """change, once each entry it names is one the view has."""
    need(change['refs'], f"change {change['title']!r} names no entry")
    unknown = [r for r in change['refs'] if r not in entries]
    need(not unknown, f"change {change['title']!r} names {unknown} entries the view doesn't have")
    return change


def quoted_in(change, entries):
    """The run a change's quotes are from: its place's, which the workflow gives every change, one of the change's own."""
    need(change.get('place'), f"change {change['title']!r} names no place its quotes are from")
    run, step = str(change['place']['run']), str(change['place']['step'])
    need((run, step) in {(p['run'], str(p['step'])) for r in dict.fromkeys(change['refs']) for p in entries[r]['places']},
         f"change {change['title']!r} is quoted from {code(run)} at step {code(step)}, a place it doesn't have")
    return run


def change_block(change, entries, run, quoted, room):
    """A change as run's fold shows it: its title and its steps in run, then its quotes where they're from run (quoted, the
    run they're from), else where they are. A quote too long for room shows its first characters, and
    says how many of how many, outside its fence, since GitHub holds a comment to 65,536 characters."""
    steps = list(dict.fromkeys(str(p['step']) for r in dict.fromkeys(change['refs']) for p in entries[r]['places'] if p['run'] == run))
    at = f"At step {code(steps[0])}" if len(steps) == 1 else f"At {counted(len(steps), 'step', 'steps')}"
    step = str(change['place']['step'])
    head = [f"*{inert(one_line(change['title']))}*"]
    if run != quoted:
        said = '\n\n'.join([*head, f"{at}. Its before and after are quoted under {code(quoted)}, at step {code(step)}."])
        need(len(said) <= room, f"change {change['title']!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters")
        return said
    head.append(at + (f"; the quotes are from step {code(step)}." if steps != [step] else '.'))

    def text(keep):
        body = list(head)
        for side in ('before', 'after'):
            quote = str(change[side])
            if not quote:
                body.append(f'{side.capitalize()}: none.')
                continue
            shown = quote if keep is None or len(quote) <= keep else quote[:keep]
            label = (f'{side.capitalize()}:' if shown == quote
                     else f'{side.capitalize()}, its first {len(written(shown)):,} of {len(written(quote)):,} characters:')
            body += [label, fence(shown)]
        return '\n\n'.join(body)
    whole = text(None)
    if len(whole) <= room:
        return whole
    sides = [str(change[side]) for side in ('before', 'after') if change[side]]
    need(sides, f"change {change['title']!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters, and has no quote to cut")
    keep = max(0, (room - len(text(0))) // len(sides))
    cut = text(keep)
    while len(cut) > room and keep > 0:
        keep = max(0, keep - -(-(len(cut) - room) // len(sides)))
        cut = text(keep)
    need(len(cut) <= room, f"change {change['title']!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters even with its quotes cut")
    return cut


LINKED = "What a context view runs and what its checks judge: [CHECKS.md]({checks})."


# The stopped words' pointer to what a view does: CHECKS.md on main.
CHECKED = f"What a context view runs and what its checks judge are in [CHECKS.md](https://github.com/{HARNESS}/blob/main/CHECKS.md)."


def linked(view):
    """Above the fold: CHECKS.md at the harness commit the view used."""
    return LINKED.format(checks=f"https://github.com/{HARNESS}/blob/{view['harness']['sha']}/CHECKS.md")


def folded(summary, items, room):
    """items under a collapsible whose summary is summary, as HTML: one where they all fit in room, else as many as hold
    them, each after the first titled as continued. An item too long for the collapsible it falls in, alone, fails the step."""
    def wrap(name, body):
        return '\n\n'.join([f'<details><summary>{name}</summary>', *body, '</details>'])
    out, body = [], []
    for item in items:
        name = f'{summary}, continued' if out else summary
        if body and len(wrap(name, [*body, item])) > room:
            out.append(wrap(name, body))
            body, name = [], f'{summary}, continued'
        need(len(wrap(name, [item])) <= room,
             f"one line of {summary!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters: {item[:200]}")
        body.append(item)
    if body:
        out.append(wrap(f'{summary}, continued' if out else summary, body))
    return out


def inside(room, summary):
    """The room one line has inside a collapsible whose summary is summary, continued."""
    return room - len(f'<details><summary>{summary}, continued</summary>\n\n\n\n</details>')


def run_folds(view, reader, entries, room):
    """A collapsible for each run with a place in the entries, in the harness's order, each holding every change the reader
    names there, in the reader's order: as many collapsibles as hold them, each within room."""
    quoted = [quoted_in(c, entries) for c in reader['changes']]
    out = []
    for run in view['order']:
        here = [(c, q) for c, q in zip(reader['changes'], quoted)
                if any(p['run'] == run for r in dict.fromkeys(c['refs']) for p in entries[r]['places'])]
        if here:
            summary = f"<code>{html.escape(one_line(run))}</code>: {counted(len(here), 'change', 'changes')}"
            out += folded(summary, [change_block(c, entries, run, q, inside(room, summary)) for c, q in here], room)
    return out


def said_line(change, field):
    """A change's one-line text in field, which the account must give, and must give as a line of text where it gives it."""
    need(field in change, f"change {change['title']!r} gives no {field}")
    text = change[field]
    article = 'an' if field[0] in 'aeiou' else 'a'
    need(isinstance(text, str) and one_line(text), f"change {change['title']!r} gives {article} {field} that isn't a line of text")
    return one_line(text)


def deltas(view, reader):
    """Above the fold, each change in the account's order, numbered: its title, and whether the description mentions it;
    where it changed and the earlier change it follows from, if the account names one; then what the base's run had there
    and what the head's has instead, each labelled with its branch or commit, and where else the same change is carried,
    if the account says."""
    out = []
    for n, c in enumerate(reader['changes'], 1):
        follows, unmentioned = c.get('follows'), c.get('unmentioned')
        need('follows' not in c or (type(follows) is int and 1 <= follows < n),
             f"change {c['title']!r} follows {follows!r}, which isn't an earlier delta's number")
        need('unmentioned' not in c or unmentioned is True, f"change {c['title']!r} gives unmentioned as {unmentioned!r}, not true")
        out.append('\n\n'.join([
            f"**Delta {n}: {inert(one_line(c['title']))}**" + (" (the description doesn't mention it)" if unmentioned else ''),
            ended(inert(said_line(c, 'where'))) + (f" Follows from Delta {follows}." if follows else ''),
            f"- base ({code(one_line(view['baseRef']))}): {ended(inert(said_line(c, 'base')))}\n"
            f"- head ({code(view['head'][:12])}): {ended(inert(said_line(c, 'head')))}"
            + (f"\n- Also in: {ended(inert(said_line(c, 'also')))}" if 'also' in c else '')]))
    return out


def lost_line(lost):
    """Above the fold: how many runs couldn't be compared, and where their reasons are."""
    return (f"1 run couldn't be compared; its reason is below." if lost == 1
            else f"{lost:,} runs couldn't be compared; the reasons are below.")


def units(view, reader, room):
    """The comment's paragraphs below its first line, in order: CHECKS.md's link first. Where some runs were compared,
    the result and how many runs couldn't be compared where some couldn't; then, where the records differ, the account's
    numbered deltas and a fold of the runs that differ, or, where they don't, the flags that differ; then folds of the
    uncompared runs' reasons, and where the records differ of the flags that differ, each where there are any. Where
    none was, each reason and the flags that differ. What was held the same is last, where the runs ran and it holds
    any."""
    held = [x for x in [held_text(view)] if x]
    if view['outcome'] != 'ran':
        need(reader is None, "a head that couldn't be compared has no reader account")
        return [linked(view), *could_not(view, room)]
    some, partial = view['runs']['compared'], bool(view.get('broken'))
    if not some:
        need(reader is None, "a head none of whose runs could be compared has no reader account")
        return [linked(view), *could_not(view, room), *flags_text(view, room), *held]
    runs = f"the {counted(some, 'run', 'runs')} it could compare" if partial else f"the {counted(some, 'run', 'runs')}"
    lost = len(view.get('broken') or [])
    reasons = summary_text(f"Runs that couldn't be compared ({lost:,})")
    lost_fold = folded(reasons, could_not(view, inside(room, reasons)), room) if lost else []
    if not view['entries']:
        need(reader is None, "a head whose runs it could compare don't differ has no reader account")
        return [linked(view),
                f"The records of {runs} don't differ between the base and this head, so no request changed{' in them' if partial else ''}.",
                *([lost_line(lost)] if lost else []), *flags_text(view, room), *lost_fold, *held]
    need(reader is not None, 'a view whose records differ needs the reader account')
    entries = {e['id']: e for e in view['entries']}
    reader = {**reader, 'changes': [known(c, entries) for c in reader['changes']]}
    changed = len({p['run'] for e in view['entries'] for p in e['places']})
    flagged = sum(len(f['new']) + len(f['gone']) for f in view.get('flags') or [])
    count = f"The records of {changed:,} of {runs} differ between the base and this head."
    differ = summary_text(f"Runs whose records differ: {changed:,} of {some:,}, with {counted(len(reader['changes']), 'change', 'changes')}")
    flags = summary_text(f"Checks' flags that differ ({flagged:,})")
    return [linked(view), count, *([lost_line(lost)] if lost else []), *([flags_line(view, flagged)] if flagged else []),
            "*A model's account of those records:*", *deltas(view, reader),
            *folded(differ, run_folds(view, reader, entries, inside(room, differ)), room), *lost_fold,
            *(folded(flags, flags_text(view, inside(room, flags))[1:], room) if flagged else []), *held]


def parts_of(view, reader, first, digest, head_now):
    """The comment as GitHub takes it: as few comments as hold it, each under 65,536 characters with its marker, the first
    with room for the longest first line an edit can give it."""
    later = f"**Automatic context view** of {code(first[:12])}, continued."
    out, body, n = [], [], 1

    def room(k):
        top = widest(view) if k == 1 else len(later)
        return COMMENT_MAX - top - len(f'\n\n\n\n{MORE}\n\n') - len(mark(view, first, digest, k if k > 1 else 1))
    for unit in units(view, reader, room(1)):
        if body and len('\n\n'.join([*body, unit])) > room(n):
            out.append(body)
            body, n = [], n + 1
        need(len(unit) <= room(n), f"one paragraph of the comment doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters: {unit[:200]}")
        body.append(unit)
    out.append(body)
    texts = []
    for k, items in enumerate(out, 1):
        top = opening(view, first, head_now) if k == 1 else later
        texts.append('\n\n'.join([top, *items, *([MORE] if k < len(out) else []), mark(view, first, digest, k)]))
    return texts


def on_pull(repo, number, token, app_id):
    """The App's context-view comments on the pull request, each with its marker's fields."""
    found, page = [], 1
    while True:
        got = pr_review.api('GET', f'/repos/{repo}/issues/{number}/comments?per_page=100&page={page}', token)
        for c in got:
            m = MARK.search((c.get('body') or '').rstrip())
            if (c.get('performed_via_github_app') or {}).get('id') == app_id and m:
                found.append((c, m.groupdict()))
        if len(got) < 100:
            return found
        page += 1


def chains(found):
    """The posted comments, each by its first head and result: its parts in order, whether it's whole (every part from 1
    there and the last saying none follow), the head its first part claims, if that part is there, and its first part's
    id, which orders comments as GitHub made them."""
    grouped = {}
    for c, g in found:
        if g['first']:
            grouped.setdefault((g['first'], g['result']), []).append((int(g['part'] or 1), c, g))
    out = []
    for (first, result), parts in grouped.items():
        parts.sort(key=lambda p: (p[0], p[1]['id']))
        whole = ([n for n, _, _ in parts] == list(range(1, len(parts) + 1))
                 and not MARK.sub('', parts[-1][1]['body'].rstrip()).rstrip().endswith(MORE))
        out.append({'first': first, 'result': result, 'parts': [c for _, c, _ in parts], 'whole': whole,
                    'claims': parts[0][2]['head'] if parts[0][0] == 1 else None, 'id': parts[0][1]['id']})
    return out


def deleted(repo, token, comments):
    """Deletes the comments in order, trying each; if GitHub refuses any, fails naming each comment still there."""
    left = []
    for c in comments:
        try:
            pr_review.api('DELETE', f"/repos/{repo}/issues/comments/{c['id']}", token, missing=True, repeat=True)
        except pr_review.Failed as e:
            left.append(f"{c.get('html_url')} may still be there, since deleting it failed: {e}")
    if left:
        raise pr_review.Failed('; '.join(left))


def worded(e):
    """An exception's words for a step's message: a Failed's own; any other's after its kind, with its traceback printed
    first, since it may be a fault in the step's own code."""
    if isinstance(e, pr_review.Failed):
        return str(e)
    traceback.print_exception(e)
    return f'{type(e).__name__}: {e}'


def unposted(repo, number, token, app_id, head, digest):
    """Deletes the parts of this head's comment that the pull request lists once its posting has failed, so none says a
    continuation follows, and says what became of them. A part GitHub made but doesn't list yet isn't among them."""
    try:
        for x in chains(on_pull(repo, number, token, app_id)):
            if (x['first'], x['result']) == (head, digest):
                deleted(repo, token, x['parts'])
    except Exception as e:
        return f'deleting the parts of its comment that went up failed too: {worded(e)}'
    return 'the parts of its comment the pull request then listed are deleted'


def post(args):
    """The view's comment, one per head, the latest always the latest run's: the latest comment, when it's whole and has
    this result, is kept and has its first line and marker made this head's; else a new one posts. A comment first posted at
    this head with this result, whose markers a new one would share, is deleted first; every other comment that claims this
    head, and one whose parts didn't all post, once this head's comment is there, and then this head's stopped words. A
    posting that fails partway, however it fails, deletes the parts the pull request then lists before it fails the step,
    saying what became of them."""
    d = args['dir']
    view = read_json(os.path.join(d, 'view.json'))
    repo, number, head = view['repo'], view['number'], view['head']
    if view['outcome'] in ('moved', 'closed'):
        return {'action': view['outcome']}
    need(view['outcome'] != 'couldnt-run', "a run that couldn't run posts its stopped words, through stopped")
    reader = read_json(args['reader']) if args.get('reader') else None
    sources = args.get('reads')
    need((reader is None) == (sources is None), "post: reads, the sha256 of the reader's instructions and guide, goes with a reader account and only with one")
    need(sources is None or isinstance(sources, dict) and set(sources) == {'instructions', 'guide'}
         and all(isinstance(x, str) and re.fullmatch('[0-9a-f]{64}', x) for x in sources.values()),
         "post: reads is {instructions, guide}, each a sha256 in lowercase hex")
    digest = result_of(view, sources)
    if not args.get('post', True):
        texts = parts_of(view, reader, head, digest, head)
        for name in os.listdir(d):
            if re.fullmatch(r'comment(-[0-9]+)?\.md', name):
                os.remove(os.path.join(d, name))
        for k, text in enumerate(texts, 1):
            with open(os.path.join(d, 'comment.md' if k == 1 else f'comment-{k}.md'), 'w') as f:
                f.write(text)
        return {'action': 'dry', 'parts': len(texts)}
    parts_of(view, reader, head, digest, head)
    token, app_id = viewed(repo)
    pr = pr_review.api('GET', f'/repos/{repo}/pulls/{number}', token)
    if pr.get('state') != 'open':
        return {'action': 'closed', 'state': pr.get('state')}
    head_now = pr['head']['sha']
    found = on_pull(repo, number, token, app_id)
    held = chains(found)
    latest = max((x for x in held if x['claims']), key=lambda x: x['id'], default=None)
    keep = latest if latest is not None and latest['whole'] and latest['result'] == digest else None
    for x in held:
        if x is not keep and (x['first'], x['result']) == (head, digest):
            deleted(repo, token, x['parts'])
    if keep is not None:
        c = keep['parts'][0]
        top, rest = c['body'].split('\n\n', 1)
        text = '\n\n'.join([opening(view, keep['first'], head_now), MARK.sub(mark(view, keep['first'], digest), rest.rstrip())])
        action = 'unchanged' if text == c['body'].rstrip() else 'edited'
        if action == 'edited':
            pr_review.api('PATCH', f"/repos/{repo}/issues/comments/{c['id']}", token, body={'body': text}, repeat=True)
        url = c.get('html_url')
    else:
        texts = parts_of(view, reader, head, digest, head_now)
        marks = [mark(view, head, digest, k) for k in range(1, len(texts) + 1)]
        try:
            done = pr_review.posted(repo, number, token, app_id, marks, texts, {})
        except Exception as e:
            raise pr_review.Failed(f'{worded(e)}; {unposted(repo, number, token, app_id, head, digest)}') from e
        action, url = 'posted', done[marks[0]].get('html_url')
    stale = []
    for x in held:
        if x is not keep and (x['first'], x['result']) != (head, digest) and (x['claims'] == head or not x['whole']):
            try:
                deleted(repo, token, x['parts'])
            except pr_review.Failed as e:
                stale.append(str(e))
    kept = [k for k in (pr_review.unsaid(repo, token, c) for c, g in found if g['stopped'] == head) if k]
    return {'action': action, 'url': url, **({'staleKept': stale} if stale else {}), **({'stoppedKept': kept} if kept else {})}


def stopped(args):
    repo, number, head = args['repo'], args['number'], args['head']
    need(full_sha(head), f"head isn't a full commit sha, {head!r}")
    said = stopped_mark(head)
    text = '\n\n'.join([f"**Automatic context view** of {code(head[:12])} stopped before it finished, so it has nothing to report.",
                         CHECKED, said])
    if not args.get('post', True):
        return {'action': 'dry', 'text': text}
    token, app_id = viewed(repo)
    found = on_pull(repo, number, token, app_id)
    held = chains(found)
    there = ([('view', x['parts'][0]) for x in held if x['claims'] == head and x['whole']]
             or [('stopped', c) for c, g in found if g['stopped'] == head])
    if there:
        return {'action': 'unchanged', 'found': there[0][0], 'url': there[0][1].get('html_url')}
    pr = pr_review.api('GET', f'/repos/{repo}/pulls/{number}', token)
    if pr.get('state') != 'open':
        return {'action': 'closed', 'state': pr.get('state')}
    if pr['head']['sha'] != head:
        return {'action': 'moved', 'headNow': pr['head']['sha']}
    for x in held:
        if not x['whole']:
            deleted(repo, token, x['parts'])
    done = pr_review.posted(repo, number, token, app_id, [said], [text], {})
    return {'action': 'posted', 'url': done[said].get('html_url')}


def rooms(args):
    """pr_review's rooms, each with its tender, as one of the view's own steps, so every step a run calls comes from one
    install. The workflow running a view says a reader its provider refused in the covered one."""
    return pr_review.rooms(args)


STEPS = {'facts': facts, 'post': post, 'stopped': stopped, 'rooms': rooms}


# The workflow running a view keeps the last 1,500 characters of a step's stderr.
KEPT = 1500


def kept_whole(line):
    """A refusal cut at its end to what the workflow keeps, so its start, which says what was refused, is what it keeps."""
    return line if len(line) <= KEPT else line[:KEPT - 1] + '…'


CHECKOUT = '~/astra/context-view'


def refuse_checkout(module, command, code):
    """Exits CODE, saying why, when MODULE, the __file__ of a module whose command line was run, is in the main working copy,
    its own environment included, naming COMMAND, its installed form."""
    home = os.path.realpath(os.path.expanduser(CHECKOUT))
    if os.path.commonpath([os.path.realpath(module), home]) != home:
        return
    print(f'{os.path.basename(module)}: the context view runs from its install, not from its main working copy {CHECKOUT}: '
          f'use `{command}`, or a worktree to run your own code', file=sys.stderr)
    sys.exit(code)


def main(argv=None):
    if argv is None:
        refuse_checkout(__file__, '~/.local/lib/context-view/current/view/.venv/bin/python -I -m view STEP', 1)
    p = argparse.ArgumentParser(prog='view.py', description=__doc__.split('\n\n')[0])
    p.add_argument('step', choices=sorted(STEPS))
    o = p.parse_args(argv)
    try:
        given = json.load(sys.stdin)
        need(isinstance(given, dict), 'stdin: one JSON object')
        print(json.dumps(STEPS[o.step](given)))
    except NotARequest as e:
        print(kept_whole(f'view.py {o.step}: {e}'), file=sys.stderr)
        return 2
    except Failed as e:
        print(kept_whole(f'view.py {o.step}: {e}'), file=sys.stderr)
        return 1
    except (KeyError, IndexError, TypeError, AttributeError, ValueError):
        traceback.print_exc()
        print(f"view.py {o.step}: a field it reads is missing or of another shape, or the step's own code failed; the "
              'traceback above says which', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

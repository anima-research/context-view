"""What a view reads: the run's manifest and each share's arms, with their results, flags, usage, upgrades and reach, each
checked against what the run side and the harness can give, into view.json (facts, compared)."""
import datetime, os, re

import pr_review
from pr_comment import one_line
from pr_run import Failed, need, read_json, refuse, write_json
from view_usage import usage_read
from view_words import ARMS, CHOSEN, HARNESS

VIEWED = {1126567876: 'anima-research/context-manager', 1132522869: 'anima-research/agent-framework',
          1123531033: 'antra-tess/membrane', 1170978461: 'anima-research/connectome-host'}
KEY = 'context-view/'
OUTCOMES = ('ran', 'moved', 'closed', 'couldnt-run', 'doesnt-merge', 'needs-companion', 'arm-missing', 'elsewhere', 'unchanged')
UNRUN = ('moved', 'closed', 'elsewhere', 'unchanged')
REACHED = {'ran': ('k', 'src'), 'arm-missing': ('k', 'src'), 'needs-companion': ('k', 'src'), 'unchanged': ('k',)}
CHECKS = ('same', 'differs', 'couldnt-run')
# A run's outcomes as the harness gives them.
RESULTS = ('pass', 'flags', 'invalid', 'couldnt-run')
FORMS = ('overlay', 'host')
# The package an overlay repository's pull request packs, by the repository's GitHub ID, as the run side's REPOS names it.
PACKS = {1126567876: '@animalabs/context-manager', 1132522869: '@animalabs/agent-framework', 1123531033: '@animalabs/membrane'}
SHA = re.compile(r'[0-9a-f]{40}')

ENTRIES = 'entries.json'
PARTS = re.compile(r'comment(-[0-9]+)?\.md')


def full_sha(v):
    return isinstance(v, str) and SHA.fullmatch(v) is not None


def key_of(repo_id, number, head):
    """A view's run key, by the repository's GitHub ID, so a rename or a transfer keeps a head's view its own."""
    return f'{KEY}{repo_id}#{number}@{head}'


def facts(args):
    """view.json, the one file the reader, its check and post read: the manifest's facts, the pull request's title and
    description as GitHub gives them now, and each share's head arm read and merged."""
    d, repo = args['dir'], args['repo']
    m = read_json(os.path.join(d, 'manifest.json'))
    need(m.get('repo') == repo.split('/', 1)[1], f"manifest.json names {m.get('repo')!r}, not {repo}")
    token, _, repo_id = viewed(repo)
    view = manifested(m, repo)
    if view['outcome'] not in ('moved', 'closed'):
        pr = pr_review.api('GET', f"/repos/{repo}/pulls/{m['number']}", token)
        view['title'], view['body'] = pr.get('title') or '', pr.get('body') or ''
    if 'forced' in view:
        view['pack'] = PACKS.get(repo_id)
    if view['outcome'] == 'ran':
        view.update(arms(d, m, PACKS.get(repo_id)), reach=reach_of(d), ended=ended_of(d))
    return answered(d, view)


def ended_of(d):
    """When the view's run side finished: its manifest's mtime, to the second in UTC as review-poll's want takes it. facts
    reads it with the rest of the view, so a view started beside this one in its directory can't move it before post."""
    at = os.stat(os.path.join(d, 'manifest.json')).st_mtime
    return datetime.datetime.fromtimestamp(at, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def compared(args):
    """view.json from a harness compare's two outputs rather than a view's run, for a dry view of a change no pull request
    holds: DIR's share-<i>/{before,after}, laid out as a view's shares, are read as facts reads them, under a manifest.json
    written from the fields given as the run side writes them, with the title and description given standing for the pull
    request's. Where DIR holds a reach.json, as the harness's reachJoined writes from the shares' reach-digests.json, the
    view reads it as facts does; without one, its comment has no reach paragraph. Nothing is asked of GitHub. Once DIR is
    a directory, it removes view.json, manifest.json, reader.json and the comment's parts, as an earlier view writes them
    there, before any other check, so whether it writes this view or refuses, none of those files predates it; it writes
    view.json last, so a manifest that can't be written leaves none."""
    d = args['dir']
    need(os.path.isdir(d), f"{d} isn't a directory")
    for name in os.listdir(d):
        if name in ('view.json', 'manifest.json', 'reader.json') or PARTS.fullmatch(name):
            os.remove(os.path.join(d, name))
    repo = args.get('repo')
    need(repo in VIEWED.values(), f"{repo} isn't one of the context view's repositories")
    shares = sorted(int(s[1]) for s in (re.fullmatch(r'share-([1-9][0-9]*)', name) for name in os.listdir(d)) if s)
    need(shares, f"{d} holds no share-<i> directory")
    need(isinstance(args.get('title'), str) and isinstance(args.get('body'), str), "compared: title and body are the pull request's, each a string")
    m = {'repo': repo.split('/', 1)[1], **{k: args.get(k) for k in ('number', 'head', 'form', 'base', 'host', 'harness')},
         **({'stack': args['stack']} if 'stack' in args else {}), **({'forced': args['forced']} if 'forced' in args else {}), 'outcome': 'ran', 'detail': None,
         'shares': [{'i': i, 'dir': f'share-{i}'} for i in shares]}
    pack = PACKS.get(next(k for k, v in VIEWED.items() if v == repo))
    view = {**manifested(m, repo), 'title': args['title'], 'body': args['body'], **({'pack': pack} if 'forced' in m else {}), **arms(d, m, pack),
            **({'reach': reach_of(d)} if os.path.exists(os.path.join(d, REACH)) else {})}
    write_json(os.path.join(d, 'manifest.json'), m)
    return answered(d, {**view, 'ended': ended_of(d)})


def manifested(m, repo):
    need(m.get('outcome') in OUTCOMES, f"manifest.json: an outcome the view doesn't know, {m.get('outcome')!r}")
    need(full_sha(m.get('head')), f"manifest.json: head isn't a full commit sha, {m.get('head')!r}")
    need(type(m.get('number')) is int and m['number'] > 0, 'manifest.json: number')
    merge = m.get('merge')
    need(merge is not None or m['outcome'] not in ('elsewhere', 'unchanged'), f"manifest.json: merge is missing from a merged pull request's {m['outcome']}")
    need(merge is None or isinstance(merge, dict) and merge.get('commit') == m['head']
         and all(type(merge.get(k, 0)) is int and merge.get(k, 0) >= 0 for k in ('k', 'n')) and type(merge.get('src', False)) is bool
         and all(k in merge for k in REACHED.get(m['outcome'], ())),
         f"manifest.json: merge isn't the head's merge commit with the counts and src its outcome had reached, {merge!r}")
    merged = {} if merge is None else {'merge': merge}
    if m['outcome'] in UNRUN:
        return {'repo': repo, 'number': m['number'], 'head': m['head'], 'outcome': m['outcome'], 'detail': m.get('detail'), **merged}
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
    if 'stack' in m:
        stack = m['stack']
        need(m['form'] == 'overlay' and isinstance(stack, dict) and set(stack) == {'base', 'head'}
             and all(isinstance(stack[side], dict) for side in stack), 'manifest.json: stack is a base and a head of chosen releases, for an overlay')
        for side, chosen in stack.items():
            for name, c in chosen.items():
                missed = c.get('missed', {'package': '', 'range': '', 'wantedBy': None, 'has': None}) if isinstance(c, dict) else None
                need(isinstance(c, dict) and type(c.get('version')) is str and type(c.get('host')) is str and type(c.get('asks', '')) is str
                     and isinstance(c.get('ranges'), list) and all(asked(r) for r in c['ranges'])
                     and asked(missed) and type(missed.get('package')) is str and (missed.get('has', '') is None or type(missed.get('has')) is str),
                     f"manifest.json: stack's {side} {name} isn't a chosen release, {c!r}")
    if 'forced' in m:
        forced = m['forced']
        need(m['form'] == 'overlay' and isinstance(forced, dict) and set(forced) == {'base', 'head'}
             and all(isinstance(forced[side], list) for side in forced) and any(forced[side] for side in forced),
             'manifest.json: forced is a base and a head of forced ranges, one at least, for an overlay')
        for side, ranges in forced.items():
            for f in ranges:
                need(asked(f) and isinstance(f['wantedBy'], str) and (CHOSEN.fullmatch(f['wantedBy']) or LOCKFILE_KEY.fullmatch(f['wantedBy']))
                     and type(f.get('has')) is str, f"manifest.json: forced's {side} holds one that isn't a forced range, {f!r}")
            need(len({f['has'] for f in ranges}) <= 1, f"manifest.json: forced's {side} runs more than one version of the package, {ranges!r}")
    return {'repo': repo, 'number': m['number'], 'head': m['head'], 'base': m['base']['sha'], 'baseRef': base['ref'], 'form': m['form'],
            'host': m['host']['sha'], 'harness': {'repo': HARNESS, 'sha': harness['sha']}, 'outcome': m['outcome'],
            'detail': m.get('detail'), 'jobs': len(m.get('shares') or []), **({'stack': m['stack']} if 'stack' in m else {}),
            **({'forced': m['forced']} if 'forced' in m else {}), **merged}


def asked(r):
    """A range in an arm's stack as the plan records it: the range, and who asks it (wantedBy, null for the arm's own)."""
    return isinstance(r, dict) and type(r.get('range')) is str and 'wantedBy' in r and (r['wantedBy'] is None or type(r['wantedBy']) is str)


def answered(d, view):
    path = os.path.join(d, 'view.json')
    write_json(path, view)
    return {'path': path, 'changed': view['outcome'] == 'ran' and bool(view['entries'])}


def viewed(repo):
    """The App's token for one of the four repositories, which are known by their GitHub IDs, so a rename or a transfer
    keeps its place, with the App's ID and the repository's. Any other repository the App is installed on is refused; one it
    isn't installed on fails at its token, with GitHub's 404. Which repositories review-workflow's own review covers doesn't
    bear on it."""
    token, _, app_id = pr_review.app_token(repo)
    repo_id = pr_review.api('GET', f'/repos/{repo}', token)['id']
    refuse(repo_id in VIEWED, f"{repo} isn't one of the context view's repositories")
    return token, app_id, repo_id


def parsed(d, path):
    """A share's file read as JSON, or a failure naming it."""
    try:
        return read_json(path)
    except ValueError as e:
        raise Failed(f"{os.path.relpath(path, d)} isn't JSON: {e}") from e


def arms(d, m, pack):
    results, order, before, after, merged, based = {}, None, None, None, {}, {}
    for share in m['shares']:
        paths = [os.path.join(d, share['dir'], arm, 'run.json') for arm in ('after', 'before')]
        need(all(os.path.exists(p) for p in paths), f"{share['dir']}: an arm wrote no run.json, though the run's outcome is ran")
        head, base = (parsed(d, p) for p in paths)
        need(order is None or head['runs'] == order, f"{share['dir']}: its run.json orders the runs differently")
        order = head['runs']
        versions = (base['candidate']['versions'], head['candidate']['versions'])
        need(before is None or versions == (before, after), f"{share['dir']}: its arms' versions differ from another share's")
        before, after = versions
        own_base = {}
        for r in base.get('results') or []:
            need(isinstance(r, dict) and type(r.get('run')) is str, f"{share['dir']}: the base arm's results hold one that isn't a run's result")
            need(r['run'] not in own_base, f"run {r['run']} is twice in {share['dir']}'s base arm")
            own_base[r['run']] = r
        for r in head['results']:
            need(r['run'] not in results, f"run {r['run']} is in two shares")
            need(broken(r) or ('flags' in r and 'counts' in r), f"{share['dir']}: {r['run']}'s result has no flags or counts to compare")
            for key in ('absent', 'baseAbsent'):
                stretches(r, key)
            results[r['run']] = r
            if r['run'] in own_base:
                based[r['run']] = own_base[r['run']]
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
    differing = []
    if m['form'] == 'overlay':
        stack = m.get('stack') or {'base': {}, 'head': {}}
        arms = {'base': before, 'head': after}
        for side, other in (('base', 'head'), ('head', 'base')):
            for name, c in stack[side].items():
                need((arms[side].get(name) or '').split(' ')[0] == c['version'],
                     f"the {side} arm ran {name} {arms[side].get(name)!r}, not the {c['version']} the plan chose")
                need(name in stack[other] or (arms[other].get(name) or '').split(' ')[0] == c['host'],
                     f"the {other} arm ran {name} {arms[other].get(name)!r}, not the lockfile's {c['host']}, though the plan chose "
                     f"{name} for the {side} alone")
        for name in sorted(set(before) | set(after)):
            if name.startswith('@animalabs/') and name not in ('@animalabs/connectome-host', pack) and before.get(name) != after.get(name):
                need(name in stack['base'] or name in stack['head'], f"the arms ran different {name}, {before.get(name)!r} in the base "
                     f"and {after.get(name)!r} in the head, which the plan didn't choose")
                b, h = before[name].split(' ')[0], after[name].split(' ')[0]
                need(b != h, f"the arms ran {name} {b} with different contents, {before[name]!r} in the base and {after[name]!r} in the head")
                differing.append({'package': name.split('/', 1)[1], 'base': b, 'head': h})
    ran = [results[r] for r in order]
    comparable = [r for r in ran if not broken(r)]
    placed = {p['run'] for e in merged.values() for p in e['places']}
    for r in comparable:
        need(r['record'] == ('differs' if r['run'] in placed else 'same'),
             f"run {r['run']}: its record says {r['record']!r}, but the entries have {'places' if r['run'] in placed else 'no place'} in it")
    for r in comparable:
        for f in r['flags']['new'] + r['flags']['gone'] + (r['flags'].get('kept') or []):
            need(type(f.get('check')) is int and f['check'] >= 1, f"{r['run']}: a flag's check isn't a whole number of 1 or more, {f.get('check')!r}")
    kept = {r['run'] for r in comparable}
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
            **({'differing': differing} if differing else {}),
            'runs': {'total': len(ran), 'compared': len(comparable)}, 'order': order,
            'broken': [{'run': r['run'], 'what': broken(r), 'reason': why_not(r), **({'reads': reads(r)} if broken(r) == 'read' or any(reads(r).values()) else {}),
                        **({'unmeasured': unmeasured(r)} if broken(r) == 'unmeasured' else {}),
                        **({'unreadable': True} if unreadable(r) else {})}
                       for r in ran if broken(r)],
            'flags': [{'run': r['run'], 'new': r['flags']['new'], 'gone': r['flags']['gone']} for r in comparable
                      if r['flags']['new'] or r['flags']['gone']],
            'reached': reached(comparable), 'entries': shown,
            'usage': (usage := [{'run': r['run'], 'base': usage_read(based[r['run']], 'base'), 'head': usage_read(r, 'head')}
                                for r in comparable if 'usage' in r and 'usage' in based.get(r['run'], {})]),
            'upgrades': upgrades_of(order, usage, results),
            'absent': [{'run': r['run'], 'head': stretches(r, 'absent'), 'base': stretches(r, 'baseAbsent')} for r in comparable
                       if r.get('absent') or r.get('baseAbsent')]}


def flag_kinds(r, side):
    f = r['flags']
    flags = (f.get('kept') or []) + (f['new'] if side == 'head' else f['gone'])
    return [list(k) for k in sorted({(x['check'], str(x.get('what') or ''), '' if x.get('what') else str(x.get('step') or ''))
                                     for x in flags if not (str(x.get('step') or '').startswith('p.') or x.get('step') == 'prefix')})]


def upgrades_of(order, usage, results):
    by = {u['run']: u for u in usage}
    out = []
    for run in order:
        parts = run.split('/')
        twin = '/'.join([*parts[:2], 'fresh'])
        if len(parts) != 3 or not parts[2].startswith('from-') or run not in by or twin not in by:
            continue
        out.append({'run': run, 'twin': twin, 'release': 'v' + parts[2][len('from-'):],
                    **{side: {'run': {'calibration': by[run][side]['calibration'], 'lastDropped': by[run][side]['lastDropped'],
                                      'flags': flag_kinds(results[run], side)},
                              'twin': {'calibration': by[twin][side]['calibration'], 'lastDropped': by[twin][side]['lastDropped'],
                                       'flags': flag_kinds(results[twin], side)}} for side in ('base', 'head')}})
    return out


def stretches(r, key):
    names = r.get(key, [])
    need(isinstance(names, list) and all(isinstance(x, str) for x in names), f"{r['run']}: its {key} isn't a list of names, {names!r}")
    return names


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
    (`baseReason`, nothing where it's absent) where the base couldn't run it, since a result's `reason` is the head's, what
    each arm whose run failed said of why where it didn't measure, else the run's."""
    if broken(r) == 'varies':
        return str(r['selfCheck'].get('detail') or '')
    if broken(r) == 'drive':
        return str(r['selfCheck'].get('reason') or '')
    if broken(r) == 'base':
        return str(r.get('baseReason') or '')
    if broken(r) == 'outcome':
        return str(r['outcome'])
    if broken(r) == 'unmeasured':
        return failed_reasons(r)
    return str(r.get('reason') or '')


FAILED = 'the run failed: '


def failed_reasons(r):
    """Why each arm whose run failed says it failed: the reason in its run-level check 1 flag, the harness's own `the run
    failed: …`, which a flag the head raised alone carries in `new`, one the base raised alone in `gone`, and one both raised
    alike in `kept`. Each reason names its arm's run, or both arms' runs together where they're alike in their text and in
    `whole`, the hash the harness gives a flag whose text it cut; a reason the harness cut says so."""
    sides = {'head': ('new', 'kept'), 'base': ('gone', 'kept')}
    named = unmeasured(r)
    said = {}
    for side, pools in sides.items():
        if 'the run failed' not in named[side]:
            continue
        for f in (x for pool in pools for x in (r.get('flags') or {}).get(pool) or []):
            if f.get('check') == 1 and f.get('step') == 'the run' and str(f.get('detail') or '').startswith(FAILED):
                said[side] = (str(f['detail'])[len(FAILED):], f.get('whole'))
                break

    def shown(reason):
        why, whole = reason
        return f'{why} (cut by the harness)' if whole else why
    if len(said) == 2 and said['head'] == said['base']:
        return f"both arms' runs failed: {shown(said['head'])}"
    return '; '.join(f"the {side}'s run failed: {shown(reason)}" for side, reason in said.items())


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

# A package-lock.json key below its root: a node_modules path, nested or under a workspace, or a workspace's own path.
_NODE = r'node_modules/(?:@[^/@\s]+/)?[^/@\s]+'
_WORKSPACE = r'[^/@\s]+(?:/[^/@\s]+)*'
LOCKFILE_KEY = re.compile(rf'(?:{_WORKSPACE}/)?{_NODE}(?:/{_NODE})*|{_WORKSPACE}')


REACH = 'reach.json'
# What each file state of reach.json can hold, as the harness's reachOf gives it: its line lists, then its deletions' states.
HOLDS = {'read': (('ran', 'notRan', 'couldntTell', 'noCode'), ('reached', 'not-reached', 'couldnt-tell', 'no-code')),
         'not-loaded': (('notRan', 'noCode', 'unloaded'), ('not-reached', 'no-code', 'unloaded')),
         'couldnt-tell': (('couldntTell', 'noCode', 'unloaded'), ('couldnt-tell', 'no-code', 'unloaded'))}
LISTS = ('ran', 'notRan', 'couldntTell', 'noCode', 'unloaded')


def reach_of(d):
    """The run's reach.json, as the comment's reach paragraph reads it: `{couldnt}`, or each changed source file's lists
    and deletions with its reason, and the notes, each checked against what the harness's reachOf can give, so a count
    the paragraph prints rests on lists that hold what their names say."""
    path = os.path.join(d, REACH)
    need(os.path.exists(path), f"the run wrote no {REACH}, though its outcome is ran")
    r = parsed(d, path)
    need(isinstance(r, dict), f"{REACH} isn't an object")
    if 'couldnt' in r:
        need(isinstance(r['couldnt'], str) and one_line(r['couldnt']), f"{REACH}: couldnt isn't a line of text")
        return {'couldnt': r['couldnt']}
    files, notes = r.get('files'), r.get('notes')
    need(isinstance(files, dict), f"{REACH}: files isn't an object")
    need(isinstance(notes, list) and all(isinstance(n, str) and one_line(n) for n in notes) and len(set(notes)) == len(notes),
         f"{REACH}: notes aren't distinct lines of text")
    out = {}
    for name, f in sorted(files.items()):
        need(name.startswith('src/') and one_line(name) == name, f"{REACH}: {name!r} isn't a path under src/")
        need(isinstance(f, dict) and f.get('state') in HOLDS, f"{REACH}: {name}'s state isn't one reach knows, {(f.get('state') if isinstance(f, dict) else f)!r}")
        lists, states = HOLDS[f['state']]
        seen = []
        for k in LISTS:
            v = f.get(k)
            need(isinstance(v, list) and all(type(n) is int and n >= 1 for n in v), f"{REACH}: {name}'s {k} isn't a list of line numbers")
            need(not v or k in lists, f"{REACH}: {name}, a {f['state']} file, has {k} lines")
            seen += v
        need(len(set(seen)) == len(seen), f"{REACH}: {name} has a line in two lists")
        dels = f.get('deletions')
        need(isinstance(dels, list) and all(isinstance(x, dict) and type(x.get('after')) is int and x['after'] >= 0 and x.get('state') in states
                                            and (x.get('by') is None if x['state'] in ('no-code', 'unloaded')
                                                 else (x.get('by') is None and x['state'] == 'couldnt-tell') or (type(x.get('by')) is int and x['by'] >= 1))
                                            for x in dels)
             and len({x['after'] for x in dels}) == len(dels), f"{REACH}: {name}'s deletions aren't each one a {f['state']} file can have")
        binary = f.get('binary') is True
        need('binary' not in f or (binary and f['state'] == 'couldnt-tell' and not seen and not dels),
             f"{REACH}: {name} is marked binary, and a binary file is a couldnt-tell one with no line or deletion")
        need(seen or dels or binary, f"{REACH}: {name} has no changed line or deletion")
        told = f['state'] == 'couldnt-tell' or f['couldntTell'] or any(x['state'] == 'couldnt-tell' for x in dels)
        need(bool(told) == ('reason' in f) and ('reason' not in f or (isinstance(f['reason'], str) and one_line(f['reason']))),
             f"{REACH}: {name} {'names no reason for what it couldn' + chr(39) + 't tell' if told else 'names a reason for nothing it couldn' + chr(39) + 't tell'}")
        need(not told or beyond(f['reason'], notes) is not None, f"{REACH}: {name}'s reason doesn't hold the notes once, as the harness joins them")
        out[name] = {'state': f['state'], **{k: sorted(f[k]) for k in LISTS},
                     'deletions': sorted(({'after': x['after'], 'state': x['state'], 'by': x.get('by')} for x in dels), key=lambda x: x['after']),
                     **({'binary': True} if binary else {}), **({'reason': f['reason']} if told else {})}
    return {'files': out, 'notes': notes}


def beyond(reason, notes):
    """What a file's reason says beyond the notes: the harness's reachOf joins with '; ' every note in their order, then
    the file's own reasons, so the notes stand in it as one run bounded by '; ' or the ends, and what follows it is the
    file's own. None where the reason holds no such run, or more than one, as it could where a path in the file's own
    reason holds the notes' text: which is the harness's isn't then known, so the view refuses rather than print the
    wrong one."""
    if not notes:
        return reason
    run = '; '.join(notes)
    found = []
    bound = len(reason)
    while (at := reason.rfind(run, 0, bound)) >= 0:
        end = at + len(run)
        if (at == 0 or reason[:at].endswith('; ')) and (end == len(reason) or reason[end:].startswith('; ')):
            found.append(at)
        bound = end - 1
    if len(found) != 1:
        return None
    at, end = found[0], found[0] + len(run)
    return '; '.join(x for x in (reason[:at].removesuffix('; '), reason[end:].removeprefix('; ')) if x)

#!/usr/bin/env python3
"""The context view's steps on the host, which the workflow running a view calls: each reads one JSON object on stdin and
prints one on its last line of stdout, or exits 1 with why on stderr, or 2 when the run's repository is one the App is
installed on that the context view doesn't cover, or when its command line names no step."""
import argparse, bisect, datetime, hashlib, html, json, math, os, re, subprocess, sys, traceback

import pr_comment
import pr_review
from pr_comment import ACTIVE, COMMENT_MAX, MORE, VIEW_MARK, code, ended, inert, one_line
from pr_run import Failed, NotARequest, need, read_json, refuse, write_json

VIEWED = {1126567876: 'anima-research/context-manager', 1132522869: 'anima-research/agent-framework',
          1123531033: 'antra-tess/membrane', 1170978461: 'anima-research/connectome-host'}
KEY = 'context-view/'
# The repository whose harness/ a view's runs use, and whose CHECKS.md says what those runs drive and what their checks judge.
HARNESS = 'anima-research/context-view'
OUTCOMES = ('ran', 'moved', 'closed', 'couldnt-run', 'doesnt-merge', 'needs-companion', 'arm-missing', 'elsewhere', 'unchanged')
UNRUN = ('moved', 'closed', 'elsewhere', 'unchanged')
REACHED = {'ran': ('k', 'src'), 'arm-missing': ('k', 'src'), 'needs-companion': ('k', 'src'), 'unchanged': ('k',)}
# The arm an outcome's detail names, as the run side names it, and as the comment does: an arm-missing names a job's arm,
# a needs-companion the arm where the plan stopped (run/context-view-run.ts, resolve() and share()).
ARMS = {'arm-missing': {'before': 'base', 'after': 'head'}, 'needs-companion': {'base': 'base', 'head': 'head'}}
CHECKS = ('same', 'differs', 'couldnt-run')
# A run's outcomes as the harness gives them.
RESULTS = ('pass', 'flags', 'invalid', 'couldnt-run')
FORMS = ('overlay', 'host')
# The package an overlay repository's pull request packs, by the repository's GitHub ID, as the run side's REPOS names it.
PACKS = {1126567876: '@animalabs/context-manager', 1132522869: '@animalabs/agent-framework', 1123531033: '@animalabs/membrane'}
SHA = re.compile(r'[0-9a-f]{40}')
MARK = re.compile(re.escape(VIEW_MARK) + r'(?:stopped:(?P<stopped>[0-9a-f]{40})|first:(?P<first>[0-9a-f]{40})'
                  r'(?: head:(?P<head>[0-9a-f]{40}))? result:(?P<result>[0-9a-f]{64})(?::(?P<part>[0-9]+))?) -->\Z')
ENTRIES = 'entries.json'
PARTS = re.compile(r'comment(-[0-9]+)?\.md')


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


FIGURES = ('requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'dropped')
PRICE = ('cost', 'unpriced')


def counting(n):
    return type(n) is int and 0 <= n <= 2 ** 53


def money(n):
    return type(n) in (int, float) and math.isfinite(n) and n >= 0


def usage_read(r, arm):
    u = r['usage']
    run = f"{r['run']}: on the {arm},"
    need(isinstance(u, dict) and isinstance(u.get('kinds'), dict), f"{run} its usage has no kinds")
    for where, kinds in (('', u['kinds']), ('history ', u.get('history'))):
        need(kinds is None or isinstance(kinds, dict), f"{run} its usage's {where}figures aren't by kind")
        for kind, k in (kinds or {}).items():
            need(isinstance(k, dict), f"{run} its usage's {where}{kind!r} figures aren't by figure")
            for f in FIGURES:
                need(counting(k.get(f)), f"{run} its usage's {where}{kind!r} {f} isn't a whole number from 0 to 2**53, {k.get(f)!r}")
            need(('cost' in k) == ('unpriced' in k), f"{run} its usage's {where}{kind!r} figures have one of cost and unpriced without the other")
            if 'cost' in k:
                need(money(k['cost']), f"{run} its usage's {where}{kind!r} cost isn't a number of 0 or more, {k['cost']!r}")
                need(counting(k['unpriced']) and k['unpriced'] <= k['requests'],
                     f"{run} its usage's {where}{kind!r} unpriced isn't a whole number from 0 to its requests, {k['unpriced']!r}")
    need(all(kind in u['kinds'] and all(k[f] <= u['kinds'][kind][f] for f in FIGURES) for kind, k in (u.get('history') or {}).items()),
         f"{run} its usage's history figures are more than the run's")
    every = [k for kinds in (u['kinds'], u.get('history') or {}) for k in kinds.values()]
    need(all('cost' in k for k in every) or not any('cost' in k for k in every), f"{run} its usage prices some kinds of request and not others")
    need('priceUnread' not in u or (isinstance(u['priceUnread'], str) and not any('cost' in k for k in every)),
         f"{run} its usage's priceUnread isn't text beside unpriced figures, {u.get('priceUnread')!r}")
    need('lastDropped' in u, f"{run} its usage has no lastDropped")
    need(u['lastDropped'] is None or counting(u['lastDropped']), f"{run} its usage's lastDropped isn't null or a whole number from 0 to 2**53, {u['lastDropped']!r}")
    c = u.get('calibration')
    m = c.get('multiplier') if isinstance(c, dict) else None
    need(c is None or ((type(m) is float and math.isfinite(m) or type(m) is int and abs(m) <= 2 ** 53) and type(c.get('provisional')) is bool
                       and type(c.get('reset')) is bool), f"{run} its usage's calibration isn't null or a multiplier with its marks")
    kept = lambda k: {f: k[f] for f in (*FIGURES, *(PRICE if 'cost' in k else ()))}
    return {'kinds': {kind: kept(k) for kind, k in u['kinds'].items()},
            **({'history': {kind: kept(k) for kind, k in u['history'].items()}} if u.get('history') is not None else {}),
            'lastDropped': u['lastDropped'], 'calibration': c, **({'priceUnread': u['priceUnread']} if 'priceUnread' in u else {})}


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


def words_of(files):
    """The sha256 of the files whose code writes a comment's fixed words, each file's bytes after its length."""
    h = hashlib.sha256()
    for path in files:
        with open(path, 'rb') as f:
            data = f.read()
        h.update(f'{len(data)}\n'.encode() + data)
    return h.hexdigest()


# The code that writes a comment's fixed words, view.py and the pinned review-workflow's pr_comment, by their bytes, so a
# comment is kept for the same result only by the code that wrote it: a release that changes either file, as moving the
# pin can, posts again at a head's next view.
WORDS = words_of((__file__, pr_comment.__file__))


def result_of(view, sources=None):
    """What a comment's fixed words and quotes rest on, apart from the heads its first lines name (this head, the head it
    was first posted at, and the pull request's head now): the same result at a later head edits the first line rather than
    posting again, and the reader's prose, written again at each run, isn't part of it. Every other word the comment prints
    comes from what this covers, and where the reader runs, so does everything it reads:
    the pull request's title and description, and its instructions and guide by their sha256 (sources, post's reads), and
    the code that writes them (WORDS)."""
    keep = ('base', 'baseRef', 'host', 'harness', 'form', 'outcome', 'detail', 'held', 'runs', 'broken', 'flags', 'reached', 'absent', 'usage', 'forced',
            'upgrades', 'stack', 'differing', 'reach')
    said = {k: view.get(k) for k in keep}
    if said['usage']:
        said['usage'] = [{**u, 'base': usage_shown(u['base']), 'head': usage_shown(u['head'])} for u in said['usage']]
    if view.get('outcome') == 'arm-missing':
        said['jobs'] = view.get('jobs')
    said['entries'] = view.get('entries') or []
    said['words'] = WORDS
    if view.get('outcome') == 'ran' and said['entries'] and sources is not None:
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
        return [f"This head couldn't be compared: it conflicts with {code(one_line(view['baseRef']))} at {code(view['base'][:12])}, "
                "and a view runs the head merged onto its base, so those conflicts need resolving before it can be viewed."]
    if kind == 'needs-companion':
        return [companion_stop(detail)]
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


def short(name):
    return name.removeprefix('@animalabs/')


CHOSEN = re.compile(r'(@animalabs/[^/@\s]+)@([^/@\s]+)')
# A package-lock.json key below its root: a node_modules path, nested or under a workspace, or a workspace's own path.
_NODE = r'node_modules/(?:@[^/@\s]+/)?[^/@\s]+'
_WORKSPACE = r'[^/@\s]+(?:/[^/@\s]+)*'
LOCKFILE_KEY = re.compile(rf'(?:{_WORKSPACE}/)?{_NODE}(?:/{_NODE})*|{_WORKSPACE}')


def asker(wanted_by, side):
    """Who asks a range in an arm's stack, as the plan names it: the arm's own package.json, a release the plan chose, or an
    entry of the host's lockfile, by its path."""
    if wanted_by is None:
        return 'it' if side == 'head' else 'its base'
    if m := CHOSEN.fullmatch(wanted_by):
        return f"{inert(short(m[1]))} {code(m[2])}, which the view chose for the {side},"
    return f"{from_whom(wanted_by, side)} in the host's stack"


def from_whom(wanted_by, side):
    if wanted_by is None:
        return 'this head' if side == 'head' else 'the base'
    if m := CHOSEN.fullmatch(wanted_by):
        return f"{inert(short(m[1]))} {code(m[2])}"
    return inert(short(wanted_by.rsplit('node_modules/', 1)[-1]))


def ranges_said(ranges, side):
    return listed(f"{code(r['range'])} from {from_whom(r['wantedBy'], side)}" for r in ranges)


def lacking(name, c, side):
    """Why the lockfile's release of a package the plan chose wouldn't do in that arm, from its stack entry's missed."""
    m = c['missed']
    held = f"connectome-host's lockfile holds {code(c['host'])}"
    if m['package'] == name:
        return f"{held}, which doesn't meet {code(m['range'])} from {from_whom(m['wantedBy'], side)}"
    return (f"{held}, and with it {from_whom(m['wantedBy'], side)} asks for {inert(short(m['package']))} {code(m['range'])}, "
            f"which the {side}'s {code(str(m['has']))} doesn't meet")


def companion_stop(d):
    """Why the plan chose no stack the arms could run, from the needs-companion's detail (run/context-view-run.ts, resolve)."""
    side, why = ARMS['needs-companion'][d['arm']], d.get('why')
    lead = (f"This head couldn't be compared: {asker(d.get('wantedBy'), side)} asks for {inert(short(str(d.get('package'))))} "
            f"{code(str(d.get('range')))}")
    if why == 'not-plain':
        return f"{lead}, which isn't a version range, so the view can't choose a release to meet it."
    if why == 'no-mover':
        if d.get('has') is None:
            return f"{lead}, and the {side}'s {code('package.json')} gives no version."
        return (f"{lead}, and the {side}'s is {code(str(d['has']))}. The view chooses releases only of agent-framework, context-manager, "
                "membrane and chronicle where connectome-host's lockfile holds them at its top level, so it can't change that.")
    if why == 'no-release':
        ranges = d.get('ranges') or []
        name = inert(short(str(d.get('release'))))
        if not ranges:
            return f"{lead}, and {name} has no published release."
        alone = len(ranges) == 1 and d.get('release') == d.get('package') and ranges[0] == {'range': d.get('range'), 'wantedBy': d.get('wantedBy')}
        return f"{lead}, and no published release of {name} " + ('meets it.' if alone else f"meets every range on it in the {side}'s stack ({ranges_said(ranges, side)}).")
    if why == 'unsettled':
        tried = sorted((d.get('tried') or {}).items())
        said = f" The {side}'s were {listed(f'{inert(short(n))} {code(v)}' for n, v in tried)}." if tried else ''
        return f"{lead}, and choosing releases for the arms came back to choices it had already made, so it stopped there.{said}"
    raise Failed(f"manifest.json: a needs-companion the view doesn't know, {why!r}")


def held_text(view):
    held = dict(view.get('held') or {})
    stack = view.get('stack') or {}

    def chose(k):
        name = f'@animalabs/{k}'
        sides = [(side, stack[side][name]) for side in ('base', 'head') if name in stack.get(side, {})]
        if not sides:
            return ''
        why = next(((side, c) for side, c in sides if 'missed' in c), None)
        return (f" (the view chose it for both arms, since {lacking(name, why[1], why[0])})" if why
                else f" (the view chose it for both arms, where connectome-host's lockfile has {code(sides[0][1]['host'])})")
    if view['form'] == 'overlay':
        held = {'connectome-host': view['host'][:12], **held}
    return 'Held the same in base and head: ' + ', '.join(f'{inert(k)} {code(v)}{chose(k)}' for k, v in held.items()) + '.' if held else None


def differing_line(view):
    """Above the fold, where the arms ran different releases of a package besides the pull request's: which, why the view
    chose each over the lockfile's, and that a difference may be theirs."""
    differing, stack = view.get('differing') or [], view.get('stack') or {}
    if not differing:
        return []
    names = [inert(d['package']) for d in differing]
    said = [f"Besides this head, the arms ran different releases of {listed(names)}: "
            + '; '.join(('' if len(differing) == 1 else f"{inert(d['package'])} ") + f"{code(d['base'])} in the base and {code(d['head'])} in the head"
                        for d in differing) + '.']
    for d in differing:
        for side in ('base', 'head'):
            name = f"@animalabs/{d['package']}"
            c = stack.get(side, {}).get(name)
            if c is None:
                continue
            said.append(f"The view chose the {side}'s {inert(d['package'])} {code(c['version'])}, "
                        + (f"since {lacking(name, c, side)}." if 'missed' in c else f"where connectome-host's lockfile has {code(c['host'])}."))
    said.append(f"So a difference this view shows may come from {listed(names)} as well as from this head, and it can't tell which.")
    return [' '.join(said)]


FOUR = ('@animalabs/agent-framework', '@animalabs/context-manager', '@animalabs/membrane', '@animalabs/chronicle')


def forced_line(view):
    """Above the fold, where an arm ran the pull request's package past a range in the host's stack that refuses it: which
    ranges, in which arms, why the view couldn't meet them, and that a difference or a failure may come from them."""
    forced = view.get('forced') or {}
    sides = [side for side in ('base', 'head') if forced.get(side)]
    if not sides:
        return []
    name = inert(short(view['pack']))
    pairs = {side: {(f['range'], f['wantedBy']) for f in forced.get(side) or []} for side in ('base', 'head')}

    def path(wanted_by):
        return [x.rstrip('/') for x in wanted_by.split('node_modules/') if x.rstrip('/')]

    def named(wanted_by):
        if m := CHOSEN.fullmatch(wanted_by):
            return inert(short(m[1]))
        at = path(wanted_by)
        return inert(short(at[-1])) if len(at) == 1 else f"{inert(short(at[-2]))}'s {inert(short(at[-1]))}"

    def chosen(wanted_by):
        """An asker the view chooses releases of: one of the four at the top of the host's stack, or a release it chose."""
        return bool(CHOSEN.fullmatch(wanted_by)) or path(wanted_by) in ([x] for x in FOUR)

    def ranges(fs, side):
        return listed(f"{code(f['range'])} from {from_whom(f['wantedBy'], side) if CHOSEN.fullmatch(f['wantedBy']) else named(f['wantedBy'])}" for f in fs)

    def why(fs, admitted):
        moved = list(dict.fromkeys(named(f['wantedBy']) for f in fs if chosen(f['wantedBy'])))
        fixed = list(dict.fromkeys(named(f['wantedBy']) for f in fs if not chosen(f['wantedBy'])))
        said = ([f"it could choose no release of {listed(moved)} that admits {admitted}"] if moved else []) + (
            [f"the view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's lockfile "
             f"holds them at its top level, so it couldn't choose a release of {listed(fixed)}"] if fixed else [])
        return ', and '.join(said)

    def over(fs):
        return 'a range' if len(fs) == 1 else 'ranges'
    def those(fs):
        return 'that range' if len(fs) == 1 else 'those ranges'
    if pairs['base'] == pairs['head']:
        fs = forced['base']
        return [f"In both arms, the view laid {name} over {ranges(fs, 'base')}, {over(fs)} that neither the base's {code(fs[0]['has'])} nor the "
                f"head's {code(forced['head'][0]['has'])} meets: {why(fs, 'them')}. So any difference or failure this view shows may come from "
                f"{those(fs)}, and the view can't tell whether it does."]
    # A checkpoint whose release names no window takes it from the base arm's install (harness/run.ts, drive.ts), so a range
    # the base forced can fail a checkpoint that head runs start from; a range only the head forced reaches nothing the base runs.
    if sides == ['head']:
        close = (f"So any difference this view shows, or any failure in the head, may come from {those(forced['head'])}, and the view "
                 "can't tell whether it does.")
    elif sides == ['base']:
        close = (f"So any difference this view shows, or any failure in the base or of a checkpoint, may come from {those(forced['base'])}, "
                 "and the view can't tell whether it does.")
    else:
        close = ("So any difference this view shows may come from the ranges named for either arm, and the view can't tell whether it does. "
                 "Any failure in an arm may come from that arm's own ranges. A checkpoint's failure may come from the base's ranges. "
                 "The view can't tell whether either does.")
    return [' '.join([*(f"In the {side}, the view laid {name} {code(forced[side][0]['has'])} over {ranges(forced[side], side)}, {over(forced[side])} "
                        f"that version doesn't meet: {why(forced[side], 'it')}." for side in sides), close])]


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
    that show the same check, step and text, on either side, as different flags can, each say another line does."""
    out = []
    for f in view.get('flags') or []:
        groups = []
        for side, more, than in (('new', 'head', 'base'), ('gone', 'base', 'head')):
            times = {}
            for flag in f[side]:
                key = json.dumps([flag.get(k) for k in ('check', 'step', 'what', 'detail', 'whole')])
                times.setdefault(key, [key, flag, 0, more, than])[2] += 1
            groups += times.values()
        shown = []
        for key, flag, n, more, than in groups:
            step = flag.get('step')
            where = f" step {code(str(step))}" if step not in (None, '', 'the run') else ''
            said = ': '.join(t for t in (one_line(x) for x in (flag.get('what'), flag.get('detail')) if x) if t)
            shown.append((f"{where}, check {code(str(flag.get('check')))}", said))
        alike = {}
        for (key, *_), face in zip(groups, shown):
            alike.setdefault(face, set()).add(key)
        for (key, flag, n, more, than), face in zip(groups, shown):
            place, said = face
            often = '1 more time' if n == 1 else f'{n:,} more times'
            other = ' (another line of this run shows the same text for a different flag)' if len(alike[face]) > 1 else ''
            line = f"- {code(f['run'])}{place}{other} flagged on the {more} {often} than on the {than}"
            if not said:
                out.append(line)
                continue

            def words(text, part, line=line):
                return line + (f': {inert(text)}' if text else '') + (f' (the flag{part})' if part else '')
            # The name and the detail are rendered as one text, so nothing GitHub would make live can form across the ': '
            # between them, as `:smile` and `: ` make an emoji.
            out.append(clipped(words, said, room))
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


def absent_line(view):
    parts = [f"{code(a['run'])}'s {listed(inert(x) for x in a[arm])} on the {arm}"
             for a in view.get('absent') or [] for arm in ('base', 'head') if a[arm]]
    return [f"Parts left out where an arm's stack doesn't bring what they need: {'; '.join(parts)}."] if parts else []


USAGE_MODEL = ("The figures are the stand-in's model of each provider's published caching and token rules, not a measurement; "
               "the stand-in answers the same every time, so a difference between the arms comes from the change.")
PRICE_MODEL = ("A list price is what each arm's host prices those figures at with its own table (connectome-host's `priceCall`), "
               "where it gives one, so it rests on the same model, with the stand-in's token estimate in place of the provider's "
               "own count, cache hits as the script's pacing gives them, and scripted replies.")


def priced(u_side):
    every = [k for kinds in (u_side['kinds'], u_side.get('history') or {}) for k in kinds.values()]
    return 'priceUnread' not in u_side and all('cost' in k for k in every)


def agent_sums(usage, side):
    zero = {f: 0 for f in (*FIGURES, *PRICE)}
    sums = {f: sum(u[side]['kinds'].get('agent', zero)[f] for u in usage) for f in FIGURES}
    if all(priced(u[side]) for u in usage) and any('cost' in k for u in usage for k in u[side]['kinds'].values()):
        sums.update({f: sum(u[side]['kinds'].get('agent', zero)[f] for u in usage) for f in PRICE})
    return sums


def list_price(k):
    n = k['requests'] - k['unpriced']
    return f"USD {k['cost'] / n:.4f}" if n else 'none'


def sent(k):
    return k['input'] + k['cacheRead'] + k['cacheWrite']


def per_request(k):
    return f"{round(sent(k) / k['requests']):,}" if k['requests'] else 'none'


def cached(k):
    return f"{k['cacheRead'] / sent(k):.1%}" if sent(k) else 'none'


def as_shown(f, k):
    return f'{k[f]:,.4f}' if f == 'cost' else f'{k[f]:,}'


def as_compared(u):
    """Each arm's figures by kind as the arms are compared, as the comment shows them: the tokens, and the list prices
    to four places, only where both arms priced."""
    keep = (*FIGURES, *(PRICE if priced(u['base']) and priced(u['head']) else ()))
    return tuple({kind: {f: as_shown(f, k) for f in keep} for kind, k in u[side]['kinds'].items()} for side in ('base', 'head'))


def moved_runs(usage):
    return [u for u in usage if as_compared(u)[0] != as_compared(u)[1]]


def usage_line(view):
    usage = view.get('usage') or []
    if not usage:
        return []
    base, head = agent_sums(usage, 'base'), agent_sums(usage, 'head')
    figures = [(per_request, 'tokens sent a request'), (cached, 'of them read from the cache'),
               (lambda k: f"{k['cacheWrite']:,}", 'written to it'), (lambda k: f"{k['output']:,}", 'output'),
               (lambda k: f"{k['dropped']:,}", 'thinking blocks dropped')]
    if 'cost' in base and 'cost' in head:
        figures.append((list_price, 'at list price a priced request'))
        if base['unpriced'] or head['unpriced']:
            figures.append((lambda k: counted(k['unpriced'], 'request', 'requests'), 'with no list price'))
    runs = counted(len(usage), 'run', 'runs')
    if all(show(base) == show(head) for show, _ in figures):
        said = f"Usage: the figures of the agents' requests, subagents' included, in the {runs} are the same in the base and this head: " + listed(
            f'{show(head)} {what}' for show, what in figures) + '.'
    else:
        said = f"Usage: the agents' requests, subagents' included, in the {runs}, base → head: " + listed(
            f'{show(base)} {what}' if show(base) == show(head) else f'{show(base)} → {show(head)} {what}' for show, what in figures) + '.'
    moved = len(moved_runs(usage))
    if moved:
        said += f" The figures of {counted(moved, 'run', 'runs')} moved, for any kind of request; they're under \"Usage that differs\", below."
    return [f"{said} {USAGE_MODEL}{f' {PRICE_MODEL}' if 'cost' in base and 'cost' in head else ''}", *unpriced_lines(usage)]


def unpriced_lines(usage):
    """Why an arm's host priced nothing, once for each arm and reason, however many runs it held for."""
    why = {}
    for u in usage:
        for side in ('base', 'head'):
            if 'priceUnread' in u[side]:
                why.setdefault((side, unread_shown(u[side]['priceUnread'])), []).append(u['run'])
    lines = []
    for (side, reason), runs in why.items():
        where = '' if len(runs) == len(usage) else f" in {counted(len(runs), 'run', 'runs')} of {len(usage):,}"
        lines.append(f"No list price on the {side}{where}: {inert(reason)}.")
    return lines


def unread_shown(reason):
    """Why a host priced nothing, as the comment shows it: one line, its first 300 characters."""
    said = one_line(reason)
    return said if len(said) <= 300 else f'{said[:300]}…'


def usage_shown(u_side):
    """An arm's usage of a run as the comment shows it, for the result digest: costs to four places, and why it went
    unpriced as unread_shown gives it."""
    out = dict(u_side)
    for where in ('kinds', 'history'):
        if u_side.get(where) is not None:
            out[where] = {kind: {f: as_shown(f, k) if f == 'cost' else v for f, v in k.items()} for kind, k in u_side[where].items()}
    if 'priceUnread' in u_side:
        out['priceUnread'] = unread_shown(u_side['priceUnread'])
    return out


def usage_fold(view, room):
    usage = view.get('usage') or []
    moved = moved_runs(usage)
    if not moved:
        return []
    columns = [('requests', 'requests'), ('input', 'input'), ('cacheRead', 'read from the cache'), ('cacheWrite', 'written to it'),
               ('output', 'output'), ('dropped', 'thinking dropped')]
    items = []
    for u in moved:
        both = priced(u['base']) and priced(u['head'])
        cols = [*columns, *([('cost', 'list price, USD'), ('unpriced', 'unpriced')] if both else [])]
        kinds = list(dict.fromkeys([*u['base']['kinds'], *u['head']['kinds']]))
        kinds.sort(key=lambda k: (k != 'agent', k))
        rows = [f"| {code(u['run'])} | kind | " + ' | '.join(name for _, name in cols) + ' |', '|' + ' --- |' * (len(cols) + 2)]
        for kind in kinds:
            b, h = (u[side]['kinds'].get(kind, {f: 0 for f in (*FIGURES, *PRICE)}) for side in ('base', 'head'))
            cell = lambda f: as_shown(f, b) if as_shown(f, b) == as_shown(f, h) else f'{as_shown(f, b)} → {as_shown(f, h)}'
            rows.append(f'| | {inert(kind)} | ' + ' | '.join(cell(f) for f, _ in cols) + ' |')
        items.append('\n'.join(rows))
    still = len(usage) - len(moved)
    if still:
        items.append(f"The figures of the other {counted(still, 'run', 'runs')} are the same in the base and this head.")
    summary = summary_text(f'Usage that differs: {len(moved):,} of {len(usage):,} runs, base → head')
    return folded(summary, items, room)



UPGRADED = "Upgraded runs beside their fresh twins"


def calibration_said(c):
    if c is None:
        return "isn't reported"
    return ('ends unconfirmed' if c['provisional'] else 'ends confirmed') + (' after a reset' if c['reset'] else '')


def dropped_said(n):
    return f"had {counted(n, 'thinking block', 'thinking blocks')} dropped" if n else 'had none dropped'


def last_said(n, upgraded):
    if n is None:
        return "none of its agent's requests was answered" if upgraded else "none of the fresh run's agent's requests was answered"
    return f"its last request {dropped_said(n)}" if upgraded else f"the fresh run's {dropped_said(n)}"


END_STATES = (
    (lambda e: None if e['calibration'] is None else e['calibration']['provisional'],
     lambda u, t: f"the calibration {calibration_said(u['calibration'])}, where the fresh run's {calibration_said(t['calibration'])}"),
    (lambda e: None if e['lastDropped'] is None else e['lastDropped'] > 0,
     lambda u, t: f"{last_said(u['lastDropped'], True)}, where {last_said(t['lastDropped'], False)}"),
)


def flag_said(kind):
    check, what, step = kind
    return f"check {check}'s {code(what)}" if what else f"check {check} at step {code(step)}" if step else f"check {check}"


def flag_differences(u, side):
    run, twin = ({tuple(k) for k in u[side][who]['flags']} for who in ('run', 'twin'))
    return {('run', k) for k in run - twin} | {('twin', k) for k in twin - run}


def upgrade_lines(view):
    out = []
    for u in view.get('upgrades') or []:
        parts = []
        for key, said in END_STATES:
            differs = {side: key(u[side]['run']) != key(u[side]['twin']) for side in ('base', 'head')}
            texts = {side: said(u[side]['run'], u[side]['twin']) for side in ('base', 'head')}
            if differs['base'] and differs['head']:
                parts.append(f"{texts['head']}, on both sides" if texts['base'] == texts['head']
                             else f"on the base, {texts['base']}, and on the head, {texts['head']}")
            elif differs['head']:
                parts.append(f"{texts['head']}, on the head only, so the change makes that")
            elif differs['base']:
                parts.append(f"{texts['base']}, on the base only, so the change ends that")
        base, head = flag_differences(u, 'base'), flag_differences(u, 'head')
        for differing, where in ((head - base, 'on the head only, so the change makes that'), (base - head, 'on the base only, so the change ends that')):
            for whose in ('run', 'twin'):
                kinds = [flag_said(kind) for who, kind in sorted(differing) if who == whose]
                if kinds:
                    parts.append(f"{'it raises' if whose == 'run' else 'the fresh run raises'} {listed(kinds)} where "
                                 f"{'the fresh run doesn' if whose == 'run' else 'it doesn'}'t, {where}")
        if not parts:
            continue
        standing = len(base & head)
        if standing:
            parts.append(f"{counted(standing, 'flag differs', 'flags differ')} from its twin's on both sides, named under \"{UPGRADED}\", below")
        out.append(f"From a store connectome-host {code(u['release'])} wrote, {code(u['run'])} beside its fresh twin {code(u['twin'])}: "
                   + '; '.join(parts) + '.')
    return out


def upgrades_fold(view, room):
    upgrades = view.get('upgrades') or []
    if not upgrades:
        return []
    usage = {u['run']: u for u in view.get('usage') or []}
    runs = list(dict.fromkeys(r for u in upgrades for r in (u['run'], u['twin'])))
    zero = {f: 0 for f in FIGURES}
    items = []
    for side, name in (('base', 'base'), ('head', 'head')):
        rows = [f'| On the {name} | requests | tokens sent a request | read from the cache | written to it | output | thinking dropped '
                '| last request dropped | calibration |', '|' + ' --- |' * 9]
        for run in runs:
            whole, history = usage[run][side]['kinds'].get('agent', zero), (usage[run][side].get('history') or {}).get('agent', zero)
            k = {f: whole[f] - history[f] for f in FIGURES}
            c = usage[run][side]['calibration']
            calibration = 'not reported' if c is None else f"{c['multiplier']:.2f}, {calibration_said(c)[5:]}"
            last = usage[run][side]['lastDropped']
            rows.append(f"| {code(run)} | {k['requests']:,} | {per_request(k)} | {cached(k)} | {k['cacheWrite']:,} | {k['output']:,} "
                        f"| {k['dropped']:,} | {'no request' if last is None else f'{last:,}'} | {calibration} |")
        items.append('\n'.join(rows))
    if any(usage[run][side].get('history') for run in runs for side in ('base', 'head')):
        items.append("A run that writes its own history first, as a fresh twin does, is shown without that history's requests, "
                     "so its figures are its workload's alone, as the upgraded runs' are.")
    for u in upgrades:
        for side in ('base', 'head'):
            differ = sorted(flag_differences(u, side))
            if differ:
                items.append(f"On the {side}, {code(u['run'])} and its twin differ in flags: " + listed(
                    f"{flag_said(kind)}, raised by {'the upgraded run' if whose == 'run' else 'the fresh run'} only" for whose, kind in differ) + '.')
    return folded(summary_text(UPGRADED), items, room)


def lost_line(lost):
    """Above the fold: how many runs couldn't be compared, and where their reasons are."""
    return (f"1 run couldn't be compared; its reason is below." if lost == 1
            else f"{lost:,} runs couldn't be compared; the reasons are below.")


REACH = 'reach.json'
# What each file state of reach.json can hold, as the harness's reachOf gives it: its line lists, then its deletions' states.
HOLDS = {'read': (('ran', 'notRan', 'couldntTell', 'noCode'), ('reached', 'not-reached', 'couldnt-tell', 'no-code')),
         'not-loaded': (('notRan', 'noCode', 'unloaded'), ('not-reached', 'no-code', 'unloaded')),
         'couldnt-tell': (('couldntTell', 'noCode', 'unloaded'), ('couldnt-tell', 'no-code', 'unloaded'))}
LISTS = ('ran', 'notRan', 'couldntTell', 'noCode', 'unloaded')
# The most characters one of the reach paragraph's lists, or one reason it quotes, takes above the fold: about three lines
# of a comment as GitHub shows it. A longer list is cut, saying how much it leaves out, and view.json holds it whole.
LISTED = 360


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


def spans(lines):
    """Line numbers as ranges, none spanning a number lines doesn't hold: [3, 4, 6] as ['3–4', '6'], each with its count."""
    out = []
    for n in sorted(lines):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return [(f'{a}–{b}' if b > a else f'{a}', b - a + 1) for a, b in out]


def at_lines(spans_):
    return f"{'line' if len(spans_) == 1 and '–' not in spans_[0] else 'lines'} {listed(spans_)}"


def fitted(items, render):
    """How many of items, at least one, render() can take within LISTED."""
    k = 1
    while k < len(items) and len(render(items[:k + 1])) <= LISTED:
        k += 1
    return k


def unlisted(rest, noun='line'):
    """What a cut list leaves out, as `N more lines in M files`, items being (file, ..., count)."""
    return f"{counted(sum(x[-1] for x in rest), f'more {noun}', f'more {noun}s')} in {counted(len({x[0] for x in rest}), 'file', 'files')}"


def by_file(items, each):
    """items, (file, piece, count) in order, as each(file, pieces) for each file in turn."""
    out = {}
    for name, piece, _ in items:
        out.setdefault(name, []).append(piece)
    return [each(name, pieces) for name, pieces in out.items()]


def reason_said(prefix, reason, after, cuts, room=None):
    """prefix, the runner's reason as the view's other runner text shows, cut to LISTED (or to room), then after; a cut
    adds to cuts."""
    def words(shown, part):
        return f"{prefix}{inert(shown)}" + (f" (the reason{part})" if part else '') + after
    said = clipped(words, one_line(reason), len(words('', '')) + LISTED if room is None else room)
    if said != words(one_line(reason), ''):
        cuts.append(reason)
    return said


def after_lines(afters):
    return f"after {'line' if len(afters) == 1 else 'lines'} {listed(str(a) for a in afters)}"


def reach_paragraph(reach):
    return reach_said(reach)[0]


def reach_said(reach):
    """The comment's reach paragraph, from view.json's reach, and whether a fold below it holds what it doesn't show: which
    of the change's source lines ran in no profiled drive, which files no profiled host loaded, which deletions no profiled
    drive reached, or that everything that could run did, and what it couldn't tell and why; each changed line and deletion
    is spoken for by one sentence, or is a line that ran, which only the all-ran sentence counts. CHECKS.md's "Which of the
    change's source lines ran" says what each word means. The fold is shown, and the paragraph's last sentence points to it,
    whenever the paragraph cuts a list or a reason, or counts lines or deletions it doesn't name, so the comment shows every
    line and deletion not seen to run, and every reason, whole; it never sends its reader to view.json, which only the house
    can open."""
    cuts = []
    if 'couldnt' in reach:
        said = reason_said("Couldn't tell which of this change's source lines ran: ", reach['couldnt'], '.', cuts)
        return said + (' The whole reason is in the fold below.' if cuts else ''), bool(cuts)
    files, notes = dict(sorted(reach['files'].items())), reach['notes']
    if not files:
        return f"This change adds or edits no line under {code('src/')}.", False
    loaded = {n: f for n, f in files.items() if f['state'] == 'read'}
    unread = {n: f for n, f in files.items() if f['state'] == 'not-loaded'}
    untold = {n: f for n, f in files.items() if f['state'] != 'not-loaded'}

    def dels(f, *states):
        return [x['after'] for x in f['deletions'] if x['state'] in states]

    def lost(f):
        return f['couldntTell'] + (f['unloaded'] if f['state'] == 'couldnt-tell' else [])
    out = []
    not_ran = [(n, s, c) for n, f in loaded.items() for s, c in spans(f['notRan'])]
    if not_ran:
        def render(xs):
            return '; '.join(by_file(xs, lambda n, ps: f"{code(n)} {at_lines(ps)}"))
        k = fitted(not_ran, render)
        cuts += not_ran[k:]
        n_lines = sum(c for *_, c in not_ran)
        out.append(f"**In the files profiled hosts loaded, {counted(n_lines, 'changed source line that maps', 'changed source lines that map')} "
                   f"to code ran in no profiled drive:** {render(not_ran[:k])}" + (f"; and {unlisted(not_ran[k:])}" if not_ran[k:] else '') + '.')
    if unread:
        def held(f):
            lines, ds = sum(len(f[k]) for k in LISTS), len(f['deletions'])
            return ' and '.join(x for x in (counted(lines, 'changed line', 'changed lines') if lines else '',
                                            counted(ds, 'deletion', 'deletions') if ds else '') if x)
        items = [(n, f"{code(n)} ({held(f)})", 1) for n, f in unread.items()]

        def render(xs, more=''):
            names = [x[1] for x in xs] + ([more] if more else [])
            return names[0] if len(names) == 1 else ', '.join(names[:-1]) + ' or ' + names[-1]
        k = fitted(items, render)
        rest = items[k:]
        cuts += rest
        out.append(f"**No profiled host loaded {render(items[:k], counted(len(rest), 'more file', 'more files') if rest else '')}.**")
    unreached = [(n, a, 1) for n, f in loaded.items() for a in dels(f, 'not-reached')]
    if unreached:
        def render(xs):
            return '; '.join(by_file(xs, lambda n, afters: f"{code(n)}, the {'one' if len(afters) == 1 else 'ones'} {after_lines(afters)}"))
        k = fitted(unreached, render)
        cuts += unreached[k:]
        out.append(f"No profiled drive reached {len(unreached):,} of this change's deletions: {render(unreached[:k])}"
                   + (f"; and {unlisted(unreached[k:], 'deletion')}" if unreached[k:] else '') + '.')
    told_lines = sum(len(lost(f)) for f in untold.values())
    told_bins = [n for n, f in untold.items() if f.get('binary')]
    told_dels = sum(len(dels(f, 'couldnt-tell') + (dels(f, 'unloaded') if f['state'] == 'couldnt-tell' else [])) for f in untold.values())
    ran = sum(len(f['ran']) for f in loaded.values())
    reached_ = sum(len(dels(f, 'reached')) for f in loaded.values())
    if not (not_ran or unread or unreached or told_lines or told_dels or told_bins) and (ran or reached_):
        if ran == 1:
            lead = "This change's 1 changed source line that maps to code ran in at least one profiled drive"
        elif ran:
            lead = f"All {ran:,} of this change's changed source lines that map to code ran in at least one profiled drive"
        if ran and reached_:
            out.append(lead + (", as did code beside 1 of its deletions." if reached_ == 1 else f", as did code beside each of {reached_:,} of its deletions."))
        elif ran:
            out.append(lead + '.')
        else:
            out.append(("Code beside 1 of this change's deletions" if reached_ == 1 else f"Code beside each of {reached_:,} of this change's deletions")
                       + " ran in at least one profiled drive.")
    if (told_lines or told_dels or told_bins) and notes:
        whether = [x for x in (f"whether {counted(told_lines, 'changed source line', 'changed source lines')} ran" if told_lines else '',
                               f"whether {counted(told_dels, 'deletion was', 'deletions were')} reached" if told_dels else '',
                               f"whether the change to {counted(len(told_bins), 'binary file', 'binary files')} ran" if told_bins else '') if x]
        more = f"; and {counted(len(notes) - 1, 'more reason', 'more reasons')}" if len(notes) > 1 else ''
        cuts += notes[1:]
        out.append(reason_said(f"Couldn't tell {', or '.join(whether)}, since ", notes[0], more + '.', cuts))
    elif told_lines or told_dels or told_bins:
        said, rest = [], []
        for n, f in untold.items():
            lines, ds = lost(f), dels(f, 'couldnt-tell') + (dels(f, 'unloaded') if f['state'] == 'couldnt-tell' else [])
            if not (lines or ds or f.get('binary')):
                continue
            if said and sum(len(s) for s in said) >= LISTED:
                rest.append((n, len(lines), len(ds), bool(f.get('binary'))))
                continue
            deleted = ds and f"{'deletion' if len(ds) == 1 else 'deletions'} {after_lines(ds)} {'was' if len(ds) == 1 else 'were'} reached"
            whether = (f"whether the change to {code(n)} ran" if f.get('binary')
                       else f"whether {len(lines):,} of {code(n)}'s changed lines ran" + (f", or whether its {deleted}" if ds else '') if lines
                       else f"whether {code(n)}'s {deleted}")
            said.append(reason_said(f"Couldn't tell {whether}: ", f['reason'], '.', cuts))
        cuts += rest
        if rest:
            lines, ds, bins = sum(x[1] for x in rest), sum(x[2] for x in rest), sum(x[3] for x in rest)
            whether = [x for x in (f"whether {counted(lines, 'more changed line', 'more changed lines')} ran" if lines else '',
                                   f"whether {counted(ds, 'more deletion was', 'more deletions were')} reached" if ds else '',
                                   f"whether the change to {counted(bins, 'more binary file', 'more binary files')} ran" if bins else '') if x]
            said.append(f"Couldn't tell either {', or '.join(whether)}, in {counted(len(rest), 'more file', 'more files')}, each for its own reason.")
        out += said
    nothing = [(n, f['noCode'], dels(f, 'no-code')) for n, f in untold.items() if f['noCode'] or dels(f, 'no-code')]
    if nothing:
        z, zd = sum(len(x[1]) for x in nothing), sum(len(x[2]) for x in nothing)

        def piece(n, lines, ds):
            if not ds:
                return f"{len(lines):,} of {code(n)}'s" + (' lines' if zd else '')
            deleted = f"{'deletion' if len(ds) == 1 else 'deletions'} {after_lines(ds)}"
            return f"{len(lines):,} of {code(n)}'s lines and its {deleted}" if lines else f"{code(n)}'s {deleted}"
        items = [(n, piece(n, lines, ds), len(lines), len(ds)) for n, lines, ds in nothing]

        def render(xs):
            ps = [x[1] for x in xs]
            return listed(ps) if not zd or len(ps) == 1 else ', '.join(ps[:-1]) + ', and ' + ps[-1]
        k = fitted(items, render)
        rest = items[k:]
        cuts += rest
        more = ' and '.join(x for x in (counted(sum(x[2] for x in rest), 'more line', 'more lines') if any(x[2] for x in rest) else '',
                                        counted(sum(x[3] for x in rest), 'more deletion', 'more deletions') if any(x[3] for x in rest) else '') if x)
        listing_ = (', '.join(x[1] for x in items[:k]) + f", and {more} in {counted(len(rest), 'more file', 'more files')}" if rest
                    else render(items))
        if z and zd:
            lead = (f"{counted(z, 'changed source line maps', 'changed source lines map')} to nothing the host runs, and "
                    f"{counted(zd, 'deletion has', 'deletions have')} no code line on either side of {'it' if zd == 1 else 'them'} to be judged by")
        elif z:
            lead = f"{counted(z, 'changed source line maps', 'changed source lines map')} to nothing the host runs"
        else:
            lead = (f"{zd:,} of this change's deletions {'has' if zd == 1 else 'have'} no code line on either side of "
                    f"{'it' if zd == 1 else 'them'} to be judged by")
        out.append(f"{lead}: {listing_}.")
    fold = bool(cuts or unread or told_lines or told_dels or (told_bins and notes) or nothing)
    if fold:
        out.append("The whole list is in the fold below.")
    return ' '.join(out), fold


# The fold that holds whole what the reach paragraph doesn't show: its lines and reasons, or the reason a join couldn't be made.
REACH_FOLD = "Changed source lines and deletions not seen to run, by file"
# What asks for a view, and who may: this account alone, while views post nowhere else. Each ask also needs write access, as
# review-workflow's /review does. The poll reads both from here, so a comment with no reader names whoever the poll serves.
COMMAND = '/context-deltas'
ASKERS = ('nissa-seru',)
UNREAD = (f"No model read these records for this view, which started on its own. A view asked for with a {code(COMMAND)} comment by "
          f"{' or '.join(code(a) for a in ASKERS)} gives a model's account of the records of the pull request's head as it is when that view "
          "runs.")
REACH_WHY = "Why it couldn't tell which of this change's source lines ran"


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


def reach_items(reach, room):
    """The fold's lines, each within room: each reason that covers every line not seen to run, then, file by file, every
    changed line and deletion of the file that isn't one that ran or was reached, what the paragraph says of it, whole, with
    the file's own reason for what it couldn't tell: the whole of it, or with notes, what it says beyond them."""
    if 'couldnt' in reach:
        return [reason_said("Couldn't tell which of this change's source lines ran: ", reach['couldnt'], '.', [], room)]
    notes, out = reach['notes'], []
    out += [reason_said("Couldn't tell for any line or deletion not seen to run, since ", n, '.', [], room) for n in notes]
    for n, f in sorted(reach['files'].items()):
        def dels(*states):
            return [x['after'] for x in f['deletions'] if x['state'] in states]

        def its(afters):
            return f"its {'deletion' if len(afters) == 1 else 'deletions'} {after_lines(afters)}"

        def at(lines):
            return at_lines([s for s, _ in spans(lines)])
        if f['state'] == 'not-loaded':
            lines, ds = sorted(sum((f[k] for k in LISTS), [])), dels(*HOLDS['not-loaded'][1])
            parts = ['no profiled host loaded it: ' + ' and '.join(x for x in (f"changed {at(lines)}" if lines else '', its(ds) if ds else '') if x)]
        else:
            lost, lost_ds = f['couldntTell'] + (f['unloaded'] if f['state'] == 'couldnt-tell' else []), dels('couldnt-tell', 'unloaded')
            parts = ["couldn't tell whether its change ran" if f.get('binary') else '',
                     f"{at(f['notRan'])} ran in no profiled drive" if f['notRan'] else '',
                     f"no profiled drive reached {its(dels('not-reached'))}" if dels('not-reached') else '',
                     f"{at(f['noCode'])} {'maps' if len(f['noCode']) == 1 else 'map'} to nothing the host runs" if f['noCode'] else '',
                     f"{its(dels('no-code'))} {'has' if len(dels('no-code')) == 1 else 'have'} no code line on either side" if dels('no-code') else '',
                     ', or '.join(x for x in (f"couldn't tell whether {at(sorted(lost))} ran" if lost else '',
                                              (f"whether {its(lost_ds)} {'was' if len(lost_ds) == 1 else 'were'} reached" if lost
                                               else f"couldn't tell whether {its(lost_ds)} {'was' if len(lost_ds) == 1 else 'were'} reached") if lost_ds else '') if x)]
            parts = [x for x in parts if x]
        if not parts:
            continue
        said = f"{code(n)}: {'; '.join(parts)}"
        own = f['state'] != 'not-loaded' and (lost or lost_ds or f.get('binary')) and beyond(f['reason'], notes)
        if own and not notes:
            out.append(reason_said(said + ', since ', own, '.', [], room))
        elif own:
            out.append(reason_said(said + ', since ', own, ', besides the reasons above.', [], room))
        else:
            out.append(said + '.')
    return out


def units(view, reader, room):
    held = [x for x in [held_text(view)] if x]
    if view['outcome'] != 'ran':
        need(reader is None, "a head that couldn't be compared has no reader account")
        return [linked(view), *could_not(view, room)]
    some, partial = view['runs']['compared'], bool(view.get('broken'))
    if not some:
        need(reader is None, "a head none of whose runs could be compared has no reader account")
        return [linked(view), *could_not(view, room), *forced_line(view), *flags_text(view, room), *held]
    runs = f"the {counted(some, 'run', 'runs')} it could compare" if partial else f"the {counted(some, 'run', 'runs')}"
    lost = len(view.get('broken') or [])
    said, cut = reach_said(view['reach']) if 'reach' in view else (None, False)
    reach = [said] if said else []
    need(all(len(x) <= room for x in reach), f"the reach paragraph doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters")
    title = summary_text(REACH_WHY if 'couldnt' in view.get('reach', {}) else REACH_FOLD)
    reach_fold = folded(title, reach_items(view['reach'], inside(room, title)), room) if cut else []
    reasons = summary_text(f"Runs that couldn't be compared ({lost:,})")
    lost_fold = folded(reasons, could_not(view, inside(room, reasons)), room) if lost else []
    if not view['entries']:
        need(reader is None, "a head whose runs it could compare don't differ has no reader account")
        return [linked(view),
                f"The records of {runs} don't differ between the base and this head.", *differing_line(view), *forced_line(view), *reach,
                *absent_line(view), *([lost_line(lost)] if lost else []), *usage_line(view), *upgrade_lines(view), *flags_text(view, room),
                *lost_fold, *usage_fold(view, room), *upgrades_fold(view, room), *reach_fold, *held]
    places = {p['run'] for e in view['entries'] for p in e['places']}
    changed = len(places)
    flagged = sum(len(f['new']) + len(f['gone']) for f in view.get('flags') or [])
    count = f"The records of {changed:,} of {runs} differ between the base and this head."
    flags = summary_text(f"Checks' flags that differ ({flagged:,})")
    lines = [linked(view), count, *differing_line(view), *forced_line(view), *reach, *absent_line(view), *([lost_line(lost)] if lost else []),
             *([flags_line(view, flagged)] if flagged else []), *usage_line(view), *upgrade_lines(view)]
    folds = [*lost_fold, *(folded(flags, flags_text(view, inside(room, flags))[1:], room) if flagged else []), *usage_fold(view, room),
             *upgrades_fold(view, room), *reach_fold, *held]
    if reader is None:
        differ = summary_text(f"Runs whose records differ: {changed:,} of {some:,}")
        return [*lines, UNREAD, *folded(differ, [listed(code(one_line(r)) for r in view['order'] if r in places) + '.'], room), *folds]
    entries = {e['id']: e for e in view['entries']}
    reader = {**reader, 'changes': [known(c, entries) for c in reader['changes']]}
    differ = summary_text(f"Runs whose records differ: {changed:,} of {some:,}, with {counted(len(reader['changes']), 'change', 'changes')}")
    return [*lines, "*A model's account of those records:*", *deltas(view, reader),
            *folded(differ, run_folds(view, reader, entries, inside(room, differ)), room), *folds]


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


# review-workflow's installed command, which a view wants its pull request's "Changes context" through.
REVIEW_POLL = os.path.expanduser('~/.local/bin/review-poll')


def context_of(view):
    """The value a view gives its pull request's "Changes context", by the comment's own headline: Yes where the records of
    some run it could compare differ, No where it compared runs, every one, and none differ, and None for any other view, a
    merged pull request's included. So No means none of the view's runs differ: a change on a path no run reaches reads No."""
    if view.get('outcome') != 'ran' or 'merge' in view:
        return None
    if view.get('entries'):
        return 'Yes'
    return 'No' if view['runs']['compared'] > 0 and not view.get('broken') else None


def wanted(d, view, value):
    """Wants value through review-workflow's poll, timed at view.json's ended, when the view's run side finished, so that of
    two views of a pull request the one whose run side finished later stands, whichever posted first. A failure is said on
    stderr and fails nothing: the comment is already up."""
    if not view.get('ended'):
        print(f"post: its Changes context, {value}, wasn't wanted: its view.json has no ended, as one facts wrote before "
              "view.json carried it", file=sys.stderr)
        return
    argv = [REVIEW_POLL, 'want', '--kind', 'context', '--repo', view['repo'], '--number', str(view['number']),
            '--label', os.path.basename(os.path.normpath(d)), '--value', value, '--started', view['ended']]
    try:
        ran = subprocess.run(argv, capture_output=True, text=True, errors='replace', timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"post: its Changes context, {value}, wasn't wanted: {e}", file=sys.stderr)
        return
    if ran.returncode != 0:
        print(f"post: its Changes context, {value}, wasn't wanted: {REVIEW_POLL} exited {ran.returncode}: "
              f"{(ran.stderr or ran.stdout).strip()[:500]}", file=sys.stderr)


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
            if PARTS.fullmatch(name):
                os.remove(os.path.join(d, name))
        for k, text in enumerate(texts, 1):
            with open(os.path.join(d, 'comment.md' if k == 1 else f'comment-{k}.md'), 'w') as f:
                f.write(text)
        return {'action': 'dry', 'parts': len(texts)}
    parts_of(view, reader, head, digest, head)
    token, app_id, _ = viewed(repo)
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
    value = context_of(view)
    if value:
        wanted(d, view, value)
    return {'action': action, 'url': url, **({'staleKept': stale} if stale else {}), **({'stoppedKept': kept} if kept else {})}


def stopped(args):
    repo, number, head = args['repo'], args['number'], args['head']
    need(full_sha(head), f"head isn't a full commit sha, {head!r}")
    said = stopped_mark(head)
    text = '\n\n'.join([f"**Automatic context view** of {code(head[:12])} stopped before it finished, so it has nothing to report.",
                         CHECKED, said])
    if not args.get('post', True):
        return {'action': 'dry', 'text': text}
    token, app_id, _ = viewed(repo)
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


STEPS = {'facts': facts, 'compared': compared, 'post': post, 'stopped': stopped, 'rooms': rooms}


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
        refuse_checkout(__file__, '~/.local/lib/context-view/current/view/step STEP', 1)
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

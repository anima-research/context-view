"""What the view's tests share: a stand-in GitHub, a run's directory as the run side lays it out with the builders of
its results, and Steps, the test case that runs the view's steps over them."""
import json, os, re, shutil, tempfile, unittest
from unittest import mock

import pr_comment
import pr_review
import view as cv
import view_read


REPO = 'anima-research/context-manager'


APP = 7


H1, H2, H3, BASE = 'a' * 40, 'b' * 40, 'c' * 40, 'd' * 40


HARNESS = '0123456789abcdef' * 2 + '01234567'


READS = {'instructions': '1' * 64, 'guide': '2' * 64}


# The four repositories' GitHub IDs as the stand-in GitHub gives them: a copy of the view's own, so a test can rename a
# repository on GitHub's side alone.
VIEWED = dict(view_read.VIEWED)


RUNS = ['H1/W1', 'H1/W2', 'C6h/W11']


VERSIONS = {'@animalabs/connectome-host': '0.21.0 (source 54321fd3af80)', '@animalabs/agent-framework': '0.32.0',
            '@animalabs/membrane': '0.8.0', '@animalabs/chronicle': '0.5.1', 'bun': '1.4.4'}


M, AF = '@animalabs/membrane', '@animalabs/agent-framework'


def read_file(path):
    with open(path) as f:
        return f.read()


def nesting(text):
    """Each collapsible in text, in order, as (its summary, its parent's summary or None); text's collapsibles must close."""
    out, stack = [], []
    for m in re.finditer(r'<details><summary>(.*?)</summary>|</details>', text):
        if m.group(1) is None:
            stack.pop()
            continue
        out.append((m.group(1), stack[-1] if stack else None))
        stack.append(m.group(1))
    assert not stack, stack
    return out


def counts(compiles=10, compressions=2, merges=1, quarantines=None):
    return {'compiles': compiles, 'compressions': compressions, 'merges': merges, 'quarantines': quarantines}


def result(run, record='same', outcome='pass', check='same', flags=None, reason=None, absent=None, baseAbsent=None, usage=None, **more):
    r = {'run': run, 'outcome': outcome, 'record': record, 'flags': flags or {'new': [], 'gone': [], 'kept': []},
         'counts': counts(**more), **({'selfCheck': {'outcome': check}} if check else {}), **({'reason': reason} if reason else {}),
         **({'absent': absent} if absent is not None else {}), **({'baseAbsent': baseAbsent} if baseAbsent is not None else {}),
         **({'usage': usage} if usage is not None else {})}
    if outcome == 'couldnt-run':
        r.update(record=None)
        r.pop('counts'), r.pop('flags'), r.pop('selfCheck', None)
    return r


def usage(agent=None, last=0, calibration=None, **kinds):
    def figures(requests=10, input=1000, cacheRead=9000, cacheWrite=500, output=200, dropped=0):
        return {'requests': requests, 'input': input, 'cacheRead': cacheRead, 'cacheWrite': cacheWrite, 'output': output, 'dropped': dropped}
    return {'kinds': {'agent': figures(**(agent or {})), **{k: figures(**v) for k, v in kinds.items()}}, 'lastDropped': last, 'calibration': calibration}


def priced(u, unpriced=0, **costs):
    """u with each kind priced: its cost from costs (0.5 where not given) and `unpriced` requests left without a price."""
    for where in ('kinds', 'history'):
        for kind, k in (u.get(where) or {}).items():
            k.update(cost=costs.get(kind, 0.5), unpriced=unpriced)
    return u


def reached_file(state='read', deletions=(), reason=None, **lists):
    """One changed file of reach.json as the harness's reachOf writes it: each list, its deletions as (after, state, by), and
    its reason where it couldn't tell."""
    return {'state': state, **{k: list(lists.get(k, [])) for k in ('ran', 'notRan', 'couldntTell', 'noCode', 'unloaded')},
            'deletions': [{'after': a, 'state': s, 'by': b} for a, s, b in deletions], **({'reason': reason} if reason else {})}


# The reach.json a run's fixture writes unless it names another: one loaded file whose two changed lines both ran.
REACHED = {'change': 'anima-research/context-manager', 'files': {'src/a.ts': reached_file(ran=[1, 2])}, 'notes': [],
           'fallbacks': {'fired': 0, 'notes': []}, 'drives': {}, 'code': {'wrote': ['9' * 64], 'joined': '9' * 64}}


ALL_RAN = "All 2 of this change's changed source lines that map to code ran in at least one profiled drive."


def entry(eid, *places, before='old text', after='new text'):
    places = [{'run': r, 'step': s} for r, s in places]
    firsts = {}
    for p in places:
        firsts.setdefault(p['run'], p)
    return {'id': eid, 'describe': f'{eid} changed', 'count': len(places), 'runs': sorted(firsts),
            'places': places, 'examples': [{'run': p['run'], 'step': p['step'], 'before': before, 'after': after} for p in firsts.values()]}


def app_token(repo):
    """The App's token, as pr_review.app_token gives it: GitHub answers 404 for a repository the App isn't installed on."""
    if repo.split('/', 1)[0] not in ('anima-research', 'antra-tess'):
        raise pr_review.Failed(f'GitHub answered 404 to GET /repos/{repo}/installation: Not Found')
    return 'tok', {'id': 4242, 'account': {'id': 1}}, APP


class GitHub:
    """GitHub's answers to the calls the steps make, refusing what GitHub refuses: a comment past 65,536 characters, and a
    change to a comment that isn't there."""

    def __init__(self):
        self.comments, self.calls, self.state, self.head = [], [], 'open', H1
        self.undeletable = set()
        self.next_id = 100
        self.posts, self.posts_fail_after = 0, None
        self.pull = {'title': 'fix: merges by relief @someone #12', 'body': 'It changes <b>this</b>.'}

    def api(self, method, path, token=None, body=None, bearer=None, missing=False, repeat=None):
        self.calls.append((method, path.split('?')[0]))
        named = re.fullmatch(r'/repos/([^/]+/[^/]+)', path)
        if named:
            ids = {**{name: rid for rid, name in VIEWED.items()}, 'anima-research/context-manager-renamed': 1126567876}
            return {'id': ids.get(named[1], 99), 'full_name': named[1]}
        if re.fullmatch(r'/repos/[^/]+/[^/]+/pulls/5', path):
            return {'state': self.state, 'head': {'sha': self.head}, **self.pull}
        if method == 'GET' and path.startswith(f'/repos/{REPO}/issues/5/comments'):
            page = int(re.search(r'[?&]page=(\d+)', path)[1])
            return [dict(c) for c in self.comments[(page - 1) * 100:page * 100]]
        if method == 'POST' and path == f'/repos/{REPO}/issues/5/comments':
            if len(body['body']) > pr_comment.COMMENT_MAX:
                raise pr_review.Failed(f"GitHub answered 422 to POST {path}: Body is too long (maximum is 65536 characters)")
            if self.posts_fail_after is not None and self.posts >= self.posts_fail_after:
                raise pr_review.Passing(f'GitHub answered 502 to POST {path}: Bad Gateway')
            self.posts += 1
            self.next_id += 1
            c = {'id': self.next_id, 'body': body['body'], 'html_url': f'https://github.com/{REPO}/pull/5#issuecomment-{self.next_id}',
                 'performed_via_github_app': {'id': APP}}
            self.comments.append(c)
            return dict(c)
        at = re.fullmatch(rf'/repos/{re.escape(REPO)}/issues/comments/(\d+)', path)
        if at and method in ('PATCH', 'DELETE'):
            held = [c for c in self.comments if c['id'] == int(at[1])]
            if not held:
                if missing:
                    return None
                raise pr_review.Failed(f'GitHub answered 404 to {method} {path}: Not Found')
            if method == 'DELETE':
                if held[0]['id'] in self.undeletable:
                    raise pr_review.Failed(f'GitHub answered 403 to DELETE {path}: Resource not accessible by integration')
                self.comments.remove(held[0])
                return None
            if len(body['body']) > pr_comment.COMMENT_MAX:
                raise pr_review.Failed(f'GitHub answered 422 to PATCH {path}: Body is too long (maximum is 65536 characters)')
            held[0]['body'] = body['body']
            return dict(held[0])
        raise AssertionError(f'unrouted {method} {path}')


class Steps(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='context-view-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.gh = GitHub()
        for name, value in (('api', self.gh.api), ('app_token', app_token), ('REPOSITORIES', {})):
            patcher = mock.patch.object(pr_review, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(pr_review.time, 'sleep', lambda s: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(cv, 'REVIEW_POLL', shutil.which('true'))
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_dir(self, shares, head=H1, outcome='ran', detail=None, form='overlay', repo='context-manager', base_versions=None,
                head_versions=None, base_results=None, runs=None, stack=None, reach=REACHED, forced=None):
        d = tempfile.mkdtemp(dir=self.tmp)
        if reach is not None:
            with open(os.path.join(d, 'reach.json'), 'w') as f:
                json.dump(reach, f)
        manifest = {'repo': repo, 'number': 5, 'head': head, 'form': form, 'base': {'ref': 'main', 'sha': BASE},
                    'host': {'sha': 'e' * 40}, 'harness': {'repo': 'anima-research/context-view', 'sha': HARNESS},
                    **({'stack': stack} if stack is not None else {}), **({'forced': forced} if forced is not None else {}), 'outcome': outcome, 'detail': detail, 'shares': []}
        for i, (results, entries) in enumerate(shares, 1):
            manifest['shares'].append({'i': i, 'dir': f'share-{i}', 'onGh': f'run-{i}', 'setupExit': 0, 'commandExit': 0,
                                       'seconds': {'setup': 60, 'command': 120}, 'kb': 900, 'viewsDropped': False, 'home': True})
            for arm, versions in (('before', base_versions or VERSIONS), ('after', head_versions or VERSIONS)):
                os.makedirs(os.path.join(d, f'share-{i}', arm))
                with open(os.path.join(d, f'share-{i}', arm, 'run.json'), 'w') as f:
                    json.dump({'runs': runs or RUNS, 'candidate': {'versions': {**versions, '@animalabs/context-manager': f'0.24.2 ({arm})'}},
                               'results': results if arm == 'after' else [r for r in base_results or [] if r['run'] in {x['run'] for x in results}]}, f)
            with open(os.path.join(d, f'share-{i}', 'after', 'entries.json'), 'w') as f:
                json.dump(entries, f)
        with open(os.path.join(d, 'manifest.json'), 'w') as f:
            json.dump(manifest, f)
        return d

    def facts(self, d, repo=REPO):
        view_read.facts({'dir': d, 'repo': repo})
        return pr_review.read_json(os.path.join(d, 'view.json'))

    def post(self, d, reader=None, post=True, reads=None):
        path = None if reader is None else self.write(d, reader)
        return cv.post({'dir': d, 'reader': path, 'post': post, **({'reads': reads or READS} if reader is not None else {})})

    def write(self, d, reader):
        """reader.json, as the workflow hands it to post: each change with the place its quotes are from, which the
        workflow works out from the view's entries. A fixture that names none gets its first entry's example's place."""
        view = os.path.join(d, 'view.json')
        if os.path.exists(view):
            entries = {e['id']: e for e in pr_review.read_json(view)['entries']}
            reader = {**reader, 'changes': [c if 'place' in c or not c['refs'] or c['refs'][0] not in entries
                                            else {**c, 'place': entries[c['refs'][0]]['example']['place']} for c in reader['changes']]}
        path = os.path.join(d, 'reader.json')
        with open(path, 'w') as f:
            json.dump(reader, f)
        return path

    def chosen_run(self, base, head, stack, reached=None):
        """Three runs whose records don't differ (or, with reached, H1/W1's does, at that entry), the arms having run the
        releases of membrane and agent-framework given, as the plan's stack chose them."""
        def versions(v):
            return {**VERSIONS, **{f'@animalabs/{k}': x for k, x in v.items()}}
        results = [result('H1/W1', record='differs' if reached else 'same'), result('H1/W2'), result('C6h/W11')]
        return self.run_dir([(results, [reached] if reached else [])], base_versions=versions(base), head_versions=versions(head), stack=stack)

    def unchanged_run(self, head=H1, **more):
        return self.run_dir([([result('H1/W1', **more), result('C6h/W11', **more)], []), ([result('H1/W2', **more)], [])], head=head)

    def changed_run(self, head=H1, after='new text'):
        e1 = [entry('aaaaaaaaaaaa', ('H1/W2', 4))]
        e2 = [entry('aaaaaaaaaaaa', ('H1/W1', 7), before='first old', after=after), entry('bbbbbbbbbbbb', ('H1/W1', 9))]
        return self.run_dir([([result('H1/W2', record='differs')], e1), ([result('H1/W1', record='differs'), result('C6h/W11')], e2)], head=head)

    def reader(self, *refs, title='Merges go first', head='The summariser gets merge requests first'):
        return {'changes': [{'title': title, 'where': 'In every run compared, at its first compile', 'base': 'It changes the order of requests @maintainer, #3',
                             'head': head, 'refs': list(refs) or ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
                             'before': 'call 1 ```x``` </details>', 'after': ''}]}

    def bodies(self):
        return [c['body'] for c in self.gh.comments]

    def four(self, word):
        long = 'x' * 20_000
        return {'changes': [{'title': f'C{i}', 'where': word, 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': long, 'after': long}
                                               for i in range(4)]}

    def comment(self, d, reader=None):
        self.facts(d)
        cv.post({'dir': d, 'reader': reader and self.write(d, reader), 'post': False, **({'reads': READS} if reader else {})})
        with open(os.path.join(d, 'comment.md')) as f:
            return f.read()

    def upgraded(self, base_run, head_run, base_twin, head_twin, flags=None, twin_flags=None):
        runs = ['H1b/continuation/from-0.9.0', 'H1b/continuation/fresh']
        def side(end, run, f=None):
            u = usage(**end)
            if run.endswith('/fresh'):
                u['kinds']['agent'] = {**u['kinds']['agent'], 'requests': 13, 'input': 1300, 'cacheRead': 9100, 'cacheWrite': 640, 'output': 260}
                u['history'] = {'agent': {'requests': 3, 'input': 400, 'cacheRead': 1000, 'cacheWrite': 100, 'output': 50, 'dropped': 0}}
            return result(run, usage=u, flags=f)
        head = [side(head_run, runs[0], flags), side(head_twin, runs[1], twin_flags)]
        base = [side(base_run, runs[0]), side(base_twin, runs[1])]
        return self.run_dir([(head, [])], base_results=base, runs=runs)

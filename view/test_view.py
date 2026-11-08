"""The context view's steps (view.py): facts read from a run's shares, its comment in fixed words or the reader's
account, posted, edited or left as it is on the pull request, and its stopped words."""
import contextlib, hashlib, io, json, os, re, shutil, tempfile, unittest
from unittest import mock

import view as cv
import pr_comment
import pr_review

REPO = 'anima-research/context-manager'
APP = 7
H1, H2, H3, BASE = 'a' * 40, 'b' * 40, 'c' * 40, 'd' * 40
HARNESS = '0123456789abcdef' * 2 + '01234567'
READS = {'instructions': '1' * 64, 'guide': '2' * 64}
# The four repositories' GitHub IDs as the stand-in GitHub gives them: a copy of the view's own, so a test can rename a
# repository on GitHub's side alone.
VIEWED = dict(cv.VIEWED)
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

    def run_dir(self, shares, head=H1, outcome='ran', detail=None, form='overlay', repo='context-manager', base_versions=None,
                head_versions=None, base_results=None, runs=None, stack=None):
        d = tempfile.mkdtemp(dir=self.tmp)
        manifest = {'repo': repo, 'number': 5, 'head': head, 'form': form, 'base': {'ref': 'main', 'sha': BASE},
                    'host': {'sha': 'e' * 40}, 'harness': {'repo': 'anima-research/context-view', 'sha': HARNESS},
                    **({'stack': stack} if stack is not None else {}), 'outcome': outcome, 'detail': detail, 'shares': []}
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
        cv.facts({'dir': d, 'repo': repo})
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


class Facts(Steps):
    def test_entries_from_every_share_merge_by_id_in_run_order_with_the_earliest_places_example(self):
        view = self.facts(self.changed_run())
        self.assertEqual([e['id'] for e in view['entries']], ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
        merged = view['entries'][0]
        self.assertEqual(merged['places'], [{'run': 'H1/W1', 'step': 7}, {'run': 'H1/W2', 'step': 4}])
        self.assertEqual(merged['example']['before'], 'first old')
        self.assertEqual((merged['count'], sorted(merged['runs'])), (2, ['H1/W1', 'H1/W2']))

    def test_a_view_is_changed_for_the_reader_whenever_it_ran_and_the_runs_it_could_compare_differ(self):
        self.assertTrue(cv.facts({'dir': self.changed_run(), 'repo': REPO})['changed'])
        self.assertFalse(cv.facts({'dir': self.unchanged_run(), 'repo': REPO})['changed'])
        some = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')],
                              [entry('aaaaaaaaaaaa', ('H1/W2', 1))])])
        self.assertTrue(cv.facts({'dir': some, 'repo': REPO})['changed'])
        only_uncompared = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2'), result('C6h/W11')],
                                         [entry('aaaaaaaaaaaa', ('H1/W1', 1))])])
        self.assertFalse(cv.facts({'dir': only_uncompared, 'repo': REPO})['changed'])
        for outcome, detail in (('doesnt-merge', None), ('arm-missing', {'share': 1, 'arm': 'after', 'log': None}), ('moved', None)):
            with self.subTest(outcome=outcome):
                try:
                    changed = cv.facts({'dir': self.run_dir([([], [])], outcome=outcome, detail=detail), 'repo': REPO})['changed']
                except Exception as e:
                    self.fail(f'facts broke on an outcome with no runs: {e!r}')
                self.assertFalse(changed)

    def test_where_the_runs_it_could_compare_differ_the_reader_runs_and_reads_the_pull_request_whatever_couldnt_be_compared(self):
        some = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')],
                              [entry('aaaaaaaaaaaa', ('H1/W2', 1))])])
        none = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2'), result('C6h/W11')], [])])
        views = [self.facts(some), self.facts(none)]
        with self.assertRaisesRegex(pr_review.Failed, 'needs the reader account'):
            self.post(some, post=False)
        some_view, none_view = views
        for other in ({'title': 'Another title'}, {'body': 'Another description'}):
            with self.subTest(other=other):
                self.assertNotEqual(cv.result_of({**some_view, **other}, READS), cv.result_of(some_view, READS))
                self.assertEqual(cv.result_of({**none_view, **other}), cv.result_of(none_view))
        for other in ({**READS, 'instructions': '3' * 64}, {**READS, 'guide': '3' * 64}):
            with self.subTest(other=other):
                self.assertNotEqual(cv.result_of(some_view, other), cv.result_of(some_view, READS))

    def test_where_the_reader_runs_its_instructions_and_guide_are_part_of_the_result_and_post_takes_their_hashes_only_with_it(self):
        view = self.facts(self.changed_run())
        for other in ({**READS, 'instructions': '3' * 64}, {**READS, 'guide': '3' * 64}):
            self.assertNotEqual(cv.result_of(view, other), cv.result_of(view, READS))
        d = self.changed_run()
        self.facts(d)
        self.post(d, self.reader())
        self.assertEqual(self.post(d, self.reader())['action'], 'unchanged')
        self.assertEqual(self.post(d, self.reader(), reads={**READS, 'guide': '3' * 64})['action'], 'posted')
        calls = len(self.gh.calls)
        path = os.path.join(d, 'reader.json')
        for args in ({'reader': path}, {'reader': None, 'reads': READS}, {'reader': path, 'reads': {**READS, 'guide': 'G' * 64}},
                     {'reader': path, 'reads': {'instructions': '1' * 64}}):
            with self.subTest(args=args), self.assertRaisesRegex(pr_review.Failed, 'post: reads'):
                cv.post({'dir': d, 'post': True, **args})
        self.assertEqual(self.gh.calls[calls:], [])

    def test_merged_entries_are_the_same_however_the_runs_fall_into_shares(self):
        one = self.run_dir([([result('H1/W2', record='differs')], [entry('aaaaaaaaaaaa', ('H1/W2', 4))]),
                            ([result('H1/W1', record='differs'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W1', 7))])])
        two = self.run_dir([([result('H1/W1', record='differs')], [entry('aaaaaaaaaaaa', ('H1/W1', 7))]),
                            ([result('H1/W2', record='differs'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W2', 4))])])
        a, b = self.facts(one), self.facts(two)
        self.assertEqual(a['entries'], b['entries'])
        self.assertEqual(a['entries'][0]['runs'], ['H1/W1', 'H1/W2'])
        self.assertEqual(cv.result_of(a), cv.result_of(b))

    def test_a_manifest_with_an_unknown_outcome_or_a_run_with_no_shares_or_a_place_outside_the_runs_fails(self):
        with self.assertRaisesRegex(pr_review.Failed, "an outcome the view doesn't know"):
            self.facts(self.run_dir([], outcome='exploded'))
        with self.assertRaisesRegex(pr_review.Failed, 'a run with no shares'):
            self.facts(self.run_dir([]))
        with self.assertRaisesRegex(pr_review.Failed, "entry aaaaaaaaaaaa has a place in a run outside its share's results"):
            self.facts(self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('W99', 1))])]))
        for places in (None, 'H1/W1', ['H1/W1']):
            e = {**entry('aaaaaaaaaaaa', ('H1/W1', 1)), 'places': places}
            with self.subTest(places=places), self.assertRaisesRegex(pr_review.Failed, "entry aaaaaaaaaaaa's places aren't a list of places"):
                self.facts(self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [e])]))
        with self.assertRaisesRegex(pr_review.Failed, "a quarantine count the view doesn't know"):
            self.facts(self.run_dir([([result('H1/W1', quarantines='odd'), result('H1/W2'), result('C6h/W11')], [])]))

    def test_a_count_that_isnt_a_whole_number_of_0_or_more_fails_the_step_naming_it(self):
        for field, value in (('compiles', 1.5), ('compiles', -1), ('compiles', '3'), ('compiles', True), ('compiles', None),
                             ('compressions', -2), ('compressions', 2.0), ('merges', -1), ('merges', False),
                             ('quarantines', {'compression': -1, 'merge': 0}), ('quarantines', {'compression': 0, 'merge': 0.5}),
                             ('quarantines', {'compression': True, 'merge': 0})):
            with self.subTest(field=field, value=value), \
                    self.assertRaisesRegex(pr_review.Failed, rf"H1/W1: .*{field[:-1]}.* count .*{re.escape(repr(value))}"):
                self.facts(self.run_dir([([result('H1/W1', **{field: value}), result('H1/W2'), result('C6h/W11')], [])]))
        d = self.run_dir([([result('H1/W1', compiles=0, compressions=0, merges=0, quarantines={'compression': 0, 'merge': 0}),
                            result('H1/W2'), result('C6h/W11')], [])])
        self.facts(d)
        self.assertEqual(pr_review.read_json(os.path.join(d, 'view.json'))['reached']['requests'], 20)

    def test_a_flag_whose_check_isnt_a_whole_number_of_1_or_more_fails_the_step_naming_it(self):
        for check, where in [(c, 'gone') for c in (0, -1, '11', 11.0, True, None)] + [('11', 'kept'), (None, 'kept'), ('[x](https://example.com)', 'kept')]:
            flags = {'new': [], 'gone': [], 'kept': [], where: [{'check': check, 'step': 'the run', 'detail': 'd'}]}
            with self.subTest(check=check, where=where), \
                    self.assertRaisesRegex(pr_review.Failed, rf"H1/W1: a flag's check isn't a whole number of 1 or more, {re.escape(repr(check))}"):
                self.facts(self.run_dir([([result('H1/W1', flags=flags), result('H1/W2'), result('C6h/W11')], [])]))
        flags = {'new': [{'check': 16, 'step': 'the run', 'detail': 'd'}], 'gone': [], 'kept': []}
        self.facts(self.run_dir([([result('H1/W1', flags=flags), result('H1/W2'), result('C6h/W11')], [])]))

    def test_entries_first_at_steps_of_one_run_are_ordered_by_their_steps_runs_of_digits_by_number(self):
        steps = ['h5', '232330.10', '16g', '232330.9', '7f']
        entries = [entry(f'{n:012x}', ('H1/W2', step)) for n, step in enumerate(steps, 1)]
        d = self.run_dir([([result('H1/W1'), result('H1/W2', record='differs'), result('C6h/W11')], entries)])
        self.facts(d)
        shown = [e['places'][0]['step'] for e in pr_review.read_json(os.path.join(d, 'view.json'))['entries']]
        self.assertEqual(shown, ['7f', '16g', '232330.9', '232330.10', 'h5'])

    def test_an_entry_with_a_place_in_another_shares_run_fails_the_step(self):
        d = self.run_dir([([result('H1/W1', record='differs'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W2', 4))]),
                          ([result('H1/W2', record='differs')], [entry('bbbbbbbbbbbb', ('H1/W2', 2))])])
        with self.assertRaisesRegex(pr_review.Failed, "share-1: entry aaaaaaaaaaaa has a place in a run outside its share's results"):
            self.facts(d)

    def test_an_example_not_at_its_runs_first_place_in_the_entry_fails_the_step(self):
        e = entry('aaaaaaaaaaaa', ('H1/W1', 2), ('H1/W1', 9))
        e['examples'][0]['step'] = 9
        d = self.run_dir([([result('H1/W1', record='differs'), result('H1/W2'), result('C6h/W11')], [e])])
        with self.assertRaisesRegex(pr_review.Failed, "entry aaaaaaaaaaaa has an example that isn't at its run's first place"):
            self.facts(d)

    def test_a_compared_runs_record_result_and_its_entry_places_agree_or_the_step_fails(self):
        differs_bare = self.run_dir([([result('H1/W1', record='differs'), result('H1/W2'), result('C6h/W11')], [])])
        with self.assertRaisesRegex(pr_review.Failed, "run H1/W1: its record says 'differs', but the entries have no place in it"):
            self.facts(differs_bare)
        same_placed = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W1', 2))])])
        with self.assertRaisesRegex(pr_review.Failed, "run H1/W1: its record says 'same', but the entries have places in it"):
            self.facts(same_placed)
        broken_placed = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')],
                                        [entry('aaaaaaaaaaaa', ('H1/W1', 2), ('H1/W2', 3))])])
        self.assertEqual([e['id'] for e in self.facts(broken_placed)['entries']], ['aaaaaaaaaaaa'])

    def test_a_share_file_that_isnt_json_fails_naming_it(self):
        for name in ('after/run.json', 'before/run.json', 'after/entries.json'):
            with self.subTest(name=name):
                d = self.unchanged_run()
                with open(os.path.join(d, 'share-2', name), 'w') as f:
                    f.write('{"runs": [')
                try:
                    self.facts(d)
                except pr_review.Failed as e:
                    self.assertIn(f"share-2/{name} isn't JSON", str(e))
                except Exception as e:
                    self.fail(f'a share file that isn\'t JSON broke facts rather than failing it by name: {e!r}')
                else:
                    self.fail("a share file that isn't JSON passed")

    def test_the_pull_requests_title_and_description_are_read_into_the_view(self):
        view = self.facts(self.unchanged_run())
        self.assertEqual((view['title'], view['body']), (self.gh.pull['title'], self.gh.pull['body']))

    def test_a_run_in_two_shares_or_a_run_in_none_fails_the_step(self):
        twice = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], []), ([result('H1/W1')], [])])
        with self.assertRaisesRegex(pr_review.Failed, 'two shares'):
            self.facts(twice)
        missing = self.run_dir([([result('H1/W1')], []), ([result('H1/W2')], [])])
        with self.assertRaisesRegex(pr_review.Failed, 'every run once'):
            self.facts(missing)

    def test_runs_that_are_empty_or_name_a_run_twice_fail_the_step(self):
        for runs, results in (([], []), (['H1/W1', 'H1/W1'], [result('H1/W1')])):
            with self.subTest(runs=runs), mock.patch(f'{__name__}.RUNS', runs):
                d = self.run_dir([(results, [])])
                with self.assertRaisesRegex(pr_review.Failed, 'empty or name a run twice'):
                    self.facts(d)

    def test_a_run_that_couldnt_be_compared_contributes_no_differences(self):
        unmeasured = {**result('H1/W2', record='differs'), 'unmeasured': ['the run failed']}
        both = entry('aaaaaaaaaaaa', ('H1/W2', 4), ('H1/W1', 7))
        broken_only = entry('bbbbbbbbbbbb', ('H1/W2', 9))
        view = self.facts(self.run_dir([([result('H1/W1', record='differs'), unmeasured, result('C6h/W11')], [both, broken_only])]))
        self.assertEqual([(e['id'], [p['run'] for p in e['places']], e['runs'], e['count']) for e in view['entries']],
                         [('aaaaaaaaaaaa', ['H1/W1'], ['H1/W1'], 1)])
        self.assertEqual(view['entries'][0]['example'], {'place': {'run': 'H1/W1', 'step': 7}, 'before': 'old text', 'after': 'new text'})
        d = self.run_dir([([result('H1/W1', record='differs'), unmeasured, result('C6h/W11')], [both, broken_only])])
        self.facts(d)
        try:
            self.post(d, self.reader('aaaaaaaaaaaa'), post=False)
        except pr_review.Failed as e:
            self.fail(f"the reader's account of the runs it could compare was refused: {e}")
        with open(os.path.join(d, 'comment.md')) as f:
            self.assertIn('The records of 1 of the 2 runs it could compare differ between the base and this head.', f.read())

    def test_entries_are_ordered_by_their_first_compared_place_whatever_a_run_that_couldnt_be_compared_held(self):
        later = entry('bbbbbbbbbbbb', ('H1/W1', 9), ('H1/W2', 1))
        earlier = entry('aaaaaaaaaaaa', ('H1/W1', 2), ('H1/W2', 5))
        view = self.facts(self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')],
                                         [later, earlier])]))
        self.assertEqual([e['id'] for e in view['entries']], ['bbbbbbbbbbbb', 'aaaaaaaaaaaa'])

    def test_an_entry_whose_examples_arent_one_per_run_it_occurs_in_fails_the_step_so_every_shown_entry_has_one(self):
        unmeasured = {**result('H1/W2', record='differs'), 'unmeasured': ['the run failed']}
        e = entry('aaaaaaaaaaaa', ('H1/W2', 4), ('H1/W1', 7))
        e['examples'] = [x for x in e['examples'] if x['run'] == 'H1/W2']
        try:
            self.facts(self.run_dir([([result('H1/W1', record='differs'), unmeasured, result('C6h/W11')], [e])]))
        except pr_review.Failed as e:
            self.assertIn("entry aaaaaaaaaaaa's examples aren't one per run it occurs in", str(e))
        except Exception as e:
            self.fail(f'facts broke rather than refusing the entry: {e!r}')
        else:
            self.fail('facts showed an entry with no example from a run it compared')
        for examples in (None, [{'run': 'H9/W9', 'step': 1, 'before': '', 'after': ''}], [{'run': 'H1/W2', 'step': 1, 'before': '', 'after': ''}],
                         [{'run': 'H1/W1', 'step': 7, 'before': '', 'after': ''}] * 2, []):
            with self.subTest(examples=examples):
                e = {**entry('aaaaaaaaaaaa', ('H1/W1', 7)), 'examples': examples}
                with self.assertRaisesRegex(pr_review.Failed, 'examples'):
                    self.facts(self.run_dir([([result('H1/W1', record='differs'), result('H1/W2'), result('C6h/W11')], [e])]))

    def test_the_same_records_split_any_way_give_one_view_and_one_result_each_example_at_its_first_place(self):
        whole = [('bbbbbbbbbbbb', [('H1/W1', 'p.2'), ('H1/W1', 'p.10'), ('C6h/W11', 'end'), ('C6h/W11', 'header')]),
                 ('aaaaaaaaaaaa', [('H1/W1', 'p.2'), ('H1/W2', 'header')]),
                 ('cccccccccccc', [('H1/W2', 'p.3'), ('C6h/W11', 'p.1')])]

        def held(runs):
            out = []
            for eid, places in whole:
                mine = [{'run': r, 'step': s, 'digest': f'{r}:{s}'} for r, s in places if r in runs]
                if mine:
                    firsts = {}
                    for p in mine:
                        firsts.setdefault(p['run'], p)
                    out.append({'id': eid, 'describe': f'{eid} changed', 'count': len(mine), 'runs': sorted(firsts), 'places': mine,
                                'examples': [{'run': r, 'step': p['step'], 'before': f"old {r} {p['step']}", 'after': f"new {r} {p['step']}"}
                                             for r, p in firsts.items()]})
            return out
        splits = ([RUNS], [['H1/W1', 'C6h/W11'], ['H1/W2']], [['H1/W2'], ['H1/W1', 'C6h/W11']], [['C6h/W11'], ['H1/W2'], ['H1/W1']])
        for uncompared in (None, 'H1/W1'):
            seen = []
            for split in splits:
                with self.subTest(uncompared=uncompared, split=split):
                    shares = [([result(r, record='missing' if r == uncompared else 'differs') for r in runs], held(runs)) for runs in split]
                    view = self.facts(self.run_dir(shares))
                    seen.append((view['entries'], cv.result_of(view)))
            self.assertEqual([s == seen[0] for s in seen], [True] * len(seen))
            entries = seen[0][0]
            self.assertEqual([e['example']['place'] for e in entries],
                             [{'run': e['places'][0]['run'], 'step': e['places'][0]['step']} for e in entries])
            if uncompared is None:
                self.assertEqual([e['id'] for e in entries], ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'])
                self.assertEqual([(p['run'], p['step']) for p in entries[1]['places']], whole[0][1])
            else:
                self.assertEqual({e['id']: e['example']['place']['run'] for e in entries},
                                 {'aaaaaaaaaaaa': 'H1/W2', 'bbbbbbbbbbbb': 'C6h/W11', 'cccccccccccc': 'H1/W2'})

    def test_what_the_runs_reached_is_summed_from_the_compared_runs_counts(self):
        d = self.run_dir([([result('H1/W1', compressions=0, merges=0), result('C6h/W11', quarantines={'compression': 1, 'merge': 2})], []),
                          ([result('H1/W2')], [])])
        r = self.facts(d)['reached']
        self.assertEqual((r['runs'], r['requests'], r['compressions'], r['merges']), (3, 30, [4, 2], [2, 2]))
        self.assertEqual(r['quarantines'], {'compression': 1, 'merge': 2, 'runs': 1, 'not-reported': 0, 'uncounted': 2})

    def test_only_versions_the_same_in_both_arms_are_held_and_the_host_is_named_by_its_commit_for_an_overlay(self):
        d = self.chosen_run({'membrane': '0.7.9'}, {'membrane': '0.8.0'},
                            {'base': {M: {'version': '0.7.9', 'host': '0.8.0', 'ranges': [{'range': '~0.7.9', 'wantedBy': None}]}}, 'head': {}})
        view = self.facts(d)
        self.assertEqual(view['held'], {'agent-framework': '0.32.0', 'chronicle': '0.5.1'})
        cv.post({'dir': d, 'reader': None, 'post': False})
        with open(os.path.join(d, 'comment.md')) as f:
            self.assertIn('Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`.', f.read())

    def test_a_key_package_installed_in_neither_arm_is_not_held_and_the_view_still_runs(self):
        # run.json names a key package an install doesn't have as null.
        absent = {**VERSIONS, '@animalabs/chronicle': None, '@animalabs/membrane': None}
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], base_versions=absent, head_versions=absent)
        try:
            view = self.facts(d)
        except Exception as e:
            self.fail(f'facts failed: {e!r}')
        self.assertEqual(view['held'], {'agent-framework': '0.32.0'})
        cv.post({'dir': d, 'reader': None, 'post': False})
        with open(os.path.join(d, 'comment.md')) as f:
            self.assertIn('Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`.', f.read())

    def test_a_key_package_the_arms_ran_differently_that_the_plan_didnt_choose_fails_the_view_unless_the_pull_request_is_the_hosts(self):
        for v in ('0.7.9', None, '0.8.0 (sha512-other)'):
            with self.subTest(v):
                d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], base_versions={**VERSIONS, M: v})
                with self.assertRaisesRegex(pr_review.Failed, re.escape(f"the arms ran different {M}, {v!r} in the base and '0.8.0' in the "
                                                                       "head, which the plan didn't choose")):
                    self.facts(d)
        chosen_elsewhere = self.chosen_run({'membrane': '0.7.9', 'agent-framework': '0.31.0'}, {},
                                           {'base': {M: {'version': '0.7.9', 'host': '0.8.0', 'ranges': []}}, 'head': {}})
        with self.assertRaisesRegex(pr_review.Failed, "the arms ran different @animalabs/agent-framework, '0.31.0' in the base"):
            self.facts(chosen_elsewhere)
        host = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], form='host', repo='connectome-host',
                            base_versions={**VERSIONS, M: '0.7.9'})
        self.assertNotIn('differing', self.facts(host, repo='anima-research/connectome-host'))

    def test_a_release_the_plan_chose_that_its_arm_didnt_run_fails_the_view(self):
        for ran in ('0.8.0', None, '0.9.1 (sha512-m)'):
            with self.subTest(ran):
                d = self.chosen_run({}, {'membrane': ran}, {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': []}}})
                with self.assertRaisesRegex(pr_review.Failed, re.escape(f"the head arm ran {M} {ran!r}, not the 0.9.0 the plan chose")):
                    self.facts(d)

    def test_a_stack_of_another_shape_or_in_a_host_view_fails_the_step(self):
        good = {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None}]}
        for what, stack, form in (('one side', {'head': {M: good}}, 'overlay'), ('a list', [], 'overlay'),
                                  ('no host', {'base': {}, 'head': {M: {**good, 'host': None}}}, 'overlay'),
                                  ('a range that isnt text', {'base': {}, 'head': {M: {**good, 'ranges': [{'range': 9, 'wantedBy': None}]}}}, 'overlay'),
                                  ('an asks that isnt text', {'base': {}, 'head': {M: {**good, 'asks': None}}}, 'overlay'),
                                  ('a host view', {'base': {}, 'head': {}}, 'host')):
            with self.subTest(what):
                d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], stack=stack, form=form,
                                 repo='connectome-host' if form == 'host' else 'context-manager')
                with self.assertRaisesRegex(pr_review.Failed, 'manifest.json: stack'):
                    self.facts(d, repo='anima-research/connectome-host' if form == 'host' else REPO)

    def test_a_host_pull_request_holds_the_packages_and_not_the_host(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], form='host', repo='connectome-host')
        self.facts(d, repo='anima-research/connectome-host')
        cv.post({'dir': d, 'reader': None, 'post': False})
        with open(os.path.join(d, 'comment.md')) as f:
            self.assertIn('Held the same in base and head: agent\\-framework `0.32.0`, chronicle `0.5.1`, membrane `0.8.0`.', f.read())

    def test_a_repository_outside_the_four_is_refused_by_its_id_whatever_its_name(self):
        with self.assertRaises(pr_review.NotARequest):
            self.facts(self.run_dir([], repo='lode'), repo='anima-research/lode')
        with self.assertRaisesRegex(pr_review.Failed, 'GitHub answered 404 to GET /repos/someone/elsewhere/installation') as raised:
            self.facts(self.run_dir([], repo='elsewhere'), repo='someone/elsewhere')
        self.assertNotIsInstance(raised.exception, pr_review.NotARequest)
        moved = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], repo='context-manager-renamed')
        self.gh.pull['title'] = 'renamed'
        try:
            view = self.facts(moved, repo='anima-research/context-manager-renamed')
        except pr_review.NotARequest as e:
            self.fail(f'a renamed repository, the same by its GitHub ID, was refused: {e}')
        self.assertEqual(view['title'], 'renamed')


    def test_an_early_moved_or_closed_manifest_without_a_base_makes_a_short_view_and_post_answers_its_name(self):
        for outcome, detail in (('moved', {'headNow': H2}), ('closed', {'state': 'merged'})):
            with self.subTest(outcome):
                d = tempfile.mkdtemp(dir=self.tmp)
                pr_review.write_json(os.path.join(d, 'manifest.json'), {'repo': 'context-manager', 'number': 5, 'head': H1, 'form': 'overlay',
                                                                         'outcome': outcome, 'detail': detail, 'shares': []})
                try:
                    changed = cv.facts({'dir': d, 'repo': REPO})['changed']
                    view = pr_review.read_json(os.path.join(d, 'view.json'))
                    calls = len(self.gh.calls)
                    answers = [self.post(d, post=post) for post in (True, False)]
                except Exception as e:
                    self.fail(f'a step refused or broke: {e!r}')
                self.assertFalse(changed)
                self.assertEqual(view, {'repo': REPO, 'number': 5, 'head': H1, 'outcome': outcome, 'detail': detail})
                self.assertEqual(answers, [{'action': outcome}] * 2)
                self.assertEqual(self.gh.calls[calls:], [])
                self.assertFalse(os.path.exists(os.path.join(d, 'comment.md')))
                self.assertEqual(self.gh.comments, [])

    def test_an_arm_the_run_side_doesnt_name_or_a_self_check_the_view_doesnt_know_fails_the_step(self):
        for outcome, detail in (('arm-missing', {'share': 1, 'arm': 'head', 'log': None}), ('arm-missing', {'share': 1, 'log': None}),
                                ('needs-companion', {'package': 'p', 'version': '1', 'arm': 'after', 'wantedBy': 'w', 'range': '^1'}),
                                ('needs-companion', {'package': 'p', 'range': '^1', 'hostHas': '0.1', 'arm': 'after'}),
                                ('needs-companion', {'package': 'p', 'range': '^1', 'hostHas': '0.1'})):
            with self.subTest(detail=detail):
                with self.assertRaisesRegex(pr_review.Failed, 'an arm the'):
                    self.facts(self.run_dir([([], [])], outcome=outcome, detail=detail))
        for check in (None, {'outcome': 'odd'}, 'same'):
            with self.subTest(check=check):
                r = {**result('H1/W1'), 'selfCheck': check}
                with self.assertRaisesRegex(pr_review.Failed, "a self-check the view doesn't know"):
                    self.facts(self.run_dir([([r, result('H1/W2'), result('C6h/W11')], [])]))

    def test_the_manifests_number_host_and_form_of_another_shape_fail_the_step_naming_the_field(self):
        for field, value, said in (('number', '5', 'number'), ('number', None, 'number'), ('host', {'sha': 42}, 'host.sha'),
                                   ('host', None, 'host.sha'), ('form', 'whole', "a form the view doesn't know"), ('form', None, 'form'),
                                   ('harness', None, 'harness.repo'), ('harness', 'anima-research/context-view', 'harness.repo'),
                                   ('harness', {'repo': 'nissa-seru/connectome-smoke', 'sha': HARNESS}, 'harness.repo'),
                                   ('harness', {'repo': 'nissa-seru/context-view', 'sha': HARNESS}, 'harness.repo'),
                                   ('harness', {'repo': 'anima-research/context-view', 'sha': HARNESS[:12]}, 'harness.sha'),
                                   ('harness', {'repo': 'anima-research/context-view', 'sha': HARNESS.upper()}, 'harness.sha'),
                                   ('harness', {'repo': 'anima-research/context-view'}, 'harness.sha'),
                                   ('harness', {'repo': 'anima-research/context-view', 'sha': int('1' * 40)}, 'harness.sha'),
                                   ('host', {'sha': int('2' * 40)}, 'host.sha'), ('base', {'ref': 'main', 'sha': int('3' * 40)}, 'base.sha'),
                                   ('head', int('4' * 40), 'head')):
            with self.subTest(field=field, value=value):
                d = self.unchanged_run()
                m = pr_review.read_json(os.path.join(d, 'manifest.json'))
                m[field] = value
                pr_review.write_json(os.path.join(d, 'manifest.json'), m)
                with self.assertRaisesRegex(pr_review.Failed, f'manifest.json: .*{said}'):
                    self.facts(d)

    def test_a_sha_of_another_shape_is_refused_naming_its_field_and_value_and_stopped_checks_its_own_head(self):
        for field, value, said in (('head', H1[:12], 'head'), ('base', {'ref': 'main', 'sha': 42}, 'base.sha'),
                                   ('host', {'sha': H1.upper()}, 'host.sha'),
                                   ('harness', {'repo': 'anima-research/context-view', 'sha': None}, 'harness.sha')):
            shown = value if field == 'head' else value['sha']
            with self.subTest(field=field):
                d = self.unchanged_run()
                m = pr_review.read_json(os.path.join(d, 'manifest.json'))
                m[field] = value
                pr_review.write_json(os.path.join(d, 'manifest.json'), m)
                with self.assertRaisesRegex(pr_review.Failed, rf"^manifest.json: {re.escape(said)} isn't a full commit sha, {re.escape(repr(shown))}$"):
                    self.facts(d)
        for head in (int('4' * 40), H1[:12]):
            with self.subTest(head=head), self.assertRaisesRegex(pr_review.Failed, rf"^head isn't a full commit sha, {re.escape(repr(head))}$"):
                cv.stopped({'repo': REPO, 'number': 5, 'head': head, 'post': False})

    def test_view_json_carries_the_harness_commit_and_a_moved_or_closed_manifest_needs_none(self):
        d = self.unchanged_run()
        self.facts(d)
        self.assertEqual(pr_review.read_json(os.path.join(d, 'view.json'))['harness'], {'repo': 'anima-research/context-view', 'sha': HARNESS})
        for outcome in ('moved', 'closed'):
            with self.subTest(outcome=outcome):
                d = self.run_dir([], outcome=outcome, detail={})
                m = pr_review.read_json(os.path.join(d, 'manifest.json'))
                del m['harness'], m['host'], m['base']
                pr_review.write_json(os.path.join(d, 'manifest.json'), m)
                self.facts(d)
                self.assertEqual(pr_review.read_json(os.path.join(d, 'view.json'))['outcome'], outcome)

    def test_a_manifest_missing_a_field_fails_the_step_with_its_traceback_then_a_line_saying_what_it_can_be(self):
        d = self.unchanged_run()
        m = pr_review.read_json(os.path.join(d, 'manifest.json'))
        del m['shares'][0]['dir']
        pr_review.write_json(os.path.join(d, 'manifest.json'), m)
        with mock.patch('sys.stdin', io.StringIO(json.dumps({'dir': d, 'repo': REPO}))), \
                contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()):
            try:
                code = cv.main(['facts'])
            except Exception as e:
                self.fail(f'facts let {e!r} out rather than failing with why')
        self.assertEqual(code, 1)
        said = err.getvalue().rstrip('\n').split('\n')
        self.assertEqual(said[-1], "view.py facts: a field it reads is missing or of another shape, or the step's own code "
                                   "failed; the traceback above says which")
        self.assertEqual(said[0], 'Traceback (most recent call last):')
        self.assertIn("KeyError: 'dir'", said[-2])

    def test_a_refusal_longer_than_the_workflow_keeps_is_cut_at_its_end_so_what_was_refused_is_kept(self):
        d = self.unchanged_run()
        m = pr_review.read_json(os.path.join(d, 'manifest.json'))
        m['outcome'] = 'x' * 5_000
        pr_review.write_json(os.path.join(d, 'manifest.json'), m)
        with mock.patch('sys.stdin', io.StringIO(json.dumps({'dir': d, 'repo': REPO}))), \
                contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cv.main(['facts']), 1)
        kept = err.getvalue().strip()[-1500:]
        self.assertTrue(kept.startswith("view.py facts: manifest.json: an outcome the view doesn't know, 'xxx"), kept[:100])
        self.assertTrue(kept.endswith('…'))

    def test_the_views_repositories_are_its_own_whatever_pr_review_reviews(self):
        asked = []
        with mock.patch.object(pr_review, 'installation_token', lambda repo, asked_=False: asked.append(repo) or ('tok', APP)):
            d = self.unchanged_run()
            self.facts(d)
            self.assertEqual(self.post(d)['action'], 'posted')
            self.gh.head = H2
            self.assertEqual(cv.stopped({'repo': REPO, 'number': 5, 'head': H2})['action'], 'posted')
        self.assertEqual(asked, [])


class Compared(Steps):
    EARLIER = ('view.json', 'manifest.json', 'reader.json', 'comment.md', 'comment-2.md')

    def plant(self, d):
        for name in self.EARLIER:
            with open(os.path.join(d, name), 'w') as f:
                f.write('{"from": "an earlier view"}')

    def fields(self, d):
        m = pr_review.read_json(os.path.join(d, 'manifest.json'))
        return {k: m[k] for k in ('number', 'head', 'form', 'base', 'host', 'harness', 'stack') if k in m}

    def shares_of(self, d):
        e = tempfile.mkdtemp(dir=self.tmp)
        for name in os.listdir(d):
            if name.startswith('share-'):
                shutil.copytree(os.path.join(d, name), os.path.join(e, name))
        return e

    def test_a_compares_shares_get_the_view_facts_would_write_with_the_given_title_and_description_and_the_run_sides_manifest_with_each_share_by_its_i_and_dir_asking_github_nothing(self):
        broken = [result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')]
        apart = [([result('H1/W1', record='differs')], [entry('aaaaaaaaaaaa', ('H1/W1', 7))])] + [([], [])] * 9 + [
            ([result('H1/W2', record='differs'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W2', 4))])]
        for what, d in (('changed', self.changed_run()), ('unchanged', self.unchanged_run()),
                        ('some not compared', self.run_dir([(broken, [entry('bbbbbbbbbbbb', ('H1/W2', 1))])])),
                        ('eleven shares', self.run_dir(apart)),
                        ('releases the plan chose', self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'},
                                                                     {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': []}}}))):
            with self.subTest(what):
                facts = cv.facts({'dir': d, 'repo': REPO})
                e = self.shares_of(d)
                self.plant(e)
                calls, tokens = len(self.gh.calls), []
                given = {'dir': e, 'repo': REPO, **self.fields(d), 'title': self.gh.pull['title'], 'body': self.gh.pull['body']}
                with mock.patch('sys.stdin', io.StringIO(json.dumps(given))), contextlib.redirect_stdout(io.StringIO()) as out, \
                        mock.patch.object(pr_review, 'app_token', lambda repo: tokens.append(repo) or app_token(repo)):
                    self.assertEqual(cv.main(['compared']), 0)
                self.assertEqual((self.gh.calls[calls:], tokens), ([], []))
                self.assertEqual(json.loads(out.getvalue().strip().split('\n')[-1]), {**facts, 'path': os.path.join(e, 'view.json')})
                with open(os.path.join(e, 'view.json'), 'rb') as mine, open(os.path.join(d, 'view.json'), 'rb') as theirs:
                    self.assertEqual(mine.read(), theirs.read())
                run_side = pr_review.read_json(os.path.join(d, 'manifest.json'))
                self.assertEqual(pr_review.read_json(os.path.join(e, 'manifest.json')),
                                 {**run_side, 'shares': [{'i': s['i'], 'dir': s['dir']} for s in run_side['shares']]})
                self.assertEqual([n for n in self.EARLIER if os.path.exists(os.path.join(e, n))], ['view.json', 'manifest.json'])

    def test_each_refusal_says_why_in_a_line_and_leaves_none_of_an_earlier_views_files(self):
        d = self.changed_run()
        e = self.shares_of(d)
        good = {'dir': e, 'repo': REPO, **self.fields(d), 'title': 't', 'body': 'b'}
        empty = tempfile.mkdtemp(dir=self.tmp)
        unread = self.shares_of(d)
        os.remove(os.path.join(unread, 'share-2', 'after', 'entries.json'))
        nowhere = os.path.join(self.tmp, 'nowhere')
        unnamed = {k: v for k, v in good.items() if k != 'repo'}
        for args, said in (({**good, 'repo': 'anima-research/lode'}, "anima-research/lode isn't one of the context view's repositories"),
                           (unnamed, "None isn't one of the context view's repositories"),
                           ({**good, 'dir': nowhere}, f"{nowhere} isn't a directory"),
                           ({**good, 'dir': empty}, 'holds no share-'),
                           ({**good, 'dir': unread}, 'share-2: the head arm wrote no entries.json'),
                           ({**good, 'title': None}, 'title'), ({**good, 'body': 3}, 'body'),
                           ({**good, 'head': H1[:12]}, "manifest.json: head isn't a full commit sha"),
                           ({**good, 'number': 0}, 'manifest.json: number'),
                           ({**good, 'harness': {'repo': 'nissa-seru/context-view', 'sha': HARNESS}}, 'manifest.json: harness.repo')):
            with self.subTest(said=said):
                for at in (e, empty, unread):
                    self.plant(at)
                calls, tokens = len(self.gh.calls), []
                with self.assertRaisesRegex(pr_review.Failed, re.escape(said)), \
                        mock.patch.object(pr_review, 'app_token', lambda repo: tokens.append(repo) or app_token(repo)):
                    cv.compared(args)
                self.assertEqual((self.gh.calls[calls:], tokens), ([], []))
                self.assertEqual([n for n in self.EARLIER if os.path.exists(os.path.join(args['dir'], n))], [])

    def test_a_manifest_that_cant_be_written_leaves_no_view(self):
        d = self.changed_run()
        e = self.shares_of(d)
        real = cv.write_json

        def failing(path, value):
            if os.path.basename(path) == 'manifest.json':
                raise OSError(28, 'No space left on device')
            real(path, value)
        with mock.patch.object(cv, 'write_json', failing), self.assertRaises(OSError):
            cv.compared({'dir': e, 'repo': REPO, **self.fields(d), 'title': 't', 'body': 'b'})
        self.assertFalse(os.path.exists(os.path.join(e, 'view.json')))


class Words(Steps):
    def comment(self, d, reader=None):
        self.facts(d)
        cv.post({'dir': d, 'reader': reader and self.write(d, reader), 'post': False, **({'reads': READS} if reader else {})})
        with open(os.path.join(d, 'comment.md')) as f:
            return f.read()

    def test_a_changed_view_opens_with_the_link_the_counts_and_the_account_and_nests_each_changed_runs_changes_in_the_runs_fold(self):
        flags = {'new': [{'check': 11, 'step': 'q.3', 'what': 'invariant', 'detail': 'a pinned message was summarised'}], 'gone': [], 'kept': []}
        d = self.run_dir([([result('H1/W1', record='differs'), result('H1/W2', record='differs', flags=flags),
                            result('C6h/W11', outcome='couldnt-run', reason='the store @x was unreadable')],
                           [entry('aaaaaaaaaaaa', ('H1/W1', 2), ('H1/W2', 1)), entry('bbbbbbbbbbbb', ('H1/W1', 5), ('H1/W1', 6))])])
        reader = {'summary': ['Merges now go first.', 'Refusals report a floor.'],
                  'changes': [{'title': 'Merges go first', 'where': 'In both runs at the first compile', 'base': 'It asked for a summary first',
                               'head': 'It asks for a merge first', 'refs': ['aaaaaaaaaaaa'], 'before': 'b1', 'after': 'a1',
                               'place': {'run': 'H1/W1', 'step': 2}},
                              {'title': 'Refusals report floor', 'where': 'In the first run at the refusal', 'base': 'The refusal gave the budget',
                               'head': 'It gives the budget and a floor', 'follows': 1, 'unmentioned': True, 'refs': ['bbbbbbbbbbbb'],
                               'before': 'b2', 'after': 'a2',
                               'place': {'run': 'H1/W1', 'step': 5}}]}
        text = self.comment(d, reader)
        top = (f'**Automatic context view** of `{H1[:12]}` merged onto `{BASE[:12]}`.\n\n'
               + f'What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md).' + '\n\n'
               'The records of 2 of the 2 runs it could compare differ between the base and this head.\n\n'
               "1 run couldn't be compared; its reason is below.\n\n"
               'Separately, 1 of the checks\' flags differs between the base and the head, in 1 run; it\'s listed under '
               '"Checks\' flags that differ", below.\n\n'
               "*A model's account of those records:*\n\n"
               '**Delta 1: Merges go first**\n\nIn both runs at the first compile.\n\n'
               '- base (`main`): It asked for a summary first.\n- head (`aaaaaaaaaaaa`): It asks for a merge first.\n\n'
               "**Delta 2: Refusals report floor** (the description doesn't mention it)\n\nIn the first run at the refusal. Follows from Delta 1.\n\n"
               '- base (`main`): The refusal gave the budget.\n- head (`aaaaaaaaaaaa`): It gives the budget and a floor.\n\n'
               '<details>')
        self.assertTrue(text.startswith(top), text[:900])
        runs = ('<details><summary>Runs whose records differ: 2 of 2, with 2 changes</summary>\n\n'
                '<details><summary><code>H1/W1</code>: 2 changes</summary>\n\n'
                '*Merges go first*\n\nAt step `2`.\n\nBefore:\n\n```text\nb1\n```\n\nAfter:\n\n```text\na1\n```\n\n'
                '*Refusals report floor*\n\nAt 2 steps; the quotes are from step `5`.\n\nBefore:\n\n```text\nb2\n```\n\n'
                'After:\n\n```text\na2\n```\n\n</details>\n\n'
                '<details><summary><code>H1/W2</code>: 1 change</summary>\n\n'
                '*Merges go first*\n\nAt step `1`. Its before and after are quoted under `H1/W1`, at step `2`.\n\n</details>\n\n'
                '</details>')
        self.assertIn(runs, text)
        folds = [m.group(1) for m in re.finditer(r'<details><summary>(.*?)</summary>', text)]
        self.assertEqual(folds, ['Runs whose records differ: 2 of 2, with 2 changes', '<code>H1/W1</code>: 2 changes',
                                 '<code>H1/W2</code>: 1 change', 'Runs that couldn&#x27;t be compared (1)', 'Checks&#x27; flags that differ (1)'])
        self.assertIn("<details><summary>Runs that couldn&#x27;t be compared (1)</summary>\n\nThis head couldn't be compared at `C6h/W11`: "
                      "the head couldn't run it (the store `@x` was unreadable).\n\n</details>", text)
        flagged = '`H1/W2` step `q.3`, check `11` flagged on the head 1 more time than on the base'
        self.assertIn(f"<details><summary>Checks&#x27; flags that differ (1)</summary>\n\n- {flagged}", text)
        self.assertEqual(text.count(flagged), 1)
        paragraphs = text.split('\n\n')
        self.assertTrue(paragraphs[-2].startswith('Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, '), paragraphs[-2])
        self.assertTrue(paragraphs[-1].startswith('<!--'), paragraphs[-1])
        for gone in ('About this view', 'Between them', "a model's reading", 'good faith', 'Merges now go first', 'Refusals report a floor'):
            self.assertNotIn(gone, text)

    def test_several_runs_that_couldnt_be_compared_are_counted_above_in_the_plural_and_folded_beside_the_runs_that_differ(self):
        d = self.run_dir([([result('H1/W1', record='differs'), result('H1/W2', outcome='couldnt-run', reason='r2'),
                            result('C6h/W11', outcome='couldnt-run', reason='r3')], [entry('aaaaaaaaaaaa', ('H1/W1', 4))])])
        text = self.comment(d, {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a'}]})
        self.assertTrue(text.startswith(f'**Automatic context view** of `{H1[:12]}` merged onto `{BASE[:12]}`.\n\n'
                                        + f'What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md).' + '\n\n'
                                        "The records of 1 of the 1 run it could compare differ between the base and this head.\n\n2 runs "
                                        "couldn't be compared; the reasons are below.\n\n*A model's account of those records:*"),
                        text[:600])
        self.assertIn("<details><summary>Runs whose records differ: 1 of 1, with 1 change</summary>\n\n"
                      "<details><summary><code>H1/W1</code>: 1 change</summary>\n\n*T*\n\nAt step `4`.\n\n", text)
        self.assertIn("</details>\n\n</details>\n\n<details><summary>Runs that couldn&#x27;t be compared (2)</summary>\n\nThis head "
                      "couldn't be compared at `H1/W2`: the head couldn't run it (r2).\n\nThis head couldn't be compared at `C6h/W11`: the "
                      "head couldn't run it (r3).\n\n</details>", text)
        self.assertEqual(text.count("couldn't be compared at `H1/W2`"), 1)

    def test_a_head_whose_compared_runs_dont_differ_says_so_and_how_many_werent_and_folds_the_reasons(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2', outcome='couldnt-run', reason='r2'), result('C6h/W11')], [])])
        text = self.comment(d)
        top = (f'**Automatic context view** of `{H1[:12]}` merged onto `{BASE[:12]}`.\n\n'
               + f'What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md).' + '\n\n'
               "The records of the 2 runs it could compare don't differ between the base and this head.\n\n"
               "1 run couldn't be compared; its reason is below.\n\n"
               "<details><summary>Runs that couldn&#x27;t be compared (1)</summary>\n\nThis head couldn't be compared at `H1/W2`: "
               "the head couldn't run it (r2).\n\n</details>\n\n"
               "Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, ")
        self.assertTrue(text.startswith(top), text[:900])
        self.assertTrue(text.split('\n\n')[-1].startswith('<!--'))
        self.assertEqual(text.count("couldn't be compared at `H1/W2`"), 1)

    def test_the_flags_line_counts_the_flags_with_the_runs_they_re_in_apart_from_the_records(self):
        two = {'flags': [{'run': 'A', 'new': [{}, {}], 'gone': []}, {'run': 'B', 'new': [], 'gone': [{}]}, {'run': 'C', 'new': [], 'gone': []}]}
        self.assertEqual(cv.flags_line(two, 3), 'Separately, 3 of the checks\' flags differ between the base and the head, in 2 runs; '
                                                'they\'re listed under "Checks\' flags that differ", below.')

    def test_flags_too_many_for_one_comment_are_folded_across_comments_each_fold_whole_and_titled_as_continued(self):
        flags = {'new': [{'check': i + 1, 'step': str(i), 'what': 'w', 'detail': 'd' * 900} for i in range(120)], 'gone': [], 'kept': []}
        d = self.run_dir([([result('H1/W1', record='differs', flags=flags), result('H1/W2'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W1', 4))])])
        self.facts(d)
        cv.post({'dir': d, 'reader': self.write(d, {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'],
                                                                                 'before': 'b', 'after': 'a'}]}),
                 'post': False, 'reads': READS})
        parts = sorted((f for f in os.listdir(d) if re.fullmatch(r'comment(-[0-9]+)?\.md', f)), key=lambda f: int(f[8:-3] or 1))
        texts = [read_file(os.path.join(d, f)) for f in parts]
        self.assertGreater(len(texts), 1)
        self.assertTrue(all(len(t) <= cv.COMMENT_MAX for t in texts))
        self.assertIn('Separately, 120 of the checks\' flags differ between the base and the head, in 1 run; they\'re listed under '
                      '"Checks\' flags that differ", below.', texts[0])
        whole = '\n\n'.join(texts)
        for t in texts:
            self.assertEqual(t.count('<details>'), t.count('</details>'))
        folds = [f for t in texts
                 for f in re.findall(r'<details><summary>(Checks&#x27; flags that differ \(120\)(?:, continued)?)</summary>(.*?)</details>', t, re.S)]
        self.assertGreater(len(folds), 1)
        self.assertEqual([t for t, _ in folds], ['Checks&#x27; flags that differ (120)'] + ['Checks&#x27; flags that differ (120), continued'] * (len(folds) - 1))
        shown = [(int(m.group(2)), m.group(1)) for _, body in folds
                 for m in re.finditer(r'^- `H1/W1` step `([0-9]+)`, check `([0-9]+)` flagged on the head 1 more time than on the base', body, re.M)]
        self.assertEqual(shown, [(i + 1, str(i)) for i in range(120)])
        self.assertNotIn("The checks' flags that differ between base and head:", whole)

    def test_the_runs_fold_lists_runs_in_the_harnesss_order_not_by_name(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2', record='differs'), result('C6h/W11', record='differs')],
                           [entry('aaaaaaaaaaaa', ('H1/W2', 3), ('C6h/W11', 8))])])
        text = self.comment(d, {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a',
                                                               'place': {'run': 'H1/W2', 'step': 3}}]})
        self.assertIn('<details><summary>Runs whose records differ: 2 of 3, with 1 change</summary>\n\n'
                      '<details><summary><code>H1/W2</code>: 1 change</summary>\n\n*T*\n\nAt step `3`.\n\n'
                      'Before:\n\n```text\nb\n```\n\nAfter:\n\n```text\na\n```\n\n</details>\n\n'
                      '<details><summary><code>C6h/W11</code>: 1 change</summary>\n\n*T*\n\n'
                      'At step `8`. Its before and after are quoted under `H1/W2`, at step `3`.\n\n</details>\n\n</details>', text)

    def test_a_delta_that_follows_no_earlier_one_says_unmentioned_otherwise_than_true_or_lacks_a_line_fails_naming_it(self):
        d = self.changed_run()
        two = lambda **second: {'changes': [
            {'title': 'A', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a'},
            {'title': 'B', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['bbbbbbbbbbbb'], 'before': 'b', 'after': 'a', **second}]}
        for second, said in (({'follows': 2}, "change 'B' follows 2, which isn't an earlier delta's number"),
                             ({'follows': 0}, "change 'B' follows 0"), ({'follows': True}, "change 'B' follows True"),
                             ({'follows': 1.0}, "change 'B' follows 1.0"), ({'unmentioned': False}, "change 'B' gives unmentioned as False"),
                             ({'unmentioned': 1}, "change 'B' gives unmentioned as 1"), ({'unmentioned': 1.0}, "change 'B' gives unmentioned as 1.0"),
                             ({'head': ' \n '}, "change 'B' gives a head that isn't a line of text"),
                             ({'where': None}, "change 'B' gives a where that isn't a line of text"),
                             ({'base': ''}, "change 'B' gives a base that isn't a line of text"), ({'follows': None}, "change 'B' follows None"),
                             ({'unmentioned': None}, "change 'B' gives unmentioned as None"),
                             ({'also': ''}, "change 'B' gives an also that isn't a line of text"),
                             ({'also': None}, "change 'B' gives an also that isn't a line of text"),
                             ({'also': ['x']}, "change 'B' gives an also that isn't a line of text")):
            with self.subTest(second=second):
                with self.assertRaisesRegex(pr_review.Failed, re.escape(said)):
                    self.comment(d, two(**second))
        try:
            self.comment(d, two(follows=1, unmentioned=True))
        except pr_review.Failed as e:
            self.fail(f'a delta following delta 1 and unmentioned was refused: {e}')

    def test_a_change_carried_into_later_requests_says_where_else_under_its_head_line(self):
        d = self.changed_run()
        reader = {'changes': [{'title': 'A', 'where': 'w', 'base': 'b0', 'head': 'h0', 'also': 'Later requests in\nthat turn carry it, @maintainer, #3 <b>',
                               'refs': ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], 'before': 'b', 'after': 'a'}]}
        text = self.comment(d, reader)
        self.assertIn("- base (`main`): b0.\n- head (`aaaaaaaaaaaa`): h0.\n- Also in: "
                      + cv.inert('Later requests in that turn carry it, @maintainer, #3 <b>') + ".\n\n<details>", text)
        self.assertNotIn(' @maintainer', text)
        self.assertNotIn('<b>', text)
        bare = self.comment(self.changed_run(), {'changes': [{k: v for k, v in reader['changes'][0].items() if k != 'also'}]})
        self.assertNotIn('Also in', bare)

    def test_the_result_names_the_view_code_that_writes_the_words_so_a_release_never_keeps_another_releases_comment(self):
        v = self.facts(self.changed_run())
        with mock.patch.object(cv, 'WORDS', 'f' * 64):
            other = cv.result_of(v)
        self.assertNotEqual(other, cv.result_of(v))
        self.assertEqual(cv.WORDS, cv.words_of((cv.__file__, pr_comment.__file__)))
        changed = os.path.join(self.tmp, 'pr_comment.py')
        with open(pr_comment.__file__, 'rb') as f, open(changed, 'wb') as g:
            g.write(f.read() + b'\n')
        self.assertNotEqual(cv.words_of((cv.__file__, changed)), cv.WORDS)
        now = cv.result_of(v)
        with mock.patch.object(cv, 'WORDS', cv.words_of((cv.__file__, changed))):
            self.assertNotEqual(cv.result_of(v), now)

    def test_an_absent_or_base_absent_that_isnt_a_list_of_names_stops_the_view_on_any_result(self):
        for key in ('absent', 'baseAbsent'):
            for bad in (False, {}, '', 0, None, 'suppression', ['suppression', 3]):
                with self.subTest(key=key, bad=bad):
                    d = self.run_dir([([{**result('H1/W1'), key: bad}, result('H1/W2'), result('C6h/W11')], [])])
                    with self.assertRaisesRegex(pr_review.Failed, f"H1/W1: its {key} isn't a list of names"):
                        self.facts(d)
            with self.subTest(key=key, run='uncompared'):
                lost = {**result('H1/W1', outcome='flags'), key: False, 'unmeasured': ['the run failed']}
                d = self.run_dir([([lost, result('H1/W2'), result('C6h/W11')], [])])
                with self.assertRaisesRegex(pr_review.Failed, f"H1/W1: its {key} isn't a list of names"):
                    self.facts(d)
        self.facts(self.run_dir([([result('H1/W1', absent=[], baseAbsent=['onboarding']), result('H1/W2'), result('C6h/W11')], [])]))

    def test_the_stretches_an_arm_left_out_are_part_of_the_result_so_a_comment_naming_them_is_never_kept_under_another(self):
        left = self.facts(self.run_dir([([result('H1/W1', baseAbsent=['suppression']), result('H1/W2'), result('C6h/W11')], [])]))
        ran = self.facts(self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])]))
        self.assertNotEqual(cv.result_of(left), cv.result_of(ran))
        self.assertNotEqual(cv.result_of(left), cv.result_of({**left, 'absent': [{**left['absent'][0], 'base': ['onboarding']}]}))
        self.assertEqual(cv.result_of(left), cv.result_of(json.loads(json.dumps(left))))

    def test_the_usage_and_the_upgraded_runs_are_part_of_the_result_so_a_comment_showing_them_is_never_kept_under_another(self):
        runs = [result('H1/W1', usage=usage()), result('H1/W2', usage=usage()), result('C6h/W11', usage=usage())]
        same = self.facts(self.run_dir([(runs, [])], base_results=runs))
        moved = [result('H1/W1', usage=usage({'cacheRead': 8000})), result('H1/W2', usage=usage()), result('C6h/W11', usage=usage())]
        self.assertNotEqual(cv.result_of(same), cv.result_of(self.facts(self.run_dir([(moved, [])], base_results=runs))))
        stuck = {'last': 1, 'calibration': {'multiplier': 1, 'provisional': True, 'reset': True}}
        fine = {'last': 0, 'calibration': {'multiplier': 1.29, 'provisional': False, 'reset': False}}
        self.assertNotEqual(cv.result_of(self.facts(self.upgraded(fine, stuck, fine, fine))), cv.result_of(self.facts(self.upgraded(fine, fine, fine, fine))))
        flagged = {'new': [], 'gone': [], 'kept': [{'check': 11, 'step': 'c.debt', 'what': 'invariant', 'detail': 'x'}]}
        self.assertNotEqual(cv.result_of(self.facts(self.upgraded(fine, fine, fine, fine, flagged))), cv.result_of(self.facts(self.upgraded(fine, fine, fine, fine))),
                            'a kept flag that differs between the twins moves only the upgraded runs, not the usage or the flags that differ')
        self.assertEqual(cv.result_of(same), cv.result_of(json.loads(json.dumps(same))))

    def test_the_bases_branch_is_part_of_the_result_so_a_comment_naming_it_is_never_kept_under_another(self):
        v = self.facts(self.changed_run())
        self.assertNotEqual(cv.result_of(v), cv.result_of({**v, 'baseRef': 'develop'}))
        self.assertEqual(cv.result_of(v), cv.result_of(json.loads(json.dumps(v))))

    def test_facts_keeps_the_bases_branch_and_refuses_a_manifest_without_one(self):
        d = self.changed_run()
        self.assertEqual(self.facts(d)['baseRef'], 'main')
        path = os.path.join(d, 'manifest.json')
        m = pr_review.read_json(path)
        for ref in (None, '', ' \n', 7):
            with self.subTest(ref=ref):
                with open(path, 'w') as f:
                    json.dump({**m, 'base': {**m['base'], 'ref': ref}}, f)
                with self.assertRaisesRegex(pr_review.Failed, "base.ref isn't a branch name"):
                    self.facts(d)

    def test_a_change_with_no_place_its_quotes_are_from_fails_rather_than_quoting_them_under_a_guessed_run(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2', record='differs'), result('C6h/W11', record='differs')],
                           [entry('aaaaaaaaaaaa', ('H1/W2', 3), ('C6h/W11', 8))])])
        self.facts(d)
        path = os.path.join(d, 'reader.json')
        with open(path, 'w') as f:
            json.dump({'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a'}]}, f)
        with self.assertRaisesRegex(pr_review.Failed, "change 'T' names no place its quotes are from"):
            cv.post({'dir': d, 'reader': path, 'post': False, 'reads': READS})
        self.assertFalse(os.path.exists(os.path.join(d, 'comment.md')))

    def test_a_change_quoted_from_a_place_it_doesnt_have_fails_rather_than_posting_quotes_no_place_shows(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2', record='differs'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W2', 3))])])
        for run, step in (('H1/W1', 3), ('H1/W2', 9)):
            with self.subTest(run=run, step=step):
                with self.assertRaisesRegex(pr_review.Failed, f"quoted from `{run}` at step `{step}`, a place it doesn't have"):
                    self.comment(d, {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b',
                                                                     'after': 'a', 'place': {'run': run, 'step': step}}]})

    def test_a_runs_changes_too_long_for_one_comment_continue_in_the_next_each_fold_whole_and_titled_as_continued(self):
        d = self.changed_run()
        self.facts(d)
        cv.post({'dir': d, 'reader': self.write(d, self.four('w')), 'post': False, 'reads': READS})
        parts = sorted((f for f in os.listdir(d) if re.fullmatch(r'comment(-[0-9]+)?\.md', f)), key=lambda f: int(f[8:-3] or 1))
        texts = [read_file(os.path.join(d, f)) for f in parts]
        self.assertGreater(len(texts), 1)
        self.assertTrue(all(len(t) <= cv.COMMENT_MAX for t in texts))
        nested = [n for t in texts for n in nesting(t)]
        for summary, parent in nested:
            self.assertEqual(parent is None, not summary.startswith('<code>'), (summary, parent))
            if parent is not None:
                self.assertTrue(parent.startswith('Runs whose records differ: 2 of 3, with 4 changes'), (summary, parent))
        whole = '\n\n'.join(texts)
        folds = [summary for summary, _ in nested]
        outer = [f for f in folds if f.startswith('Runs whose records differ')]
        self.assertGreater(len(outer), 1)
        self.assertEqual(outer, ['Runs whose records differ: 2 of 3, with 4 changes']
                         + ['Runs whose records differ: 2 of 3, with 4 changes, continued'] * (len(outer) - 1))
        self.assertIn(('<code>H1/W1</code>: 4 changes, continued', 'Runs whose records differ: 2 of 3, with 4 changes, continued'), nested)
        runs = [f for f in folds if f.startswith('<code>')]
        self.assertEqual(runs[0], '<code>H1/W1</code>: 4 changes')
        self.assertIn('<code>H1/W1</code>: 4 changes, continued', runs)
        self.assertEqual(runs[-1], '<code>H1/W2</code>: 4 changes')
        self.assertEqual(re.findall(r'^\*(C[0-9])\*$', whole, re.M), ['C0', 'C1', 'C2', 'C3'] * 2)
        self.assertEqual(whole.count('```text\n' + 'x' * 20_000 + '\n```'), 8)

    def test_a_later_change_too_long_for_its_continued_runs_collapsible_cuts_its_quote_and_every_part_fits(self):
        d = self.changed_run()
        self.facts(d)
        reader = self.four('w')
        reader['changes'][3]['before'] = 'y' * 70_000
        try:
            cv.post({'dir': d, 'reader': self.write(d, reader), 'post': False, 'reads': READS})
        except pr_review.Failed as e:
            self.fail(f'no comment for a long quote in a continued collapsible: {e}')
        parts = sorted((f for f in os.listdir(d) if re.fullmatch(r'comment(-[0-9]+)?\.md', f)), key=lambda f: int(f[8:-3] or 1))
        texts = [read_file(os.path.join(d, f)) for f in parts]
        self.assertTrue(all(len(t) <= cv.COMMENT_MAX for t in texts))
        [cut] = [t for t in texts if 'Before, its first' in t]
        shown = re.search(r'\*C3\*\n\nAt step `7`\.\n\nBefore, its first ([0-9,]+) of 70,000 characters:\n\n```text\n(y+)\n```', cut)
        self.assertIsNotNone(shown, cut[:400])
        self.assertEqual(int(shown[1].replace(',', '')), len(shown[2]))
        [(run, outer)] = [n for n in nesting(cut) if n[0].startswith('<code>H1/W1</code>')]
        self.assertEqual((run, outer), ('<code>H1/W1</code>: 4 changes, continued', 'Runs whose records differ: 2 of 3, with 4 changes, continued'))

    def test_a_runs_name_holding_blank_lines_or_markdown_stays_one_line_of_code_in_its_collapsibles_summary(self):
        run = 'H1\n\n[click](https://example.com)\n\n<b>Z</b>'
        entries = {'aaaaaaaaaaaa': {'places': [{'run': run, 'step': 1}]}}
        reader = {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a', 'place': {'run': run, 'step': 1}}]}
        [fold] = cv.run_folds({'order': [run]}, reader, entries, 10_000)
        self.assertTrue(fold.startswith('<details><summary><code>H1 [click](https://example.com) &lt;b&gt;Z&lt;/b&gt;</code>: 1 change</summary>'
                                        '\n\n*T*'), fold[:300])

    def test_folded_continues_a_list_too_long_for_one_comment_in_order_each_fold_titled_and_within_room(self):
        items = [f'- `R{i}`: *T* at step `{i}`.' for i in range(40)]
        room = 400
        folds = cv.folded("Runs whose records differ (40 of 40)", items, room)
        self.assertGreater(len(folds), 1)
        self.assertTrue(all(len(f) <= room for f in folds))
        titles = [re.match(r'<details><summary>([^<]*)</summary>', f).group(1) for f in folds]
        self.assertEqual(titles, ['Runs whose records differ (40 of 40)'] + ['Runs whose records differ (40 of 40), continued'] * (len(folds) - 1))
        self.assertEqual([line for f in folds for line in f.split('\n\n') if line.startswith('- ')], items)

    def test_folded_takes_a_first_item_that_fits_under_the_first_title_only(self):
        title = 'Runs whose records differ (1 of 1)'
        room = len(f'<details><summary>{title}</summary>\n\n\n\n</details>') + 40
        item = 'x' * 40
        try:
            got = cv.folded(title, [item], room)
        except pr_review.Failed as e:
            self.fail(f'a first item that fits under the first title was refused: {e}')
        self.assertEqual(got, [f'<details><summary>{title}</summary>\n\n{item}\n\n</details>'])
        with self.assertRaisesRegex(pr_review.Failed, "doesn't fit"):
            cv.folded(title, [item, item], room)

    def test_one_changed_run_with_every_run_compared_and_no_flag_says_so_above_with_no_clause(self):
        d = self.run_dir([([result('H1/W1', record='differs'), result('H1/W2'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W1', 4))])])
        text = self.comment(d, {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a'}]})
        self.assertIn("/CHECKS.md).\n\nThe records of 1 of the 3 runs differ between the base and this head.\n\n"
                      "*A model's account of those records:*\n\n**Delta 1: T**\n\nw.\n\n- base (`main`): b0.\n- head (`aaaaaaaaaaaa`): h0."
                      "\n\n<details>", text)
        self.assertIn('<details><summary>Runs whose records differ: 1 of 3, with 1 change</summary>\n\n'
                      '<details><summary><code>H1/W1</code>: 1 change</summary>\n\n', text)
        self.assertNotIn("couldn't be compared", text)
        self.assertNotIn('Checks&#x27; flags', text)

    def test_where_the_arms_ran_different_releases_besides_the_head_a_line_after_the_count_says_which_why_and_that_a_difference_may_be_theirs(self):
        stack = {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None},
                                                                                         {'range': '^0.8.0 || ^0.9.0', 'wantedBy': f'node_modules/{AF}'}]}}}
        d = self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'}, stack)
        view = self.facts(d)
        self.assertEqual((view['differing'], view['held']), ([{'package': 'membrane', 'base': '0.8.0', 'head': '0.9.0'}],
                                                             {'agent-framework': '0.32.0', 'chronicle': '0.5.1'}))
        said = ("Besides this head, the arms ran different releases of membrane: `0.8.0` in the base and `0.9.0` in the head. The view "
                "chose the head's membrane `0.9.0` to meet `^0.9.0` from this head and `^0.8.0 || ^0.9.0` from agent\\-framework, where "
                "connectome-host's lockfile has `0.8.0`. So a difference this view shows may come from membrane as well as from this head, "
                "and it can't tell which.")
        self.assertIn(f"The records of the 3 runs don't differ between the base and this head.\n\n{said}\n\nHeld the same in base and head: "
                      "connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`.", self.comment(d))
        changed = self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'}, stack, reached=entry('aaaaaaaaaaaa', ('H1/W1', 4)))
        text = self.comment(changed, {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a'}]})
        self.assertIn(f"The records of 1 of the 3 runs differ between the base and this head.\n\n{said}\n\n*A model's account of those records:*", text)
        asker = {'base': {}, 'head': {AF: {'version': '0.34.0', 'host': '0.32.0', 'ranges': [], 'asks': '^0.24.0 || ^0.25.0'}}}
        self.assertIn("Besides this head, the arms ran different releases of agent\\-framework: `0.32.0` in the base and `0.34.0` in the head. "
                      "The view chose the head's agent\\-framework `0.34.0` to admit the head's context\\-manager, where connectome-host's "
                      "lockfile has `0.32.0`. So a difference this view shows may come from agent\\-framework as well as from this head, and "
                      "it can't tell which.", self.comment(self.chosen_run({}, {'agent-framework': '0.34.0 (sha512-a)'}, asker)))
        both = {'base': {M: {'version': '0.7.9', 'host': '0.8.0', 'ranges': [{'range': '~0.7.9', 'wantedBy': None}]}},
                'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None}]},
                         AF: {'version': '0.34.0', 'host': '0.32.0', 'ranges': [{'range': '^0.34.0', 'wantedBy': f'{M}@0.9.0'}]}}}
        self.assertIn("Besides this head, the arms ran different releases of agent\\-framework and membrane: agent\\-framework `0.32.0` in the "
                      "base and `0.34.0` in the head; membrane `0.7.9` in the base and `0.9.0` in the head. The view chose the head's "
                      "agent\\-framework `0.34.0` to meet `^0.34.0` from membrane `0.9.0`, where connectome-host's lockfile has `0.32.0`. The "
                      "view chose the base's membrane `0.7.9` to meet `~0.7.9` from the base, where connectome-host's lockfile has `0.8.0`. "
                      "The view chose the head's membrane `0.9.0` to meet `^0.9.0` from this head, where connectome-host's lockfile has "
                      "`0.8.0`. So a difference this view shows may come from agent\\-framework and membrane as well as from this head, and "
                      "it can't tell which.",
                      self.comment(self.chosen_run({'membrane': '0.7.9 (sha512-o)'}, {'membrane': '0.9.0 (sha512-m)', 'agent-framework': '0.34.0 (sha512-a)'}, both)))

    def test_a_release_both_arms_ran_that_the_plan_chose_is_held_with_the_lockfiles_version_beside_it_and_no_line_above(self):
        chosen = {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.8.1', 'wantedBy': None}]}
        d = self.chosen_run({'membrane': '0.9.0 (sha512-m)'}, {'membrane': '0.9.0 (sha512-m)'}, {'base': {M: chosen}, 'head': {M: chosen}})
        view = self.facts(d)
        self.assertEqual(view['held'], {'agent-framework': '0.32.0', 'chronicle': '0.5.1', 'membrane': '0.9.0'})
        self.assertNotIn('differing', view)
        text = self.comment(d)
        self.assertIn("Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`, "
                      "membrane `0.9.0` (connectome-host's lockfile has `0.8.0`).", text)
        self.assertNotIn('Besides this head', text)

    def test_the_releases_the_plan_chose_are_part_of_the_result_so_a_comment_naming_them_is_never_kept_under_another(self):
        stack = {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None}]}}}
        v = self.facts(self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'}, stack))
        for other in ({**v, 'stack': {'base': {}, 'head': {M: {**stack['head'][M], 'host': '0.8.1'}}}},
                      {**v, 'differing': [{'package': 'membrane', 'base': '0.8.1', 'head': '0.9.0'}]},
                      {k: x for k, x in v.items() if k not in ('stack', 'differing')}):
            self.assertNotEqual(cv.result_of(v), cv.result_of(other))
        self.assertEqual(cv.result_of(v), cv.result_of(json.loads(json.dumps(v))))

    def test_no_entry_differing_in_runs_all_compared_says_the_records_show_no_request_changed_then_what_was_held(self):
        text = self.comment(self.unchanged_run(quarantines={'compression': 0, 'merge': 1}))
        self.assertTrue(text.startswith(f'**Automatic context view** of `{H1[:12]}` merged onto `{BASE[:12]}`.\n\n'
                                        + f'What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md).' + '\n\n'
                                        "The records of the 3 runs don't differ between the base and this head.\n\n"
                                        "Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, "), text[:700])
        self.assertEqual(len(text.split('\n\n')), 5)
        self.assertNotIn('<details>', text)

    def test_the_agents_usage_shows_above_the_fold_the_same_on_both_sides_with_its_figures_and_what_they_model(self):
        runs = [result('H1/W1', usage=usage()), result('H1/W2', usage=usage()), result('C6h/W11', usage=usage())]
        text = self.comment(self.run_dir([(runs, [])], base_results=runs))
        self.assertIn("between the base and this head.\n\nUsage: the figures of the agents' requests, subagents' included, in the 3 runs are the same in the base and this head: 1,050 tokens "
                      "sent a request, 85.7% of them read from the cache, 1,500 written to it, 600 output and 0 thinking blocks dropped. "
                      f"{cv.USAGE_MODEL}\n\nHeld the same in base and head:", text)
        self.assertNotIn('Usage that differs', text)

    def test_usage_that_moved_gives_the_agents_sums_base_to_head_and_folds_each_moved_runs_kinds_with_the_count_of_runs_that_didnt(self):
        base = [result('H1/W1', usage=usage({'requests': 30, 'input': 3000, 'cacheRead': 60000, 'cacheWrite': 1500, 'output': 600})), result('H1/W2', usage=usage(summariser={'requests': 4})), result('C6h/W11', usage=usage())]
        head = [result('H1/W1', usage=usage({'requests': 30, 'input': 3000, 'cacheRead': 60000, 'cacheWrite': 1500, 'output': 600})), result('H1/W2', usage=usage({'cacheRead': 8000, 'cacheWrite': 1500}, summariser={'requests': 4})),
                result('C6h/W11', usage=usage())]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn("Usage: the agents' requests, subagents' included, in the 3 runs, base → head: 1,710 tokens sent a request, 91.2% → 90.1% of them read from the "
                      "cache, 2,500 → 3,500 written to it, 1,000 output and 0 thinking blocks dropped. The figures of 1 run moved, for any kind "
                      f"of request; they're under \"Usage that differs\", below. {cv.USAGE_MODEL}\n\n", text)
        self.assertIn('<details><summary>Usage that differs: 1 of 3 runs, base → head</summary>\n\n'
                      '| `H1/W2` | kind | requests | input | read from the cache | written to it | output | thinking dropped |\n'
                      '| --- | --- | --- | --- | --- | --- | --- | --- |\n'
                      '| | agent | 10 | 1,000 | 9,000 → 8,000 | 500 → 1,500 | 200 | 0 |\n'
                      '| | summariser | 4 | 1,000 | 9,000 | 500 | 200 | 0 |\n\n'
                      'The figures of the other 2 runs are the same in the base and this head.\n\n</details>', text)
        other = [result('H1/W1', usage=usage({'requests': 30, 'input': 3000, 'cacheRead': 60000, 'cacheWrite': 1500, 'output': 600})), result('H1/W2', usage=usage(summariser={'requests': 5})), result('C6h/W11', usage=usage())]
        text = self.comment(self.run_dir([(other, [])], base_results=base))
        self.assertIn("are the same in the base and this head: 1,710 tokens sent a request, 91.2% of them read from the cache, 2,500 written to "
                      "it, 1,000 output and 0 thinking blocks dropped. The figures of 1 run moved, for any kind of request;", text)
        self.assertIn('| | summariser | 4 → 5 | 1,000 | 9,000 | 500 | 200 | 0 |', text)

    def test_names_the_runner_wrote_into_usage_and_flags_are_shown_inert(self):
        name = '[x](https://example.com) @someone|b'
        base = [result('H1/W1', usage=usage()), result('H1/W2', usage=usage()), result('C6h/W11', usage=usage())]
        head = [result('H1/W1', usage=usage(**{name: {'requests': 2}})), result('H1/W2', usage=usage()), result('C6h/W11', usage=usage())]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn(f'| | {pr_comment.inert(name)} | 0 → 2 |', text)
        self.assertNotIn('[x](https://example.com)', text)
        fine = {'last': 0, 'calibration': {'multiplier': 1.29, 'provisional': False, 'reset': False}}
        what = '[w](https://example.com) @who'
        raised = {'new': [{'check': 11, 'step': 'c.debt', 'what': what, 'detail': 'x'}], 'gone': [], 'kept': []}
        text = self.comment(self.upgraded(fine, fine, fine, fine, raised))
        self.assertIn(f"it raises check 11's `{what}` where the fresh run doesn't", text)
        self.assertEqual(text.count(what), text.count(f'`{what}`'), 'every mention of the name is a code span')

    def test_usage_is_read_only_where_both_arms_give_it_and_only_as_whole_numbers(self):
        head = [result('H1/W1', usage=usage()), result('H1/W2'), result('C6h/W11', usage=usage())]
        self.assertNotIn('Usage:', self.comment(self.run_dir([(head, [])], base_results=[result('H1/W1'), result('H1/W2'), result('C6h/W11')])))
        self.assertIn("in the 2 runs are the same", self.comment(self.run_dir([(head, [])], base_results=head)))
        good = [result('H1/W1', usage=usage()), result('H1/W2'), result('C6h/W11')]
        bad = [result('H1/W1', usage=usage({'input': 1.5})), result('H1/W2'), result('C6h/W11')]
        for head, base, arm in ((bad, good, 'head'), (good, bad, 'base')):
            with self.subTest(arm=arm), self.assertRaisesRegex(pr_review.Failed, re.escape(f"H1/W1: on the {arm}, its usage's 'agent' input isn't a whole number from 0 to 2**53, 1.5")):
                self.facts(self.run_dir([(head, [])], base_results=base))
        huge = [result('H1/W1', usage=usage({'input': 10 ** 400})), result('H1/W2'), result('C6h/W11')]
        with self.assertRaisesRegex(pr_review.Failed, re.escape("H1/W1: on the head, its usage's 'agent' input isn't a whole number from 0 to 2**53")):
            self.facts(self.run_dir([(huge, [])], base_results=good))
        lost = usage()
        del lost['lastDropped']
        with self.assertRaisesRegex(pr_review.Failed, re.escape("H1/W1: on the head, its usage has no lastDropped")):
            self.facts(self.run_dir([([result('H1/W1', usage=lost), result('H1/W2'), result('C6h/W11')], [])], base_results=good))

    def test_usage_whose_history_outweighs_its_run_or_whose_multiplier_isnt_finite_fails_the_step_naming_it(self):
        good = [result('H1/W1', usage=usage()), result('H1/W2'), result('C6h/W11')]
        over = usage()
        over['history'] = {'agent': {**over['kinds']['agent'], 'requests': 11}}
        lone = usage()
        lone['history'] = {'judge': dict(lone['kinds']['agent'])}
        for u, said in ((over, "H1/W1: on the head, its usage's history figures are more than the run's"), (lone, "H1/W1: on the head, its usage's history figures are more than the run's"),
                        (usage(calibration={'multiplier': float('nan'), 'provisional': False, 'reset': False}), "H1/W1: on the head, its usage's calibration isn't null"),
                        (usage(calibration={'multiplier': float('inf'), 'provisional': False, 'reset': False}), "H1/W1: on the head, its usage's calibration isn't null"),
                        (usage(calibration={'multiplier': 10 ** 400, 'provisional': False, 'reset': False}), "H1/W1: on the head, its usage's calibration isn't null")):
            with self.subTest(said=said, u=json.dumps(u)), self.assertRaisesRegex(pr_review.Failed, re.escape(said)):
                self.facts(self.run_dir([([result('H1/W1', usage=u), result('H1/W2'), result('C6h/W11')], [])], base_results=good))

    def test_a_base_arms_results_are_held_to_the_head_arms_rules_and_read_within_their_own_share(self):
        runs = [result('H1/W1', usage=usage()), result('H1/W2', usage=usage()), result('C6h/W11', usage=usage())]
        d = self.run_dir([(runs[:2], []), (runs[2:], [])], base_results=runs)
        path = os.path.join(d, 'share-2', 'before', 'run.json')
        arm = pr_review.read_json(path)
        for results, said in (([None], "share-2: the base arm's results hold one that isn't a run's result"),
                              ([{'usage': usage()}], "share-2: the base arm's results hold one that isn't a run's result"),
                              ([runs[2], runs[2]], "run C6h/W11 is twice in share-2's base arm"),
                              ([runs[2], {**runs[0], 'usage': usage({'cacheRead': 1})}], None)):
            with open(path, 'w') as f:
                json.dump({**arm, 'results': results}, f)
            with self.subTest(said=said):
                if said:
                    with self.assertRaisesRegex(pr_review.Failed, re.escape(said)):
                        self.facts(d)
                else:
                    view = self.facts(d)
                    self.assertEqual([u['base'] for u in view['usage'] if u['run'] == 'H1/W1'], [cv.usage_read(runs[0], 'base')],
                                     "a run's base figures are its own share's, not another share's base arm's")

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

    def test_an_upgraded_run_whose_end_states_differ_from_its_fresh_twins_says_what_on_which_side_and_whether_the_change_made_or_ended_it(self):
        stuck = {'last': 1, 'calibration': {'multiplier': 1, 'provisional': True, 'reset': True}, 'agent': {'dropped': 15}}
        fine = {'last': 0, 'calibration': {'multiplier': 1.29, 'provisional': False, 'reset': False}}
        kept = {'new': [], 'gone': [], 'kept': [{'check': 11, 'step': 'c.debt', 'what': 'invariant', 'detail': 'x'}]}
        built = {'new': [], 'gone': [], 'kept': [{'check': 4, 'step': 'p.17', 'what': 'not-reached', 'detail': 'y'}]}
        lead = "From a store connectome-host `v0.9.0` wrote, `H1b/continuation/from-0.9.0` beside its fresh twin `H1b/continuation/fresh`: "
        text = self.comment(self.upgraded(stuck, stuck, fine, fine, kept, twin_flags=built))
        self.assertIn(lead + "the calibration ends unconfirmed after a reset, where the fresh run's ends confirmed, on both sides; its last "
                      "request had 1 thinking block dropped, where the fresh run's had none dropped, on both sides; 1 flag differs from its "
                      f"twin's on both sides, named under \"{cv.UPGRADED}\", below.\n\n", text)
        self.assertIn(f"<details><summary>{cv.UPGRADED}</summary>\n\n| On the base | requests | tokens sent a request | read from the cache "
                      "| written to it | output | thinking dropped | last request dropped | calibration |\n" + '|' + ' --- |' * 9 + "\n"
                      "| `H1b/continuation/from-0.9.0` | 10 | 1,050 | 85.7% | 500 | 200 | 15 | 1 | 1.00, unconfirmed after a reset |\n"
                      "| `H1b/continuation/fresh` | 10 | 954 | 84.9% | 540 | 210 | 0 | 0 | 1.29, confirmed |", text)
        self.assertIn("A run that writes its own history first, as a fresh twin does, is shown without that history's requests", text)
        self.assertIn("On the head, `H1b/continuation/from-0.9.0` and its twin differ in flags: check 11's `invariant`, raised by the "
                      "upgraded run only.", text)
        self.assertNotIn('not-reached', text, "a flag in the history the run built isn't set beside the twin's")
        fixed = {'last': 0, 'calibration': {'multiplier': 1.3, 'provisional': False, 'reset': True}}
        ended = self.comment(self.upgraded(stuck, fixed, fine, fine))
        self.assertIn(lead + "the calibration ends unconfirmed after a reset, where the fresh run's ends confirmed, on the base only, so the "
                      "change ends that; its last request had 1 thinking block dropped, where the fresh run's had none dropped, on the base "
                      "only, so the change ends that.", ended)
        self.assertNotIn('From a store', self.comment(self.upgraded(fixed, fixed, fine, fine)), 'a reset alone differs in nothing')
        made = self.comment(self.upgraded(fine, stuck, fine, fine))
        self.assertIn("ends confirmed, on the head only, so the change makes that;", made)
        raised = {'new': [{'check': 11, 'step': 'c.debt', 'what': 'invariant', 'detail': 'x'}], 'gone': [], 'kept': []}
        self.assertIn(lead + "it raises check 11's `invariant` where the fresh run doesn't, on the head only, so the change makes that.",
                      self.comment(self.upgraded(fine, fine, fine, fine, raised)))
        both = {'new': [], 'gone': [], 'kept': [{'check': 11, 'step': 'c.debt', 'what': 'invariant', 'detail': 'x'}]}
        self.assertIn(lead + "it raises check 11's `invariant` where the fresh run doesn't, on the head only, so the change makes that.",
                      self.comment(self.upgraded(fine, fine, fine, fine, both, twin_flags={'new': [], 'gone': [both['kept'][0]], 'kept': []})),
                      "both raised it on the base and only the upgraded run does on the head: the difference is the head's, whoever changed")
        lowered = {'new': [], 'gone': [{'check': 11, 'step': 'c.debt', 'what': 'invariant', 'detail': 'x'}], 'kept': []}
        self.assertIn(lead + "it raises check 11's `invariant` where the fresh run doesn't, on the base only, so the change ends that.",
                      self.comment(self.upgraded(fine, fine, fine, fine, lowered)))
        two = {'new': [{'check': 11, 'step': 'c.debt', 'what': 'invariant', 'detail': 'x'}, {'check': 6, 'step': 'c.tool', 'detail': 'z'}], 'gone': [], 'kept': []}
        self.assertIn(lead + "it raises check 6 at step `c.tool` and check 11's `invariant` where the fresh run doesn't, on the head only, so the "
                      "change makes that.", self.comment(self.upgraded(fine, fine, fine, fine, two)), 'one clause for each side and run, its flags listed')
        stepped = {'new': [{'check': 6, 'step': 'c.tool', 'detail': 'z'}], 'gone': [], 'kept': []}
        self.assertIn(lead + "it raises check 6 at step `c.tool` where the fresh run doesn't, on the head only, so the change makes that.",
                      self.comment(self.upgraded(fine, fine, fine, fine, stepped)))
        self.assertNotIn('From a store', self.comment(self.upgraded(fine, fine, fine, fine)))

    def test_an_upgraded_run_with_no_answered_request_or_no_calibration_read_says_so_and_differs_from_a_twin_that_has_them(self):
        fine = {'last': 0, 'calibration': {'multiplier': 1.29, 'provisional': False, 'reset': False}}
        unanswered = {'last': None, 'calibration': {'multiplier': 1.29, 'provisional': False, 'reset': False}}
        unread = {'last': 0, 'calibration': None}
        lead = "From a store connectome-host `v0.9.0` wrote, `H1b/continuation/from-0.9.0` beside its fresh twin `H1b/continuation/fresh`: "
        text = self.comment(self.upgraded(fine, unanswered, fine, fine))
        self.assertIn(lead + "none of its agent's requests was answered, where the fresh run's had none dropped, on the head only, so the "
                      "change makes that.", text)
        self.assertIn("| `H1b/continuation/from-0.9.0` | 10 | 1,050 | 85.7% | 500 | 200 | 0 | no request | 1.29, confirmed |", text)
        twin = self.comment(self.upgraded(fine, fine, fine, unanswered))
        self.assertIn(lead + "its last request had none dropped, where none of the fresh run's agent's requests was answered, on the head "
                      "only, so the change makes that.", twin)
        text = self.comment(self.upgraded(unread, unread, fine, fine))
        self.assertIn(lead + "the calibration isn't reported, where the fresh run's ends confirmed, on both sides.", text)
        self.assertIn("| 0 | 0 | not reported |", text)
        self.assertNotIn('From a store', self.comment(self.upgraded(unanswered, unanswered, unanswered, unanswered)))

    def test_a_part_an_arms_stack_can_t_run_is_named_with_its_run_and_arm_after_the_count_so_no_reader_takes_it_for_one_that_passed(self):
        # A host bump: the base's stack lacks both modules and the head's has them, so the run's record differs.
        bump = self.run_dir([([result('H1/W1', record='differs', baseAbsent=['suppression', 'onboarding']), result('H1/W2'), result('C6h/W11')],
                              [entry('aaaaaaaaaaaa', ('H1/W1', 3))])])
        self.assertIn("The records of 1 of the 3 runs differ between the base and this head.\n\n"
                      "Parts left out where an arm's stack doesn't bring what they need: `H1/W1`'s suppression and onboarding on the base.\n\n"
                      "*A model's account of those records:*", self.comment(bump, self.reader('aaaaaaaaaaaa')))
        # Neither arm's stack has them, so both leave them out and the record doesn't differ.
        both = self.run_dir([([result('H1/W1', absent=['suppression', 'onboarding'], baseAbsent=['suppression', 'onboarding']), result('H1/W2'),
                               result('C6h/W11')], [])])
        self.assertIn("The records of the 3 runs don't differ between the base and this head.\n\n"
                      "Parts left out where an arm's stack doesn't bring what they need: `H1/W1`'s suppression and onboarding on the base; "
                      "`H1/W1`'s suppression and onboarding on the head.\n\n", self.comment(both))
        self.assertNotIn('Parts left out', self.comment(self.unchanged_run()))
        part = self.run_dir([([result('H1/W1', record='differs', absent=['conversations']), result('H1/W2'), result('C6h/W11')],
                              [entry('aaaaaaaaaaaa', ('H1/W1', 3))])])
        self.assertIn("Parts left out where an arm's stack doesn't bring what they need: `H1/W1`'s conversations on the head.\n\n",
                      self.comment(part, self.reader('aaaaaaaaaaaa')))

    def test_every_kind_of_view_links_checks_md_at_its_own_harness_commit_first_and_says_what_was_held_last(self):
        link = f'What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md).'
        changed = self.changed_run()
        shapes = {'unchanged': self.comment(self.unchanged_run()),
                  'unmerged': self.comment(self.run_dir([([], [])], outcome='doesnt-merge')),
                  'none compared': self.comment(self.run_dir([([result(run, outcome='couldnt-run', reason='x')
                                                                 for run in ('H1/W1', 'H1/W2', 'C6h/W11')], [])])),
                  'read': self.comment(changed, self.reader('aaaaaaaaaaaa', 'bbbbbbbbbbbb'))}
        for shape, text in shapes.items():
            with self.subTest(shape=shape):
                paragraphs = text.split('\n\n')
                self.assertEqual(paragraphs[1], link)
                self.assertEqual(text.count(link), 1)
                self.assertEqual(paragraphs[-2].startswith('Held the same in base and head:'), shape != 'unmerged', paragraphs[-2])
                for gone in ('About this view', 'Between them', 'good faith'):
                    self.assertNotIn(gone, text)

    def test_a_run_whose_outcome_the_view_doesnt_know_isnt_compared_and_says_why_and_the_known_ones_are(self):
        d = self.run_dir([([result('H1/W1', outcome='exploded'), result('H1/W2', outcome='flags'), result('C6h/W11', outcome='invalid')], [])])
        view = self.facts(d)
        self.assertEqual(view['runs'], {'total': 3, 'compared': 2})
        text = self.comment(d)
        self.assertIn("couldn't be compared at `H1/W1`: the harness gave it an outcome the view doesn't know (exploded).", text)
        null = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11', outcome='skipped', record=None)], [])])
        self.assertIn("couldn't be compared at `C6h/W11`: the harness gave it an outcome the view doesn't know (skipped).", self.comment(null))
        self.assertNotIn('`H1/W2`', text.split('The records of')[0])

    def test_each_kind_of_head_that_couldnt_be_compared_says_which_in_fixed_words_with_no_reader(self):
        cases = [('doesnt-merge', None, f"This head couldn't be compared: it conflicts with `main` at `{BASE[:12]}`, and a view "
                                        "runs the head merged onto its base, so those conflicts need resolving before it can be "
                                        "viewed."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': '^0.9.0', 'wantedBy': None, 'has': '0.8.0', 'why': 'no-release',
                                      'release': M, 'ranges': [{'range': '^0.9.0', 'wantedBy': None}]},
                  "This head couldn't be compared: it asks for membrane `^0.9.0`, and no published release of membrane meets it."),
                 ('needs-companion', {'arm': 'base', 'package': M, 'range': '^0.9.0', 'wantedBy': None, 'has': '0.8.0', 'why': 'no-release',
                                      'release': M, 'ranges': [{'range': '^0.9.0', 'wantedBy': None},
                                                               {'range': '^0.8.0', 'wantedBy': 'node_modules/@animalabs/agent-framework'},
                                                               {'range': '~0.9.1', 'wantedBy': '@animalabs/chronicle@0.7.0'}]},
                  "This head couldn't be compared: its base asks for membrane `^0.9.0`, and no published release of membrane meets every "
                  "range on it in the base's stack (`^0.9.0` from the base, `^0.8.0` from agent\\-framework and `~0.9.1` from chronicle "
                  "`0.7.0`)."),
                 ('needs-companion', {'arm': 'base', 'package': M, 'range': '^0.8.0', 'wantedBy': 'node_modules/@animalabs/agent-framework',
                                      'has': '0.9.0', 'why': 'no-release', 'release': AF, 'ranges': [], 'admits': {'package': M, 'version': '0.9.0'}},
                  "This head couldn't be compared: agent\\-framework in the host's stack asks for membrane `^0.8.0`, and no published "
                  "release of agent\\-framework admits the base's membrane `0.9.0`."),
                 ('needs-companion', {'arm': 'head', 'package': '@animalabs/chronicle', 'range': '^0.7.0', 'wantedBy': f'{AF}@0.34.0', 'has': '0.6.0',
                                      'why': 'no-release', 'release': '@animalabs/chronicle', 'ranges': [{'range': '^0.7.0', 'wantedBy': f'{AF}@0.34.0'}],
                                      'admits': {'package': M, 'version': '0.9.0'}},
                  "This head couldn't be compared: agent\\-framework `0.34.0`, which the view chose for the head, asks for chronicle `^0.7.0`, "
                  "and no published release of chronicle meets it and admits the head's membrane `0.9.0`."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': 'github:antra-tess/membrane#v0.9.0', 'wantedBy': None, 'has': '0.8.0',
                                      'why': 'not-plain'},
                  "This head couldn't be compared: it asks for membrane `github:antra-tess/membrane#v0.9.0`, which isn't a version range, so "
                  "the view can't choose a release to meet it."),
                 ('needs-companion', {'arm': 'base', 'package': M, 'version': '0.9.0', 'range': '^0.8.0', 'wantedBy': 'node_modules/optional-user',
                                      'has': '0.9.0', 'why': 'no-mover'},
                  "This head couldn't be compared: optional\\-user in the host's stack asks for membrane `^0.8.0`, and the base's is "
                  "`0.9.0`. The view chooses releases only for the `@animalabs` packages at the top level of connectome-host's lockfile, "
                  "so it can't change that."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': '^0.8.0', 'wantedBy': 'node_modules/@animalabs/agent-framework',
                                      'has': None, 'why': 'no-mover'},
                  "This head couldn't be compared: agent\\-framework in the host's stack asks for membrane `^0.8.0`, and the head's "
                  "`package.json` gives no version."),
                 ('needs-companion', {'arm': 'base', 'package': '@animalabs/chronicle', 'range': '0.6.0', 'wantedBy': '@animalabs/context-manager@0.25.0',
                                      'has': '0.7.0', 'why': 'unsettled', 'tried': {'@animalabs/context-manager': '0.25.0', '@animalabs/chronicle': '0.6.0'}},
                  "This head couldn't be compared: context\\-manager `0.25.0`, which the view chose for the base, asks for chronicle `0.6.0`, "
                  "and choosing releases for the arms came back to choices it had already made, so it stopped there. The base's were "
                  "chronicle `0.6.0` and context\\-manager `0.25.0`."),
                 ('arm-missing', {'share': 2, 'arm': 'after', 'log': 'boot failed: @x port in use'},
                  "This head couldn't be compared: one of its 2 jobs came back without the head arm's results (its last log line: "
                  "boot failed\\: `@x` port in use)."),
                 ('arm-missing', {'share': 1, 'arm': 'before', 'log': None},
                  "This head couldn't be compared: one of its 2 jobs came back without the base arm's results.")]
        for outcome, detail, said in cases:
            with self.subTest(outcome):
                d = self.run_dir([([], []), ([], [])], outcome=outcome, detail=detail)
                text = self.comment(d)
                self.assertEqual(text.split('\n\n')[1:3], [f'What a context view runs and what its checks judge: '
                                                             f'[CHECKS.md](https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md).', said])
                self.assertNotIn('This view', text)

    def test_a_head_that_conflicts_with_a_stacked_base_names_that_branch(self):
        d = self.run_dir([([], [])], outcome='doesnt-merge')
        path = os.path.join(d, 'manifest.json')
        m = pr_review.read_json(path)
        with open(path, 'w') as f:
            json.dump({**m, 'base': {**m['base'], 'ref': 'stack/@x-part-1'}}, f)
        self.assertIn(f"it conflicts with `stack/@x-part-1` at `{BASE[:12]}`, and a view runs", self.comment(d))

    def test_a_head_that_doesnt_merge_is_named_against_the_base_not_merged_onto_it(self):
        text = self.comment(self.run_dir([([], [])], outcome='doesnt-merge'))
        self.assertTrue(text.startswith(f'**Automatic context view** of `{H1[:12]}` against `{BASE[:12]}`.'))
        self.assertNotIn('Held the same', text)

    def test_a_head_run_without_a_self_check_or_whose_drive_with_recording_off_couldnt_show_it_says_which_and_why(self):
        unchecked, drive = result('H1/W1', check=None), result('H1/W2', check='couldnt-run')
        drive['selfCheck']['reason'] = 'it logged 3 compiles with recording off'
        try:
            text = self.comment(self.run_dir([([unchecked, drive, result('C6h/W11')], [])]))
        except Exception as e:
            self.fail(f'no comment for runs without a self-check: {e!r}')
        self.assertIn("couldn't be compared at `H1/W1`: the head wasn't self-checked.", text)
        self.assertIn("couldn't be compared at `H1/W2`: the head's second drive, with recording off, couldn't show that recording "
                      "changes nothing it sends (it logged 3 compiles with recording off).", text)

    def test_a_run_either_arm_couldnt_run_or_whose_records_varied_is_left_out_of_the_comparison_and_named(self):
        missing = self.run_dir([([result('H1/W1'), result('H1/W2', record='missing'), result('C6h/W11')], [])])
        some = self.comment(missing)
        self.assertIn("The records of the 2 runs it could compare don't differ between the base and this head.", some)
        self.assertNotIn("Between them", some)
        d = self.run_dir([([result('H1/W1', outcome='couldnt-run', reason='the store @x was unreadable'), result('H1/W2', record='missing'),
                            {**result('C6h/W11', check=None), 'selfCheck': {'outcome': 'differs', 'at': 0, 'detail': 'no request bodies were saved in /w/on'}}],
                           [entry('aaaaaaaaaaaa', ('C6h/W11', 1))])])
        text = self.comment(d)
        self.assertIn("couldn't be compared at `H1/W1`: the head couldn't run it (the store `@x` was unreadable).", text)
        self.assertIn("couldn't be compared at `H1/W2`: the base couldn't run it.", text)
        self.assertIn("couldn't be compared at `C6h/W11`: its self-check, which drives this head again with recording off, didn't "
                      f"find the two drives' requests the same, so a difference from the base can't be put down to the change alone "
                      f"({cv.inert('no request bodies were saved in /w/on')}).", text)
        self.assertNotIn('requests differed', text)
        self.assertNotIn("don't differ between the base and this head", text)
        self.assertNotIn('it could compare', text)

    def test_a_run_the_base_couldnt_run_gives_the_bases_own_reason_and_never_the_heads(self):
        # The harness gives the base arm's reason as baseReason; a result's own reason is the head's.
        said = {**result('H1/W2', record='missing', reason='the head arm said this too'), 'baseReason': 'its checkpoint failed: H1/W2 exited 1'}
        heads = {**result('H1/W1', record='missing'), 'reason': 'the head arm said this'}
        silent = {**result('C6h/W11', record='missing'), 'baseReason': ''}
        text = self.comment(self.run_dir([([heads, said, silent], [])]))
        self.assertIn("couldn't be compared at `H1/W2`: the base couldn't run it (its checkpoint failed\\: H1\\/W2 exited 1).", text)
        self.assertIn("couldn't be compared at `H1/W1`: the base couldn't run it.", text)
        self.assertIn("couldn't be compared at `C6h/W11`: the base couldn't run it.", text)
        self.assertNotIn('the head arm said this', text)
        # A run the head couldn't run gives the head's reason, whatever baseReason says.
        head = {**result('H1/W1', outcome='couldnt-run', reason='the store was unreadable'), 'baseReason': 'the base arm said this'}
        text = self.comment(self.run_dir([([head, result('H1/W2'), result('C6h/W11')], [])]))
        self.assertIn("couldn't be compared at `H1/W1`: the head couldn't run it (the store was unreadable).", text)
        self.assertNotIn('the base arm said this', text)

    def test_a_run_whose_read_failed_on_either_arm_is_left_out_of_the_comparison_naming_the_arm_and_the_read(self):
        heads = result('H1/W1', record='differs')
        heads['readsFailed'], heads['baseReadsFailed'] = ['messages', 'receipt'], ['summaries']
        q = result('H1/W2', quarantines={'compression': 'unreadable', 'merge': 0})
        try:
            text = self.comment(self.run_dir([([heads, q, result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W1', 1))])]))
        except Exception as e:
            self.fail(f'no comment for a head whose reads failed: {e!r}')
        self.assertIn("couldn't be compared at `H1/W1`: the head's reads of messages and receipt, and the base's read of summaries, "
                      "failed.", text)
        self.assertIn("couldn't be compared at `H1/W2`: the head's quarantine count couldn't be read.", text)
        self.assertNotRegex(text, r"(?<!don't) differ between the base and this head\.")

    def test_a_run_that_failed_gives_the_failing_arms_own_reason_from_its_run_level_check_1_flag(self):
        def failure(text, whole=None):
            return {'check': 1, 'step': 'the run', 'detail': f'the run failed: {text}', **({'whole': whole} if whole else {})}
        later = {'check': 1, 'step': 's2', 'detail': 'unclassified request: its last message carries none of step s2\'s canaries'}
        other = {'check': 1, 'step': 'the run', 'detail': 'the host raised an operator alert'}
        stepped = {'check': 1, 'step': 's1', 'detail': 'the run failed: a step-level flag with the prefix'}
        checked = {'check': 11, 'step': 'the run', 'detail': 'the run failed: another check with the prefix'}
        head = {**result('H1/W1', outcome='flags', flags={'new': [other, stepped, checked, failure("the stand-in got a request it couldn't classify (r6)"), later],
                                                          'gone': [], 'kept': []}),
                'unmeasured': ['the run failed']}
        base = {**result('H1/W2', flags={'new': [], 'gone': [failure('boot 1 exited 1')], 'kept': []}), 'baseUnmeasured': ['the run failed']}
        apart = {**result('C6h/W11', outcome='flags', flags={'new': [failure('the head said this')], 'gone': [failure('the base said this')], 'kept': []}),
                 'unmeasured': ['the run failed'], 'baseUnmeasured': ['the run failed']}
        alike = {**result('H1/W1', outcome='flags', flags={'new': [], 'gone': [], 'kept': [failure('both said this')]}),
                 'unmeasured': ['the run failed'], 'baseUnmeasured': ['the run failed']}
        mixed = {**result('H1/W1', outcome='flags', flags={'new': [failure('the head said this')], 'gone': [], 'kept': []}),
                 'unmeasured': ['the run failed'], 'baseUnmeasured': ['its folds were clamped (check 10)']}
        judged = {**result('H1/W2', outcome='flags', flags={'new': [failure('the head said this')], 'gone': [], 'kept': []}),
                  'unmeasured': ['the run failed', 'check 4 (coverage) judged nothing']}
        text = self.comment(self.run_dir([([head, base, apart], [])]))
        others = self.comment(self.run_dir([([mixed, judged, result('C6h/W11')], [])]))
        one = {**result('H1/W2', outcome='flags', flags={'new': [failure('only the head said why')], 'gone': [], 'kept': []}),
               'unmeasured': ['the run failed'], 'baseUnmeasured': ['the run failed']}
        both = self.comment(self.run_dir([([alike, one, result('C6h/W11')], [])]))
        cut_apart = {**result('H1/W1', outcome='flags', flags={'new': [failure('alike up to the cut', 'aaaaaaaaaaaa')],
                                                               'gone': [failure('alike up to the cut', 'bbbbbbbbbbbb')], 'kept': []}),
                     'unmeasured': ['the run failed'], 'baseUnmeasured': ['the run failed']}
        cut_alike = {**result('H1/W2', outcome='flags', flags={'new': [], 'gone': [], 'kept': [failure('cut the same', 'cccccccccccc')]}),
                     'unmeasured': ['the run failed'], 'baseUnmeasured': ['the run failed']}
        paired = {**result('C6h/W11', outcome='flags', flags={'new': [failure('said alike')], 'gone': [failure('said alike')], 'kept': []}),
                  'unmeasured': ['the run failed'], 'baseUnmeasured': ['the run failed']}
        cut = self.comment(self.run_dir([([cut_apart, cut_alike, paired], [])]))
        self.assertIn(f"({cv.inert(chr(39).join(['the head', 's run failed: alike up to the cut (cut by the harness); the base', 's run failed: alike up to the cut (cut by the harness)']))}).", cut)
        self.assertIn(f"({cv.inert(chr(39).join(['both arms', ' runs failed: cut the same (cut by the harness)']))}).", cut)
        self.assertIn(f"({cv.inert(chr(39).join(['both arms', ' runs failed: said alike']))}).", cut)
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed) "
                      f"({cv.inert(chr(39).join(['the head', 's run failed: the stand-in got a request it couldn', 't classify (r6)']))}).", text)
        self.assertIn(f"couldn't be compared at `H1/W2`: the run didn't measure (on the base, the run failed) ({cv.inert(chr(39).join(['the base', 's run failed: boot 1 exited 1']))}).", text)
        self.assertIn("couldn't be compared at `C6h/W11`: the run didn't measure (on the head, the run failed; on the base, the run failed) "
                      f"({cv.inert(chr(39).join(['the head', 's run failed: the head said this; the base', 's run failed: the base said this']))}).", text)
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed; on the base, the run failed) "
                      f"({cv.inert(chr(39).join(['both arms', ' runs failed: both said this']))}).", both)
        self.assertIn("couldn't be compared at `H1/W2`: the run didn't measure (on the head, the run failed; on the base, the run failed) "
                      f"({cv.inert(chr(39).join(['the head', 's run failed: only the head said why']))}).", both)
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed; on the base, its folds were clamped "
                      f"\\(check 10\\)) ({cv.inert(chr(39).join(['the head', 's run failed: the head said this']))}).", others)
        self.assertIn("couldn't be compared at `H1/W2`: the run didn't measure (on the head, the run failed and check 4 \\(coverage\\) judged "
                      f"nothing) ({cv.inert(chr(39).join(['the head', 's run failed: the head said this']))}).", others)
        self.assertNotIn('operator alert', text)
        self.assertNotIn('unclassified request', text)
        self.assertNotIn('with the prefix', text)

    def test_a_run_that_didnt_measure_and_whose_read_failed_says_both(self):
        r = {**result('H1/W1'), 'unmeasured': ['the run failed'], 'baseReadsFailed': ['summaries']}
        text = self.comment(self.run_dir([([r, result('H1/W2'), result('C6h/W11')], [])]))
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed), and the base's read of "
                      "summaries failed.", text)

    def test_a_run_that_didnt_measure_and_whose_quarantine_count_couldnt_be_read_says_both(self):
        r = {**result('H1/W1', quarantines={'compression': 'unreadable', 'merge': 0}), 'unmeasured': ['the run failed']}
        text = self.comment(self.run_dir([([r, result('H1/W2'), result('C6h/W11')], [])]))
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed), and the head's quarantine "
                      "count couldn't be read.", text)

    def test_a_flag_list_too_long_for_one_comment_goes_on_in_the_next(self):
        flags = {'new': [{'check': i + 1, 'step': str(i), 'what': 'w', 'detail': 'd' * 900} for i in range(120)], 'gone': [], 'kept': []}
        d = self.run_dir([([result('H1/W1', flags=flags), result('H1/W2'), result('C6h/W11')], [])])
        self.facts(d)
        try:
            out = self.post(d)
        except pr_review.Failed as e:
            self.fail(f'a long flag list failed the post: {e}')
        self.assertGreater(len(self.bodies()), 1)
        self.assertEqual(sum(b.count('flagged on the head 1 more time than on the base') for b in self.bodies()), 120)
        self.assertEqual(out['action'], 'posted')

    def test_a_cut_shows_the_longest_prefix_whose_rendered_form_fits(self):
        words = lambda shown, part: f'x{part}: {pr_comment.inert(shown)}'
        for text in ('*' * 100_000, 'a*' * 50_000):
            with self.subTest(text=text[:4]):
                said = cv.clipped(words, text, 65_000)
                n = int(re.search(r"'s first ([0-9,]+) of 100,000 characters", said)[1].replace(',', ''))
                self.assertLessEqual(len(said), 65_000)
                self.assertGreater(len(words(text[:n + 1], f"'s first {n + 1:,} of 100,000 characters")), 65_000)

    def test_a_flag_cut_counts_only_the_characters_it_shows_even_between_its_name_and_its_detail(self):
        view = {'flags': [{'run': 'H1/W1', 'new': [{'check': 'kv', 'step': 3, 'what': 'a pin moved', 'detail': 'z' * 50}], 'gone': []}]}
        line = '- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base'
        counted = set()
        for room in range(len(line) + len(" (the flag's first 0 of 63 characters)"), len(line) + 100):
            said = cv.flags_text(view, room)[1]
            m = re.fullmatch(re.escape(line) + r"(?:: (.*))? \(the flag's first ([0-9,]+) of 63 characters\)", said)
            if m:
                shown = pr_comment.readable(m[1] or '')
                self.assertEqual(len(shown), int(m[2]), (room, said))
                counted.add(int(m[2]))
        self.assertIn(11, counted)
        self.assertTrue(any(n > 13 for n in counted))

    def test_a_flag_cut_counts_none_of_the_whitespace_rendering_takes_out(self):
        view = {'flags': [{'run': 'H1/W1', 'new': [{'check': 'kv', 'step': 3, 'what': ' a pin\tmoved  ', 'detail': '\n   ' + 'z' * 50}],
                           'gone': []}]}
        line = '- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base'
        counted = set()
        for room in range(len(line) + len(" (the flag's first 0 of 63 characters)"), len(line) + 100):
            said = cv.flags_text(view, room)[1]
            m = re.fullmatch(re.escape(line) + r"(?:: (.*))? \(the flag's first ([0-9,]+) of 63 characters\)", said)
            if m:
                shown = pr_comment.readable(m[1] or '')
                self.assertEqual(int(m[2]), len(shown), (room, said))
                counted.add(int(m[2]))
        self.assertIn(11, counted)
        self.assertTrue(any(n > 13 for n in counted))
        self.assertEqual(cv.flags_text(view, 1000)[1], line + ': a pin moved\\: ' + 'z' * 50)

    def test_a_flag_with_no_words_is_listed_by_its_check_and_place(self):
        view = {'flags': [{'run': 'H1/W1', 'new': [{'check': 'kv', 'step': 3}, {'check': 'k2', 'step': 4, 'what': ' \n', 'detail': ''}],
                           'gone': []}]}
        try:
            said = cv.flags_text(view, 1000)[1:]
        except Exception as e:
            self.fail(f'a flag with no words broke the flags: {e!r}')
        self.assertEqual(said,
                         ['- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base',
                          '- `H1/W1` step `4`, check `k2` flagged on the head 1 more time than on the base'])

    def test_identical_flags_in_one_run_at_one_step_on_one_side_are_one_line_saying_how_many_times(self):
        same = {'check': 4, 'step': '405389.11', 'what': 'more-than-once', 'detail': '1 message(s) reach the request more than once'}
        said = cv.inert('more-than-once: 1 message(s) reach the request more than once')
        view = {'flags': [{'run': 'C6h/W9', 'new': [same, dict(same), dict(same, step='405389.12'), dict(same, step='405389.12'),
                                                    dict(same, step='405389.12'), dict(same, check=11), same],
                           'gone': [dict(same)]},
                          {'run': 'C6h/W10', 'new': [dict(same)], 'gone': []}]}
        self.assertEqual(cv.flags_text(view, 1000)[1:], [
            '- `C6h/W9` step `405389.11`, check `4` flagged on the head 3 more times than on the base: ' + said,
            '- `C6h/W9` step `405389.12`, check `4` flagged on the head 3 more times than on the base: ' + said,
            '- `C6h/W9` step `405389.11`, check `11` flagged on the head 1 more time than on the base: ' + said,
            '- `C6h/W9` step `405389.11`, check `4` flagged on the base 1 more time than on the head: ' + said,
            '- `C6h/W10` step `405389.11`, check `4` flagged on the head 1 more time than on the base: ' + said])
        apart = {'flags': [{'run': 'C6h/W9', 'new': [dict(same, whole='a' * 40), dict(same, whole='b' * 40)], 'gone': []}]}
        self.assertEqual([l.split(' on the head')[0] for l in cv.flags_text(apart, 1000)[1:]],
                         ['- `C6h/W9` step `405389.11`, check `4` (another line of this run shows the same text for a different flag) flagged'] * 2)
        three = {'flags': [{'run': 'C6h/W9', 'new': [dict(same, whole='a' * 40), dict(same, whole='a' * 40), dict(same, whole='b' * 40)],
                            'gone': []}]}
        self.assertEqual([l.split(': ')[0] for l in cv.flags_text(three, 1000)[1:]], [
            '- `C6h/W9` step `405389.11`, check `4` (another line of this run shows the same text for a different flag) flagged on the head 2 more times than on the base',
            '- `C6h/W9` step `405389.11`, check `4` (another line of this run shows the same text for a different flag) flagged on the head 1 more time than on the base'])
        for field in ('what', 'detail'):
            alone = {'flags': [{'run': 'C6h/W9', 'new': [same, dict(same, **{field: 'other'})], 'gone': []}]}
            self.assertEqual(len(cv.flags_text(alone, 1000)[1:]), 2, field)
        past = {'flags': [{'run': 'C6h/W9', 'new': [dict(same, whole='a' * 12)], 'gone': [dict(same, whole='b' * 12)]},
                          {'run': 'C6h/W10', 'new': [dict(same, whole='a' * 12), dict(same, whole='b' * 12)], 'gone': [dict(same, step='9')]}]}
        lines = cv.flags_text(past, 1000)[1:]
        mark = ' (another line of this run shows the same text for a different flag)'
        self.assertEqual([l.split(' flagged')[0] for l in lines], [
            '- `C6h/W9` step `405389.11`, check `4`' + mark, '- `C6h/W9` step `405389.11`, check `4`' + mark,
            '- `C6h/W10` step `405389.11`, check `4`' + mark, '- `C6h/W10` step `405389.11`, check `4`' + mark,
            '- `C6h/W10` step `9`, check `4`'])
        split = {'flags': [{'run': 'C6h/W9', 'new': [{'check': 4, 'step': 'the run', 'what': 'x', 'detail': 'y'},
                                                    {'check': 4, 'detail': 'x: y'}], 'gone': []}]}
        self.assertEqual([l.split(' flagged')[0] for l in cv.flags_text(split, 1000)[1:]],
                         ['- `C6h/W9`, check `4` (another line of this run shows the same text for a different flag)'] * 2)
        gone = {'flags': [{'run': 'C6h/W9', 'new': [], 'gone': [same, dict(same)]}]}
        self.assertEqual(cv.flags_text(gone, 1000)[1:], [
            '- `C6h/W9` step `405389.11`, check `4` flagged on the base 2 more times than on the head: ' + said])
        twice = {'flags': [{'run': 'C6h/W9', 'new': [same, dict(same)], 'gone': []}]}
        self.assertEqual(cv.flags_text(twice, 1000)[1:], [
            '- `C6h/W9` step `405389.11`, check `4` flagged on the head 2 more times than on the base: ' + said])
        self.assertTrue(cv.flags_line(view, 9).startswith("Separately, 9 of the checks' flags differ between the base and the head, in 2 runs;"),
                        cv.flags_line(view, 9))

    def test_a_flag_too_long_for_a_comment_shows_its_first_characters_and_says_how_many_of_how_many(self):
        flags = {'new': [{'check': 11, 'step': 3, 'what': 'a pin moved', 'detail': 'z' * 100_000}], 'gone': [], 'kept': []}
        d = self.run_dir([([result('H1/W1', flags=flags), result('H1/W2'), result('C6h/W11')], [])])
        self.facts(d)
        try:
            self.assertEqual(self.post(d)['action'], 'posted')
        except pr_review.Failed as e:
            self.fail(f'one long flag failed the post: {e}')
        self.assertTrue(all(len(b) <= pr_comment.COMMENT_MAX for b in self.bodies()))
        shown = re.search(r"- `H1/W1` step `3`, check `11` flagged on the head 1 more time than on the base: a pin moved\\: (z+) "
                          r"\(the flag's first ([0-9,]+) of 100,013 characters\)", ''.join(self.bodies()))
        self.assertIsNotNone(shown)
        self.assertEqual(len('a pin moved: ' + shown[1]), int(shown[2].replace(',', '')))

    def test_a_run_the_base_couldnt_run_whose_read_failed_says_both(self):
        r = {**result('H1/W1', record='missing'), 'readsFailed': ['summaries']}
        text = self.comment(self.run_dir([([r, result('H1/W2'), result('C6h/W11')], [])]))
        self.assertIn("couldn't be compared at `H1/W1`: the base couldn't run it, and the head's read of summaries failed.", text)

    def test_a_head_arm_without_entries_or_a_compared_result_without_flags_or_counts_fails_rather_than_reading_as_a_run(self):
        d = self.unchanged_run()
        os.remove(os.path.join(d, 'share-1', 'after', 'entries.json'))
        with self.assertRaisesRegex(pr_review.Failed, 'wrote no entries.json'):
            self.facts(d)
        for field in ('counts', 'flags'):
            bare = result('H1/W1')
            del bare[field]
            with self.subTest(field), self.assertRaisesRegex(pr_review.Failed, "H1/W1's result has no flags or counts"):
                self.facts(self.run_dir([([bare, result('H1/W2'), result('C6h/W11')], [])]))

    def test_a_run_that_didnt_measure_on_either_arm_is_left_out_of_the_comparison_naming_the_arm_and_what(self):
        failed, judged = result('H1/W1'), result('H1/W2')
        failed['unmeasured'] = ['the run failed']
        judged['baseUnmeasured'] = ['check 4 (coverage) judged nothing']
        try:
            text = self.comment(self.run_dir([([failed, judged, result('C6h/W11')], [])]))
        except Exception as e:
            self.fail(f'no comment for a head whose runs didn\'t measure: {e!r}')
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed).", text)
        self.assertIn("couldn't be compared at `H1/W2`: the run didn't measure (on the base, check 4 \\(coverage\\) judged nothing).", text)
        self.assertIn("The records of the 1 run it could compare don't differ between the base and this head.", text)

    def test_an_arm_that_wrote_no_run_json_fails_the_step_rather_than_reading_as_a_run(self):
        for arm in ('after', 'before'):
            d = self.unchanged_run()
            os.remove(os.path.join(d, 'share-2', arm, 'run.json'))
            with self.subTest(arm), self.assertRaises(Exception) as raised:
                self.facts(d)
            self.assertIsInstance(raised.exception, pr_review.Failed)
            self.assertIn('wrote no run.json', str(raised.exception))

    def test_a_log_line_or_reason_too_long_for_a_comment_is_cut_to_fit_and_says_how_much_of_it_shows(self):
        long = 'boot failed ' * 10_000
        missing = self.run_dir([([], []), ([], [])], outcome='arm-missing', detail={'share': 1, 'arm': 'after', 'log': long})
        reasoned = self.run_dir([([result('H1/W1', outcome='couldnt-run', reason=long), result('H1/W2'), result('C6h/W11')], [])])
        for d, said, total in ((missing, "(its last log line's first ", len(long.strip())), (reasoned, ", the reason's first ", len(long.strip()))):
            with self.subTest(said=said):
                self.facts(d)
                try:
                    parts = self.post(d, post=False)['parts']
                except pr_review.Failed as e:
                    self.fail(f'a long line failed the comment: {e}')
                texts = [read_file(os.path.join(d, 'comment.md' if k == 1 else f'comment-{k}.md')) for k in range(1, parts + 1)]
                self.assertTrue(all(len(t) <= cv.COMMENT_MAX for t in texts))
                self.assertIn(said, ''.join(texts))
                self.assertIn(f" of {total:,} characters", ''.join(texts))

    # A cut line's "first k of N" counts what a reader sees, both of them: a code span's backticks don't show, nor the space
    # CommonMark takes from each end of content like ` a `, and a cut never ends inside a code span or a run of backticks,
    # so what shows is the whole text's first k characters as it shows.
    REASON_LEAD = "This head couldn't be compared at `H1/W1`: the head couldn't run it ("

    def reason_line(self, reason, line):
        view = {'outcome': 'ran', 'broken': [{'run': 'H1/W1', 'what': 'head', 'reason': reason}]}
        return cv.could_not(view, len(line))

    def test_a_cut_reason_counts_what_shows_of_its_code_spans(self):
        for reason, shown, k, n in (('see ` a ` here ' + 'w' * 300, 'see ` a ` here www', 14, 311),
                                    ('the store `could not` be opened: ' + 'y' * 300, 'the store `could not` be opened\\: yy', 33, 331)):
            line = self.REASON_LEAD + f"{shown}, the reason's first {k} of {n} characters)."
            with self.subTest(reason=reason[:12]):
                self.assertEqual(self.reason_line(reason, line), [line])

    def test_a_cut_never_ends_inside_a_code_span_or_a_run_of_backticks(self):
        span = 'x ' + '`' * 30 + 'y' + '`' * 30 + ' z' * 200
        line = self.REASON_LEAD + "x, the reason's first 1 of 403 characters)."
        self.assertEqual(self.reason_line(span, line + 'abc'), [line])
        unpaired = 'a `` b `````' + ' q' * 200
        line = self.REASON_LEAD + "a \\`\\` b, the reason's first 6 of 412 characters)."
        self.assertEqual(self.reason_line(unpaired, line + 'abcde'), [line])
        ends = self.REASON_LEAD + "x `y`, the reason's first 3 of 303 characters)."
        self.assertEqual(self.reason_line('x `y`' + 'z' * 300, ends), [ends])

    def test_a_cut_flag_counts_what_shows_of_its_code_spans_and_never_ends_inside_one(self):
        line = '- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base'
        for what, detail, shown, k, n, spare in (
                ('a pin moved', 'the `kv` store said `no` ' + 'z' * 300, ': a pin moved\\: the `kv` store said `no` zz', 36, 334, 0),
                ('a pin moved', '`' + 'k' * 40 + '`' + ' z' * 100, ': a pin moved\\:', 12, 253, 10),
                ('a `' + 'p' * 40 + '` moved', 'z' * 300, ': a', 1, 350, 10),
                (':smile', 'x' * 300, ': `:smile:` xx', 10, 308, 0)):
            said = line + f"{shown} (the flag's first {k} of {n} characters)"
            view = {'flags': [{'run': 'H1/W1', 'new': [{'check': 'kv', 'step': 3, 'what': what, 'detail': detail}], 'gone': []}]}
            with self.subTest(what=what[:4], detail=detail[:12]):
                self.assertEqual(cv.flags_text(view, len(said) + spare)[1], said)

    def test_a_cut_log_line_counts_what_shows_of_its_code_spans(self):
        view = lambda log: {'outcome': 'arm-missing', 'jobs': 2, 'detail': {'share': 1, 'arm': 'after', 'log': log}}
        whole = cv.could_not(view('q'), 1000)[0]
        lead = whole[:-len(' (its last log line: q).')]
        line = lead + " (its last log line's first 14 of 311 characters: see ` a ` here www)."
        self.assertEqual(cv.could_not(view('see ` a ` here ' + 'w' * 300), len(line)), [line])

    def test_a_cut_quote_counts_its_control_characters_as_they_show(self):
        change = {'title': 't', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'ab\x07cd\x1b[0m' + 'e' * 400, 'after': '',
                  'place': {'run': 'H1/W1', 'step': 1}}
        text = cv.change_block(change, {'aaaaaaaaaaaa': {'places': [{'run': 'H1/W1', 'step': 1}]}}, 'H1/W1', 'H1/W1', 300)
        cut = re.search(r"Before, its first ([0-9,]+) of ([0-9,]+) characters:\n\n```text\n(.*?)\n```", text, re.S)
        self.assertEqual((int(cut[1]), int(cut[2])), (len(cut[3]), 415), text)
        self.assertTrue(cut[3].startswith('ab\\x07cd\\x1b[0m'), cut[3])
        self.assertLessEqual(len(text), 300)

    def test_a_reason_with_room_for_none_of_its_characters_still_says_it_was_cut(self):
        view = {'outcome': 'ran', 'broken': [{'run': 'H1/W1', 'what': 'head', 'reason': 'x' * 100}]}
        zero = "This head couldn't be compared at `H1/W1`: the head couldn't run it (the reason's first 0 of 100 characters)."
        self.assertEqual(cv.could_not(view, len(zero) + 2), [zero])

    def test_differing_records_show_the_readers_account_and_each_change_under_each_run_counted_from_its_entries_places(self):
        text = self.comment(self.changed_run(), self.reader())
        self.assertIn("The records of 2 of the 3 runs differ between the base and this head.\n\n*A model's account of those records:*", text)
        self.assertIn('- base (`main`): It changes the order of requests `@maintainer`\\, `#3`.\n- head (`aaaaaaaaaaaa`): The summariser gets '
                      'merge requests first.\n\n<details>', text)
        self.assertIn('<details><summary><code>H1/W1</code>: 1 change</summary>\n\n*Merges go first*\n\n'
                      'At 2 steps; the quotes are from step `7`.\n\nBefore:\n\n'
                      '````text\ncall 1 ```x``` </details>\n````\n\nAfter: none.\n\n</details>', text)
        self.assertIn('<details><summary><code>H1/W2</code>: 1 change</summary>\n\n*Merges go first*\n\n'
                      'At step `4`. Its before and after are quoted under `H1/W1`, at step `7`.'
                      '\n\n</details>', text)

    def test_a_change_title_is_escaped_with_references_in_code_and_reaches_github_inert(self):
        text = self.comment(self.changed_run(), self.reader(title='Old </summary><img src=x> by @antra-tess in #12'))
        self.assertIn('\n\n*Old \\<\\/summary\\>\\<img src\\=x\\> by `@antra-tess` in `#12`*\n\n', text)
        self.assertNotIn('<img src=x>', text)
        text = self.comment(self.changed_run(), self.reader(title='Says :smile: at $x$'))
        self.assertIn('\n\n*Says `:smile:` at `$`x`$`*\n\n', text)

    def test_a_change_naming_an_entry_the_view_doesnt_have_fails_rather_than_posting(self):
        d = self.changed_run()
        with self.assertRaisesRegex(pr_review.Failed, 'entries the view doesn.t have'):
            self.comment(d, self.reader('aaaaaaaaaaaa', 'cccccccccccc'))
        with self.assertRaisesRegex(pr_review.Failed, 'entries the view doesn.t have'):
            self.post(d, self.reader('aaaaaaaaaaaa', 'cccccccccccc'))
        self.assertEqual([c for c in self.gh.calls if c[0] != 'GET'], [])
        self.assertEqual(self.gh.comments, [])

    def test_a_change_naming_no_entry_fails_saying_so(self):
        d = self.changed_run()
        reader = self.reader()
        reader['changes'][0]['refs'] = []
        with self.assertRaisesRegex(pr_review.Failed, "names no entry"):
            self.comment(d, reader)

    def test_differing_records_without_a_reader_account_or_a_reader_account_without_them_fail(self):
        with self.assertRaisesRegex(pr_review.Failed, 'needs the reader account'):
            self.comment(self.changed_run())
        with self.assertRaisesRegex(pr_review.Failed, 'has no reader account'):
            self.comment(self.unchanged_run(), self.reader())
        broken = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2'), result('C6h/W11')], [])])
        with self.assertRaisesRegex(pr_review.Failed, "could compare don't differ has no reader account"):
            self.comment(broken, self.reader('aaaaaaaaaaaa'))

    def test_a_flag_new_on_the_head_or_gone_from_it_is_listed(self):
        flags = {'new': [{'check': 11, 'step': '232330.9', 'what': 'a pin @x moved', 'detail': ''}],
                 'gone': [{'check': 1, 'step': 'the run', 'detail': 'judged none of coverage'}], 'kept': [{'check': 4, 'step': 'kk', 'detail': 'kept alike'}]}
        d = self.run_dir([([result('H1/W1', flags=flags), result('H1/W2'), result('C6h/W11')], [])])
        text = self.comment(d)
        self.assertIn("The checks' flags that differ between base and head:\n\n- `H1/W1` step `232330.9`, check `11` flagged on the head 1 more time than "
                      'on the base: a pin `@x` moved\n\n- `H1/W1`, check `1` flagged on the base 1 more time than on the head: judged none of coverage', text)
        self.assertNotIn('kept alike', text)


    def test_a_change_too_long_for_a_comment_with_no_quote_to_cut_fails_saying_so(self):
        d = self.changed_run()
        self.facts(d)
        reader = {'changes': [{'title': 'ab ' * 24_000, 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': '', 'after': ''}]}
        try:
            self.post(d, reader, post=False)
            raised = None
        except Exception as e:
            raised = e
        self.assertIsInstance(raised, pr_review.Failed)
        self.assertIn('has no quote to cut', str(raised))

class Posting(Steps):
    def claiming(self, head):
        return [b for b in self.bodies() if f' head:{head} result:' in b]

    def test_a_head_returned_to_through_two_others_ends_with_one_comment_claiming_it(self):
        for back in (H2, H1):
            with self.subTest(back=back):
                self.gh.comments.clear()
                for run, reader in ((self.unchanged_run(head=H1), None), (self.unchanged_run(head=H2), None),
                                    (self.changed_run(head=H3), self.reader())):
                    self.facts(run)
                    self.post(run, reader)
                again = self.unchanged_run(head=back)
                self.facts(again)
                self.post(again)
                self.assertEqual(self.claiming(back), [self.bodies()[-1]])
                marks = [cv.MARK.search(b).groupdict() for b in self.bodies()]
                heads = [m['head'] for m in marks if m['head']]
                self.assertEqual(len(heads), len(set(heads)))
                parts = [(m['first'], m['result'], m['part']) for m in marks]
                self.assertEqual(len(parts), len(set(parts)))

    def test_a_head_run_again_behind_a_later_comment_posts_its_comment_afresh_at_the_bottom_however_many_parts(self):
        d = self.changed_run()
        self.facts(d)
        self.post(d, self.reader())
        other = self.unchanged_run(head=H2)
        self.facts(other)
        self.post(other)
        self.facts(d)
        self.assertEqual(self.post(d, self.four('Omega'))['action'], 'posted')
        mine = [b for b in self.bodies() if f'first:{H1}' in b]
        self.assertGreater(len(mine), 1)
        self.assertEqual(self.bodies()[-len(mine):], mine)
        self.assertNotIn('It changes the order of requests', ''.join(mine))
        self.assertEqual(len(self.claiming(H1)), 1)

    def test_continuations_whose_first_part_is_gone_go_when_a_view_posts(self):
        d = self.changed_run()
        self.facts(d)
        self.post(d, self.four('Alpha'))
        del self.gh.comments[0]
        later = self.unchanged_run(head=H2)
        self.facts(later)
        self.post(later)
        self.assertEqual(len(self.gh.comments), 1)
        self.assertFalse(any('Alpha' in b for b in self.bodies()))

    def test_a_kept_comments_first_line_says_where_the_head_is_now_each_time_its_kept(self):
        d = self.unchanged_run()
        self.facts(d)
        self.post(d)
        self.gh.head = H3
        self.assertEqual(self.post(d)['action'], 'edited')
        self.assertIn(f"The pull request's head has since moved to `{H3[:12]}`.", self.bodies()[0].split('\n\n')[0])
        self.gh.head = H1
        self.assertEqual(self.post(d)['action'], 'edited')
        self.assertNotIn('has since moved', self.bodies()[0])
        self.assertEqual(self.post(d)['action'], 'unchanged')
        self.assertEqual(len(self.gh.comments), 1)

    def test_comments_past_the_first_page_are_found_and_cleaned_up(self):
        self.gh.next_id = 1000
        self.gh.comments += [{'id': i, 'body': 'chatter', 'performed_via_github_app': None} for i in range(1, 151)]
        self.assertEqual(cv.stopped({'repo': REPO, 'number': 5, 'head': H1})['action'], 'posted')
        d = self.unchanged_run()
        self.facts(d)
        self.assertEqual(self.post(d)['action'], 'posted')
        self.assertEqual(self.post(d)['action'], 'unchanged')
        ours = [c['body'] for c in self.gh.comments if c.get('performed_via_github_app')]
        self.assertEqual(len(ours), 1)
        self.assertNotIn('stopped before it finished', ours[0])

    def test_a_replacement_that_fails_to_post_leaves_the_view_it_would_replace(self):
        a = self.unchanged_run()
        self.facts(a)
        self.post(a)
        before = self.bodies()
        b = self.changed_run()
        self.facts(b)
        api = self.gh.api

        posts = []

        def failing(method, path, *args, **kw):
            if method == 'POST':
                posts.append(path)
                raise pr_review.Failed(f'GitHub answered 422 to POST {path}')
            return api(method, path, *args, **kw)
        with mock.patch.object(pr_review, 'api', failing):
            with self.assertRaises(pr_review.Failed):
                self.post(b, self.reader())
        self.assertEqual(len(posts), 1)
        self.assertEqual(self.bodies(), before)

    def test_a_dry_post_leaves_no_part_of_an_earlier_longer_one(self):
        d = self.changed_run()
        self.facts(d)
        self.assertGreater(self.post(d, self.four('Alpha'), post=False)['parts'], 1)
        self.assertEqual(self.post(d, self.reader(), post=False)['parts'], 1)
        self.assertEqual(sorted(n for n in os.listdir(d) if n.startswith('comment')), ['comment.md'])

    def test_a_new_result_posts_one_comment_that_ends_with_its_marker(self):
        d = self.unchanged_run()
        self.facts(d)
        out = self.post(d)
        self.assertEqual(out['action'], 'posted')
        [body] = self.bodies()
        self.assertRegex(body, rf'<!-- context-view:first:{H1} head:{H1} result:[0-9a-f]{{64}} -->\Z')

    def test_the_same_head_again_posts_nothing_new(self):
        d = self.unchanged_run()
        self.facts(d)
        self.post(d)
        self.assertEqual(self.post(d)['action'], 'unchanged')
        self.assertEqual(len(self.gh.comments), 1)

    def test_a_later_head_with_the_same_result_edits_the_first_line_and_marker_and_posts_nothing(self):
        first = self.unchanged_run()
        self.facts(first)
        self.post(first)
        self.gh.head = H2
        later = self.unchanged_run(head=H2)
        self.facts(later)
        out = self.post(later)
        self.assertEqual(out['action'], 'edited')
        [body] = self.bodies()
        self.assertTrue(body.startswith(f"**Automatic context view** of `{H2[:12]}` merged onto `{BASE[:12]}`. Its runs show no "
                                        f"difference from the base, as at `{H1[:12]}`, where this comment was first posted.\n\n"))
        self.assertRegex(body, rf'first:{H1} head:{H2} result:')
        self.assertEqual(body.count("don't differ between the base and this head"), 1)

    def test_an_edit_says_what_held_at_the_first_head_in_the_words_of_its_kind(self):
        cases = [(lambda h: self.changed_run(head=h), self.reader(), "Its runs show the same differences from the base as at"),
                 (lambda h: self.run_dir([([], [])], head=h, outcome='doesnt-merge'), None,
                  "It couldn't be compared for the same reasons as at")]
        for make, reader, said in cases:
            with self.subTest(said):
                self.gh.comments.clear()
                first = make(H1)
                self.facts(first)
                self.post(first, reader)
                later = make(H2)
                self.facts(later)
                self.assertEqual(self.post(later, reader)['action'], 'edited')
                self.assertIn(f"{said} `{H1[:12]}`, where this comment was first posted.", self.bodies()[0].split('\n\n')[0])

    def test_a_view_with_differences_and_runs_it_couldnt_compare_says_both_and_its_edit_says_both_held(self):
        def run(head):
            e = [entry('aaaaaaaaaaaa', ('H1/W1', 7))]
            return self.run_dir([([result('H1/W1', record='differs'), result('H1/W2', record='missing'), result('C6h/W11')], e)], head=head)
        a = run(H1)
        self.assertTrue(cv.facts({'dir': a, 'repo': REPO})['changed'])
        reader = self.reader('aaaaaaaaaaaa')
        try:
            self.post(a, reader)
        except pr_review.Failed as e:
            self.fail(f"the reader's account of the runs it could compare was refused: {e}")
        b = run(H2)
        self.facts(b)
        self.assertEqual(self.post(b, reader)['action'], 'edited')
        [body] = self.bodies()
        self.assertIn("The records of 1 of the 2 runs it could compare differ between the base and this head.\n\n1 run couldn't be "
                      "compared; its reason is below.\n\n*A model's account of those records:*", body)
        self.assertLess(body.index('<summary>Runs whose records differ: 1 of 2, with 1 change</summary>'),
                        body.index("<summary>Runs that couldn&#x27;t be compared (1)</summary>\n\nThis head couldn't be compared at `H1/W2`: "
                                   "the base couldn't run it.\n\n</details>"))
        self.assertIn(f"Its runs show the same differences from the base, and couldn't be compared at the same runs for the same reasons, "
                      f"as at `{H1[:12]}`, where this comment was first posted.", body.split('\n\n')[0])
        self.assertIn("couldn't be compared at `H1/W2`: the base couldn't run it.", body)
        self.assertIn('The records of 1 of the 2 runs it could compare differ between the base and this head.', body)

    def test_an_edit_at_a_later_head_keeps_the_head_lines_of_the_head_its_first_line_says_it_was_first_posted_at(self):
        first = self.changed_run(head=H1)
        self.facts(first)
        self.post(first, self.reader())
        later = self.changed_run(head=H2)
        self.facts(later)
        self.assertEqual(self.post(later, self.reader())['action'], 'edited')
        [body] = self.bodies()
        self.assertIn(f"as at `{H1[:12]}`, where this comment was first posted.", body.split('\n\n')[0])
        self.assertIn(f"- head (`{H1[:12]}`): The summariser gets merge requests first.", body)
        self.assertNotIn(f"`{H2[:12]}`): ", body)

    def test_a_later_head_with_another_result_posts_a_new_comment(self):
        first = self.unchanged_run()
        self.facts(first)
        self.post(first)
        later = self.changed_run(head=H2)
        self.facts(later)
        self.assertEqual(self.post(later, self.reader())['action'], 'posted')
        self.assertEqual(len(self.gh.comments), 2)

    def test_the_same_entries_with_the_readers_prose_written_again_are_the_same_result(self):
        a = self.changed_run()
        self.facts(a)
        self.post(a, self.reader())
        b = self.changed_run(head=H2)
        self.facts(b)
        self.assertEqual(self.post(b, self.reader(head='Worded otherwise'))['action'], 'edited')

    def test_an_example_that_reads_otherwise_is_another_result_so_a_comment_never_quotes_another_heads_text(self):
        a = self.changed_run()
        self.facts(a)
        self.post(a, self.reader())
        b = self.changed_run(head=H2, after='other new text')
        self.facts(b)
        self.assertEqual(self.post(b, self.reader())['action'], 'posted')

    def test_a_difference_at_a_later_place_of_an_entry_is_another_result_though_its_example_reads_the_same(self):
        def run(head, second):
            e = entry('aaaaaaaaaaaa', ('H1/W1', 7), ('H1/W2', 4))
            e['places'] = [{**e['places'][0], 'digest': '111111111111'}, {**e['places'][1], 'digest': second}]
            return self.run_dir([([result('H1/W1', record='differs'), result('H1/W2', record='differs'), result('C6h/W11')], [e])],
                                head=head)
        a = run(H1, '222222222222')
        self.facts(a)
        self.post(a, self.reader('aaaaaaaaaaaa'))
        b = run(H2, '333333333333')
        self.facts(b)
        self.assertEqual(self.post(b, self.reader('aaaaaaaaaaaa'))['action'], 'posted')

    def test_an_arm_missing_whose_job_count_changed_is_another_result(self):
        detail = {'share': 1, 'arm': 'after', 'log': None}
        a = self.run_dir([([], []), ([], [])], outcome='arm-missing', detail=detail)
        self.facts(a)
        self.post(a)
        b = self.run_dir([([], []), ([], []), ([], [])], head=H2, outcome='arm-missing', detail=detail)
        self.facts(b)
        self.assertEqual(self.post(b)['action'], 'posted')

    def test_a_description_edited_between_heads_gets_a_fresh_account_where_the_reader_runs_and_an_edit_where_it_doesnt(self):
        a = self.changed_run()
        self.facts(a)
        self.post(a, self.reader())
        self.gh.pull['body'] = 'It changes <b>that</b> now.'
        b = self.changed_run(head=H2)
        self.facts(b)
        self.assertEqual(self.post(b, self.reader())['action'], 'posted')
        self.gh.comments.clear()
        c = self.unchanged_run(head=H1)
        self.facts(c)
        self.post(c)
        self.gh.pull['body'] = 'Edited again.'
        d = self.unchanged_run(head=H2)
        self.facts(d)
        self.assertEqual(self.post(d)['action'], 'edited')

    def test_a_first_comment_full_to_its_room_still_takes_the_longest_first_line_an_edit_can_give_it(self):
        longest = (f"**Automatic context view** of `{'f' * 12}` merged onto `{BASE[:12]}`. Its runs show the same differences from the "
                   f"base as at `{'0' * 12}`, where this comment was first posted. The pull request's head has since moved to `{'e' * 12}`.")
        d = self.changed_run()
        self.facts(d)
        filled = 0
        for size in range(63_000, 65_536, 37):
            reader = {'changes': [{'title': 'C', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'x' * size, 'after': ''}]}
            try:
                self.post(d, reader, post=False)
            except pr_review.Failed:
                continue
            with open(os.path.join(d, 'comment.md')) as f:
                first = f.read()
            filled = max(filled, len(first))
            self.assertLessEqual(len(first) - len(first.split('\n\n')[0]) + len(longest), pr_comment.COMMENT_MAX, size)
        self.assertGreater(filled, pr_comment.COMMENT_MAX - 300)

    def test_a_later_head_whose_host_or_base_moved_posts_afresh_since_the_body_names_them(self):
        for field, value in (('host', {'sha': '1' * 40}), ('base', {'ref': 'main', 'sha': '2' * 40}),
                             ('harness', {'repo': 'anima-research/context-view', 'sha': '3' * 40})):
            self.gh.comments.clear()
            first = self.unchanged_run()
            self.facts(first)
            self.post(first)
            later = self.unchanged_run(head=H2)
            m = pr_review.read_json(os.path.join(later, 'manifest.json'))
            m[field] = value
            pr_review.write_json(os.path.join(later, 'manifest.json'), m)
            self.facts(later)
            self.assertEqual(self.post(later)['action'], 'posted', field)
            self.assertEqual(len(self.gh.comments), 2, field)

    def test_a_partial_comment_from_an_earlier_head_is_posted_again_whole_rather_than_edited(self):
        long = 'x' * 20_000
        reader = {'changes': [{'title': f'C{i}', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': long, 'after': long}
                                               for i in range(4)]}
        d = self.changed_run()
        self.facts(d)
        self.post(d, reader)
        parts = len(self.gh.comments)
        del self.gh.comments[-1]
        later = self.changed_run(head=H2)
        self.facts(later)
        self.assertEqual(self.post(later, reader)['action'], 'posted')
        self.assertEqual(len(self.gh.comments), parts)
        self.assertTrue(all(f'first:{H2}' in b for b in self.bodies()))

    def test_another_result_at_the_same_head_replaces_the_comment_so_a_head_has_one(self):
        a = self.unchanged_run()
        self.facts(a)
        self.post(a)
        b = self.changed_run()
        self.facts(b)
        self.assertEqual(self.post(b, self.reader())['action'], 'posted')
        self.assertEqual(len(self.bodies()), 1)
        self.assertIn('runs differ between the base and this head.', self.bodies()[0])

    def test_a_comment_the_post_couldnt_delete_after_posting_is_named_and_the_post_still_answers_posted(self):
        a = self.unchanged_run()
        self.facts(a)
        self.post(a)
        [old] = self.gh.comments
        self.gh.undeletable.add(old['id'])
        b = self.changed_run()
        self.facts(b)
        try:
            answer = self.post(b, self.reader())
        except pr_review.Failed as e:
            self.fail(f'a refused delete after the post failed the step: {e}')
        self.assertEqual(answer['action'], 'posted')
        self.assertIn('staleKept', answer)
        self.assertEqual(len(answer['staleKept']), 1)
        self.assertIn(old['html_url'], answer['staleKept'][0])
        self.assertIn('runs differ between the base and this head.', self.bodies()[-1])

    def test_a_quote_on_one_side_too_long_for_a_comment_is_cut_to_fit(self):
        d = self.changed_run()
        self.facts(d)
        try:
            self.post(d, {'changes': [{'title': 'C', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b' * 70_000,
                                                         'after': ''}]})
        except pr_review.Failed as e:
            self.fail(f'no comment for a one-sided long quote: {e}')
        self.assertTrue(all(len(b) <= pr_comment.COMMENT_MAX for b in self.bodies()))
        self.assertIn('Before, its first', ''.join(self.bodies()))

    def test_a_pull_request_closed_or_merged_gets_nothing(self):
        d = self.unchanged_run()
        self.facts(d)
        self.gh.state = 'closed'
        self.assertEqual(self.post(d)['action'], 'closed')
        self.assertEqual(self.gh.comments, [])

    def test_a_head_that_moved_before_its_run_posts_nothing(self):
        d = self.run_dir([], outcome='moved', detail={'headNow': H2})
        self.facts(d)
        self.assertEqual(self.post(d)['action'], 'moved')
        self.assertEqual(self.gh.comments, [])

    def test_a_head_that_moved_after_its_run_says_so_in_its_first_line(self):
        d = self.unchanged_run()
        self.facts(d)
        self.gh.head = H3
        self.post(d)
        self.assertIn(f"The pull request's head has since moved to `{H3[:12]}`.", self.bodies()[0].split('\n\n')[0])

    def stopped_heads(self):
        return [m['stopped'] for m in (cv.MARK.search(b) for b in self.bodies()) if m and m['stopped']]

    def test_a_heads_stopped_words_are_deleted_once_its_view_posts_and_once_it_edits(self):
        cv.stopped({'repo': REPO, 'number': 5, 'head': H1})
        self.assertEqual(self.stopped_heads(), [H1])
        d = self.unchanged_run()
        self.facts(d)
        self.assertEqual(self.post(d)['action'], 'posted')
        self.assertEqual(self.stopped_heads(), [])
        self.gh.head = H2
        self.assertEqual(cv.stopped({'repo': REPO, 'number': 5, 'head': H2})['action'], 'posted')
        self.assertEqual(self.stopped_heads(), [H2])
        later = self.unchanged_run(head=H2)
        self.facts(later)
        self.assertEqual(self.post(later)['action'], 'edited')
        self.assertEqual(self.stopped_heads(), [])
        self.assertEqual(len(self.gh.comments), 1)

    def test_a_view_leaves_another_heads_stopped_words_so_a_newer_heads_failure_stays_said(self):
        cv.stopped({'repo': REPO, 'number': 5, 'head': H1})
        self.gh.head = H2
        self.assertEqual(cv.stopped({'repo': REPO, 'number': 5, 'head': H2})['action'], 'posted')
        d = self.unchanged_run()
        self.facts(d)
        self.assertEqual(self.post(d)['action'], 'posted')
        self.assertEqual(self.stopped_heads(), [H2])

    def test_a_posting_that_fails_partway_deletes_the_parts_that_went_up_and_fails_the_step(self):
        d = self.changed_run()
        self.facts(d)
        self.gh.posts_fail_after = 1
        with self.assertRaisesRegex(pr_review.Failed, r'502 .*; the parts of its comment the pull request then listed are deleted'):
            self.post(d, self.four('Alpha'))
        self.assertEqual(self.gh.comments, [])

    def test_a_posting_github_answers_with_text_that_isnt_json_deletes_the_parts_that_went_up_too(self):
        d = self.changed_run()
        self.facts(d)
        answer = self.gh.api

        def garbled(method, path, *args, **kwargs):
            out = answer(method, path, *args, **kwargs)
            if method == 'POST' and self.gh.posts == 2:
                raise json.JSONDecodeError('Expecting value', '<html>', 0)
            return out
        with mock.patch.object(pr_review, 'api', garbled), contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(Exception) as raised:
            self.post(d, self.four('Alpha'))
        self.assertIsInstance(raised.exception, pr_review.Failed)
        self.assertRegex(str(raised.exception), r"^JSONDecodeError: Expecting value: .*; the parts of its comment the pull request "
                                                r"then listed are deleted$")
        self.assertEqual(self.gh.comments, [])

    def test_a_cleanup_whose_listing_isnt_json_says_so_beside_the_posting_failure(self):
        d = self.changed_run()
        self.facts(d)
        self.gh.posts_fail_after = 1
        listing = cv.on_pull
        calls = []

        def garbled(*args):
            calls.append(args)
            if len(calls) == 2:
                raise json.JSONDecodeError('Expecting value', '<html>', 0)
            return listing(*args)
        with mock.patch.object(cv, 'on_pull', garbled), contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(Exception) as raised:
            self.post(d, self.four('Alpha'))
        self.assertIsInstance(raised.exception, pr_review.Failed)
        self.assertRegex(str(raised.exception), r'^GitHub answered 502 .*; deleting the parts of its comment that went up failed too: '
                                                r'JSONDecodeError: Expecting value')
        self.assertEqual(len(calls), 2)

    def test_a_fault_of_the_steps_own_in_the_cleanup_prints_where_it_is_and_still_ends_with_the_verdict(self):
        d = self.changed_run()
        self.facts(d)
        self.gh.posts_fail_after = 1
        listing = cv.on_pull
        calls = []

        def broken(*args):
            calls.append(args)
            if len(calls) == 2:
                raise TypeError("'NoneType' object is not subscriptable")
            return listing(*args)
        err = io.StringIO()
        with mock.patch.object(cv, 'on_pull', broken), contextlib.redirect_stderr(err), \
                self.assertRaises(Exception) as raised:
            self.post(d, self.four('Alpha'))
        self.assertIsInstance(raised.exception, pr_review.Failed)
        self.assertRegex(str(raised.exception), r"^GitHub answered 502 .*; deleting the parts of its comment that went up failed too: "
                                                r"TypeError: 'NoneType' object is not subscriptable$")
        self.assertRegex(err.getvalue(), r"(?s)^Traceback .*in broken\n.*TypeError: 'NoneType' object is not subscriptable\n$")

    def test_a_cleanup_tries_every_part_and_names_each_still_there(self):
        d = self.changed_run()
        self.facts(d)
        self.gh.posts_fail_after = 3
        first, third = self.gh.next_id + 1, self.gh.next_id + 3
        self.gh.undeletable |= {first, third}
        with self.assertRaises(pr_review.Failed) as raised:
            self.post(d, self.four('Alpha'))
        self.assertEqual([c['id'] for c in self.gh.comments], [first, third])
        said = str(raised.exception)
        self.assertIn(f'#issuecomment-{first} may still be there', said)
        self.assertIn(f'#issuecomment-{third} may still be there', said)

    def test_a_posting_that_fails_partway_and_whose_parts_cant_be_deleted_says_which_is_still_there(self):
        d = self.changed_run()
        self.facts(d)
        self.gh.posts_fail_after = 1
        self.gh.undeletable.add(self.gh.next_id + 1)
        with self.assertRaisesRegex(pr_review.Failed, rf'deleting the parts of its comment that went up failed too: \S+#issuecomment-'
                                                      rf'{self.gh.next_id + 1} may still be there'):
            self.post(d, self.four('Alpha'))

    def test_a_chain_left_partly_deleted_is_named_by_the_first_part_still_there(self):
        d = self.changed_run()
        self.facts(d)
        self.post(d, self.four('Alpha'))
        first, second = self.gh.comments[0], self.gh.comments[1]
        self.gh.undeletable.add(second['id'])
        other = self.unchanged_run()
        self.facts(other)
        answer = self.post(other)
        self.assertEqual(answer['action'], 'posted')
        self.assertEqual(len(answer['staleKept']), 1)
        self.assertTrue(answer['staleKept'][0].startswith(f"{second['html_url']} may still be there"))
        self.assertNotIn(first, self.gh.comments)

    def test_a_comment_too_long_for_one_is_posted_as_parts_each_under_githubs_limit(self):
        long = 'x' * 20_000
        changes = [{'title': f'Change {i}', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': long, 'after': long} for i in range(4)]
        d = self.changed_run()
        self.facts(d)
        self.post(d, {'changes': changes})
        bodies = self.bodies()
        self.assertGreater(len(bodies), 1)
        self.assertTrue(all(len(b) <= pr_comment.COMMENT_MAX for b in bodies))
        self.assertTrue(all(b.rstrip().endswith(':%d -->' % k) for k, b in enumerate(bodies[1:], 2)))
        self.assertTrue(bodies[0].split('\n\n')[-2] == pr_comment.MORE and bodies[-1].split('\n\n')[-2] != pr_comment.MORE)

    def test_a_comment_whose_posting_stopped_partway_is_posted_again_whole_from_the_run_started_again(self):
        long = 'x' * 20_000
        said = lambda word: {'changes': [{'title': f'C{i}', 'where': word, 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': long,
                                                            'after': long} for i in range(4)]}
        d = self.changed_run()
        self.facts(d)
        self.post(d, said('Alpha'))
        parts = len(self.gh.comments)
        del self.gh.comments[1:]
        self.post(d, said('Omega'))
        self.assertEqual(len(self.gh.comments), parts)
        self.assertFalse(any('Alpha' in b for b in self.bodies()))

    def test_a_quote_too_long_for_a_comment_shows_its_first_characters_and_says_how_many_of_how_many(self):
        d = self.changed_run()
        self.facts(d)
        try:
            self.post(d, {'changes': [{'title': 'C', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b' * 100_000,
                                                         'after': 'a' * 30}]})
        except pr_review.Failed as e:
            self.fail(f'no comment for a change with a long quote: {e}')
        self.assertTrue(all(len(b) <= pr_comment.COMMENT_MAX for b in self.bodies()))
        text = ''.join(self.bodies())
        shown = re.search(r'Before, its first ([0-9,]+) of 100,000 characters:\n\n```text\n(b+)\n```', text)
        self.assertIsNotNone(shown)
        self.assertEqual(int(shown[1].replace(',', '')), len(shown[2]))
        self.assertIn('After:\n\n```text\n' + 'a' * 30 + '\n```', text)

    def test_a_long_quote_full_of_backtick_runs_is_cut_until_its_longer_fences_fit(self):
        d = self.changed_run()
        self.facts(d)
        quote = ('x' + '`' * 300) * 300
        try:
            self.post(d, {'changes': [{'title': 'C', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': quote, 'after': quote}]})
        except pr_review.Failed as e:
            self.fail(f'no comment for a quote of backtick runs: {e}')
        self.assertTrue(all(len(b) <= pr_comment.COMMENT_MAX for b in self.bodies()))

    def test_a_comment_edited_to_a_head_is_unchanged_at_it_and_edited_back_at_its_first(self):
        first = self.unchanged_run()
        self.facts(first)
        self.post(first)
        later = self.unchanged_run(head=H2)
        self.facts(later)
        self.post(later)
        self.assertEqual(self.post(later)['action'], 'unchanged')
        self.facts(first)
        self.assertEqual(self.post(first)['action'], 'edited')
        [body] = self.bodies()
        self.assertTrue(body.startswith(f'**Automatic context view** of `{H1[:12]}` merged onto `{BASE[:12]}`.\n\n'))
        self.assertRegex(body, rf'first:{H1} head:{H1} result:')

    def test_a_one_part_comment_full_to_its_room_takes_the_longest_first_line_and_marker_an_edit_can_give_it(self):
        longest = (f"**Automatic context view** of `{'f' * 12}` merged onto `{BASE[:12]}`. Its runs show the same differences from the "
                   f"base as at `{'0' * 12}`, where this comment was first posted. The pull request's head has since moved to `{'e' * 12}`.")
        d = self.changed_run()
        self.facts(d)

        def parts(size):
            reader = {'changes': [{'title': 'C', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'y' * size, 'after': ''}]}
            self.post(d, reader, post=False)
            return 1 + sum(os.path.exists(os.path.join(d, f'comment-{n}.md')) for n in (2, 3))
        lo, hi = 1, 70_000
        while lo < hi:
            mid = (lo + hi + 1) // 2
            lo, hi = (mid, hi) if parts(mid) == 1 and 'its first' not in read_file(os.path.join(d, 'comment.md')) else (lo, mid - 1)
        parts(lo)
        with open(os.path.join(d, 'comment.md')) as f:
            first = f.read()
        self.assertLessEqual(len(first) - len(first.split('\n\n')[0]) + len(longest), pr_comment.COMMENT_MAX)

    def test_an_edit_still_holds_the_reader_account_to_the_view(self):
        d = self.changed_run()
        self.facts(d)
        self.assertEqual(self.post(d, self.reader())['action'], 'posted')
        self.assertEqual(len(self.gh.comments), 1)
        later = self.changed_run(head=H2)
        self.facts(later)
        before, calls = self.bodies(), len(self.gh.calls)
        with self.assertRaisesRegex(pr_review.Failed, "entries the view doesn.t have"):
            self.post(later, self.reader('aaaaaaaaaaaa', 'cccccccccccc'))
        self.assertEqual(self.bodies(), before)
        self.assertEqual([c for c in self.gh.calls[calls:] if c[0] != 'GET'], [])
        self.assertEqual(self.post(later, self.reader())['action'], 'edited')

    def test_a_partial_comment_at_this_head_behind_a_later_one_is_posted_again_whole(self):
        long = 'x' * 20_000
        said = lambda word: {'changes': [{'title': f'C{i}', 'where': word, 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': long,
                                                            'after': long} for i in range(4)]}
        reader = said('Omega')
        d = self.changed_run()
        self.facts(d)
        self.post(d, said('Alpha'))
        parts = len(self.gh.comments)
        other = self.unchanged_run(head=H2)
        self.facts(other)
        self.post(other)
        del self.gh.comments[parts - 1]
        self.facts(d)
        self.post(d, reader)
        mine = [b for b in self.bodies() if f'first:{H1}' in b]
        self.assertEqual(len(mine), parts)
        self.assertFalse(any('Alpha' in b for b in mine))
        self.assertFalse(mine[-1].split('\n\n')[-2] == pr_comment.MORE)

    def test_a_dry_run_writes_the_comment_and_touches_no_pull_request(self):
        d = self.unchanged_run()
        self.facts(d)
        calls = len(self.gh.calls)
        self.assertEqual(self.post(d, post=False)['action'], 'dry')
        self.assertEqual(self.gh.calls[calls:], [])
        self.assertTrue(os.path.exists(os.path.join(d, 'comment.md')))


class Stopped(Steps):
    def test_the_stopped_words_post_once_for_a_head_and_name_it(self):
        out = cv.stopped({'repo': REPO, 'number': 5, 'head': H1})
        self.assertEqual(out['action'], 'posted')
        again = cv.stopped({'repo': REPO, 'number': 5, 'head': H1})
        self.assertEqual((again['action'], again.get('found'), again['url']), ('unchanged', 'stopped', out['url']))
        self.assertEqual(self.bodies(), [f'**Automatic context view** of `{H1[:12]}` stopped before it finished, so it has nothing to '
                                         'report.\n\nWhat a context view runs and what its checks judge are in '
                                         '[CHECKS.md](https://github.com/anima-research/context-view/blob/main/CHECKS.md).\n\n'
                                         f'<!-- context-view:stopped:{H1} -->'])

    def test_a_view_whose_parts_didnt_all_post_is_replaced_by_the_stopped_words(self):
        d = self.changed_run()
        self.facts(d)
        self.post(d, self.four('Alpha'))
        del self.gh.comments[1:]
        self.assertEqual(cv.stopped({'repo': REPO, 'number': 5, 'head': H1})['action'], 'posted')
        self.assertEqual(len(self.bodies()), 1)
        self.assertIn('stopped before it finished', self.bodies()[0])

    def test_a_view_already_posted_at_the_head_gets_no_stopped_words_beside_it_and_is_named_as_a_view(self):
        d = self.unchanged_run()
        self.facts(d)
        posted = self.post(d)
        out = cv.stopped({'repo': REPO, 'number': 5, 'head': H1})
        self.assertEqual((out['action'], out.get('found'), out['url']), ('unchanged', 'view', posted['url']))
        self.assertEqual(len(self.gh.comments), 1)

    def test_a_pull_request_whose_head_moved_gets_no_stopped_words_for_the_head_it_left(self):
        self.gh.head = H2
        self.assertEqual(cv.stopped({'repo': REPO, 'number': 5, 'head': H1}), {'action': 'moved', 'headNow': H2})
        self.assertEqual(self.gh.comments, [])

    def test_a_closed_pull_request_gets_no_stopped_words(self):
        self.gh.state = 'closed'
        self.assertEqual(cv.stopped({'repo': REPO, 'number': 5, 'head': H1})['action'], 'closed')
        self.assertEqual(self.gh.comments, [])

    def test_a_repository_outside_the_four_is_refused(self):
        with self.assertRaises(pr_review.NotARequest):
            cv.stopped({'repo': 'anima-research/lode', 'number': 5, 'head': H1})
        d = self.unchanged_run()
        self.facts(d)
        view = pr_review.read_json(os.path.join(d, 'view.json'))
        pr_review.write_json(os.path.join(d, 'view.json'), {**view, 'repo': 'anima-research/lode'})
        with self.assertRaises(pr_review.NotARequest):
            self.post(d)


class Rooms(unittest.TestCase):
    def test_the_rooms_step_answers_as_the_reviews_rooms_do_on_one_json_line(self):
        rooms = {rid: {'id': rid, 'tender': {'effective': {'kind': 'colleague', 'agentId': f'{rid}-tender'}}}
                 for rid in (pr_review.COVERED_ROOM, pr_review.WORKFLOW_ROOM)}

        def commons(operation, given):
            if operation == 'list_agents':
                return {'items': [{'id': f'{rid}-tender', 'reference': f'Tender-{n}'} for n, rid in enumerate(sorted(rooms))]}
            self.assertEqual(operation, 'list_rooms')
            return {'rooms': [rooms[given['room']]], 'destinations': []}
        with mock.patch.object(pr_review, 'commons', commons), mock.patch('sys.stdin', io.StringIO('{}')), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cv.main(['rooms']), 0)
        with mock.patch.object(pr_review, 'commons', commons):
            expected = pr_review.rooms({})
        self.assertEqual(json.loads(out.getvalue().rstrip('\n').split('\n')[-1]), expected)
        self.assertEqual(expected['covered']['room'], pr_review.COVERED_ROOM)
        self.assertIsNotNone(expected['covered']['tender'])


class Checkout(unittest.TestCase):
    def test_a_command_line_from_the_main_working_copy_refuses_naming_the_installed_form_and_elsewhere_runs(self):
        copy = os.path.dirname(os.path.dirname(os.path.realpath(cv.__file__)))
        with mock.patch.object(cv, 'CHECKOUT', copy), mock.patch('sys.argv', ['view.py', 'rooms']), \
                contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as refused:
            cv.main()
        self.assertEqual(refused.exception.code, 1)
        self.assertIn(f'not from its main working copy {copy}: use '
                      '`~/.local/lib/context-view/current/view/step STEP`', err.getvalue())
        with tempfile.TemporaryDirectory() as elsewhere, mock.patch.object(cv, 'CHECKOUT', elsewhere), \
                mock.patch.object(pr_review, 'rooms', lambda args: {'covered': None}), mock.patch('sys.argv', ['view.py', 'rooms']), \
                mock.patch('sys.stdin', io.StringIO('{}')), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cv.main(), 0)
        self.assertEqual(json.loads(out.getvalue()), {'covered': None})

    def test_the_copys_own_environment_and_a_link_to_its_module_from_elsewhere_are_the_copy_too(self):
        with tempfile.TemporaryDirectory() as copy, tempfile.TemporaryDirectory() as elsewhere:
            installed = os.path.join(copy, 'view', '.venv', 'lib', 'python3.14', 'site-packages', 'view.py')
            os.makedirs(os.path.dirname(installed))
            open(installed, 'w').close()
            link = os.path.join(elsewhere, 'view.py')
            os.symlink(os.path.join(copy, 'view', '.venv', 'lib', 'python3.14', 'site-packages', 'view.py'), link)
            for module in (installed, link):
                with self.subTest(module=module), mock.patch.object(cv, 'CHECKOUT', copy), \
                        contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as refused:
                    cv.refuse_checkout(module, 'the installed form', 1)
                self.assertEqual(refused.exception.code, 1)
            with mock.patch.object(cv, 'CHECKOUT', copy):
                self.assertIsNone(cv.refuse_checkout(os.path.join(elsewhere, 'other.py'), 'the installed form', 1))


if __name__ == '__main__':
    unittest.main()

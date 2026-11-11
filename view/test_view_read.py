"""What a view reads (view_read.py): facts from a run's shares, compared from a harness compare's outputs, and each
arm's results held to the rules a run's records keep."""
import contextlib, io, json, os, re, shutil, tempfile, unittest
from unittest import mock

import pr_review
import view as cv
import view_read
import view_usage
from fixtures import AF, ALL_RAN, APP, H1, H2, HARNESS, M, READS, REPO, RUNS, Steps, VERSIONS, app_token, entry, result, usage


class Facts(Steps):
    def test_entries_from_every_share_merge_by_id_in_run_order_with_the_earliest_places_example(self):
        view = self.facts(self.changed_run())
        self.assertEqual([e['id'] for e in view['entries']], ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
        merged = view['entries'][0]
        self.assertEqual(merged['places'], [{'run': 'H1/W1', 'step': 7}, {'run': 'H1/W2', 'step': 4}])
        self.assertEqual(merged['example']['before'], 'first old')
        self.assertEqual((merged['count'], sorted(merged['runs'])), (2, ['H1/W1', 'H1/W2']))

    def test_a_view_is_changed_for_the_reader_whenever_it_ran_and_the_runs_it_could_compare_differ(self):
        self.assertTrue(view_read.facts({'dir': self.changed_run(), 'repo': REPO})['changed'])
        self.assertFalse(view_read.facts({'dir': self.unchanged_run(), 'repo': REPO})['changed'])
        some = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')],
                              [entry('aaaaaaaaaaaa', ('H1/W2', 1))])])
        self.assertTrue(view_read.facts({'dir': some, 'repo': REPO})['changed'])
        only_uncompared = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2'), result('C6h/W11')],
                                         [entry('aaaaaaaaaaaa', ('H1/W1', 1))])])
        self.assertFalse(view_read.facts({'dir': only_uncompared, 'repo': REPO})['changed'])
        for outcome, detail in (('doesnt-merge', None), ('arm-missing', {'share': 1, 'arm': 'after', 'log': None}), ('moved', None)):
            with self.subTest(outcome=outcome):
                try:
                    changed = view_read.facts({'dir': self.run_dir([([], [])], outcome=outcome, detail=detail), 'repo': REPO})['changed']
                except Exception as e:
                    self.fail(f'facts broke on an outcome with no runs: {e!r}')
                self.assertFalse(changed)

    def test_where_the_runs_it_could_compare_differ_the_reader_runs_and_reads_the_pull_request_whatever_couldnt_be_compared(self):
        some = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')],
                              [entry('aaaaaaaaaaaa', ('H1/W2', 1))])])
        none = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2'), result('C6h/W11')], [])])
        views = [self.facts(some), self.facts(none)]
        self.assertEqual(self.post(some, post=False), {'action': 'dry', 'parts': 1})
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
            with self.subTest(runs=runs), mock.patch('fixtures.RUNS', runs):
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

    def test_the_arm_a_release_wasnt_chosen_for_ran_the_lockfiles_and_a_version_run_with_different_contents_fails_the_view(self):
        for ran in ('0.7.9', None):
            with self.subTest(ran):
                d = self.chosen_run({'membrane': ran}, {'membrane': '0.9.0 (sha512-m)'},
                                    {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': []}}})
                with self.assertRaisesRegex(pr_review.Failed, re.escape(f"the base arm ran {M} {ran!r}, not the lockfile's 0.8.0, though the plan "
                                                                       f"chose {M} for the head alone")):
                    self.facts(d)
        chosen = {'version': '0.9.0', 'host': '0.8.0', 'ranges': []}
        d = self.chosen_run({'membrane': '0.9.0 (sha512-b)'}, {'membrane': '0.9.0 (sha512-h)'}, {'base': {M: chosen}, 'head': {M: chosen}})
        with self.assertRaisesRegex(pr_review.Failed, re.escape(f"the arms ran {M} 0.9.0 with different contents, '0.9.0 (sha512-b)' in the base "
                                                               "and '0.9.0 (sha512-h)' in the head")):
            self.facts(d)

    def test_forced_of_another_shape_or_in_a_host_view_fails_the_step(self):
        ask = {'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}
        for what, forced, form in (('one side', {'head': [ask]}, 'overlay'), ('neither side holds one', {'base': [], 'head': []}, 'overlay'),
                                   ('no wantedBy', {'base': [], 'head': [{**ask, 'wantedBy': None}]}, 'overlay'),
                                   ('no has', {'base': [], 'head': [{'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}'}]}, 'overlay'),
                                   ('a side that is no list', {'base': '', 'head': [ask]}, 'overlay'),
                                   ('a range that is no string', {'base': [], 'head': [{**ask, 'range': 25}]}, 'overlay'),
                                   ('an empty wantedBy', {'base': [], 'head': [{**ask, 'wantedBy': ''}]}, 'overlay'),
                                   ('a wantedBy that names no package', {'base': [], 'head': [{**ask, 'wantedBy': 'node_modules/'}]}, 'overlay'),
                                   ('a bare scoped name, which no lockfile key is', {'base': [], 'head': [{**ask, 'wantedBy': AF}]}, 'overlay'),
                                   ('a name and version that no chosen release is', {'base': [], 'head': [{**ask, 'wantedBy': 'x@1'}]}, 'overlay'),
                                   ('two versions in one arm', {'base': [], 'head': [ask, {**ask, 'range': '^0.24.0', 'has': '0.27.0'}]}, 'overlay'),
                                   ('a host view', {'base': [], 'head': [ask]}, 'host')):
            with self.subTest(what):
                d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced=forced, form=form,
                                 repo='connectome-host' if form == 'host' else 'context-manager')
                with self.assertRaisesRegex(pr_review.Failed, 'manifest.json: forced'):
                    self.facts(d, repo='anima-research/connectome-host' if form == 'host' else REPO)

    def test_a_stack_of_another_shape_or_in_a_host_view_fails_the_step(self):
        good = {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None}]}
        for what, stack, form in (('one side', {'head': {M: good}}, 'overlay'), ('a list', [], 'overlay'),
                                  ('a range with no wantedBy', {'base': {}, 'head': {M: {**good, 'ranges': [{'range': '^0.9.0'}]}}}, 'overlay'),
                                  ('a missed with no package', {'base': {}, 'head': {M: {**good, 'missed': {'range': '^0.9.0', 'wantedBy': None, 'has': '0.8.0'}}}}, 'overlay'),
                                  ('a missed whose has is a number', {'base': {}, 'head': {M: {**good, 'missed': {'package': M, 'range': '^0.9.0', 'wantedBy': None, 'has': 8}}}}, 'overlay'),
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
                    changed = view_read.facts({'dir': d, 'repo': REPO})['changed']
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

    def test_a_merge_that_ran_no_job_makes_a_short_view_with_its_merge_and_the_pull_requests_words(self):
        for outcome, detail, extra in (('elsewhere', {'branch': 'release'}, {'merge': {'commit': H1}}),
                                       ('unchanged', None, {'base': {'ref': 'main', 'sha': H2}, 'merge': {'commit': H1, 'k': 0}})):
            with self.subTest(outcome):
                d = tempfile.mkdtemp(dir=self.tmp)
                pr_review.write_json(os.path.join(d, 'manifest.json'), {'repo': 'context-manager', 'number': 5, 'head': H1, 'form': 'overlay',
                                                                         'outcome': outcome, 'detail': detail, 'shares': [], **extra})
                self.assertFalse(view_read.facts({'dir': d, 'repo': REPO})['changed'])
                self.assertEqual(pr_review.read_json(os.path.join(d, 'view.json')),
                                 {'repo': REPO, 'number': 5, 'head': H1, 'outcome': outcome, 'detail': detail, 'merge': extra['merge'],
                                  'title': self.gh.pull['title'], 'body': self.gh.pull['body']})

    def test_a_merges_view_json_carries_its_merge_as_the_run_side_wrote_it_and_a_heads_has_none(self):
        d = self.unchanged_run()
        self.assertNotIn('merge', self.facts(d))
        for merge in ({'commit': H1, 'k': 0, 'src': True}, {'commit': H1, 'k': 2, 'n': 2, 'src': False}):
            with self.subTest(merge=merge):
                m = pr_review.read_json(os.path.join(d, 'manifest.json'))
                pr_review.write_json(os.path.join(d, 'manifest.json'), {**m, 'merge': merge})
                self.assertEqual(self.facts(d)['merge'], merge)
        for merge in ({'commit': H1[:12], 'k': 0, 'src': True}, {'commit': H1, 'k': -1}, {'commit': H1, 'k': 0, 'src': 'yes'}, [H1]):
            with self.subTest(bad=merge):
                m = pr_review.read_json(os.path.join(d, 'manifest.json'))
                pr_review.write_json(os.path.join(d, 'manifest.json'), {**m, 'merge': merge})
                with self.assertRaisesRegex(cv.Failed, 'manifest.json: merge'):
                    self.facts(d)

    def test_a_merge_naming_another_commit_than_the_head_or_lacking_what_its_outcome_had_reached_is_refused(self):
        d = self.unchanged_run()
        m = pr_review.read_json(os.path.join(d, 'manifest.json'))
        for merge in ({'commit': H2, 'k': 0, 'src': True}, {'commit': H1, 'src': True}, {'commit': H1, 'k': 0}):
            with self.subTest(ran=merge):
                pr_review.write_json(os.path.join(d, 'manifest.json'), {**m, 'merge': merge})
                with self.assertRaisesRegex(cv.Failed, 'manifest.json: merge'):
                    self.facts(d)
        for outcome, merge, refused in (('unchanged', {'commit': H1}, True), ('unchanged', {'commit': H2, 'k': 0}, True),
                                        ('elsewhere', {'commit': H2}, True), ('elsewhere', {'commit': H1}, False)):
            with self.subTest(outcome=outcome, merge=merge):
                s = tempfile.mkdtemp(dir=self.tmp)
                pr_review.write_json(os.path.join(s, 'manifest.json'), {'repo': 'context-manager', 'number': 5, 'head': H1, 'form': 'overlay',
                                                                         'outcome': outcome, 'detail': None, 'shares': [], 'merge': merge})
                if refused:
                    with self.assertRaisesRegex(cv.Failed, 'manifest.json: merge'):
                        view_read.facts({'dir': s, 'repo': REPO})
                else:
                    self.assertEqual(view_read.facts({'dir': s, 'repo': REPO})['changed'], False)
        for outcome in ('elsewhere', 'unchanged'):
            for merge in (None, 'absent'):
                with self.subTest(outcome=outcome, merge=merge):
                    s = tempfile.mkdtemp(dir=self.tmp)
                    pr_review.write_json(os.path.join(s, 'manifest.json'), {'repo': 'context-manager', 'number': 5, 'head': H1, 'form': 'overlay',
                                                                             'outcome': outcome, 'detail': None, 'shares': [],
                                                                             **({} if merge == 'absent' else {'merge': merge})})
                    with self.assertRaisesRegex(cv.Failed, 'manifest.json: merge'):
                        view_read.facts({'dir': s, 'repo': REPO})

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
        return {k: m[k] for k in ('number', 'head', 'form', 'base', 'host', 'harness', 'stack', 'forced') if k in m}

    def shares_of(self, d, reach=True):
        """A compare's outputs as d's run left them: its shares, and its reach.json where reach."""
        e = tempfile.mkdtemp(dir=self.tmp)
        for name in os.listdir(d):
            if name.startswith('share-'):
                shutil.copytree(os.path.join(d, name), os.path.join(e, name))
        if reach:
            shutil.copy(os.path.join(d, 'reach.json'), e)
        return e

    def test_a_compare_without_a_reach_json_gets_a_view_with_no_reach_and_a_comment_with_no_reach_paragraph(self):
        d = self.unchanged_run()
        e = self.shares_of(d, reach=False)
        view_read.compared({'dir': e, 'repo': REPO, **self.fields(d), 'title': 't', 'body': 'b'})
        view = pr_review.read_json(os.path.join(e, 'view.json'))
        self.assertNotIn('reach', view)
        self.assertNotIn('profiled drive', '\n\n'.join(cv.units(view, None, 60_000)))
        e = self.shares_of(d)
        view_read.compared({'dir': e, 'repo': REPO, **self.fields(d), 'title': 't', 'body': 'b'})
        self.assertIn(ALL_RAN, cv.units(pr_review.read_json(os.path.join(e, 'view.json')), None, 60_000))

    def test_a_compares_shares_get_the_view_facts_would_write_with_the_given_title_and_description_and_the_run_sides_manifest_with_each_share_by_its_i_and_dir_asking_github_nothing(self):
        broken = [result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')]
        apart = [([result('H1/W1', record='differs')], [entry('aaaaaaaaaaaa', ('H1/W1', 7))])] + [([], [])] * 9 + [
            ([result('H1/W2', record='differs'), result('C6h/W11')], [entry('aaaaaaaaaaaa', ('H1/W2', 4))])]
        for what, d in (('changed', self.changed_run()), ('unchanged', self.unchanged_run()),
                        ('some not compared', self.run_dir([(broken, [entry('bbbbbbbbbbbb', ('H1/W2', 1))])])),
                        ('eleven shares', self.run_dir(apart)),
                        ('forced', self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])],
                                                forced={'base': [], 'head': [{'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}]})),
                        ('releases the plan chose', self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'},
                                                                     {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': []}}}))):
            with self.subTest(what):
                earlier = os.stat(os.path.join(d, 'manifest.json')).st_mtime - 5
                os.utime(os.path.join(d, 'manifest.json'), (earlier, earlier))
                e = self.shares_of(d)
                self.plant(e)
                calls, tokens = len(self.gh.calls), []
                given = {'dir': e, 'repo': REPO, **self.fields(d), 'title': self.gh.pull['title'], 'body': self.gh.pull['body']}
                with mock.patch('sys.stdin', io.StringIO(json.dumps(given))), contextlib.redirect_stdout(io.StringIO()) as out, \
                        mock.patch.object(pr_review, 'app_token', lambda repo: tokens.append(repo) or app_token(repo)):
                    self.assertEqual(cv.main(['compared']), 0)
                self.assertEqual((self.gh.calls[calls:], tokens), ([], []))
                written = os.stat(os.path.join(e, 'manifest.json')).st_mtime
                os.utime(os.path.join(d, 'manifest.json'), (written, written))
                facts = view_read.facts({'dir': d, 'repo': REPO})
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
                    view_read.compared(args)
                self.assertEqual((self.gh.calls[calls:], tokens), ([], []))
                self.assertEqual([n for n in self.EARLIER if os.path.exists(os.path.join(args['dir'], n))], [])

    def test_a_manifest_that_cant_be_written_leaves_no_view(self):
        d = self.changed_run()
        e = self.shares_of(d)
        real = view_read.write_json

        def failing(path, value):
            if os.path.basename(path) == 'manifest.json':
                raise OSError(28, 'No space left on device')
            real(path, value)
        with mock.patch.object(view_read, 'write_json', failing), self.assertRaises(OSError):
            view_read.compared({'dir': e, 'repo': REPO, **self.fields(d), 'title': 't', 'body': 'b'})
        self.assertFalse(os.path.exists(os.path.join(e, 'view.json')))


class Arms(Steps):
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

    def test_a_view_whose_arm_came_back_missing_carries_the_forced_ranges_with_the_package_they_were_forced_on(self):
        ask = {'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}
        d = self.run_dir([([], []), ([], [])], outcome='arm-missing', detail={'share': 1, 'arm': 'after', 'log': None}, forced={'base': [ask], 'head': [ask]})
        view = self.facts(d)
        self.assertEqual((view['forced'], view['pack']), ({'base': [ask], 'head': [ask]}, '@animalabs/context-manager'))

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
                    self.assertEqual([u['base'] for u in view['usage'] if u['run'] == 'H1/W1'], [view_usage.usage_read(runs[0], 'base')],
                                     "a run's base figures are its own share's, not another share's base arm's")

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

    def test_an_arm_that_wrote_no_run_json_fails_the_step_rather_than_reading_as_a_run(self):
        for arm in ('after', 'before'):
            d = self.unchanged_run()
            os.remove(os.path.join(d, 'share-2', arm, 'run.json'))
            with self.subTest(arm), self.assertRaises(Exception) as raised:
                self.facts(d)
            self.assertIsInstance(raised.exception, pr_review.Failed)
            self.assertIn('wrote no run.json', str(raised.exception))


if __name__ == '__main__':
    unittest.main()

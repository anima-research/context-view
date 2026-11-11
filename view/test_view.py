"""The context view's posting (view.py): the result a comment rests on, the comment posted, edited or left as it is on
the pull request, the want for its project field, its stopped words, the rooms step and the refused checkout."""
import contextlib, datetime, io, json, os, re, tempfile, unittest
from unittest import mock

import pr_comment
import pr_review
import view as cv
import view_reach
import view_read
import view_usage
import view_words
from fixtures import BASE, H1, H2, H3, M, READS, REPO, Steps, entry, read_file, result, usage


class Result(Steps):
    def test_the_result_names_the_view_code_that_writes_the_words_so_a_release_never_keeps_another_releases_comment(self):
        v = self.facts(self.changed_run())
        with mock.patch.object(cv, 'WORDS', 'f' * 64):
            other = cv.result_of(v)
        self.assertNotEqual(other, cv.result_of(v))
        view = (cv.__file__, view_reach.__file__, view_read.__file__, view_usage.__file__, view_words.__file__)
        self.assertEqual(cv.WORDS, cv.words_of((*view, pr_comment.__file__)))
        changed = os.path.join(self.tmp, 'pr_comment.py')
        with open(pr_comment.__file__, 'rb') as f, open(changed, 'wb') as g:
            g.write(f.read() + b'\n')
        self.assertNotEqual(cv.words_of((*view, changed)), cv.WORDS)
        now = cv.result_of(v)
        with mock.patch.object(cv, 'WORDS', cv.words_of((*view, changed))):
            self.assertNotEqual(cv.result_of(v), now)

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

    def test_the_releases_the_plan_chose_are_part_of_the_result_so_a_comment_naming_them_is_never_kept_under_another(self):
        stack = {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None}]}}}
        v = self.facts(self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'}, stack))
        for other in ({**v, 'stack': {'base': {}, 'head': {M: {**stack['head'][M], 'host': '0.8.1'}}}},
                      {**v, 'differing': [{'package': 'membrane', 'base': '0.8.1', 'head': '0.9.0'}]},
                      {k: x for k, x in v.items() if k not in ('stack', 'differing')}):
            self.assertNotEqual(cv.result_of(v), cv.result_of(other))
        self.assertEqual(cv.result_of(v), cv.result_of(json.loads(json.dumps(v))))

    def test_a_view_with_no_reader_is_never_the_result_of_one_with_a_reader_so_an_account_stands_only_over_the_head_its_reader_read(self):
        a = self.changed_run()
        self.facts(a)
        self.post(a, self.reader())
        asked = [dict(c) for c in self.gh.comments]
        b = self.changed_run(head=H2)
        self.assertNotEqual(cv.result_of(self.facts(b)), cv.result_of(self.facts(b), READS))
        self.assertEqual(self.post(b)['action'], 'posted')
        self.assertEqual(self.gh.comments[:len(asked)], asked)
        self.assertIn(view_words.UNREAD, self.gh.comments[-1]['body'])
        c = self.changed_run(head=H3)
        self.facts(c)
        self.assertEqual(self.post(c)['action'], 'edited')
        self.assertEqual(self.gh.comments[:len(asked)], asked)

    def test_a_comment_with_no_reader_rests_on_no_word_of_the_description_so_an_edited_one_keeps_it_at_a_later_head(self):
        a = self.changed_run()
        self.facts(a)
        self.post(a)
        self.gh.pull['body'] = 'It changes <b>that</b> now.'
        b = self.changed_run(head=H2)
        self.facts(b)
        self.assertEqual(self.post(b)['action'], 'edited')
        self.assertEqual(len(self.gh.comments), 1)


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
        self.assertTrue(view_read.facts({'dir': a, 'repo': REPO})['changed'])
        reader = self.reader('aaaaaaaaaaaa')
        try:
            self.post(a, reader)
        except pr_review.Failed as e:
            self.fail(f"the reader's account of the runs it could compare was refused: {e}")
        b = run(H2)
        self.facts(b)
        self.assertEqual(self.post(b, reader)['action'], 'edited')
        [body] = self.bodies()
        self.assertIn("The records of 1 of the 2 runs it could compare differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n1 run couldn't be "
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


class Context(Steps):
    """A view that could tell wants its pull request's "Changes context" through review-workflow's poll."""
    def setUp(self):
        super().setUp()
        self.calls = os.path.join(self.tmp, 'review-poll.calls')
        self.exit = os.path.join(self.tmp, 'review-poll.exit')
        command = os.path.join(self.tmp, 'review-poll')
        with open(command, 'w') as f:
            f.write(f"""#!/usr/bin/env python3
import json, sys
with open({self.calls!r}, 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
try:
    code = int(open({self.exit!r}).read())
except FileNotFoundError:
    code = 0
if code:
    sys.stderr.buffer.write(b'review-poll: no such step, want \\xff\\n')
sys.exit(code)
""")
        os.chmod(command, 0o755)
        patcher = mock.patch.object(cv, 'REVIEW_POLL', command)
        patcher.start()
        self.addCleanup(patcher.stop)

    def wants(self):
        if not os.path.exists(self.calls):
            return []
        with open(self.calls) as f:
            return [json.loads(l) for l in f]

    def ran_at(self, d, when):
        at = datetime.datetime.fromisoformat(when).timestamp()
        os.utime(os.path.join(d, 'manifest.json'), (at, at))

    def test_a_view_wants_yes_where_some_run_it_compared_differs_no_where_every_run_compared_and_none_does_and_nothing_else(self):
        cases = {
            'differs': (self.changed_run(), 'Yes'),
            'same': (self.unchanged_run(), 'No'),
            'some lost, the rest differ': (self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='differs'), result('C6h/W11')],
                                                         [entry('aaaaaaaaaaaa', ('H1/W2', 1))])]), 'Yes'),
            'some lost, the rest the same': (self.run_dir([([result('H1/W1', record='missing'), result('H1/W2'), result('C6h/W11')], [])]), None),
            'none compared': (self.run_dir([([result('H1/W1', record='missing'), result('H1/W2', record='missing'), result('C6h/W11', record='missing')], [])]), None),
            'doesnt-merge': (self.run_dir([([], [])], outcome='doesnt-merge'), None),
            'arm-missing': (self.run_dir([([], [])], outcome='arm-missing', detail={'share': 1, 'arm': 'after', 'log': None}), None),
        }
        for name, (d, value) in cases.items():
            with self.subTest(name):
                self.assertEqual(cv.context_of(self.facts(d)), value)
        self.assertIsNone(cv.context_of({**self.facts(self.changed_run()), 'merge': {'commit': H1}}))

    def test_a_posted_edited_or_kept_comment_wants_its_value_timed_when_its_run_side_finished_as_facts_read_it(self):
        a = self.changed_run()
        self.ran_at(a, '2026-11-10T23:41:07.6+00:00')
        self.facts(a)
        self.ran_at(a, '2026-11-11T02:00:00+00:00')
        self.assertEqual(self.post(a, self.reader())['action'], 'posted')
        self.assertEqual(self.post(a, self.reader())['action'], 'unchanged')
        b = self.changed_run(head=H2)
        self.ran_at(b, '2026-11-11T00:02:59+00:00')
        self.facts(b)
        self.assertEqual(self.post(b, self.reader())['action'], 'edited')
        c = self.unchanged_run(head=H3)
        self.ran_at(c, '2026-11-11T01:00:00+00:00')
        self.facts(c)
        self.assertEqual(self.post(c)['action'], 'posted')
        def want(d, value, at):
            return ['want', '--kind', 'context', '--repo', REPO, '--number', '5', '--label', os.path.basename(d), '--value', value, '--started', at]
        self.assertEqual(self.wants(), [want(a, 'Yes', '2026-11-10T23:41:07Z'), want(a, 'Yes', '2026-11-10T23:41:07Z'),
                                        want(b, 'Yes', '2026-11-11T00:02:59Z'), want(c, 'No', '2026-11-11T01:00:00Z')])

    def test_a_dry_view_one_whose_pull_request_moved_or_closed_and_one_that_couldnt_tell_want_nothing(self):
        d = self.changed_run()
        self.facts(d)
        self.assertEqual(self.post(d, self.reader(), post=False)['action'], 'dry')
        lost = self.run_dir([([result('H1/W1', record='missing'), result('H1/W2'), result('C6h/W11')], [])])
        self.facts(lost)
        self.assertEqual(self.post(lost)['action'], 'posted')
        moved = self.run_dir([], outcome='moved', detail={'headNow': H2})
        self.facts(moved)
        self.assertEqual(self.post(moved)['action'], 'moved')
        self.gh.state = 'closed'
        e = self.changed_run(head=H2)
        self.facts(e)
        self.assertEqual(self.post(e, self.reader())['action'], 'closed')
        self.assertEqual(self.wants(), [])

    def test_a_want_that_fails_a_command_that_isnt_there_or_a_view_json_without_ended_is_said_on_stderr_and_the_view_still_posts(self):
        with open(self.exit, 'w') as f:
            f.write('2')
        d = self.changed_run()
        self.facts(d)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.post(d, self.reader())['action'], 'posted')
        self.assertIn(f"post: its Changes context, Yes, wasn't wanted: {cv.REVIEW_POLL} exited 2: review-poll: no such step, want", err.getvalue())
        self.assertEqual(len(self.wants()), 1)
        e = self.changed_run(head=H2, after='other new text')
        self.facts(e)
        with mock.patch.object(cv, 'REVIEW_POLL', os.path.join(self.tmp, 'nowhere')), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.post(e, self.reader())['action'], 'posted')
        self.assertIn("post: its Changes context, Yes, wasn't wanted: ", err.getvalue())
        self.assertEqual(len(self.gh.comments), 2)
        f = self.changed_run(head=H3, after='a third new text')
        self.facts(f)
        view = os.path.join(f, 'view.json')
        with open(view) as g:
            older = {k: v for k, v in json.load(g).items() if k != 'ended'}
        with open(view, 'w') as g:
            json.dump(older, g)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.post(f, self.reader())['action'], 'posted')
        self.assertIn("post: its Changes context, Yes, wasn't wanted: its view.json has no ended", err.getvalue())
        self.assertEqual(len(self.wants()), 1)
        self.assertEqual(len(self.gh.comments), 3)

    def test_a_view_started_beside_this_one_in_its_directory_moves_neither_its_want_nor_its_time(self):
        d = self.changed_run()
        self.ran_at(d, '2026-11-11T01:10:00+00:00')
        self.facts(d)
        os.remove(os.path.join(d, 'manifest.json'))
        self.assertEqual(self.post(d, self.reader())['action'], 'posted')
        with open(os.path.join(d, 'manifest.json'), 'w') as g:
            g.write('{}')
        self.ran_at(d, '2026-11-11T01:30:00+00:00')
        self.assertEqual(self.post(d, self.reader())['action'], 'unchanged')
        self.assertEqual([w[-1] for w in self.wants()], ['2026-11-11T01:10:00Z', '2026-11-11T01:10:00Z'])


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

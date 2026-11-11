"""The comment's reach paragraph and its fold (view_reach.py), and how facts reads a run's reach.json for them."""
import json, os, re, unittest

import pr_comment
import pr_review
import view as cv
import view_reach
from fixtures import ALL_RAN, Steps, reached_file, read_file, result


def said(files, notes=()):
    """The reach paragraph for these files and notes, as view.json holds them."""
    return view_reach.reach_paragraph({'files': files, 'notes': list(notes)})


class Reach(Steps):
    """The comment's reach paragraph: which of the change's source lines ran in no profiled drive, and what it couldn't tell,
    from the run's reach.json, in the forms room-900 read (CHECKS.md's "Which of the change's source lines ran")."""

    def test_facts_reads_reach_json_into_view_json_and_a_ran_run_without_one_fails(self):
        d = self.unchanged_run()
        self.assertEqual(self.facts(d)['reach'], {'files': {'src/a.ts': reached_file(ran=[1, 2])}, 'notes': []})
        os.remove(os.path.join(d, 'reach.json'))
        with self.assertRaisesRegex(pr_review.Failed, "the run wrote no reach.json, though its outcome is ran"):
            self.facts(d)
        joined = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], reach={'couldnt': "no share brought its reach home"})
        self.assertEqual(self.facts(joined)['reach'], {'couldnt': "no share brought its reach home"})

    def test_a_reach_json_whose_lists_dont_hold_what_the_harness_gives_fails_the_step(self):
        for files, notes, why in (
                ({'src/a.ts': reached_file('gone', ran=[1])}, [], "src/a.ts's state isn't one reach knows, 'gone'"),
                ({'src/a.ts': reached_file(unloaded=[1])}, [], 'src/a.ts, a read file, has unloaded lines'),
                ({'src/a.ts': reached_file('not-loaded', couldntTell=[1], reason='r')}, [], 'src/a.ts, a not-loaded file, has couldntTell lines'),
                ({'src/a.ts': reached_file('couldnt-tell', ran=[1], reason='r')}, [], 'src/a.ts, a couldnt-tell file, has ran lines'),
                ({'src/a.ts': reached_file(ran=[1], notRan=[1])}, [], 'src/a.ts has a line in two lists'),
                ({'src/a.ts': reached_file(ran=[0])}, [], "src/a.ts's ran isn't a list of line numbers"),
                ({'src/a.ts': reached_file(deletions=[(2, 'unloaded', None)])}, [], "src/a.ts's deletions aren't each one a read file can have"),
                ({'src/a.ts': reached_file('couldnt-tell', unloaded=[1])}, [], "src/a.ts names no reason for what it couldn't tell"),
                ({'src/a.ts': reached_file(couldntTell=[1])}, ['n'], "src/a.ts names no reason for what it couldn't tell"),
                ({'src/a.ts': reached_file(ran=[1], reason='r')}, [], "src/a.ts names a reason for nothing it couldn't tell"),
                ({'src/a.ts': reached_file()}, [], 'src/a.ts has no changed line or deletion'),
                ({'test/a.ts': reached_file(ran=[1])}, [], "'test/a.ts' isn't a path under src/"),
                ({}, ['n', 'n'], "notes aren't distinct lines of text"),
                ({'src/a.ts': reached_file(ran=[1], deletions=[(3, 'reached', None)])}, [], "src/a.ts's deletions aren't each one a read file can have"),
                ({'src/a.ts': reached_file(ran=[1], deletions=[(3, 'not-reached', 0)])}, [], "src/a.ts's deletions aren't each one a read file can have"),
                ({'src/a.ts': reached_file(ran=[1], deletions=[(3, 'no-code', 2)])}, [], "src/a.ts's deletions aren't each one a read file can have"),
                ({'src/a.ts': reached_file('not-loaded', unloaded=[1], deletions=[(3, 'unloaded', 2)])}, [], "src/a.ts's deletions aren't each one a not-loaded file can have"),
                ({'src/a.ts': reached_file(couldntTell=[1], reason='another reason')}, ['n'], "src/a.ts's reason doesn't hold the notes once, as the harness joins them"),
                ({'src/a.ts': {**reached_file('couldnt-tell', unloaded=[1], reason='r'), 'binary': True}}, [], "src/a.ts is marked binary, and a binary file is a couldnt-tell one with no line or deletion"),
                ({'src/a.ts': {**reached_file('read', reason='r'), 'binary': True}}, [], "src/a.ts is marked binary, and a binary file is a couldnt-tell one with no line or deletion"),
                ({'src/a.ts': reached_file(couldntTell=[1], reason='dist/x; n1; y ran with no source map; n1; it can run in a worker the host started (w; n1; v), which isn' + chr(39) + 't profiled')}, ['n1'],
                 "src/a.ts's reason doesn't hold the notes once, as the harness joins them")):
            with self.subTest(why=why):
                d = self.unchanged_run()
                with open(os.path.join(d, 'reach.json'), 'w') as f:
                    json.dump({'files': files, 'notes': notes}, f)
                with self.assertRaisesRegex(pr_review.Failed, re.escape(f'reach.json: {why}')):
                    self.facts(d)

    def test_a_couldnt_tell_deletion_with_no_code_beside_it_in_the_loaded_script_as_a_split_build_gives_is_one_a_read_file_can_have(self):
        d = self.unchanged_run()
        with open(os.path.join(d, 'reach.json'), 'w') as f:
            json.dump({'files': {'src/a.ts': reached_file(ran=[1], couldntTell=[2], deletions=[(3, 'couldnt-tell', None)], reason='src/a.ts is built into more than one script')},
                       'notes': []}, f)
        self.facts(d)

    def test_the_paragraph_follows_the_records_sentence_whether_or_not_the_records_differ_and_its_result_is_part_of_the_comments(self):
        unchanged = self.unchanged_run()
        self.facts(unchanged)
        self.post(unchanged)
        self.assertIn(f"The records of the 3 runs don't differ between the base and this head.\n\n{ALL_RAN}\n\n", self.bodies()[-1])
        changed = self.changed_run()
        self.facts(changed)
        self.post(changed, self.reader())
        self.assertIn(f"The records of 2 of the 3 runs differ between the base and this head.\n\n{ALL_RAN}\n\n", self.bodies()[-1])
        view = pr_review.read_json(os.path.join(unchanged, 'view.json'))
        other = {**view, 'reach': {'files': {'src/a.ts': reached_file(ran=[1], notRan=[2])}, 'notes': []}}
        self.assertNotEqual(cv.result_of(view), cv.result_of(other))

    def test_lines_that_ran_in_no_profiled_drive_are_listed_by_file_in_ranges_that_never_span_a_line_outside_the_list(self):
        files = {'src/framework.ts': reached_file(notRan=[3, 4, 6, 10, 11, 12], ran=[5], noCode=[7]),
                 'src/mcpl/channel.ts': reached_file(notRan=[9])}
        self.assertEqual(said(files), "**In the files profiled hosts loaded, 7 changed source lines that map to code ran in no profiled "
                                      "drive:** `src/framework.ts` lines 3–4, 6 and 10–12; `src/mcpl/channel.ts` line 9. 1 changed source "
                                      "line maps to nothing the host runs: 1 of `src/framework.ts`'s. The whole list is in the fold below.")

    def test_a_list_longer_than_its_room_is_cut_saying_how_much_it_leaves_out(self):
        files = {f'src/f{i:02}.ts': reached_file(notRan=[1, 2, 4]) for i in range(20)}
        text = said(files)
        shown = re.search(r'drive:\*\* (.*); and (\d+) more lines in (\d+) files\. The whole list', text)
        self.assertIsNotNone(shown, text)
        listing, more, rest = shown[1], int(shown[2]), int(shown[3])
        self.assertLessEqual(len(listing), view_reach.LISTED)
        named = re.findall(r'`(src/f\d\d\.ts)` lines 1–2 and 4', listing)
        self.assertEqual((len(named) * 3 + more, len(named) + rest, named), (60, 20, [f'src/f{i:02}.ts' for i in range(len(named))]))
        self.assertTrue(text.startswith('**In the files profiled hosts loaded, 60 changed source lines'))

    def test_files_no_profiled_host_loaded_are_named_with_all_their_changed_lines_and_deletions(self):
        files = {'src/cli/args.ts': reached_file('not-loaded', notRan=[1, 2], noCode=[3], unloaded=[], deletions=[(5, 'not-reached', 4)]),
                 'src/cli/serve.ts': reached_file('not-loaded', unloaded=list(range(1, 13)))}
        self.assertEqual(said(files), "**No profiled host loaded `src/cli/args.ts` (3 changed lines and 1 deletion) or `src/cli/serve.ts` "
                                      "(12 changed lines).** The whole list is in the fold below.")

    def test_deletions_no_profiled_drive_reached_are_named_by_the_line_they_follow(self):
        files = {'src/a.ts': reached_file(ran=[1], deletions=[(3, 'not-reached', 2), (9, 'not-reached', 10), (12, 'reached', 1)]),
                 'src/b.ts': reached_file(deletions=[(4, 'not-reached', 5)])}
        self.assertEqual(said(files), "No profiled drive reached 3 of this change's deletions: `src/a.ts`, the ones after lines 3 and 9; "
                                      "`src/b.ts`, the one after line 4.")

    def test_where_everything_that_could_run_ran_it_says_so_never_counting_the_changes_deletions_as_a_whole(self):
        for files, words in (
                ({'src/a.ts': reached_file(ran=[1, 2])}, ALL_RAN),
                ({'src/a.ts': reached_file(ran=[1])}, "This change's 1 changed source line that maps to code ran in at least one profiled drive."),
                ({'src/a.ts': reached_file(ran=[1, 2], deletions=[(3, 'reached', 2), (5, 'reached', 2)])},
                 "All 2 of this change's changed source lines that map to code ran in at least one profiled drive, as did code beside each "
                 "of 2 of its deletions."),
                ({'src/a.ts': reached_file(ran=[1, 2], deletions=[(3, 'reached', 2)])},
                 "All 2 of this change's changed source lines that map to code ran in at least one profiled drive, as did code beside 1 of "
                 "its deletions."),
                ({'src/a.ts': reached_file(deletions=[(3, 'reached', 2)]), 'src/t.ts': reached_file(deletions=[(2, 'no-code', None)])},
                 "Code beside 1 of this change's deletions ran in at least one profiled drive. 1 of this change's deletions has no code "
                 "line on either side of it to be judged by: `src/t.ts`'s deletion after line 2. The whole list is in the fold below."),
                ({'src/a.ts': reached_file(ran=[1], noCode=[2, 3])},
                 "This change's 1 changed source line that maps to code ran in at least one profiled drive. 2 changed source lines map to "
                 "nothing the host runs: 2 of `src/a.ts`'s. The whole list is in the fold below.")):
            with self.subTest(words=words):
                self.assertEqual(said(files), words)

    def test_with_a_note_it_says_how_many_lines_and_deletions_it_couldnt_tell_about_and_why(self):
        files = {'src/a.ts': reached_file(ran=[1], couldntTell=[2, 3], deletions=[(4, 'couldnt-tell', 3)], reason='r1; r2'),
                 'src/b.ts': reached_file('couldnt-tell', unloaded=[1, 2], noCode=[3], reason='r1; r2')}
        self.assertEqual(said(files, ['H1/W9: its profiled drive failed at step 648143.2', 'r2']),
                         "Couldn't tell whether 4 changed source lines ran, or whether 1 deletion was reached, since H1\\/W9\\: its profiled "
                         "drive failed at step 648143\\.2; and 1 more reason. 1 changed source line maps to nothing the host runs: 1 of "
                         "`src/b.ts`'s. The whole list is in the fold below.")
        self.assertEqual(said({'src/a.ts': reached_file(couldntTell=[2], reason='a host exited before its blocks were read')},
                              ['a host exited before its blocks were read']),
                         "Couldn't tell whether 1 changed source line ran, since a host exited before its blocks were read. The whole list "
                         "is in the fold below.")

    def test_without_a_note_each_file_it_couldnt_tell_about_says_how_much_and_its_own_reason(self):
        files = {'src/a.ts': reached_file(ran=[1], couldntTell=[2, 3], deletions=[(9, 'couldnt-tell', 3)], reason='a worker can run it'),
                 'src/b.ts': reached_file('couldnt-tell', unloaded=[4], reason='dist/x.js ran with no source map'),
                 'src/c.ts': reached_file('couldnt-tell', deletions=[(2, 'unloaded', None), (7, 'unloaded', None)], reason='dist/x.js ran')}
        self.assertEqual(said(files), "Couldn't tell whether 2 of `src/a.ts`'s changed lines ran, or whether its deletion after line 9 was "
                                      "reached: a worker can run it. Couldn't tell whether 1 of `src/b.ts`'s changed lines ran: dist\\/x\\.js "
                                      "ran with no source map. Couldn't tell whether `src/c.ts`'s deletions after lines 2 and 7 were "
                                      "reached: dist\\/x\\.js ran. The whole list is in the fold below.")

    def test_lines_and_deletions_with_nothing_to_run_are_counted_apart_by_file(self):
        files = {'src/types/agent.ts': reached_file(noCode=list(range(1, 13)), deletions=[(9, 'no-code', None)]),
                 'src/framework.ts': reached_file(ran=[1], noCode=[2, 3, 4])}
        self.assertEqual(said(files), "This change's 1 changed source line that maps to code ran in at least one profiled drive. 15 changed "
                                      "source lines map to nothing the host runs, and 1 deletion has no code line on either side of it to "
                                      "be judged by: 3 of `src/framework.ts`'s lines, and 12 of `src/types/agent.ts`'s lines and its "
                                      "deletion after line 9. The whole list is in the fold below.")

    def test_a_file_whose_only_part_with_nothing_to_run_is_a_deletion_names_it_as_one_beside_files_with_lines(self):
        files = {'src/a.ts': reached_file(ran=[1], noCode=[2, 3, 4]), 'src/t.ts': reached_file(deletions=[(9, 'no-code', None)]),
                 'src/u.ts': reached_file(noCode=[1, 2])}
        self.assertEqual(said(files), "This change's 1 changed source line that maps to code ran in at least one profiled drive. 5 changed "
                                      "source lines map to nothing the host runs, and 1 deletion has no code line on either side of it to "
                                      "be judged by: 3 of `src/a.ts`'s lines, `src/t.ts`'s deletion after line 9, and 2 of `src/u.ts`'s "
                                      "lines. The whole list is in the fold below.")

    def test_past_the_cut_the_files_it_couldnt_tell_about_for_their_own_reasons_are_counted_with_their_deletions(self):
        files = {f'src/pkg/f{i:02}.ts': reached_file('couldnt-tell', unloaded=[1, 2], reason='dist/bundle.js ran with no source map')
                 for i in range(8)}
        files['src/pkg/z.ts'] = reached_file('couldnt-tell', deletions=[(4, 'unloaded', None)], reason='dist/bundle.js ran with no source map')
        text = said(files)
        shown = re.search(r"Couldn't tell either whether (\d+) more changed lines ran, or whether 1 more deletion was reached, in (\d+) more "
                          r"files, each for its own reason\. The whole list is in the fold below\.$", text)
        self.assertIsNotNone(shown, text)
        told = re.findall(r"Couldn't tell whether 2 of `(src/pkg/f\d\d\.ts)`'s changed lines ran: ", text)
        self.assertEqual((len(told) * 2 + int(shown[1]), len(told) + int(shown[2])), (16, 9))

    def test_a_long_list_of_lines_with_nothing_to_run_is_cut_the_same_way(self):
        files = {f'src/types/t{i:02}.ts': reached_file(noCode=[1, 2, 3]) for i in range(30)}
        text = said(files)
        shown = re.fullmatch(r"90 changed source lines map to nothing the host runs: (.*), and (\d+) more lines in (\d+) more files\. "
                             r"The whole list is in the fold below\.", text)
        self.assertIsNotNone(shown, text)
        named = re.findall(r"3 of `(src/types/t\d\d\.ts)`'s", shown[1])
        self.assertLessEqual(len(shown[1]), view_reach.LISTED)
        self.assertEqual((len(named) * 3 + int(shown[2]), len(named) + int(shown[3])), (90, 30))

    def reach_comment(self, reach):
        """The comment, as post writes it, for an unchanged run whose reach.json is reach."""
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], reach=reach)
        self.facts(d)
        cv.post({'dir': d, 'reader': None, 'post': False})
        return read_file(os.path.join(d, 'comment.md'))

    FOLD = '<details><summary>Changed source lines and deletions not seen to run, by file</summary>'

    def test_a_list_the_paragraph_cuts_is_held_whole_in_a_fold_below_it(self):
        files = {f'src/f{i:02}.ts': reached_file(notRan=[1, 2, 4]) for i in range(20)}
        files['src/t.ts'] = reached_file(ran=[1], noCode=[2, 3], deletions=[(5, 'no-code', None), (9, 'not-reached', 10)])
        files['src/cli.ts'] = reached_file('not-loaded', unloaded=[1, 2], deletions=[(4, 'unloaded', None)])
        text = self.reach_comment({'files': files, 'notes': []})
        self.assertIn('The whole list is in the fold below.', text)
        fold = text[text.index(self.FOLD):]
        for i in range(20):
            self.assertIn(f'\n\n`src/f{i:02}.ts`: lines 1–2 and 4 ran in no profiled drive.\n\n', fold)
        self.assertIn("\n\n`src/t.ts`: no profiled drive reached its deletion after line 9; lines 2–3 map to nothing the host runs; its deletion "
                      "after line 5 has no code line on either side.\n\n", fold)
        self.assertIn('\n\n`src/cli.ts`: no profiled host loaded it: changed lines 1–2 and its deletion after line 4.\n\n', fold)
        self.assertRegex(text[:text.index(self.FOLD)], r'; and \d+ more lines in \d+ files\. ')

    def test_reasons_the_paragraph_leaves_out_or_cuts_are_held_whole_in_the_fold_and_nothing_cut_means_no_fold(self):
        notes = ['H1/W9: its profiled drive failed at step 648143.2', 'share 4 brought no reach home', 'x ' * 300]
        text = self.reach_comment({'files': {'src/a.ts': reached_file(ran=[1], couldntTell=[2, 3], reason='; '.join(notes))}, 'notes': notes})
        self.assertIn('; and 2 more reasons. The whole list is in the fold below.', text)
        fold = text[text.index(self.FOLD):]
        for n in notes:
            self.assertIn(f"Couldn't tell for any line or deletion not seen to run, since {pr_comment.inert(pr_comment.one_line(n))}.", fold)
        self.assertIn("\n\n`src/a.ts`: couldn't tell whether lines 2–3 ran.\n\n", fold)
        long = self.reach_comment({'files': {'src/a.ts': reached_file(couldntTell=[2], reason='y ' * 300)}, 'notes': []})
        self.assertIn("(the reason's first", long[:long.index(self.FOLD)])
        self.assertIn(f"\n\n`src/a.ts`: couldn't tell whether line 2 ran, since {'y ' * 299}y.\n\n", long[long.index(self.FOLD):])
        own = self.reach_comment({'files': {**{f'src/f{i:02}.ts': reached_file(notRan=[1, 2, 4]) for i in range(20)},
                                            'src/b.ts': reached_file('couldnt-tell', noCode=[5], reason='dist/bundle.js ran with no source map')},
                                  'notes': []})
        self.assertIn("\n\n`src/b.ts`: line 5 maps to nothing the host runs.\n\n", own[own.index(self.FOLD):])
        join = self.reach_comment({'couldnt': 'z ' * 300})
        m = re.search(r"which of this change's source lines ran: ((?:z )+z) \(the reason's first ([0-9]+) of 599 characters\)\. The whole reason is in the fold below\.\n\n", join)
        self.assertEqual((len(m[1]), int(m[2]) <= view_reach.LISTED), (int(m[2]), True))
        why = "<details><summary>Why it couldn&#x27;t tell which of this change&#x27;s source lines ran</summary>"
        self.assertIn(f"{why}\n\nCouldn't tell which of this change's source lines ran: {'z ' * 299}z.\n\n", join)
        self.assertNotIn(self.FOLD, join)
        whole = self.reach_comment({'files': {'src/a.ts': reached_file(ran=[1], notRan=[2], deletions=[(4, 'not-reached', 5)])}, 'notes': []})
        self.assertNotIn(self.FOLD, whole)
        self.assertNotIn('The whole list', whole)
        self.assertNotIn('view.json', whole)
        counted_only = self.reach_comment({'files': {'src/a.ts': reached_file(ran=[1], noCode=[2, 3])}, 'notes': []})
        self.assertIn('2 of `src/a.ts`\'s. The whole list is in the fold below.', counted_only)
        self.assertIn("\n\n`src/a.ts`: lines 2–3 map to nothing the host runs.\n\n", counted_only[counted_only.index(self.FOLD):])
        beside = self.reach_comment({'files': {'src/a.ts': reached_file(ran=[1], couldntTell=[2], reason='n1; a worker the host started can run it')},
                                     'notes': ['n1']})
        self.assertIn("\n\n`src/a.ts`: couldn't tell whether line 2 ran, since a worker the host started can run it, besides the reasons above.\n\n",
                      beside[beside.index(self.FOLD):])
        self.assertNotIn('view.json', beside)

    def test_a_files_own_reason_beside_the_notes_is_what_the_harness_added_to_them_whole_even_where_it_holds_a_notes_text(self):
        files = {'src/m.ts': reached_file('couldnt-tell', unloaded=[1], reason='dist/a; n1; b.js ran with no source map; n1; n2')}
        text = self.reach_comment({'files': files, 'notes': ['n1', 'n2']})
        self.assertIn("\n\n`src/m.ts`: couldn't tell whether line 1 ran, since dist\\/a\\; n1\\; b\\.js ran with no source map, besides the reasons above.\n\n",
                      text[text.index(self.FOLD):])

    def test_a_changed_binary_file_is_said_as_a_change_it_couldnt_tell_ran_never_as_no_line_changed(self):
        why = "src/q.wasm isn't script source, so whether its change ran can't be read"
        q = {**reached_file('couldnt-tell', reason=why), 'binary': True}
        self.assertEqual(said({'src/q.wasm': q}), f"Couldn't tell whether the change to `src/q.wasm` ran: {pr_comment.inert(why)}.")
        both = said({'src/a.ts': reached_file(couldntTell=[2, 3], reason='n1'), 'src/q.wasm': {**q, 'reason': f'n1; {why}'}}, ['n1'])
        self.assertTrue(both.startswith("Couldn't tell whether 2 changed source lines ran, or whether the change to 1 binary file ran, since n1."), both)
        alone = self.reach_comment({'files': {'src/q.wasm': q}, 'notes': []})
        self.assertNotIn(self.FOLD, alone)
        self.assertNotIn('adds or edits no line', alone)
        text = self.reach_comment({'files': {'src/q.wasm': {**q, 'reason': f'n1; {why}'}}, 'notes': ['n1']})
        self.assertIn(f"\n\n`src/q.wasm`: couldn't tell whether its change ran, since {pr_comment.inert(why)}, besides the reasons above.\n\n", text[text.index(self.FOLD):])

    def test_a_change_with_no_source_line_or_a_join_that_couldnt_be_made_says_so_alone(self):
        self.assertEqual(said({}), "This change adds or edits no line under `src/`.")
        self.assertEqual(view_reach.reach_paragraph({'couldnt': "no share brought its reach home"}),
                         "Couldn't tell which of this change's source lines ran: no share brought its reach home.")
        long = 'x ' * 400
        text = view_reach.reach_paragraph({'couldnt': long})
        m = re.fullmatch(r"Couldn't tell which of this change's source lines ran: ((?:x )+x) \(the reason's first ([0-9]+) of 799 characters\)\. "
                         r"The whole reason is in the fold below\.", text)
        self.assertEqual((len(m[1]), int(m[2]) <= view_reach.LISTED), (int(m[2]), True))


if __name__ == '__main__':
    unittest.main()

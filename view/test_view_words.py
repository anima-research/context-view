"""The comment's fixed words (view_words.py): its opening, counts and folds, a head that couldn't be compared, the
forced, held and differing lines, the flags, the reader's changes, and text cut to fit."""
import json, os, re, unittest

import pr_comment
import pr_review
import view as cv
import view_words
from fixtures import AF, ALL_RAN, BASE, H1, HARNESS, M, READS, Steps, entry, nesting, read_file, result


class Words(Steps):
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
               'The records of 2 of the 2 runs it could compare differ between the base and this head.\n\nAll 2 of this change\'s changed source lines that map to code ran in at least one profiled drive.\n\n'
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
                                        "The records of 1 of the 1 run it could compare differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n2 runs "
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
               "The records of the 2 runs it could compare don't differ between the base and this head.\n\nAll 2 of this change\'s changed source lines that map to code ran in at least one profiled drive.\n\n"
               "1 run couldn't be compared; its reason is below.\n\n"
               "<details><summary>Runs that couldn&#x27;t be compared (1)</summary>\n\nThis head couldn't be compared at `H1/W2`: "
               "the head couldn't run it (r2).\n\n</details>\n\n"
               "Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, ")
        self.assertTrue(text.startswith(top), text[:900])
        self.assertTrue(text.split('\n\n')[-1].startswith('<!--'))
        self.assertEqual(text.count("couldn't be compared at `H1/W2`"), 1)

    def test_the_flags_line_counts_the_flags_with_the_runs_they_re_in_apart_from_the_records(self):
        two = {'flags': [{'run': 'A', 'new': [{}, {}], 'gone': []}, {'run': 'B', 'new': [], 'gone': [{}]}, {'run': 'C', 'new': [], 'gone': []}]}
        self.assertEqual(view_words.flags_line(two, 3), 'Separately, 3 of the checks\' flags differ between the base and the head, in 2 runs; '
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
                      + pr_comment.inert('Later requests in that turn carry it, @maintainer, #3 <b>') + ".\n\n<details>", text)
        self.assertNotIn(' @maintainer', text)
        self.assertNotIn('<b>', text)
        bare = self.comment(self.changed_run(), {'changes': [{k: v for k, v in reader['changes'][0].items() if k != 'also'}]})
        self.assertNotIn('Also in', bare)

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
        [fold] = view_words.run_folds({'order': [run]}, reader, entries, 10_000)
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
        self.assertIn("/CHECKS.md).\n\nThe records of 1 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n"
                      "*A model's account of those records:*\n\n**Delta 1: T**\n\nw.\n\n- base (`main`): b0.\n- head (`aaaaaaaaaaaa`): h0."
                      "\n\n<details>", text)
        self.assertIn('<details><summary>Runs whose records differ: 1 of 3, with 1 change</summary>\n\n'
                      '<details><summary><code>H1/W1</code>: 1 change</summary>\n\n', text)
        self.assertNotIn("couldn't be compared", text)
        self.assertNotIn('Checks&#x27; flags', text)

    def test_where_both_arms_forced_one_range_a_line_after_the_count_says_so_and_that_a_difference_or_a_failure_may_come_from_it(self):
        ask = lambda has: {'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': has}
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [ask('0.26.0')], 'head': [ask('0.26.1')]})
        view = self.facts(d)
        self.assertEqual((view['forced'], view['pack']), ({'base': [ask('0.26.0')], 'head': [ask('0.26.1')]}, '@animalabs/context-manager'))
        said = ("In both arms, the view laid context\\-manager over `^0.25.0` from agent\\-framework, a range that neither the base's `0.26.0` nor "
                "the head's `0.26.1` meets: it could choose no release of agent\\-framework that admits them. So any difference or failure this view shows may come from that range, and the view can't tell whether it does.")
        self.assertIn(f"The records of the 3 runs don't differ between the base and this head.\n\n{said}\n\n{ALL_RAN}", self.comment(d))

    def test_where_one_arm_forced_a_range_the_line_names_that_arm_and_that_a_difference_may_come_from_it(self):
        ask = {'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [], 'head': [ask]})
        said = ("In the head, the view laid context\\-manager `0.26.0` over `^0.25.0` from agent\\-framework, a range that version doesn't meet: "
                "it could choose no release of agent\\-framework that admits it. So any difference this view shows, or any failure in the head, may come from that range, and the view can't tell whether it does.")
        self.assertIn(f"The records of the 3 runs don't differ between the base and this head.\n\n{said}\n\n{ALL_RAN}", self.comment(d))
        base = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [ask], 'head': []})
        self.assertIn("In the base, the view laid context\\-manager `0.26.0` over `^0.25.0` from agent\\-framework, a range that version doesn't meet: "
                      "it could choose no release of agent\\-framework that admits it. So any difference this view shows, or any failure in the base or of a checkpoint, may come from that range, and the view can't tell whether it does.", self.comment(base))
        self.assertNotIn('any failure in the head', self.comment(base))
        self.assertNotIn('checkpoint', self.comment(d))
        plain = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])])
        self.assertNotIn('forced', self.facts(plain))
        self.assertNotEqual(cv.result_of(self.facts(d)), cv.result_of(self.facts(plain)), 'a comment naming a forced range is never kept under one that names none')

    def test_the_forced_line_speaks_of_those_ranges_where_there_are_more_than_one(self):
        ask = lambda has, wanted=f'node_modules/{AF}', rng='^0.25.0': {'range': rng, 'wantedBy': wanted, 'has': has}
        two = [ask('0.26.0'), ask('0.26.0', 'node_modules/@animalabs/chronicle', '^0.24.0 || ^0.25.0')]
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': two, 'head': two})
        comment = self.comment(d)
        self.assertIn("ranges that neither the base's `0.26.0` nor the head's `0.26.0` meets: it could choose no release of agent\\-framework and chronicle that admits them. "
                      "So any difference or failure this view shows may come from those ranges, and the view can't tell whether it does.", comment)
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [], 'head': two})
        self.assertIn("ranges that version doesn't meet: it could choose no release of agent\\-framework and chronicle that admits it. "
                      "So any difference this view shows, or any failure in the head, may come from those ranges, and the view can't tell whether it does.", self.comment(d))
        self.assertNotIn('No resident', self.comment(d))

    def test_where_both_arms_forced_differently_each_arm_is_said_with_its_own_version_askers_and_ranges(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={
            'base': [{'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}],
            'head': [{'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.27.0'}, {'range': '^0.26.0', 'wantedBy': 'node_modules/@animalabs/membrane', 'has': '0.27.0'}]})
        said = ("In the base, the view laid context\\-manager `0.26.0` over `^0.25.0` from agent\\-framework, a range that version doesn't meet: it "
                "could choose no release of agent\\-framework that admits it. In the head, the view laid context\\-manager `0.27.0` over `^0.25.0` from "
                "agent\\-framework and `^0.26.0` from membrane, ranges that version doesn't meet: it could choose no release of agent\\-framework and "
                "membrane that admits it. So any difference this view shows may come from the ranges named for either arm, and the view can't tell whether it does. Any failure in an arm may come from that arm's own ranges. "
                "A checkpoint's failure may come from the base's ranges. The view can't tell whether either does.")
        self.assertIn(f"\n\n{said}\n\n", self.comment(d))

    def test_an_asker_the_view_chose_is_named_as_a_package_where_no_release_of_it_could_be_chosen_and_once(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [], 'head': [
            {'range': '^0.34.0', 'wantedBy': f'{AF}@0.33.0', 'has': '0.26.0'}, {'range': '>=0.25.0 <0.26.0', 'wantedBy': f'{AF}@0.33.0', 'has': '0.26.0'}]})
        comment = self.comment(d)
        self.assertIn("over `^0.34.0` from agent\\-framework `0.33.0` and `>=0.25.0 <0.26.0` from agent\\-framework `0.33.0`, ranges that version "
                      "doesn't meet: it could choose no release of agent\\-framework that admits it.", comment)

    def test_the_same_forced_ranges_in_another_order_in_each_arm_are_said_as_both_arms_alike(self):
        a = {'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}
        b = {'range': '^0.24.0 || ^0.25.0', 'wantedBy': 'node_modules/@animalabs/chronicle', 'has': '0.26.0'}
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [a, b], 'head': [b, a]})
        self.assertIn("In both arms, the view laid context\\-manager over `^0.25.0` from agent\\-framework and `^0.24.0 || ^0.25.0` from chronicle, "
                      "ranges that neither the base's `0.26.0` nor the head's `0.26.0` meets", self.comment(d))

    def test_where_none_of_its_runs_could_be_compared_the_forced_line_still_says_what_the_view_laid_and_that_a_failure_may_come_from_it(self):
        ask = {'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}
        d = self.run_dir([([result(run, outcome='couldnt-run', reason='x') for run in ('H1/W1', 'H1/W2', 'C6h/W11')], [])], forced={'base': [ask], 'head': [ask]})
        self.assertIn("In both arms, the view laid context\\-manager over `^0.25.0` from agent\\-framework, a range that neither the base's `0.26.0` nor "
                      "the head's `0.26.0` meets: it could choose no release of agent\\-framework that admits them. So any difference or failure this view shows may come from that range, and the view can't tell whether it does.",
                      self.comment(d))

    def test_a_nested_copy_that_asks_is_named_as_the_copy_it_is_and_said_to_be_one_the_view_chooses_no_release_of(self):
        d = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [], 'head': [
            {'range': '^0.25.0', 'wantedBy': 'node_modules/@animalabs/chronicle/node_modules/@animalabs/membrane', 'has': '0.26.0'}]})
        said = self.comment(d)
        self.assertIn("In the head, the view laid context\\-manager `0.26.0` over `^0.25.0` from chronicle's membrane, a range that version doesn't "
                      "meet: the view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's "
                      "lockfile holds them at its top level, so it couldn't choose a release of chronicle's membrane.", said)
        self.assertNotIn('could choose no release of chronicle', said)
        two = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [], 'head': [
            {'range': '^0.25.0', 'wantedBy': 'node_modules/@animalabs/chronicle/node_modules/@animalabs/membrane', 'has': '0.26.0'},
            {'range': '^0.24.0', 'wantedBy': 'node_modules/@animalabs/mcpl', 'has': '0.26.0'}]})
        self.assertIn("so it couldn't choose a release of chronicle's membrane and mcpl.", self.comment(two))
        workspace = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [], 'head': [
            {'range': '^0.24.0', 'wantedBy': 'packages/plugin', 'has': '0.26.0'}]})
        self.assertIn("over `^0.24.0` from packages\\/plugin, a range that version doesn't meet: the view chooses releases only of agent-framework, "
                      "context-manager, membrane and chronicle where connectome-host's lockfile holds them at its top level, so it couldn't choose a "
                      "release of packages\\/plugin.", self.comment(workspace))
        both = self.run_dir([([result('H1/W1'), result('H1/W2'), result('C6h/W11')], [])], forced={'base': [], 'head': [
            {'range': '^0.25.0', 'wantedBy': 'node_modules/@animalabs/chronicle/node_modules/@animalabs/membrane', 'has': '0.26.0'},
            {'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}]})
        self.assertIn("ranges that version doesn't meet: it could choose no release of agent\\-framework that admits it, and the view chooses releases only "
                      "of agent-framework, context-manager, membrane and chronicle where connectome-host's lockfile holds them at its top level, so it "
                      "couldn't choose a release of chronicle's membrane.", self.comment(both))

    def test_where_the_arms_ran_different_releases_besides_the_head_a_line_after_the_count_says_which_why_and_that_a_difference_may_be_theirs(self):
        stack = {'base': {}, 'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None},
                                                                                         {'range': '^0.8.0 || ^0.9.0', 'wantedBy': f'node_modules/{AF}'}],
                                          'missed': {'package': M, 'range': '^0.9.0', 'wantedBy': None, 'has': '0.8.0'}}}}
        d = self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'}, stack)
        view = self.facts(d)
        self.assertEqual((view['differing'], view['held']), ([{'package': 'membrane', 'base': '0.8.0', 'head': '0.9.0'}],
                                                             {'agent-framework': '0.32.0', 'chronicle': '0.5.1'}))
        said = ("Besides this head, the arms ran different releases of membrane: `0.8.0` in the base and `0.9.0` in the head. The view "
                "chose the head's membrane `0.9.0`, since connectome-host's lockfile holds `0.8.0`, which doesn't meet `^0.9.0` from this head. So a "
                "difference this view shows may come from membrane as well as from this head, and it can't tell which.")
        self.assertIn(f"The records of the 3 runs don't differ between the base and this head.\n\n{said}\n\n{ALL_RAN}\n\nHeld the same in base and head: "
                      "connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`.", self.comment(d))
        changed = self.chosen_run({}, {'membrane': '0.9.0 (sha512-m)'}, stack, reached=entry('aaaaaaaaaaaa', ('H1/W1', 4)))
        text = self.comment(changed, {'changes': [{'title': 'T', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'b', 'after': 'a'}]})
        self.assertIn(f"The records of 1 of the 3 runs differ between the base and this head.\n\n{said}\n\n{ALL_RAN}\n\n*A model's account of those records:*", text)
        asker = {'base': {}, 'head': {AF: {'version': '0.34.0', 'host': '0.32.0', 'ranges': [], 'asks': '^0.24.0 || ^0.25.0',
                                           'missed': {'package': '@animalabs/context-manager', 'range': '^0.24.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.25.0'}}}}
        self.assertIn("Besides this head, the arms ran different releases of agent\\-framework: `0.32.0` in the base and `0.34.0` in the head. "
                      "The view chose the head's agent\\-framework `0.34.0`, since connectome-host's lockfile holds `0.32.0`, and with it "
                      "agent\\-framework asks for context\\-manager `^0.24.0`, which the head's `0.25.0` doesn't meet. So a difference this view shows may come from "
                      "agent\\-framework as well as from this head, and it can't tell which.",
                      self.comment(self.chosen_run({}, {'agent-framework': '0.34.0 (sha512-a)'}, asker)))
        both = {'base': {M: {'version': '0.7.9', 'host': '0.8.0', 'ranges': [{'range': '~0.7.9', 'wantedBy': None}],
                             'missed': {'package': M, 'range': '~0.7.9', 'wantedBy': None, 'has': '0.8.0'}}},
                'head': {M: {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.9.0', 'wantedBy': None}]},
                         AF: {'version': '0.34.0', 'host': '0.32.0', 'ranges': [{'range': '^0.34.0', 'wantedBy': f'{M}@0.9.0'}],
                              'missed': {'package': AF, 'range': '^0.34.0', 'wantedBy': f'{M}@0.9.0', 'has': '0.32.0'}}}}
        self.assertIn("Besides this head, the arms ran different releases of agent\\-framework and membrane: agent\\-framework `0.32.0` in the "
                      "base and `0.34.0` in the head; membrane `0.7.9` in the base and `0.9.0` in the head. The view chose the head's "
                      "agent\\-framework `0.34.0`, since connectome-host's lockfile holds `0.32.0`, which doesn't meet `^0.34.0` from membrane `0.9.0`. The view chose "
                      "the base's membrane `0.7.9`, since connectome-host's lockfile holds `0.8.0`, which doesn't meet `~0.7.9` from the base. The view chose the head's "
                      "membrane `0.9.0`, where connectome-host's lockfile has `0.8.0`. So a difference this view shows may come from "
                      "agent\\-framework and membrane as well as from this head, and it can't tell which.",
                      self.comment(self.chosen_run({'membrane': '0.7.9 (sha512-o)'}, {'membrane': '0.9.0 (sha512-m)', 'agent-framework': '0.34.0 (sha512-a)'}, both)))

    def test_a_release_both_arms_ran_that_the_plan_chose_is_held_saying_why_and_no_line_above(self):
        chosen = {'version': '0.9.0', 'host': '0.8.0', 'ranges': [{'range': '^0.8.1', 'wantedBy': None}]}
        missed = {**chosen, 'missed': {'package': M, 'range': '^0.8.1', 'wantedBy': None, 'has': '0.8.0'}}
        for stack, why in (({'base': {M: chosen}, 'head': {M: missed}}, "since connectome-host's lockfile holds `0.8.0`, which doesn't meet `^0.8.1` from this head"),
                           ({'base': {M: chosen}, 'head': {M: chosen}}, "where connectome-host's lockfile has `0.8.0`")):
            with self.subTest(why):
                d = self.chosen_run({'membrane': '0.9.0 (sha512-m)'}, {'membrane': '0.9.0 (sha512-m)'}, stack)
                view = self.facts(d)
                self.assertEqual(view['held'], {'agent-framework': '0.32.0', 'chronicle': '0.5.1', 'membrane': '0.9.0'})
                self.assertNotIn('differing', view)
                text = self.comment(d)
                self.assertIn("Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, agent\\-framework `0.32.0`, chronicle `0.5.1`, "
                              f"membrane `0.9.0` (the view chose it for both arms, {why}).", text)
                self.assertNotIn('Besides this head', text)

    def test_no_entry_differing_in_runs_all_compared_says_the_records_show_no_request_changed_then_what_was_held(self):
        text = self.comment(self.unchanged_run(quarantines={'compression': 0, 'merge': 1}))
        self.assertTrue(text.startswith(f'**Automatic context view** of `{H1[:12]}` merged onto `{BASE[:12]}`.\n\n'
                                        + f'What a context view runs and what its checks judge: [CHECKS.md](https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md).' + '\n\n'
                                        "The records of the 3 runs don't differ between the base and this head.\n\nAll 2 of this change\'s changed source lines that map to code ran in at least one profiled drive.\n\n"
                                        "Held the same in base and head: connectome\\-host `eeeeeeeeeeee`, "), text[:700])
        self.assertEqual(len(text.split('\n\n')), 6)
        self.assertNotIn('<details>', text)

    def test_a_part_an_arms_stack_can_t_run_is_named_with_its_run_and_arm_after_the_count_so_no_reader_takes_it_for_one_that_passed(self):
        # A host bump: the base's stack lacks both modules and the head's has them, so the run's record differs.
        bump = self.run_dir([([result('H1/W1', record='differs', baseAbsent=['suppression', 'onboarding']), result('H1/W2'), result('C6h/W11')],
                              [entry('aaaaaaaaaaaa', ('H1/W1', 3))])])
        self.assertIn("The records of 1 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n"
                      "Parts left out where an arm's stack doesn't bring what they need: `H1/W1`'s suppression and onboarding on the base.\n\n"
                      "*A model's account of those records:*", self.comment(bump, self.reader('aaaaaaaaaaaa')))
        # Neither arm's stack has them, so both leave them out and the record doesn't differ.
        both = self.run_dir([([result('H1/W1', absent=['suppression', 'onboarding'], baseAbsent=['suppression', 'onboarding']), result('H1/W2'),
                               result('C6h/W11')], [])])
        self.assertIn("The records of the 3 runs don't differ between the base and this head.\n\nAll 2 of this change\'s changed source lines that map to code ran in at least one profiled drive.\n\n"
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
                 ('needs-companion', {'arm': 'head', 'package': '@animalabs/chronicle', 'range': '^0.7.0', 'wantedBy': f'{AF}@0.34.0', 'has': '0.6.0',
                                      'why': 'no-release', 'release': '@animalabs/chronicle', 'ranges': [{'range': '^0.7.0', 'wantedBy': f'{AF}@0.34.0'}]},
                  "This head couldn't be compared: agent\\-framework `0.34.0`, which the view chose for the head, asks for chronicle `^0.7.0`, "
                  "and no published release of chronicle meets it."),
                 ('needs-companion', {'arm': 'head', 'package': '@animalabs/chronicle', 'range': '^0.7.0', 'wantedBy': f'{AF}@0.34.0', 'has': '0.6.0',
                                      'why': 'no-release', 'release': '@animalabs/chronicle', 'ranges': []},
                  "This head couldn't be compared: agent\\-framework `0.34.0`, which the view chose for the head, asks for chronicle `^0.7.0`, "
                  "and chronicle has no published release."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': 'github:antra-tess/membrane#v0.9.0', 'wantedBy': None, 'has': '0.8.0',
                                      'why': 'not-plain'},
                  "This head couldn't be compared: it asks for membrane `github:antra-tess/membrane#v0.9.0`, which isn't a version range, so "
                  "the view can't choose a release to meet it."),
                 ('needs-companion', {'arm': 'base', 'package': M, 'version': '0.9.0', 'range': '^0.8.0', 'wantedBy': 'node_modules/optional-user',
                                      'has': '0.9.0', 'why': 'no-mover'},
                  "This head couldn't be compared: optional\\-user in the host's stack asks for membrane `^0.8.0`, and the base's is "
                  "`0.9.0`. The view chooses releases only of agent-framework, context-manager, membrane and chronicle where "
                  "connectome-host's lockfile holds them at its top level, so it can't change that."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': '^0.8.0', 'wantedBy': 'node_modules/@animalabs/agent-framework',
                                      'has': None, 'why': 'no-mover'},
                  "This head couldn't be compared: agent\\-framework in the host's stack asks for membrane `^0.8.0`, and the head's "
                  "`package.json` gives no version."),
                 ('needs-companion', {'arm': 'base', 'package': '@animalabs/chronicle', 'range': '0.6.0', 'wantedBy': '@animalabs/context-manager@0.25.0',
                                      'has': '0.7.0', 'why': 'unsettled', 'tried': {'@animalabs/context-manager': '0.25.0', '@animalabs/chronicle': '0.6.0'}},
                  "This head couldn't be compared: context\\-manager `0.25.0`, which the view chose for the base, asks for chronicle `0.6.0`, "
                  "and choosing releases for the arms came back to choices it had already made, so it stopped there. The base's were "
                  "chronicle `0.6.0` and context\\-manager `0.25.0`."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': '^0.8.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.9.0', 'why': 'unsettled',
                                      'tried': {}},
                  "This head couldn't be compared: agent\\-framework in the host's stack asks for membrane `^0.8.0`, and choosing releases for "
                  "the arms came back to choices it had already made, so it stopped there."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': '^0.8.0', 'wantedBy': 'packages/tools', 'has': '0.9.0', 'why': 'no-mover'},
                  "This head couldn't be compared: packages\\/tools in the host's stack asks for membrane `^0.8.0`, and the head's is `0.9.0`. "
                  "The view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's "
                  "lockfile holds them at its top level, so it can't change that."),
                 ('needs-companion', {'arm': 'head', 'package': M, 'range': '^0.8.0', 'wantedBy': 'node_modules/@animalabs/mcpl-core', 'has': '0.9.0',
                                      'why': 'no-mover'},
                  "This head couldn't be compared: mcpl\\-core in the host's stack asks for membrane `^0.8.0`, and the head's is `0.9.0`. "
                  "The view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's "
                  "lockfile holds them at its top level, so it can't change that."),
                 ('needs-companion', {'arm': 'head', 'package': '@animalabs/mcpl-core', 'range': '^0.5.0', 'wantedBy': None, 'has': '0.4.0', 'why': 'no-mover'},
                  "This head couldn't be compared: it asks for mcpl\\-core `^0.5.0`, and the head's is `0.4.0`. The view chooses releases only "
                  "of agent-framework, context-manager, membrane and chronicle where connectome-host's lockfile holds them at its top level, so "
                  "it can't change that."),
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
                      f"({pr_comment.inert('no request bodies were saved in /w/on')}).", text)
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
        self.assertIn(f"({pr_comment.inert(chr(39).join(['the head', 's run failed: alike up to the cut (cut by the harness); the base', 's run failed: alike up to the cut (cut by the harness)']))}).", cut)
        self.assertIn(f"({pr_comment.inert(chr(39).join(['both arms', ' runs failed: cut the same (cut by the harness)']))}).", cut)
        self.assertIn(f"({pr_comment.inert(chr(39).join(['both arms', ' runs failed: said alike']))}).", cut)
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed) "
                      f"({pr_comment.inert(chr(39).join(['the head', 's run failed: the stand-in got a request it couldn', 't classify (r6)']))}).", text)
        self.assertIn(f"couldn't be compared at `H1/W2`: the run didn't measure (on the base, the run failed) ({pr_comment.inert(chr(39).join(['the base', 's run failed: boot 1 exited 1']))}).", text)
        self.assertIn("couldn't be compared at `C6h/W11`: the run didn't measure (on the head, the run failed; on the base, the run failed) "
                      f"({pr_comment.inert(chr(39).join(['the head', 's run failed: the head said this; the base', 's run failed: the base said this']))}).", text)
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed; on the base, the run failed) "
                      f"({pr_comment.inert(chr(39).join(['both arms', ' runs failed: both said this']))}).", both)
        self.assertIn("couldn't be compared at `H1/W2`: the run didn't measure (on the head, the run failed; on the base, the run failed) "
                      f"({pr_comment.inert(chr(39).join(['the head', 's run failed: only the head said why']))}).", both)
        self.assertIn("couldn't be compared at `H1/W1`: the run didn't measure (on the head, the run failed; on the base, its folds were clamped "
                      f"\\(check 10\\)) ({pr_comment.inert(chr(39).join(['the head', 's run failed: the head said this']))}).", others)
        self.assertIn("couldn't be compared at `H1/W2`: the run didn't measure (on the head, the run failed and check 4 \\(coverage\\) judged "
                      f"nothing) ({pr_comment.inert(chr(39).join(['the head', 's run failed: the head said this']))}).", others)
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
                said = view_words.clipped(words, text, 65_000)
                n = int(re.search(r"'s first ([0-9,]+) of 100,000 characters", said)[1].replace(',', ''))
                self.assertLessEqual(len(said), 65_000)
                self.assertGreater(len(words(text[:n + 1], f"'s first {n + 1:,} of 100,000 characters")), 65_000)

    def test_a_flag_cut_counts_only_the_characters_it_shows_even_between_its_name_and_its_detail(self):
        view = {'flags': [{'run': 'H1/W1', 'new': [{'check': 'kv', 'step': 3, 'what': 'a pin moved', 'detail': 'z' * 50}], 'gone': []}]}
        line = '- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base'
        counted = set()
        for room in range(len(line) + len(" (the flag's first 0 of 63 characters)"), len(line) + 100):
            said = view_words.flags_text(view, room)[1]
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
            said = view_words.flags_text(view, room)[1]
            m = re.fullmatch(re.escape(line) + r"(?:: (.*))? \(the flag's first ([0-9,]+) of 63 characters\)", said)
            if m:
                shown = pr_comment.readable(m[1] or '')
                self.assertEqual(int(m[2]), len(shown), (room, said))
                counted.add(int(m[2]))
        self.assertIn(11, counted)
        self.assertTrue(any(n > 13 for n in counted))
        self.assertEqual(view_words.flags_text(view, 1000)[1], line + ': a pin moved\\: ' + 'z' * 50)

    def test_a_flag_with_no_words_is_listed_by_its_check_and_place(self):
        view = {'flags': [{'run': 'H1/W1', 'new': [{'check': 'kv', 'step': 3}, {'check': 'k2', 'step': 4, 'what': ' \n', 'detail': ''}],
                           'gone': []}]}
        try:
            said = view_words.flags_text(view, 1000)[1:]
        except Exception as e:
            self.fail(f'a flag with no words broke the flags: {e!r}')
        self.assertEqual(said,
                         ['- `H1/W1` step `3`, check `kv` flagged on the head 1 more time than on the base',
                          '- `H1/W1` step `4`, check `k2` flagged on the head 1 more time than on the base'])

    def test_identical_flags_in_one_run_at_one_step_on_one_side_are_one_line_saying_how_many_times(self):
        same = {'check': 4, 'step': '405389.11', 'what': 'more-than-once', 'detail': '1 message(s) reach the request more than once'}
        said = pr_comment.inert('more-than-once: 1 message(s) reach the request more than once')
        view = {'flags': [{'run': 'C6h/W9', 'new': [same, dict(same), dict(same, step='405389.12'), dict(same, step='405389.12'),
                                                    dict(same, step='405389.12'), dict(same, check=11), same],
                           'gone': [dict(same)]},
                          {'run': 'C6h/W10', 'new': [dict(same)], 'gone': []}]}
        self.assertEqual(view_words.flags_text(view, 1000)[1:], [
            '- `C6h/W9` step `405389.11`, check `4` flagged on the head 3 more times than on the base: ' + said,
            '- `C6h/W9` step `405389.12`, check `4` flagged on the head 3 more times than on the base: ' + said,
            '- `C6h/W9` step `405389.11`, check `11` flagged on the head 1 more time than on the base: ' + said,
            '- `C6h/W9` step `405389.11`, check `4` flagged on the base 1 more time than on the head: ' + said,
            '- `C6h/W10` step `405389.11`, check `4` flagged on the head 1 more time than on the base: ' + said])
        apart = {'flags': [{'run': 'C6h/W9', 'new': [dict(same, whole='a' * 40), dict(same, whole='b' * 40)], 'gone': []}]}
        self.assertEqual([l.split(' on the head')[0] for l in view_words.flags_text(apart, 1000)[1:]],
                         ['- `C6h/W9` step `405389.11`, check `4` (another line of this run shows the same text for a different flag) flagged'] * 2)
        three = {'flags': [{'run': 'C6h/W9', 'new': [dict(same, whole='a' * 40), dict(same, whole='a' * 40), dict(same, whole='b' * 40)],
                            'gone': []}]}
        self.assertEqual([l.split(': ')[0] for l in view_words.flags_text(three, 1000)[1:]], [
            '- `C6h/W9` step `405389.11`, check `4` (another line of this run shows the same text for a different flag) flagged on the head 2 more times than on the base',
            '- `C6h/W9` step `405389.11`, check `4` (another line of this run shows the same text for a different flag) flagged on the head 1 more time than on the base'])
        for field in ('what', 'detail'):
            alone = {'flags': [{'run': 'C6h/W9', 'new': [same, dict(same, **{field: 'other'})], 'gone': []}]}
            self.assertEqual(len(view_words.flags_text(alone, 1000)[1:]), 2, field)
        past = {'flags': [{'run': 'C6h/W9', 'new': [dict(same, whole='a' * 12)], 'gone': [dict(same, whole='b' * 12)]},
                          {'run': 'C6h/W10', 'new': [dict(same, whole='a' * 12), dict(same, whole='b' * 12)], 'gone': [dict(same, step='9')]}]}
        lines = view_words.flags_text(past, 1000)[1:]
        mark = ' (another line of this run shows the same text for a different flag)'
        self.assertEqual([l.split(' flagged')[0] for l in lines], [
            '- `C6h/W9` step `405389.11`, check `4`' + mark, '- `C6h/W9` step `405389.11`, check `4`' + mark,
            '- `C6h/W10` step `405389.11`, check `4`' + mark, '- `C6h/W10` step `405389.11`, check `4`' + mark,
            '- `C6h/W10` step `9`, check `4`'])
        split = {'flags': [{'run': 'C6h/W9', 'new': [{'check': 4, 'step': 'the run', 'what': 'x', 'detail': 'y'},
                                                    {'check': 4, 'detail': 'x: y'}], 'gone': []}]}
        self.assertEqual([l.split(' flagged')[0] for l in view_words.flags_text(split, 1000)[1:]],
                         ['- `C6h/W9`, check `4` (another line of this run shows the same text for a different flag)'] * 2)
        gone = {'flags': [{'run': 'C6h/W9', 'new': [], 'gone': [same, dict(same)]}]}
        self.assertEqual(view_words.flags_text(gone, 1000)[1:], [
            '- `C6h/W9` step `405389.11`, check `4` flagged on the base 2 more times than on the head: ' + said])
        twice = {'flags': [{'run': 'C6h/W9', 'new': [same, dict(same)], 'gone': []}]}
        self.assertEqual(view_words.flags_text(twice, 1000)[1:], [
            '- `C6h/W9` step `405389.11`, check `4` flagged on the head 2 more times than on the base: ' + said])
        self.assertTrue(view_words.flags_line(view, 9).startswith("Separately, 9 of the checks' flags differ between the base and the head, in 2 runs;"),
                        view_words.flags_line(view, 9))

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
        return view_words.could_not(view, len(line))

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
                self.assertEqual(view_words.flags_text(view, len(said) + spare)[1], said)

    def test_a_cut_log_line_counts_what_shows_of_its_code_spans(self):
        view = lambda log: {'outcome': 'arm-missing', 'jobs': 2, 'detail': {'share': 1, 'arm': 'after', 'log': log}}
        whole = view_words.could_not(view('q'), 1000)[0]
        lead = whole[:-len(' (its last log line: q).')]
        line = lead + " (its last log line's first 14 of 311 characters: see ` a ` here www)."
        self.assertEqual(view_words.could_not(view('see ` a ` here ' + 'w' * 300), len(line)), [line])

    def test_a_cut_quote_counts_its_control_characters_as_they_show(self):
        change = {'title': 't', 'where': 'w', 'base': 'b0', 'head': 'h0', 'refs': ['aaaaaaaaaaaa'], 'before': 'ab\x07cd\x1b[0m' + 'e' * 400, 'after': '',
                  'place': {'run': 'H1/W1', 'step': 1}}
        text = view_words.change_block(change, {'aaaaaaaaaaaa': {'places': [{'run': 'H1/W1', 'step': 1}]}}, 'H1/W1', 'H1/W1', 300)
        cut = re.search(r"Before, its first ([0-9,]+) of ([0-9,]+) characters:\n\n```text\n(.*?)\n```", text, re.S)
        self.assertEqual((int(cut[1]), int(cut[2])), (len(cut[3]), 415), text)
        self.assertTrue(cut[3].startswith('ab\\x07cd\\x1b[0m'), cut[3])
        self.assertLessEqual(len(text), 300)

    def test_a_reason_with_room_for_none_of_its_characters_still_says_it_was_cut(self):
        view = {'outcome': 'ran', 'broken': [{'run': 'H1/W1', 'what': 'head', 'reason': 'x' * 100}]}
        zero = "This head couldn't be compared at `H1/W1`: the head couldn't run it (the reason's first 0 of 100 characters)."
        self.assertEqual(view_words.could_not(view, len(zero) + 2), [zero])

    def test_differing_records_show_the_readers_account_and_each_change_under_each_run_counted_from_its_entries_places(self):
        text = self.comment(self.changed_run(), self.reader())
        self.assertIn("The records of 2 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map to code ran in at least one profiled drive.\n\n*A model's account of those records:*", text)
        self.assertIn('- base (`main`): It changes the order of requests `@maintainer`\\, `#3`.\n- head (`aaaaaaaaaaaa`): The summariser gets '
                      'merge requests first.\n\n<details>', text)
        self.assertIn('<details><summary><code>H1/W1</code>: 1 change</summary>\n\n*Merges go first*\n\n'
                      'At 2 steps; the quotes are from step `7`.\n\nBefore:\n\n'
                      '````text\ncall 1 ```x``` </details>\n````\n\nAfter: none.\n\n</details>', text)
        self.assertIn('<details><summary><code>H1/W2</code>: 1 change</summary>\n\n*Merges go first*\n\n'
                      'At step `4`. Its before and after are quoted under `H1/W1`, at step `7`.'
                      '\n\n</details>', text)

    def test_where_records_differ_the_forced_line_still_says_what_the_view_laid_and_that_a_difference_may_come_from_it(self):
        e1 = [entry('aaaaaaaaaaaa', ('H1/W2', 4))]
        e2 = [entry('aaaaaaaaaaaa', ('H1/W1', 7), before='first old', after='new text'), entry('bbbbbbbbbbbb', ('H1/W1', 9))]
        d = self.run_dir([([result('H1/W2', record='differs')], e1), ([result('H1/W1', record='differs'), result('C6h/W11')], e2)],
                         forced={'base': [], 'head': [{'range': '^0.25.0', 'wantedBy': f'node_modules/{AF}', 'has': '0.26.0'}]})
        self.assertIn("The records of 2 of the 3 runs differ between the base and this head.\n\nIn the head, the view laid context\\-manager `0.26.0` over "
                      "`^0.25.0` from agent\\-framework, a range that version doesn't meet: it could choose no release of agent\\-framework that admits it. "
                      "So any difference this view shows, or any failure in the head, may come from that range, and the view can't tell whether it does.\n\n",
                      self.comment(d, self.reader()))

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

    def test_differing_records_without_a_reader_account_say_which_runs_differ_and_how_an_account_is_asked_for_and_no_account(self):
        text = self.comment(self.changed_run())
        self.assertIn("The records of 2 of the 3 runs differ between the base and this head.\n\nAll 2 of this change's changed source lines that map "
                      f"to code ran in at least one profiled drive.\n\n{view_words.UNREAD}\n\n<details><summary>Runs whose records differ: 2 of 3</summary>\n\n"
                      "`H1/W1` and `H1/W2`.\n\n</details>", text)
        for account in ("A model's account of those records", 'Delta 1', '<code>H1/W1</code>: '):
            self.assertNotIn(account, text)
        self.assertIn('`/context-deltas`', view_words.UNREAD)
        self.assertIn('`nissa-seru`', view_words.UNREAD)

    def test_the_comment_with_no_reader_names_what_asks_for_a_view_and_who_may_as_the_poll_serves_them(self):
        import poll
        self.assertEqual(poll.COMMAND, view_words.COMMAND)
        self.assertIs(poll.ASKERS, view_words.ASKERS)
        self.assertIn(f'with a `{view_words.COMMAND}` comment by ', view_words.UNREAD)
        for asker in view_words.ASKERS:
            self.assertIn(f'`{asker}`', view_words.UNREAD)

    def test_a_reader_account_without_differing_records_fails(self):
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


if __name__ == '__main__':
    unittest.main()

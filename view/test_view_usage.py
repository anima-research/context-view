"""The view's usage (view_usage.py): each arm's usage read and checked, and the agents' figures, their list price and the
runs whose figures moved, as the comment shows them."""
import json, re, unittest

import pr_comment
import pr_review
import view as cv
import view_usage as cu
from test_view import ALL_RAN, Steps, priced, result, usage


class Usage(Steps):
    def test_the_agents_usage_shows_above_the_fold_the_same_on_both_sides_with_its_figures_and_what_they_model(self):
        runs = [result('H1/W1', usage=usage()), result('H1/W2', usage=usage()), result('C6h/W11', usage=usage())]
        text = self.comment(self.run_dir([(runs, [])], base_results=runs))
        self.assertIn(f"between the base and this head.\n\n{ALL_RAN}\n\n" "Usage: the figures of the agents' requests, subagents' included, in the 3 runs are the same in the base and this head: 1,050 tokens "
                      "sent a request, 85.7% of them read from the cache, 1,500 written to it, 600 output and 0 thinking blocks dropped. "
                      f"{cu.USAGE_MODEL}\n\nHeld the same in base and head:", text)
        self.assertNotIn('Usage that differs', text)

    def test_usage_that_moved_gives_the_agents_sums_base_to_head_and_folds_each_moved_runs_kinds_with_the_count_of_runs_that_didnt(self):
        base = [result('H1/W1', usage=usage({'requests': 30, 'input': 3000, 'cacheRead': 60000, 'cacheWrite': 1500, 'output': 600})), result('H1/W2', usage=usage(summariser={'requests': 4})), result('C6h/W11', usage=usage())]
        head = [result('H1/W1', usage=usage({'requests': 30, 'input': 3000, 'cacheRead': 60000, 'cacheWrite': 1500, 'output': 600})), result('H1/W2', usage=usage({'cacheRead': 8000, 'cacheWrite': 1500}, summariser={'requests': 4})),
                result('C6h/W11', usage=usage())]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn("Usage: the agents' requests, subagents' included, in the 3 runs, base → head: 1,710 tokens sent a request, 91.2% → 90.1% of them read from the "
                      "cache, 2,500 → 3,500 written to it, 1,000 output and 0 thinking blocks dropped. The figures of 1 run moved, for any kind "
                      f"of request; they're under \"Usage that differs\", below. {cu.USAGE_MODEL}\n\n", text)
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

    def test_where_both_arms_priced_the_line_gives_the_agents_list_price_a_request_and_the_fold_a_price_column(self):
        base = [result(r, usage=priced(usage())) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        head = [result('H1/W1', usage=priced(usage())), result('H1/W2', usage=priced(usage(), agent=0.8)), result('C6h/W11', usage=priced(usage()))]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn("Usage: the agents' requests, subagents' included, in the 3 runs, base → head: 1,050 tokens sent a request, 85.7% of them read from "
                      "the cache, 1,500 written to it, 600 output, 0 thinking blocks dropped and USD 0.0500 → USD 0.0600 at list price a priced request. "
                      f"The figures of 1 run moved, for any kind of request; they're under \"Usage that differs\", below. {cu.USAGE_MODEL} {cu.PRICE_MODEL}\n\n", text)
        self.assertIn('| `H1/W2` | kind | requests | input | read from the cache | written to it | output | thinking dropped | list price, USD | unpriced |\n'
                      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
                      '| | agent | 10 | 1,000 | 9,000 | 500 | 200 | 0 | 0.5000 → 0.8000 | 0 |\n', text)
        some = [result(r, usage=priced(usage(), unpriced=2)) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        text = self.comment(self.run_dir([(some, [])], base_results=some))
        self.assertIn('0 thinking blocks dropped, USD 0.0625 at list price a priced request and 6 requests with no list price.', text,
                      'the price a request is over the priced ones, and the unpriced are counted apart')

    def test_the_price_a_request_weighs_each_run_by_its_priced_requests_and_each_arm_counts_its_own_unpriced(self):
        base = [result('H1/W1', usage=priced(usage(), unpriced=9, agent=0.5)), result('H1/W2', usage=priced(usage(), unpriced=1, agent=0.9)),
                result('C6h/W11', usage=priced(usage(), unpriced=10, agent=0))]
        head = [result('H1/W1', usage=priced(usage(), unpriced=8, agent=0.5)), result('H1/W2', usage=priced(usage(), unpriced=1, agent=0.9)),
                result('C6h/W11', usage=priced(usage(), unpriced=10, agent=0))]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn('USD 0.1400 → USD 0.1273 at list price a priced request and 20 requests → 19 requests with no list price.', text,
                      "1.40 over 10 priced requests, not the runs' own prices averaged; and each arm's unpriced count its own")

    def test_a_price_that_differs_only_past_the_four_places_shown_moves_no_run(self):
        base = [result(r, usage=priced(usage(), agent=0.5)) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        head = [result('H1/W1', usage=priced(usage(), agent=0.50001)), *base[1:]]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn("in the 3 runs are the same in the base and this head: ", text)
        self.assertNotIn('Usage that differs', text)
        self.assertNotIn('The figures of 1 run moved', text)
        moved = [result('H1/W1', usage=priced(usage(), agent=0.5001)), *base[1:]]
        text = self.comment(self.run_dir([(moved, [])], base_results=base))
        self.assertIn('| | agent | 10 | 1,000 | 9,000 | 500 | 200 | 0 | 0.5000 → 0.5001 | 0 |', text, 'a move at the fourth place is a move')
        of = lambda runs: cv.result_of(self.facts(self.run_dir([(runs, [])], base_results=base)))
        self.assertEqual(of(head), of(base), 'a price that moves past the four places shown moves no result')
        self.assertNotEqual(of(moved), of(base))

    def test_the_sentence_is_the_same_exactly_when_every_figure_it_shows_is(self):
        base = [result(r, usage=priced(usage(), unpriced=8, agent=0.10006)) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        head = [result(r, usage=priced(usage(), unpriced=8, agent=0.10014)) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn("in the 3 runs, base → head: ", text, 'each run shows 0.1001 on both arms, but the price a request is 0.0500 against 0.0501')
        self.assertIn('USD 0.0500 → USD 0.0501 at list price a priced request', text)
        self.assertNotIn('The figures of 1 run moved', text)

    def test_runs_with_no_answered_request_on_either_arm_carry_no_list_price(self):
        empty = {'kinds': {}, 'lastDropped': None, 'calibration': None}
        runs = [result(r, usage=empty) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        text = self.comment(self.run_dir([(runs, [])], base_results=runs))
        self.assertIn("Usage: the figures of the agents' requests", text)
        self.assertNotIn('list price', text)
        self.assertNotIn(cu.PRICE_MODEL, text)

    def test_where_one_arm_left_a_run_unpriced_the_sentence_compares_only_the_figures_it_shows(self):
        base = [result(r, usage=priced(usage())) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        head = [result('H1/W1', usage={**usage(), 'priceUnread': 'bun exited 1'}), result('H1/W2', usage=priced(usage(), agent=0.8)),
                result('C6h/W11', usage=priced(usage()))]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn("in the 3 runs are the same in the base and this head: 1,050 tokens sent a request, 85.7% of them read from the cache, 1,500 "
                      "written to it, 600 output and 0 thinking blocks dropped. The figures of 1 run moved, for any kind of request;", text)
        self.assertIn('| | agent | 10 | 1,000 | 9,000 | 500 | 200 | 0 | 0.5000 → 0.8000 | 0 |', text)
        self.assertIn('No list price on the head in 1 run of 3: bun exited 1.', text)

    def test_why_an_arm_went_unpriced_is_shown_inert_and_cut_and_the_result_rests_only_on_what_is_shown(self):
        why = '[x](https://example.com) @someone ' + 'y' * 400
        base = [result(r, usage=priced(usage())) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        head = [result(r, usage={**usage(), 'priceUnread': why}) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn(f"No list price on the head: {pr_comment.inert(why[:300] + '…')}.", text)
        self.assertNotIn('[x](https://example.com)', text)
        self.assertNotIn('y' * 301, text)
        past = [result(r, usage={**usage(), 'priceUnread': why + ' and more stderr'}) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        within = [result(r, usage={**usage(), 'priceUnread': 'other ' + why}) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        of = lambda runs: cv.result_of(self.facts(self.run_dir([(runs, [])], base_results=base)))
        self.assertEqual(of(past), of(head), 'words past the 300 shown move no result')
        self.assertNotEqual(of(within), of(head))
        split = [result('H1/W1', usage={**usage(), 'priceUnread': why + ' A'}), result('H1/W2', usage={**usage(), 'priceUnread': why + ' B'}),
                 result('C6h/W11', usage={**usage(), 'priceUnread': why + ' A'})]
        text = self.comment(self.run_dir([(split, [])], base_results=base))
        self.assertEqual(text.count('No list price on the head'), 1, 'reasons alike as shown are one line, as the result has them')
        self.assertIn(f"No list price on the head: {pr_comment.inert(why[:300] + '…')}.", text)

    def test_an_arm_whose_host_couldnt_price_shows_no_price_and_says_why_once_however_many_runs(self):
        why = "its src/call-pricing.ts exports no priceCall"
        base = [result(r, usage={**usage(), 'priceUnread': why}) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        head = [result(r, usage=priced(usage())) for r in ('H1/W1', 'H1/W2', 'C6h/W11')]
        text = self.comment(self.run_dir([(head, [])], base_results=base))
        self.assertIn("in the 3 runs are the same in the base and this head: 1,050 tokens sent a request, 85.7% of them read from the cache, 1,500 "
                      f"written to it, 600 output and 0 thinking blocks dropped. {cu.USAGE_MODEL}\n\nNo list price on the base: {pr_comment.inert(why)}.\n\n", text)
        self.assertEqual(text.count('No list price'), 1)
        self.assertNotIn(cu.PRICE_MODEL, text)
        self.assertNotIn('Usage that differs', text, "a price one arm doesn't have moves no run")
        failed = "the host couldn't price its calls (bun exited 1: `boom`)"
        partly = [result('H1/W1', usage={**usage(), 'priceUnread': failed}), *head[1:]]
        text = self.comment(self.run_dir([(partly, [])], base_results=head))
        self.assertIn(f"No list price on the head in 1 run of 3: {pr_comment.inert(failed)}.", text)

    def test_usage_prices_are_read_only_as_a_cost_and_an_unpriced_count_together_on_every_kind(self):
        good = [result('H1/W1', usage=usage()), result('H1/W2'), result('C6h/W11')]
        alone = usage()
        alone['kinds']['agent']['cost'] = 0.5
        mixed = priced(usage(summariser={}))
        del mixed['kinds']['summariser']['cost'], mixed['kinds']['summariser']['unpriced']
        for u, said in ((alone, "H1/W1: on the head, its usage's 'agent' figures have one of cost and unpriced without the other"),
                        (priced(usage(), agent=-0.1), "H1/W1: on the head, its usage's 'agent' cost isn't a number of 0 or more, -0.1"),
                        (priced(usage(), agent=float('nan')), "H1/W1: on the head, its usage's 'agent' cost isn't a number of 0 or more"),
                        (priced(usage(), unpriced=11), "H1/W1: on the head, its usage's 'agent' unpriced isn't a whole number from 0 to its requests, 11"),
                        (mixed, "H1/W1: on the head, its usage prices some kinds of request and not others"),
                        ({**priced(usage()), 'priceUnread': 'no'}, "H1/W1: on the head, its usage's priceUnread isn't text beside unpriced figures"),
                        ({**usage(), 'priceUnread': 7}, "H1/W1: on the head, its usage's priceUnread isn't text beside unpriced figures, 7")):
            with self.subTest(said=said), self.assertRaisesRegex(pr_review.Failed, re.escape(said)):
                self.facts(self.run_dir([([result('H1/W1', usage=u), result('H1/W2'), result('C6h/W11')], [])], base_results=good))

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


if __name__ == '__main__':
    unittest.main()

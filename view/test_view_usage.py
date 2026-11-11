"""The view's usage (view_usage.py): each arm's usage read and checked, and the agents' figures, their list price and the
runs whose figures moved, as the comment shows them."""
import json, re, unittest

import pr_comment
import pr_review
import view as cv
import view_usage as cu
from test_view import ALL_RAN, HARNESS, Steps, entry, priced, result, usage

RUNS = ('H1/W1', 'H1/W2', 'C6h/W11')
CONTEXT_CHECKS = f'https://github.com/anima-research/context-view/blob/{HARNESS}/CHECKS.md#what-the-context-figures-count'


def ctx(seams=0, out=0, largest=0, peak=10_000):
    return {'seams': seams, 'out': out, 'largest': largest, 'peak': peak}


def used(context=None, **kinds):
    """A run's usage as test_view's usage gives it, with the harness's context figures where context isn't None."""
    return {**usage(**kinds), **({'context': context} if context is not None else {})}


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

    def context_view(self, base_ctx, head_ctx, differ=True, base_more=None, head_more=None):
        base = [result(r, usage=used(c, **((base_more or {}).get(r, {})))) for r, c in zip(RUNS, base_ctx)]
        head = [result(r, record='differs' if differ and r == 'H1/W1' else 'same', usage=used(c, **((head_more or {}).get(r, {})))) for r, c in zip(RUNS, head_ctx)]
        return self.run_dir([(head, [entry('bbbbbbbbbbbb', ('H1/W1', 1))] if differ else [])], base_results=base)

    def test_where_records_differ_a_context_line_follows_the_usage_line_each_measure_with_the_runs_it_rose_and_fell_in_then_its_figure(self):
        base = [ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 40_000), ctx()]
        head = [ctx(3, 500, 250, 50_000), ctx(1, 100, 100, 40_000), ctx()]
        text = self.comment(self.context_view(base, head))
        self.assertIn(f"{cu.USAGE_MODEL}\n\nContext in the 3 runs, base → head. Seams: more in 1 run; 3 → 4 in all. Tokens in the parts they changed or "
                      f"took out: more in 1 run; 400 → 600 in all. The most one agent request held: 50,000 tokens in both, moved in no run. The summariser's "
                      f"requests: 0 in both, moved in no run. [What these count]({CONTEXT_CHECKS}).\n\n{cv.UNREAD}", text)
        same = self.comment(self.context_view(base, head, differ=False))
        for said in ('Context in the', 'Context:', 'Context that differs'):
            self.assertNotIn(said, same, "a view whose records don't differ says nothing new")

    def test_a_measure_is_judged_run_by_run_so_sums_that_cancel_still_say_where_it_rose_and_fell_and_the_most_held_is_a_maximum(self):
        text = self.comment(self.context_view([ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 40_000), ctx()], [ctx(1, 100, 100, 50_000), ctx(2, 300, 200, 45_000), ctx()]))
        self.assertIn("Seams: more in 1 run, fewer in 1; 3 in both. Tokens in the parts they changed or took out: more in 1 run, fewer in 1; 400 in both. "
                      "The most one agent request held: higher in 1 run; 50,000 tokens at most in both.", text)
        text = self.comment(self.context_view([ctx(1, 100, 100, 50_000), ctx(), ctx()], [ctx(1, 100, 100, 49_000), ctx(), ctx(peak=51_000)]))
        self.assertIn("The most one agent request held: higher in 1 run, lower in 1; 50,000 → 51,000 tokens at most.", text)
        text = self.comment(self.context_view([ctx(3, 300, 100), ctx(2, 200, 100), ctx()], [ctx(1, 100, 100), ctx(1, 100, 100), ctx()]))
        self.assertIn("Seams: fewer in 2 runs; 5 → 2 in all.", text)
        text = self.comment(self.context_view([ctx(1, 100, 100), ctx(1, 100, 100), ctx(3, 300, 100)], [ctx(2, 200, 100), ctx(2, 200, 100), ctx(1, 100, 100)]))
        self.assertIn("Seams: more in 2 runs, fewer in 1; 5 in both. Tokens in the parts they changed or took out: more in 2 runs, fewer in 1; 500 in both.", text)

    def test_the_summariser_gives_its_requests_and_where_every_run_is_priced_its_list_price_each_with_its_own_split(self):
        more = lambda n: {'H1/W2': {'summariser': {'requests': n}}}
        text = self.comment(self.context_view([ctx()] * 3, [ctx()] * 3, base_more=more(4), head_more=more(5)))
        self.assertIn("The summariser's requests: more in 1 run; 4 → 5 in all. [What these count]", text)
        base = [result(r, usage=priced(used(ctx(), **({'summariser': {'requests': 4}} if r == 'H1/W2' else {})), summariser=1.0)) for r in RUNS]
        head = [result(r, record='differs' if r == 'H1/W1' else 'same', usage=priced(used(ctx(), **({'summariser': {'requests': 4}} if r == 'H1/W2' else {})), unpriced=1, summariser=0.5))
                for r in RUNS]
        text = self.comment(self.run_dir([(head, [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=base))
        self.assertIn("The summariser's requests: 4 in both, moved in no run. Their list price: lower in 1 run; USD 1.0000 → USD 0.5000 in all, leaving out "
                      "0 → 1 request with no list price.", text)
        unread = [result(r, usage=used(ctx(), **({'summariser': {'requests': 3}} if r == 'H1/W2' else {}))) for r in RUNS]
        text = self.comment(self.run_dir([(head, [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=unread))
        self.assertIn("The summariser's requests: more in 1 run; 3 → 4 in all. [What these count]", text, "no price where an arm went unpriced")

    def test_the_unpriced_requests_show_wherever_the_price_does_and_either_arm_has_any_also_where_the_price_didnt_move(self):
        arm = lambda cost, unpriced=0, differ=False, seams=0: [result(r, **({'record': 'differs' if r == 'H1/W1' else 'same'} if differ else {}),
                                                                       usage=priced(used(ctx(seams, 100 * seams, 100 * seams) if r == 'H1/W1' else ctx(),
                                                                                         **({'summariser': {'requests': 10}} if r == 'H1/W2' else {})), unpriced=unpriced, summariser=cost))
                                                                for r in RUNS]
        text = self.comment(self.run_dir([(arm(2.0, differ=True), [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=arm(1.0)))
        self.assertIn("The summariser's requests: 10 in both, moved in no run. Their list price: higher in 1 run; USD 1.0000 → USD 2.0000 in all. [What", text)
        text = self.comment(self.run_dir([(arm(1.0, unpriced=1, differ=True, seams=1), [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=arm(1.0, unpriced=1)))
        self.assertIn("Seams: more in 1 run; 0 → 1 in all.", text)
        self.assertIn("Their list price: USD 1.0000 in both, leaving out 1 request with no list price, moved in no run.", text)

    def test_where_every_run_is_priced_but_none_sent_the_summariser_a_request_the_line_gives_no_list_price(self):
        arm = lambda differ=False: [result(r, **({'record': 'differs' if r == 'H1/W1' else 'same'} if differ else {}),
                                           usage=priced(used(ctx(1, 100, 100) if differ and r == 'H1/W1' else ctx()))) for r in RUNS]
        text = self.comment(self.run_dir([(arm(differ=True), [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=arm()))
        self.assertIn("The summariser's requests: 0 in both, moved in no run. [What these count]", text)
        self.assertNotIn('Their list price', text)

    def test_an_unpriced_count_that_changed_alone_shows_the_line_with_its_change_rather_than_saying_nothing_moved(self):
        arm = lambda unpriced, differ=False: [result(r, **({'record': 'differs' if r == 'H1/W1' else 'same'} if differ else {}),
                                                     usage=priced(used(ctx(), **({'summariser': {'requests': 10}} if r == 'H1/W2' else {})), unpriced=unpriced, summariser=1.0))
                                              for r in RUNS]
        text = self.comment(self.run_dir([(arm(2, differ=True), [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=arm(1)))
        self.assertNotIn('stayed the same', text)
        self.assertIn("Their list price: USD 1.0000 in both, leaving out 1 → 2 requests with no list price, moved in no run.", text)

    def test_the_summariser_price_over_the_runs_is_their_sum_shown_once_to_four_places_and_each_run_is_compared_as_shown(self):
        arm = lambda cost, differ=False: [result(r, **({'record': 'differs' if r == 'H1/W1' else 'same'} if differ else {}),
                                                 usage=priced(used(ctx(1, 100, 100) if differ and r == 'H1/W1' else ctx(), summariser={'requests': 1}), summariser=cost))
                                          for r in RUNS]
        text = self.comment(self.run_dir([(arm(0.00004, differ=True), [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=arm(0.00001)))
        self.assertIn("Their list price: USD 0.0000 in both, moved in no run.", text, "the figure over the runs sums each run's price as shown, so it moves only where some run's does")
        text = self.comment(self.run_dir([(arm(0.000041, differ=True), [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=arm(0.00004)))
        self.assertIn("Their list price: USD 0.0000 in both, moved in no run.", text, "a run's price that moves below four places hasn't moved")
        text = self.comment(self.run_dir([(arm(0.50006, differ=True), [entry('bbbbbbbbbbbb', ('H1/W1', 1))])], base_results=arm(0.5)))
        self.assertIn("Their list price: higher in 3 runs; USD 1.5000 → USD 1.5003 in all.", text, "a change at the fourth place is counted")

    def test_where_no_measure_moved_in_any_run_one_sentence_says_so(self):
        same = [ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 40_000), ctx()]
        text = self.comment(self.context_view(same, same))
        self.assertIn(f"Context in the 3 runs: in each run, the number of seams, the tokens in the parts they changed or took out, "
                      f"the most one agent request held and the number of summariser requests stayed the same. [What these count]({CONTEXT_CHECKS}).\n\n{cv.UNREAD}", text)
        self.assertNotIn('Context that differs', text)

    def test_where_only_a_runs_largest_seam_moved_the_line_says_in_how_many_runs_and_points_at_the_fold_which_has_them(self):
        text = self.comment(self.context_view([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(2, 300, 150, 50_000), ctx(), ctx()]))
        self.assertNotIn('stayed the same', text)
        self.assertIn("Context in the 3 runs, base → head. Seams: 2 in both, moved in no run.", text)
        self.assertIn(f"The summariser's requests: 0 in both, moved in no run. The largest seam moved in 1 run, in the fold below. [What these count]({CONTEXT_CHECKS}).", text)
        self.assertIn('Context that differs: 1 of 3 runs, base → head', text)
        other = self.comment(self.context_view([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(3, 300, 150, 50_000), ctx(), ctx()]))
        self.assertNotIn('The largest seam moved', other, 'where another measure moved, the largest seam stays in the fold')
        more = lambda n: {'H1/W2': {'summariser': {'requests': n}}}
        summarised = self.comment(self.context_view([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(2, 300, 150, 50_000), ctx(), ctx()], base_more=more(4), head_more=more(5)))
        self.assertIn("The summariser's requests: more in 1 run; 4 → 5 in all. The largest seam moved in 1 run, in the fold below.", summarised,
                      "the sentence is judged on the context fold's own measures, whatever the summariser did")
        alone = self.comment(self.context_view([ctx()] * 3, [ctx()] * 3, base_more=more(4), head_more=more(5)))
        self.assertNotIn('The largest seam moved', alone, 'a summariser that moved with no context fold says nothing of the largest seam')

    def test_the_runs_whose_context_figures_moved_fold_by_how_far_their_seams_then_tokens_then_most_held_moved_then_by_name(self):
        text = self.comment(self.context_view([ctx(2, 300, 200, 50_000), ctx(4, 600, 300, 40_000), ctx(peak=20_000)],
                                              [ctx(3, 500, 250, 50_000), ctx(3, 300, 300, 40_000), ctx(peak=20_500)]))
        self.assertIn('<details><summary>Context that differs: 3 of 3 runs, base → head</summary>\n\n'
                      '| run | seams | tokens in parts changed or taken out | largest seam | most held |\n| --- | --- | --- | --- | --- |\n'
                      '| `H1/W2` | 4 → 3 | 600 → 300 | 300 | 40,000 |\n'
                      '| `H1/W1` | 2 → 3 | 300 → 500 | 200 → 250 | 50,000 |\n'
                      '| `C6h/W11` | 0 | 0 | 0 | 20,000 → 20,500 |\n\n</details>', text)
        seams = self.comment(self.context_view([ctx(1, 100, 100), ctx(1, 100, 100), ctx()], [ctx(3, 200, 100), ctx(2, 600, 500), ctx()]))
        self.assertIn('| `H1/W1` | 1 → 3 | 100 → 200 | 100 | 10,000 |\n| `H1/W2` | 1 → 2 |', seams, 'the change in seams before the change in tokens')
        held = self.comment(self.context_view([ctx(1, 100, 100), ctx(1, 100, 100, 20_000), ctx()], [ctx(2, 200, 100), ctx(2, 200, 100, 20_500), ctx()]))
        self.assertIn('| `H1/W2` | 1 → 2 | 100 → 200 | 100 | 20,000 → 20,500 |\n| `H1/W1` | 1 → 2 |', held, 'the change in the most held before the name')
        tied = self.comment(self.context_view([ctx(1, 100, 100), ctx(), ctx(1, 100, 100)], [ctx(2, 200, 100), ctx(), ctx(2, 200, 100)]))
        self.assertIn('| `C6h/W11` | 1 → 2 | 100 → 200 | 100 | 10,000 |\n| `H1/W1` | 1 → 2 |', tied, 'a tie goes by name, not the harness\'s order')

    def test_a_run_with_context_figures_on_one_arm_or_neither_is_counted_apart_in_the_opening_and_left_out_of_every_figure(self):
        more = lambda n: {'H1/W2': {'summariser': {'requests': n}}}
        text = self.comment(self.context_view([ctx(2, 300, 200, 50_000), ctx(1, 100, 100, 90_000), None], [ctx(3, 500, 250, 50_000), None, None], base_more=more(4), head_more=more(5)))
        self.assertIn(f"{cu.USAGE_MODEL}\n\nContext in the 1 run that gave figures on both arms, not the 2 that didn't, base → head. Seams: more in 1 run; 2 → 3 in all. "
                      "Tokens in the parts they changed or took out: more in 1 run; 300 → 500 in all. The most one agent request held: 50,000 tokens in both, moved in no run. "
                      "The summariser's requests: 0 in both, moved in no run.", text, 'a run without figures on both arms is in none of the figures')
        self.assertIn('Context that differs: 1 of 1 runs, base → head', text)
        text = self.comment(self.context_view([ctx(2, 300, 200), ctx(), None], [ctx(2, 300, 200), ctx(), None]))
        self.assertIn("Context in the 2 runs that gave figures on both arms, not the 1 that didn't: in each run, the number of seams", text)
        text = self.comment(self.context_view([ctx(), None, None], [None, ctx(), None]))
        self.assertIn(f"{cu.USAGE_MODEL}\n\nContext: none of the 3 runs gave figures on both arms. [What these count]({CONTEXT_CHECKS}).", text)
        old = self.comment(self.context_view([None] * 3, [None] * 3))
        self.assertNotIn('Context', old, 'a harness from before the context figures gives none on any arm, and no line')

    def test_context_figures_are_read_only_as_four_whole_numbers_whose_seams_are_0_exactly_where_their_tokens_are(self):
        good = [result('H1/W1', usage=used(ctx())), result('H1/W2'), result('C6h/W11')]
        for c, said in ((ctx(1, 0, 0), "its usage's context isn't four whole numbers, its seams 0 exactly where the tokens taken out are, and its largest no more than them"),
                        (ctx(0, 5, 5), "its usage's context isn't four whole numbers"), (ctx(1, 5, 9), "its usage's context isn't four whole numbers"),
                        ({**ctx(), 'peak': 1.5}, "its usage's context isn't four whole numbers"), ({'seams': 0, 'out': 0, 'largest': 0}, "its usage's context isn't four whole numbers")):
            with self.subTest(c=c), self.assertRaisesRegex(pr_review.Failed, re.escape(f"H1/W1: on the head, {said}")):
                self.facts(self.run_dir([([result('H1/W1', usage=used(c)), result('H1/W2'), result('C6h/W11')], [])], base_results=good))

    def test_the_context_figures_are_part_of_the_result_so_a_comment_showing_them_is_never_kept_under_another(self):
        v = self.facts(self.context_view([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(3, 500, 250, 50_000), ctx(), ctx()]))
        other = self.facts(self.context_view([ctx(2, 300, 200, 50_000), ctx(), ctx()], [ctx(3, 500, 250, 51_000), ctx(), ctx()]))
        self.assertNotEqual(cv.result_of(v), cv.result_of(other))


if __name__ == '__main__':
    unittest.main()

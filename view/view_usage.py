"""What a view's comment says of the runs' usage: each arm's usage read and checked, the agents' figures and list price
base → head above the fold, and each run whose figures moved in a fold."""
import math

from pr_comment import code, inert, one_line
from pr_run import need
from view_words import counted, folded, listed, summary_text


FIGURES = ('requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'dropped')
PRICE = ('cost', 'unpriced')
CONTEXT = ('seams', 'out', 'largest', 'peak')


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
    x = u.get('context')
    need('context' not in u or (isinstance(x, dict) and set(x) == set(CONTEXT) and all(counting(x[f]) for f in CONTEXT)
                                and (x['seams'] == 0) == (x['out'] == 0) and x['largest'] <= x['out']),
         f"{run} its usage's context isn't four whole numbers from 0 to 2**53, its seams 0 exactly where the tokens taken out are, and its largest no more "
         f"than them, {x!r}")
    need('contextNone' not in u or isinstance(u['contextNone'], str), f"{run} its usage's contextNone isn't text, {u.get('contextNone')!r}")
    need('context' not in u or 'contextNone' not in u, f"{run} its usage gives both context figures and why it gives none")
    kept = lambda k: {f: k[f] for f in (*FIGURES, *(PRICE if 'cost' in k else ()))}
    return {'kinds': {kind: kept(k) for kind, k in u['kinds'].items()}, **({'context': x} if 'context' in u else {}), **({'contextNone': u['contextNone']} if 'contextNone' in u else {}),
            **({'history': {kind: kept(k) for kind, k in u['history'].items()}} if u.get('history') is not None else {}),
            'lastDropped': u['lastDropped'], 'calibration': c, **({'priceUnread': u['priceUnread']} if 'priceUnread' in u else {})}


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
    """An arm's usage of a run as the comment shows it, for the result digest: costs to four places, why it went unpriced as
    unread_shown gives it, and that it gave no context figures, not why."""
    out = dict(u_side)
    if 'contextNone' in u_side:
        out['contextNone'] = True
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


CONTEXT_LINK = "[What these count]({checks})."


def gave_context(u):
    return 'context' in u['base'] and 'context' in u['head']


def summariser(u_side):
    return u_side['kinds'].get('summariser', {f: 0 for f in (*FIGURES, *PRICE)})


def context_moved(u):
    return any(u['base']['context'][f] != u['head']['context'][f] for f in CONTEXT)


def context_line(view):
    """Where records differ, what the change did to the context the agents lived in, over the runs that gave its figures on
    both arms: each measure's runs where it rose and where it fell, judged run by run so that sums which cancel still show,
    then its figure over the runs, base → head."""
    usage = view.get('usage') or []
    if not any('context' in u[side] or 'contextNone' in u[side] for u in usage for side in ('base', 'head')):
        return []
    link = CONTEXT_LINK.format(checks=f"https://github.com/{view['harness']['repo']}/blob/{view['harness']['sha']}/CHECKS.md#what-the-context-figures-count")
    runs = [u for u in usage if gave_context(u)]
    if not runs:
        return [f"Context: none of the {counted(len(usage), 'run', 'runs')} gave figures on both arms. {link}"]
    none = len(usage) - len(runs)
    scope = (f"the {counted(len(runs), 'run', 'runs')}" if not none else
             f"the {counted(len(runs), 'run that gave figures on both arms', 'runs that gave figures on both arms')}, not the {none:,} that didn't")

    def sentence(name, get, over, total, up, down, key=lambda v: v):
        """name's measure: in how many runs the figure get reads rose (up) and fell (down), each run's compared as key shows
        it, then its figure over the runs, over, in total's words. Returns whether it moved, and the sentence."""
        rose = sum(1 for u in runs if key(get(u['head'])) > key(get(u['base'])))
        fell = sum(1 for u in runs if key(get(u['head'])) < key(get(u['base'])))
        b, h = over(get(u['base']) for u in runs), over(get(u['head']) for u in runs)
        if not rose and not fell:
            return False, f"{name}: {total(b, h, False)}, moved in no run."
        split = (f"{up} in {counted(rose, 'run', 'runs')}, {down} in {fell:,}" if rose and fell else
                 f"{up} in {counted(rose, 'run', 'runs')}" if rose else f"{down} in {counted(fell, 'run', 'runs')}")
        return True, f"{name}: {split}; {total(b, h, True)}."

    of = lambda f: lambda s: s['context'][f]
    summed = lambda b, h, moved: f'{b:,} in both' if b == h else f'{b:,} → {h:,} in all'
    held = lambda b, h, moved: (f'{b:,} tokens in both' if not moved else f'{b:,} tokens at most in both' if b == h else f'{b:,} → {h:,} tokens at most')
    said = [sentence('Seams', of('seams'), sum, summed, 'more', 'fewer'),
            sentence('Tokens in the parts they changed or took out', of('out'), sum, summed, 'more', 'fewer'),
            sentence('The most one agent request held', of('peak'), max, held, 'higher', 'lower'),
            sentence("The summariser's requests", lambda s: summariser(s)['requests'], sum, summed, 'more', 'fewer')]
    if all(priced(u[side]) for u in runs for side in ('base', 'head')) and any('cost' in u[side]['kinds'].get('summariser', {}) for u in runs for side in ('base', 'head')):
        usd = lambda v: f'USD {v:.4f}'
        b, h = (sum(summariser(u[side]).get('unpriced', 0) for u in runs) for side in ('base', 'head'))
        unpriced = (f", leaving out {counted(b, 'request', 'requests') if b == h else f'{b:,} → ' + counted(h, 'request', 'requests')} with no list price"
                    if b or h else '')
        said.append(sentence(f'Their list price{unpriced}', lambda s: float(f"{summariser(s).get('cost', 0):.4f}"), lambda xs: usd(sum(xs)),
                             lambda b, h, moved: f'{b} in both' if b == h else f'{b} → {h} in all', 'higher', 'lower'))
        said.append((any(summariser(u['base']).get('unpriced', 0) != summariser(u['head']).get('unpriced', 0) for u in runs), ''))
    if not any(moved for moved, _ in said) and not any(context_moved(u) for u in runs):
        return [f"Context in {scope}: in each run, the number of seams, the tokens in the parts they changed or took out, the most one agent request "
                f"held and the number of summariser requests stayed the same. {link}"]
    largest = sum(1 for u in runs if u['base']['context']['largest'] != u['head']['context']['largest'])
    only = [f"The largest seam moved in {counted(largest, 'run', 'runs')}, in the fold below."] if largest and not any(moved for moved, _ in said[:3]) else []
    return [f"Context in {scope}, base → head. {' '.join([*(text for _, text in said if text), *only])} {link}"]


def context_fold(view, room):
    runs = [u for u in view.get('usage') or [] if gave_context(u)]
    moved = [u for u in runs if context_moved(u)]
    if not moved:
        return []
    change = lambda u, f: abs(u['head']['context'][f] - u['base']['context'][f])
    moved.sort(key=lambda u: (-change(u, 'seams'), -change(u, 'out'), -change(u, 'peak'), u['run']))
    cell = lambda u, f: f"{u['base']['context'][f]:,}" if u['base']['context'][f] == u['head']['context'][f] else f"{u['base']['context'][f]:,} → {u['head']['context'][f]:,}"
    rows = ['| run | seams | tokens in parts changed or taken out | largest seam | most held |', '| --- | --- | --- | --- | --- |',
            *(f"| {code(u['run'])} | " + ' | '.join(cell(u, f) for f in CONTEXT) + ' |' for u in moved)]
    summary = summary_text(f'Context that differs: {len(moved):,} of {len(runs):,} runs, base → head')
    return folded(summary, ['\n'.join(rows)], room)

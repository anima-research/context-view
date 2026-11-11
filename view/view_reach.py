"""The comment's reach paragraph and its fold: which of the change's source lines ran in no profiled drive, which files no
profiled host loaded and which deletions no profiled drive reached, or that everything that could run did, and what the
view couldn't tell and why, in CHECKS.md's words."""
from pr_comment import code, inert, one_line
from view_read import HOLDS, LISTS, beyond
from view_words import clipped, counted, listed

# The most characters one of the reach paragraph's lists, or one reason it quotes, takes above the fold: about three lines
# of a comment as GitHub shows it. A longer list is cut, saying how much it leaves out, and view.json holds it whole.
LISTED = 360


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
REACH_WHY = "Why it couldn't tell which of this change's source lines ran"


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

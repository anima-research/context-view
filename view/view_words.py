"""The comment's fixed words but for usage and reach: the words every part of it shares (counts and lists in words, a
collapsible's summary line, items folded into collapsibles within a comment's room, and text cut to fit), its opening, what
it says of a head that couldn't be compared, the lines on forced, held and differing releases, the flags, the reader's
changes and their folds, and the link to CHECKS.md."""
import bisect, html, json, re

import pr_comment
from pr_comment import ACTIVE, COMMENT_MAX, code, ended, inert, one_line
from pr_run import Failed, need


def counted(n, one, many):
    return f'{n:,} {one if n == 1 else many}'


def listed(names):
    names = list(names)
    return names[0] if len(names) == 1 else ', '.join(names[:-1]) + ' and ' + names[-1]


def summary_text(text):
    """A <details> summary line is an HTML block, where Markdown isn't read: each token GitHub would turn into something
    else (`ACTIVE`) in <code>, which GitHub leaves as it is, and the rest escaped as HTML."""
    text, out, at = one_line(text), [], 0
    for m in ACTIVE.finditer(text):
        out += [html.escape(text[at:m.start()]), f'<code>{html.escape(m.group(0))}</code>']
        at = m.end()
    return ''.join(out + [html.escape(text[at:])])


def folded(summary, items, room):
    """items under a collapsible whose summary is summary, as HTML: one where they all fit in room, else as many as hold
    them, each after the first titled as continued. An item too long for the collapsible it falls in, alone, fails the step."""
    def wrap(name, body):
        return '\n\n'.join([f'<details><summary>{name}</summary>', *body, '</details>'])
    out, body = [], []
    for item in items:
        name = f'{summary}, continued' if out else summary
        if body and len(wrap(name, [*body, item])) > room:
            out.append(wrap(name, body))
            body, name = [], f'{summary}, continued'
        need(len(wrap(name, [item])) <= room,
             f"one line of {summary!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters: {item[:200]}")
        body.append(item)
    if body:
        out.append(wrap(f'{summary}, continued' if out else summary, body))
    return out


# The repository whose harness/ a view's runs use, and whose CHECKS.md says what those runs drive and what their checks judge.
HARNESS = 'anima-research/context-view'

# The arm an outcome's detail names, as the run side names it, and as the comment does: an arm-missing names a job's arm,
# a needs-companion the arm where the plan stopped (run/context-view-run.ts, resolve() and share()).
ARMS = {'arm-missing': {'before': 'base', 'after': 'head'}, 'needs-companion': {'base': 'base', 'head': 'head'}}


def opening(view, first, head_now):
    joined = 'against' if view['outcome'] == 'doesnt-merge' else 'merged onto'
    text = f"**Automatic context view** of {code(view['head'][:12])} {joined} {code(view['base'][:12])}."
    if first != view['head']:
        text += since(view, f"as at {code(first[:12])}, where this comment was first posted.")
    if head_now != view['head']:
        text += f" The pull request's head has since moved to {code(head_now[:12])}."
    return text


def since(view, at):
    """What an edited first line says held at the head the comment was first posted at, by what the comment shows."""
    if view['outcome'] != 'ran' or not view['runs']['compared']:
        return f" It couldn't be compared for the same reasons {at}"
    if view.get('broken'):
        seen = 'the same differences from the base' if view['entries'] else 'no difference from the base'
        return f" Its runs show {seen}, and couldn't be compared at the same runs for the same reasons, {at}"
    if view['entries']:
        return f" Its runs show the same differences from the base {at}"
    return f" Its runs show no difference from the base, {at}"


def widest(view):
    return len(opening({**view, 'head': 'f' * 40}, '0' * 40, 'e' * 40))


def written(text):
    """text as a fence shows it: each control character but a tab or a newline written as its \\xNN."""
    return re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', lambda m: f'\\x{ord(m.group(0)):02x}', str(text))


def fence(text):
    text = written(text)
    ticks = max((len(t) for t in re.findall(r'`+', text)), default=0)
    f = '`' * max(3, ticks + 1)
    return f'{f}text\n{text}\n{f}'


def clipped(words, text, room):
    """words(shown, part) with all of text, as one_line() gives it, where it fits in room, else with its longest prefix whose
    words fit, part naming how many characters a reader sees of that prefix and of the whole text, both as seen() counts
    them, so a code span's backticks aren't counted. A prefix's end moves back as whole(text) moves it, so it never ends
    inside a code span or a run of backticks, and it ends before any whitespace there, which rendering takes out: what
    shows is then the whole text's first characters as they show.
    The prefix is found by bisection on the words' rendered length, since rendering escapes and fences text, so a
    character can take several: it's the longest where that length grows with the prefix, as it does but where a
    reference or code span completes."""
    said = words(text, '')
    if len(said) <= room:
        return said
    cut, total = whole(text), pr_comment.seen(text)

    def shown(k):
        k = len(text[:cut(k)].rstrip())
        return words(text[:k], f"'s first {pr_comment.seen(text[:k]):,} of {total:,} characters")
    need(len(shown(0)) <= room, f"a paragraph doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters even with its text cut")
    lo, hi = 0, len(text) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        lo, hi = (mid, hi) if len(shown(mid)) <= room else (lo, mid - 1)
    return shown(lo)


def whole(text):
    """cut(k) for text, as one_line() gives it: k, or where the code span inert() shows of the whole text, or the run of
    backticks it shows as text, that k falls inside begins, since a cut there could show what the whole doesn't, such as
    a backtick that closes no span, or pair an unclosed run anew. A token `ACTIVE` codes
    is one such span, so one longer than the room shows none of it."""
    spans = []
    for is_code, piece, start, end in pr_comment.runs(text):
        spans += [(start, end)] if is_code else [(start + m.start(), start + m.end()) for m in re.finditer(r'`+', piece)]
    starts = [start for start, _ in spans]

    def cut(k):
        at = bisect.bisect_left(starts, k) - 1
        return spans[at][0] if at >= 0 and spans[at][1] > k else k
    return cut


def could_not(view, room):
    """The fixed words for a head that couldn't be compared, each saying what the run found, each paragraph within room."""
    kind, detail = view['outcome'], view.get('detail') or {}
    if kind == 'doesnt-merge':
        return [f"This head couldn't be compared: it conflicts with {code(one_line(view['baseRef']))} at {code(view['base'][:12])}, "
                "and a view runs the head merged onto its base, so those conflicts need resolving before it can be viewed."]
    if kind == 'needs-companion':
        return [companion_stop(detail)]
    if kind == 'arm-missing':
        log = one_line(detail.get('log') or '')
        lead = (f"This head couldn't be compared: one of its {counted(view['jobs'], 'job', 'jobs')} came back without the "
                f"{ARMS[kind][detail['arm']]} arm's results")
        return [clipped(lambda shown, part: lead + f" (its last log line{part}: {inert(shown)}).", log, room) if log else lead + '.']
    said = {'head': "the head couldn't run it", 'base': "the base couldn't run it",
            'varies': "its self-check, which drives this head again with recording off, didn't find the two drives' requests the "
                      "same, so a difference from the base can't be put down to the change alone",
            'unchecked': "the head wasn't self-checked",
            'outcome': "the harness gave it an outcome the view doesn't know",
            'drive': "the head's second drive, with recording off, couldn't show that recording changes nothing it sends"}

    def why(b):
        parts = []
        if b['what'] == 'unmeasured':
            sides = [f"on the {arm}, {listed(inert(x) for x in names)}" for arm, names in b['unmeasured'].items() if names]
            parts.append(f"the run didn't measure ({'; '.join(sides)})")
        elif b['what'] != 'read':
            parts.append(said[b['what']])
        failed = [f"the {arm}'s {'read' if len(names) == 1 else 'reads'} of {listed(inert(x) for x in names)}"
                  for arm, names in (b.get('reads') or {}).items() if names]
        if failed:
            parts.append(f"{failed[0]} failed" if len(failed) == 1 else f"{', and '.join(failed)}, failed")
        if b.get('unreadable'):
            parts.append("the head's quarantine count couldn't be read")
        return ', and '.join(parts)

    def reason(b):
        def words(shown, part):
            said = [x for x in (inert(shown) if shown else '', f'the reason{part}' if part else '') if x]
            return f"This head couldn't be compared at {code(b['run'])}: {why(b)}" + (f" ({', '.join(said)})." if said else '.')
        return clipped(words, one_line(b['reason']), room)
    return [reason(b) for b in view.get('broken') or []]


def short(name):
    return name.removeprefix('@animalabs/')


CHOSEN = re.compile(r'(@animalabs/[^/@\s]+)@([^/@\s]+)')


def asker(wanted_by, side):
    """Who asks a range in an arm's stack, as the plan names it: the arm's own package.json, a release the plan chose, or an
    entry of the host's lockfile, by its path."""
    if wanted_by is None:
        return 'it' if side == 'head' else 'its base'
    if m := CHOSEN.fullmatch(wanted_by):
        return f"{inert(short(m[1]))} {code(m[2])}, which the view chose for the {side},"
    return f"{from_whom(wanted_by, side)} in the host's stack"


def from_whom(wanted_by, side):
    if wanted_by is None:
        return 'this head' if side == 'head' else 'the base'
    if m := CHOSEN.fullmatch(wanted_by):
        return f"{inert(short(m[1]))} {code(m[2])}"
    return inert(short(wanted_by.rsplit('node_modules/', 1)[-1]))


def ranges_said(ranges, side):
    return listed(f"{code(r['range'])} from {from_whom(r['wantedBy'], side)}" for r in ranges)


def lacking(name, c, side):
    """Why the lockfile's release of a package the plan chose wouldn't do in that arm, from its stack entry's missed."""
    m = c['missed']
    held = f"connectome-host's lockfile holds {code(c['host'])}"
    if m['package'] == name:
        return f"{held}, which doesn't meet {code(m['range'])} from {from_whom(m['wantedBy'], side)}"
    return (f"{held}, and with it {from_whom(m['wantedBy'], side)} asks for {inert(short(m['package']))} {code(m['range'])}, "
            f"which the {side}'s {code(str(m['has']))} doesn't meet")


def companion_stop(d):
    """Why the plan chose no stack the arms could run, from the needs-companion's detail (run/context-view-run.ts, resolve)."""
    side, why = ARMS['needs-companion'][d['arm']], d.get('why')
    lead = (f"This head couldn't be compared: {asker(d.get('wantedBy'), side)} asks for {inert(short(str(d.get('package'))))} "
            f"{code(str(d.get('range')))}")
    if why == 'not-plain':
        return f"{lead}, which isn't a version range, so the view can't choose a release to meet it."
    if why == 'no-mover':
        if d.get('has') is None:
            return f"{lead}, and the {side}'s {code('package.json')} gives no version."
        return (f"{lead}, and the {side}'s is {code(str(d['has']))}. The view chooses releases only of agent-framework, context-manager, "
                "membrane and chronicle where connectome-host's lockfile holds them at its top level, so it can't change that.")
    if why == 'no-release':
        ranges = d.get('ranges') or []
        name = inert(short(str(d.get('release'))))
        if not ranges:
            return f"{lead}, and {name} has no published release."
        alone = len(ranges) == 1 and d.get('release') == d.get('package') and ranges[0] == {'range': d.get('range'), 'wantedBy': d.get('wantedBy')}
        return f"{lead}, and no published release of {name} " + ('meets it.' if alone else f"meets every range on it in the {side}'s stack ({ranges_said(ranges, side)}).")
    if why == 'unsettled':
        tried = sorted((d.get('tried') or {}).items())
        said = f" The {side}'s were {listed(f'{inert(short(n))} {code(v)}' for n, v in tried)}." if tried else ''
        return f"{lead}, and choosing releases for the arms came back to choices it had already made, so it stopped there.{said}"
    raise Failed(f"manifest.json: a needs-companion the view doesn't know, {why!r}")


def held_text(view):
    held = dict(view.get('held') or {})
    stack = view.get('stack') or {}

    def chose(k):
        name = f'@animalabs/{k}'
        sides = [(side, stack[side][name]) for side in ('base', 'head') if name in stack.get(side, {})]
        if not sides:
            return ''
        why = next(((side, c) for side, c in sides if 'missed' in c), None)
        return (f" (the view chose it for both arms, since {lacking(name, why[1], why[0])})" if why
                else f" (the view chose it for both arms, where connectome-host's lockfile has {code(sides[0][1]['host'])})")
    if view['form'] == 'overlay':
        held = {'connectome-host': view['host'][:12], **held}
    return 'Held the same in base and head: ' + ', '.join(f'{inert(k)} {code(v)}{chose(k)}' for k, v in held.items()) + '.' if held else None


def differing_line(view):
    """Above the fold, where the arms ran different releases of a package besides the pull request's: which, why the view
    chose each over the lockfile's, and that a difference may be theirs."""
    differing, stack = view.get('differing') or [], view.get('stack') or {}
    if not differing:
        return []
    names = [inert(d['package']) for d in differing]
    said = [f"Besides this head, the arms ran different releases of {listed(names)}: "
            + '; '.join(('' if len(differing) == 1 else f"{inert(d['package'])} ") + f"{code(d['base'])} in the base and {code(d['head'])} in the head"
                        for d in differing) + '.']
    for d in differing:
        for side in ('base', 'head'):
            name = f"@animalabs/{d['package']}"
            c = stack.get(side, {}).get(name)
            if c is None:
                continue
            said.append(f"The view chose the {side}'s {inert(d['package'])} {code(c['version'])}, "
                        + (f"since {lacking(name, c, side)}." if 'missed' in c else f"where connectome-host's lockfile has {code(c['host'])}."))
    said.append(f"So a difference this view shows may come from {listed(names)} as well as from this head, and it can't tell which.")
    return [' '.join(said)]


FOUR = ('@animalabs/agent-framework', '@animalabs/context-manager', '@animalabs/membrane', '@animalabs/chronicle')


def forced_line(view):
    """Above the fold, where an arm ran the pull request's package past a range in the host's stack that refuses it: which
    ranges, in which arms, why the view couldn't meet them, and that a difference or a failure may come from them."""
    forced = view.get('forced') or {}
    sides = [side for side in ('base', 'head') if forced.get(side)]
    if not sides:
        return []
    name = inert(short(view['pack']))
    pairs = {side: {(f['range'], f['wantedBy']) for f in forced.get(side) or []} for side in ('base', 'head')}

    def path(wanted_by):
        return [x.rstrip('/') for x in wanted_by.split('node_modules/') if x.rstrip('/')]

    def named(wanted_by):
        if m := CHOSEN.fullmatch(wanted_by):
            return inert(short(m[1]))
        at = path(wanted_by)
        return inert(short(at[-1])) if len(at) == 1 else f"{inert(short(at[-2]))}'s {inert(short(at[-1]))}"

    def chosen(wanted_by):
        """An asker the view chooses releases of: one of the four at the top of the host's stack, or a release it chose."""
        return bool(CHOSEN.fullmatch(wanted_by)) or path(wanted_by) in ([x] for x in FOUR)

    def ranges(fs, side):
        return listed(f"{code(f['range'])} from {from_whom(f['wantedBy'], side) if CHOSEN.fullmatch(f['wantedBy']) else named(f['wantedBy'])}" for f in fs)

    def why(fs, admitted):
        moved = list(dict.fromkeys(named(f['wantedBy']) for f in fs if chosen(f['wantedBy'])))
        fixed = list(dict.fromkeys(named(f['wantedBy']) for f in fs if not chosen(f['wantedBy'])))
        said = ([f"it could choose no release of {listed(moved)} that admits {admitted}"] if moved else []) + (
            [f"the view chooses releases only of agent-framework, context-manager, membrane and chronicle where connectome-host's lockfile "
             f"holds them at its top level, so it couldn't choose a release of {listed(fixed)}"] if fixed else [])
        return ', and '.join(said)

    def over(fs):
        return 'a range' if len(fs) == 1 else 'ranges'
    def those(fs):
        return 'that range' if len(fs) == 1 else 'those ranges'
    if pairs['base'] == pairs['head']:
        fs = forced['base']
        return [f"In both arms, the view laid {name} over {ranges(fs, 'base')}, {over(fs)} that neither the base's {code(fs[0]['has'])} nor the "
                f"head's {code(forced['head'][0]['has'])} meets: {why(fs, 'them')}. So any difference or failure this view shows may come from "
                f"{those(fs)}, and the view can't tell whether it does."]
    # A checkpoint whose release names no window takes it from the base arm's install (harness/run.ts, drive.ts), so a range
    # the base forced can fail a checkpoint that head runs start from; a range only the head forced reaches nothing the base runs.
    if sides == ['head']:
        close = (f"So any difference this view shows, or any failure in the head, may come from {those(forced['head'])}, and the view "
                 "can't tell whether it does.")
    elif sides == ['base']:
        close = (f"So any difference this view shows, or any failure in the base or of a checkpoint, may come from {those(forced['base'])}, "
                 "and the view can't tell whether it does.")
    else:
        close = ("So any difference this view shows may come from the ranges named for either arm, and the view can't tell whether it does. "
                 "Any failure in an arm may come from that arm's own ranges. A checkpoint's failure may come from the base's ranges. "
                 "The view can't tell whether either does.")
    return [' '.join([*(f"In the {side}, the view laid {name} {code(forced[side][0]['has'])} over {ranges(forced[side], side)}, {over(forced[side])} "
                        f"that version doesn't meet: {why(forced[side], 'it')}." for side in sides), close])]


def flags_line(view, flagged):
    """What the flags fold holds, said apart from the records' differences: the checks' flags that differ between the base
    and the head, counted with the runs they're in."""
    flagged_runs = len({f['run'] for f in view.get('flags') or [] if f['new'] or f['gone']})
    differ, listed = ('differs', "it's") if flagged == 1 else ('differ', "they're")
    return (f"Separately, {flagged:,} of the checks' flags {differ} between the base and the head, in "
            f"{counted(flagged_runs, 'run', 'runs')}; {listed} listed under \"Checks' flags that differ\", below.")


def flags_text(view, room):
    """The flags that differ, a paragraph for each distinct flag, each flag's text cut to fit room where it doesn't. The
    harness pairs a head's flags with the base's one for one, so a `new` flag says only that the head raised it once more
    than the base; identical flags in one run, on one side (alike in check, step, what, detail and whole, as the harness's
    flagKey matches them), are one line saying how many more times one side raised it than the other. Lines of one run
    that show the same check, step and text, on either side, as different flags can, each say another line does."""
    out = []
    for f in view.get('flags') or []:
        groups = []
        for side, more, than in (('new', 'head', 'base'), ('gone', 'base', 'head')):
            times = {}
            for flag in f[side]:
                key = json.dumps([flag.get(k) for k in ('check', 'step', 'what', 'detail', 'whole')])
                times.setdefault(key, [key, flag, 0, more, than])[2] += 1
            groups += times.values()
        shown = []
        for key, flag, n, more, than in groups:
            step = flag.get('step')
            where = f" step {code(str(step))}" if step not in (None, '', 'the run') else ''
            said = ': '.join(t for t in (one_line(x) for x in (flag.get('what'), flag.get('detail')) if x) if t)
            shown.append((f"{where}, check {code(str(flag.get('check')))}", said))
        alike = {}
        for (key, *_), face in zip(groups, shown):
            alike.setdefault(face, set()).add(key)
        for (key, flag, n, more, than), face in zip(groups, shown):
            place, said = face
            often = '1 more time' if n == 1 else f'{n:,} more times'
            other = ' (another line of this run shows the same text for a different flag)' if len(alike[face]) > 1 else ''
            line = f"- {code(f['run'])}{place}{other} flagged on the {more} {often} than on the {than}"
            if not said:
                out.append(line)
                continue

            def words(text, part, line=line):
                return line + (f': {inert(text)}' if text else '') + (f' (the flag{part})' if part else '')
            # The name and the detail are rendered as one text, so nothing GitHub would make live can form across the ': '
            # between them, as `:smile` and `: ` make an emoji.
            out.append(clipped(words, said, room))
    return ["The checks' flags that differ between base and head:", *out] if out else []


def known(change, entries):
    """change, once each entry it names is one the view has."""
    need(change['refs'], f"change {change['title']!r} names no entry")
    unknown = [r for r in change['refs'] if r not in entries]
    need(not unknown, f"change {change['title']!r} names {unknown} entries the view doesn't have")
    return change


def quoted_in(change, entries):
    """The run a change's quotes are from: its place's, which the workflow gives every change, one of the change's own."""
    need(change.get('place'), f"change {change['title']!r} names no place its quotes are from")
    run, step = str(change['place']['run']), str(change['place']['step'])
    need((run, step) in {(p['run'], str(p['step'])) for r in dict.fromkeys(change['refs']) for p in entries[r]['places']},
         f"change {change['title']!r} is quoted from {code(run)} at step {code(step)}, a place it doesn't have")
    return run


def change_block(change, entries, run, quoted, room):
    """A change as run's fold shows it: its title and its steps in run, then its quotes where they're from run (quoted, the
    run they're from), else where they are. A quote too long for room shows its first characters, and
    says how many of how many, outside its fence, since GitHub holds a comment to 65,536 characters."""
    steps = list(dict.fromkeys(str(p['step']) for r in dict.fromkeys(change['refs']) for p in entries[r]['places'] if p['run'] == run))
    at = f"At step {code(steps[0])}" if len(steps) == 1 else f"At {counted(len(steps), 'step', 'steps')}"
    step = str(change['place']['step'])
    head = [f"*{inert(one_line(change['title']))}*"]
    if run != quoted:
        said = '\n\n'.join([*head, f"{at}. Its before and after are quoted under {code(quoted)}, at step {code(step)}."])
        need(len(said) <= room, f"change {change['title']!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters")
        return said
    head.append(at + (f"; the quotes are from step {code(step)}." if steps != [step] else '.'))

    def text(keep):
        body = list(head)
        for side in ('before', 'after'):
            quote = str(change[side])
            if not quote:
                body.append(f'{side.capitalize()}: none.')
                continue
            shown = quote if keep is None or len(quote) <= keep else quote[:keep]
            label = (f'{side.capitalize()}:' if shown == quote
                     else f'{side.capitalize()}, its first {len(written(shown)):,} of {len(written(quote)):,} characters:')
            body += [label, fence(shown)]
        return '\n\n'.join(body)
    whole = text(None)
    if len(whole) <= room:
        return whole
    sides = [str(change[side]) for side in ('before', 'after') if change[side]]
    need(sides, f"change {change['title']!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters, and has no quote to cut")
    keep = max(0, (room - len(text(0))) // len(sides))
    cut = text(keep)
    while len(cut) > room and keep > 0:
        keep = max(0, keep - -(-(len(cut) - room) // len(sides)))
        cut = text(keep)
    need(len(cut) <= room, f"change {change['title']!r} doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters even with its quotes cut")
    return cut


LINKED = "What a context view runs and what its checks judge: [CHECKS.md]({checks})."


# The stopped words' pointer to what a view does: CHECKS.md on main.
CHECKED = f"What a context view runs and what its checks judge are in [CHECKS.md](https://github.com/{HARNESS}/blob/main/CHECKS.md)."


def linked(view):
    """Above the fold: CHECKS.md at the harness commit the view used."""
    return LINKED.format(checks=f"https://github.com/{HARNESS}/blob/{view['harness']['sha']}/CHECKS.md")


def inside(room, summary):
    """The room one line has inside a collapsible whose summary is summary, continued."""
    return room - len(f'<details><summary>{summary}, continued</summary>\n\n\n\n</details>')


def run_folds(view, reader, entries, room):
    """A collapsible for each run with a place in the entries, in the harness's order, each holding every change the reader
    names there, in the reader's order: as many collapsibles as hold them, each within room."""
    quoted = [quoted_in(c, entries) for c in reader['changes']]
    out = []
    for run in view['order']:
        here = [(c, q) for c, q in zip(reader['changes'], quoted)
                if any(p['run'] == run for r in dict.fromkeys(c['refs']) for p in entries[r]['places'])]
        if here:
            summary = f"<code>{html.escape(one_line(run))}</code>: {counted(len(here), 'change', 'changes')}"
            out += folded(summary, [change_block(c, entries, run, q, inside(room, summary)) for c, q in here], room)
    return out


def said_line(change, field):
    """A change's one-line text in field, which the account must give, and must give as a line of text where it gives it."""
    need(field in change, f"change {change['title']!r} gives no {field}")
    text = change[field]
    article = 'an' if field[0] in 'aeiou' else 'a'
    need(isinstance(text, str) and one_line(text), f"change {change['title']!r} gives {article} {field} that isn't a line of text")
    return one_line(text)


def deltas(view, reader):
    """Above the fold, each change in the account's order, numbered: its title, and whether the description mentions it;
    where it changed and the earlier change it follows from, if the account names one; then what the base's run had there
    and what the head's has instead, each labelled with its branch or commit, and where else the same change is carried,
    if the account says."""
    out = []
    for n, c in enumerate(reader['changes'], 1):
        follows, unmentioned = c.get('follows'), c.get('unmentioned')
        need('follows' not in c or (type(follows) is int and 1 <= follows < n),
             f"change {c['title']!r} follows {follows!r}, which isn't an earlier delta's number")
        need('unmentioned' not in c or unmentioned is True, f"change {c['title']!r} gives unmentioned as {unmentioned!r}, not true")
        out.append('\n\n'.join([
            f"**Delta {n}: {inert(one_line(c['title']))}**" + (" (the description doesn't mention it)" if unmentioned else ''),
            ended(inert(said_line(c, 'where'))) + (f" Follows from Delta {follows}." if follows else ''),
            f"- base ({code(one_line(view['baseRef']))}): {ended(inert(said_line(c, 'base')))}\n"
            f"- head ({code(view['head'][:12])}): {ended(inert(said_line(c, 'head')))}"
            + (f"\n- Also in: {ended(inert(said_line(c, 'also')))}" if 'also' in c else '')]))
    return out


def absent_line(view):
    parts = [f"{code(a['run'])}'s {listed(inert(x) for x in a[arm])} on the {arm}"
             for a in view.get('absent') or [] for arm in ('base', 'head') if a[arm]]
    return [f"Parts left out where an arm's stack doesn't bring what they need: {'; '.join(parts)}."] if parts else []


def lost_line(lost):
    """Above the fold: how many runs couldn't be compared, and where their reasons are."""
    return (f"1 run couldn't be compared; its reason is below." if lost == 1
            else f"{lost:,} runs couldn't be compared; the reasons are below.")

# What asks for a view, and who may: this account alone, while views post nowhere else. Each ask also needs write access, as
# review-workflow's /review does. The poll reads both from here, so a comment with no reader names whoever the poll serves.
COMMAND = '/context-deltas'
ASKERS = ('nissa-seru',)
UNREAD = (f"No model read these records for this view, which started on its own. A view asked for with a {code(COMMAND)} comment by "
          f"{' or '.join(code(a) for a in ASKERS)} gives a model's account of the records of the pull request's head as it is when that view "
          "runs.")

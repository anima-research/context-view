#!/usr/bin/env python3
"""The context view's steps on the host, which the workflow running a view calls: each reads one JSON object on stdin and
prints one on its last line of stdout, or exits 1 with why on stderr, or 2 when the run's repository is one the App is
installed on that the context view doesn't cover, or when its command line names no step. facts and compared, which read
a run, are view_read.py's; post puts the comment together here from the words view_words.py, view_usage.py and
view_reach.py write."""
import argparse, hashlib, json, os, re, subprocess, sys, traceback

import pr_comment
import pr_review
import view_reach
import view_read
import view_usage
import view_words
from pr_comment import COMMENT_MAX, MORE, VIEW_MARK, code, one_line
from pr_run import Failed, NotARequest, need, read_json
from view_reach import REACH_FOLD, REACH_WHY, reach_items, reach_said
from view_read import PARTS, compared, facts, full_sha, viewed
from view_usage import context_fold, context_line, upgrade_lines, upgrades_fold, usage_fold, usage_line, usage_shown
from view_words import CHECKED, UNREAD, absent_line, could_not, counted, deltas, differing_line, flags_line, flags_text, folded, forced_line, held_text, inside, known, linked, listed, lost_line, opening, run_folds, summary_text, widest

MARK = re.compile(re.escape(VIEW_MARK) + r'(?:stopped:(?P<stopped>[0-9a-f]{40})|first:(?P<first>[0-9a-f]{40})'
                  r'(?: head:(?P<head>[0-9a-f]{40}))? result:(?P<result>[0-9a-f]{64})(?::(?P<part>[0-9]+))?) -->\Z')


def words_of(files):
    """The sha256 of the files whose code writes a comment's fixed words, each file's bytes after its length."""
    h = hashlib.sha256()
    for path in files:
        with open(path, 'rb') as f:
            data = f.read()
        h.update(f'{len(data)}\n'.encode() + data)
    return h.hexdigest()


# The code that writes a comment's fixed words, view.py, view_reach.py, view_read.py, view_usage.py, view_words.py and the
# pinned review-workflow's pr_comment, by their bytes, so a comment is kept for the same result only by the code that wrote
# it: a release that changes any of those files, as moving the pin can, posts again at a head's next view.
WORDS = words_of((__file__, view_reach.__file__, view_read.__file__, view_usage.__file__, view_words.__file__, pr_comment.__file__))


def result_of(view, sources=None):
    """What a comment's fixed words and quotes rest on, apart from the heads its first lines name (this head, the head it
    was first posted at, and the pull request's head now): the same result at a later head edits the first line rather than
    posting again, and the reader's prose, written again at each run, isn't part of it. Every other word the comment prints
    comes from what this covers, and where the reader runs, so does everything it reads:
    the pull request's title and description, and its instructions and guide by their sha256 (sources, post's reads), and
    the code that writes them (WORDS)."""
    keep = ('base', 'baseRef', 'host', 'harness', 'form', 'outcome', 'detail', 'held', 'runs', 'broken', 'flags', 'reached', 'absent', 'usage', 'forced',
            'upgrades', 'stack', 'differing', 'reach')
    said = {k: view.get(k) for k in keep}
    if said['usage']:
        said['usage'] = [{**u, 'base': usage_shown(u['base']), 'head': usage_shown(u['head'])} for u in said['usage']]
    if view.get('outcome') == 'arm-missing':
        said['jobs'] = view.get('jobs')
    said['entries'] = view.get('entries') or []
    said['words'] = WORDS
    if view.get('outcome') == 'ran' and said['entries'] and sources is not None:
        said['pr'] = [view.get('title'), view.get('body')]
        said['reads'] = sources
    return hashlib.sha256(json.dumps(said, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def mark(view, first, digest, part=1):
    if part == 1:
        return f"{VIEW_MARK}first:{first} head:{view['head']} result:{digest} -->"
    return f"{VIEW_MARK}first:{first} result:{digest}:{part} -->"


def stopped_mark(head):
    return f'{VIEW_MARK}stopped:{head} -->'


def units(view, reader, room):
    held = [x for x in [held_text(view)] if x]
    if view['outcome'] != 'ran':
        need(reader is None, "a head that couldn't be compared has no reader account")
        return [linked(view), *could_not(view, room)]
    some, partial = view['runs']['compared'], bool(view.get('broken'))
    if not some:
        need(reader is None, "a head none of whose runs could be compared has no reader account")
        return [linked(view), *could_not(view, room), *forced_line(view), *flags_text(view, room), *held]
    runs = f"the {counted(some, 'run', 'runs')} it could compare" if partial else f"the {counted(some, 'run', 'runs')}"
    lost = len(view.get('broken') or [])
    said, cut = reach_said(view['reach']) if 'reach' in view else (None, False)
    reach = [said] if said else []
    need(all(len(x) <= room for x in reach), f"the reach paragraph doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters")
    title = summary_text(REACH_WHY if 'couldnt' in view.get('reach', {}) else REACH_FOLD)
    reach_fold = folded(title, reach_items(view['reach'], inside(room, title)), room) if cut else []
    reasons = summary_text(f"Runs that couldn't be compared ({lost:,})")
    lost_fold = folded(reasons, could_not(view, inside(room, reasons)), room) if lost else []
    if not view['entries']:
        need(reader is None, "a head whose runs it could compare don't differ has no reader account")
        return [linked(view),
                f"The records of {runs} don't differ between the base and this head.", *differing_line(view), *forced_line(view), *reach,
                *absent_line(view), *([lost_line(lost)] if lost else []), *usage_line(view), *upgrade_lines(view), *flags_text(view, room),
                *lost_fold, *usage_fold(view, room), *upgrades_fold(view, room), *reach_fold, *held]
    places = {p['run'] for e in view['entries'] for p in e['places']}
    changed = len(places)
    flagged = sum(len(f['new']) + len(f['gone']) for f in view.get('flags') or [])
    count = f"The records of {changed:,} of {runs} differ between the base and this head."
    flags = summary_text(f"Checks' flags that differ ({flagged:,})")
    lines = [linked(view), count, *differing_line(view), *forced_line(view), *reach, *absent_line(view), *([lost_line(lost)] if lost else []),
             *([flags_line(view, flagged)] if flagged else []), *usage_line(view), *context_line(view), *upgrade_lines(view)]
    folds = [*lost_fold, *(folded(flags, flags_text(view, inside(room, flags))[1:], room) if flagged else []), *usage_fold(view, room), *context_fold(view, room),
             *upgrades_fold(view, room), *reach_fold, *held]
    if reader is None:
        differ = summary_text(f"Runs whose records differ: {changed:,} of {some:,}")
        return [*lines, UNREAD, *folded(differ, [listed(code(one_line(r)) for r in view['order'] if r in places) + '.'], room), *folds]
    entries = {e['id']: e for e in view['entries']}
    reader = {**reader, 'changes': [known(c, entries) for c in reader['changes']]}
    differ = summary_text(f"Runs whose records differ: {changed:,} of {some:,}, with {counted(len(reader['changes']), 'change', 'changes')}")
    return [*lines, "*A model's account of those records:*", *deltas(view, reader),
            *folded(differ, run_folds(view, reader, entries, inside(room, differ)), room), *folds]


def parts_of(view, reader, first, digest, head_now):
    """The comment as GitHub takes it: as few comments as hold it, each under 65,536 characters with its marker, the first
    with room for the longest first line an edit can give it."""
    later = f"**Automatic context view** of {code(first[:12])}, continued."
    out, body, n = [], [], 1

    def room(k):
        top = widest(view) if k == 1 else len(later)
        return COMMENT_MAX - top - len(f'\n\n\n\n{MORE}\n\n') - len(mark(view, first, digest, k if k > 1 else 1))
    for unit in units(view, reader, room(1)):
        if body and len('\n\n'.join([*body, unit])) > room(n):
            out.append(body)
            body, n = [], n + 1
        need(len(unit) <= room(n), f"one paragraph of the comment doesn't fit in a comment of GitHub's {COMMENT_MAX:,} characters: {unit[:200]}")
        body.append(unit)
    out.append(body)
    texts = []
    for k, items in enumerate(out, 1):
        top = opening(view, first, head_now) if k == 1 else later
        texts.append('\n\n'.join([top, *items, *([MORE] if k < len(out) else []), mark(view, first, digest, k)]))
    return texts


def on_pull(repo, number, token, app_id):
    """The App's context-view comments on the pull request, each with its marker's fields."""
    found, page = [], 1
    while True:
        got = pr_review.api('GET', f'/repos/{repo}/issues/{number}/comments?per_page=100&page={page}', token)
        for c in got:
            m = MARK.search((c.get('body') or '').rstrip())
            if (c.get('performed_via_github_app') or {}).get('id') == app_id and m:
                found.append((c, m.groupdict()))
        if len(got) < 100:
            return found
        page += 1


def chains(found):
    """The posted comments, each by its first head and result: its parts in order, whether it's whole (every part from 1
    there and the last saying none follow), the head its first part claims, if that part is there, and its first part's
    id, which orders comments as GitHub made them."""
    grouped = {}
    for c, g in found:
        if g['first']:
            grouped.setdefault((g['first'], g['result']), []).append((int(g['part'] or 1), c, g))
    out = []
    for (first, result), parts in grouped.items():
        parts.sort(key=lambda p: (p[0], p[1]['id']))
        whole = ([n for n, _, _ in parts] == list(range(1, len(parts) + 1))
                 and not MARK.sub('', parts[-1][1]['body'].rstrip()).rstrip().endswith(MORE))
        out.append({'first': first, 'result': result, 'parts': [c for _, c, _ in parts], 'whole': whole,
                    'claims': parts[0][2]['head'] if parts[0][0] == 1 else None, 'id': parts[0][1]['id']})
    return out


def deleted(repo, token, comments):
    """Deletes the comments in order, trying each; if GitHub refuses any, fails naming each comment still there."""
    left = []
    for c in comments:
        try:
            pr_review.api('DELETE', f"/repos/{repo}/issues/comments/{c['id']}", token, missing=True, repeat=True)
        except pr_review.Failed as e:
            left.append(f"{c.get('html_url')} may still be there, since deleting it failed: {e}")
    if left:
        raise pr_review.Failed('; '.join(left))


def worded(e):
    """An exception's words for a step's message: a Failed's own; any other's after its kind, with its traceback printed
    first, since it may be a fault in the step's own code."""
    if isinstance(e, pr_review.Failed):
        return str(e)
    traceback.print_exception(e)
    return f'{type(e).__name__}: {e}'


def unposted(repo, number, token, app_id, head, digest):
    """Deletes the parts of this head's comment that the pull request lists once its posting has failed, so none says a
    continuation follows, and says what became of them. A part GitHub made but doesn't list yet isn't among them."""
    try:
        for x in chains(on_pull(repo, number, token, app_id)):
            if (x['first'], x['result']) == (head, digest):
                deleted(repo, token, x['parts'])
    except Exception as e:
        return f'deleting the parts of its comment that went up failed too: {worded(e)}'
    return 'the parts of its comment the pull request then listed are deleted'


# review-workflow's installed command, which a view wants its pull request's "Changes context" through.
REVIEW_POLL = os.path.expanduser('~/.local/bin/review-poll')


def context_of(view):
    """The value a view gives its pull request's "Changes context", by the comment's own headline: Yes where the records of
    some run it could compare differ, No where it compared runs, every one, and none differ, and None for any other view, a
    merged pull request's included. So No means none of the view's runs differ: a change on a path no run reaches reads No."""
    if view.get('outcome') != 'ran' or 'merge' in view:
        return None
    if view.get('entries'):
        return 'Yes'
    return 'No' if view['runs']['compared'] > 0 and not view.get('broken') else None


def wanted(d, view, value):
    """Wants value through review-workflow's poll, timed at view.json's ended, when the view's run side finished, so that of
    two views of a pull request the one whose run side finished later stands, whichever posted first. A failure is said on
    stderr and fails nothing: the comment is already up."""
    if not view.get('ended'):
        print(f"post: its Changes context, {value}, wasn't wanted: its view.json has no ended, as one facts wrote before "
              "view.json carried it", file=sys.stderr)
        return
    argv = [REVIEW_POLL, 'want', '--kind', 'context', '--repo', view['repo'], '--number', str(view['number']),
            '--label', os.path.basename(os.path.normpath(d)), '--value', value, '--started', view['ended']]
    try:
        ran = subprocess.run(argv, capture_output=True, text=True, errors='replace', timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"post: its Changes context, {value}, wasn't wanted: {e}", file=sys.stderr)
        return
    if ran.returncode != 0:
        print(f"post: its Changes context, {value}, wasn't wanted: {REVIEW_POLL} exited {ran.returncode}: "
              f"{(ran.stderr or ran.stdout).strip()[:500]}", file=sys.stderr)


def post(args):
    """The view's comment, one per head, the latest always the latest run's: the latest comment, when it's whole and has
    this result, is kept and has its first line and marker made this head's; else a new one posts. A comment first posted at
    this head with this result, whose markers a new one would share, is deleted first; every other comment that claims this
    head, and one whose parts didn't all post, once this head's comment is there, and then this head's stopped words. A
    posting that fails partway, however it fails, deletes the parts the pull request then lists before it fails the step,
    saying what became of them."""
    d = args['dir']
    view = read_json(os.path.join(d, 'view.json'))
    repo, number, head = view['repo'], view['number'], view['head']
    if view['outcome'] in ('moved', 'closed'):
        return {'action': view['outcome']}
    need(view['outcome'] != 'couldnt-run', "a run that couldn't run posts its stopped words, through stopped")
    reader = read_json(args['reader']) if args.get('reader') else None
    sources = args.get('reads')
    need((reader is None) == (sources is None), "post: reads, the sha256 of the reader's instructions and guide, goes with a reader account and only with one")
    need(sources is None or isinstance(sources, dict) and set(sources) == {'instructions', 'guide'}
         and all(isinstance(x, str) and re.fullmatch('[0-9a-f]{64}', x) for x in sources.values()),
         "post: reads is {instructions, guide}, each a sha256 in lowercase hex")
    digest = result_of(view, sources)
    if not args.get('post', True):
        texts = parts_of(view, reader, head, digest, head)
        for name in os.listdir(d):
            if PARTS.fullmatch(name):
                os.remove(os.path.join(d, name))
        for k, text in enumerate(texts, 1):
            with open(os.path.join(d, 'comment.md' if k == 1 else f'comment-{k}.md'), 'w') as f:
                f.write(text)
        return {'action': 'dry', 'parts': len(texts)}
    parts_of(view, reader, head, digest, head)
    token, app_id, _ = viewed(repo)
    pr = pr_review.api('GET', f'/repos/{repo}/pulls/{number}', token)
    if pr.get('state') != 'open':
        return {'action': 'closed', 'state': pr.get('state')}
    head_now = pr['head']['sha']
    found = on_pull(repo, number, token, app_id)
    held = chains(found)
    latest = max((x for x in held if x['claims']), key=lambda x: x['id'], default=None)
    keep = latest if latest is not None and latest['whole'] and latest['result'] == digest else None
    for x in held:
        if x is not keep and (x['first'], x['result']) == (head, digest):
            deleted(repo, token, x['parts'])
    if keep is not None:
        c = keep['parts'][0]
        top, rest = c['body'].split('\n\n', 1)
        text = '\n\n'.join([opening(view, keep['first'], head_now), MARK.sub(mark(view, keep['first'], digest), rest.rstrip())])
        action = 'unchanged' if text == c['body'].rstrip() else 'edited'
        if action == 'edited':
            pr_review.api('PATCH', f"/repos/{repo}/issues/comments/{c['id']}", token, body={'body': text}, repeat=True)
        url = c.get('html_url')
    else:
        texts = parts_of(view, reader, head, digest, head_now)
        marks = [mark(view, head, digest, k) for k in range(1, len(texts) + 1)]
        try:
            done = pr_review.posted(repo, number, token, app_id, marks, texts, {})
        except Exception as e:
            raise pr_review.Failed(f'{worded(e)}; {unposted(repo, number, token, app_id, head, digest)}') from e
        action, url = 'posted', done[marks[0]].get('html_url')
    stale = []
    for x in held:
        if x is not keep and (x['first'], x['result']) != (head, digest) and (x['claims'] == head or not x['whole']):
            try:
                deleted(repo, token, x['parts'])
            except pr_review.Failed as e:
                stale.append(str(e))
    kept = [k for k in (pr_review.unsaid(repo, token, c) for c, g in found if g['stopped'] == head) if k]
    value = context_of(view)
    if value:
        wanted(d, view, value)
    return {'action': action, 'url': url, **({'staleKept': stale} if stale else {}), **({'stoppedKept': kept} if kept else {})}


def stopped(args):
    repo, number, head = args['repo'], args['number'], args['head']
    need(full_sha(head), f"head isn't a full commit sha, {head!r}")
    said = stopped_mark(head)
    text = '\n\n'.join([f"**Automatic context view** of {code(head[:12])} stopped before it finished, so it has nothing to report.",
                         CHECKED, said])
    if not args.get('post', True):
        return {'action': 'dry', 'text': text}
    token, app_id, _ = viewed(repo)
    found = on_pull(repo, number, token, app_id)
    held = chains(found)
    there = ([('view', x['parts'][0]) for x in held if x['claims'] == head and x['whole']]
             or [('stopped', c) for c, g in found if g['stopped'] == head])
    if there:
        return {'action': 'unchanged', 'found': there[0][0], 'url': there[0][1].get('html_url')}
    pr = pr_review.api('GET', f'/repos/{repo}/pulls/{number}', token)
    if pr.get('state') != 'open':
        return {'action': 'closed', 'state': pr.get('state')}
    if pr['head']['sha'] != head:
        return {'action': 'moved', 'headNow': pr['head']['sha']}
    for x in held:
        if not x['whole']:
            deleted(repo, token, x['parts'])
    done = pr_review.posted(repo, number, token, app_id, [said], [text], {})
    return {'action': 'posted', 'url': done[said].get('html_url')}


STEPS = {'facts': facts, 'compared': compared, 'post': post, 'stopped': stopped}


# The workflow running a view keeps the last 1,500 characters of a step's stderr.
KEPT = 1500


def kept_whole(line):
    """A refusal cut at its end to what the workflow keeps, so its start, which says what was refused, is what it keeps."""
    return line if len(line) <= KEPT else line[:KEPT - 1] + '…'


CHECKOUT = '~/astra/context-view'


def refuse_checkout(module, command, code):
    """Exits CODE, saying why, when MODULE, the __file__ of a module whose command line was run, is in the main working copy,
    its own environment included, naming COMMAND, its installed form."""
    home = os.path.realpath(os.path.expanduser(CHECKOUT))
    if os.path.commonpath([os.path.realpath(module), home]) != home:
        return
    print(f'{os.path.basename(module)}: the context view runs from its install, not from its main working copy {CHECKOUT}: '
          f'use `{command}`, or a worktree to run your own code', file=sys.stderr)
    sys.exit(code)


def main(argv=None):
    if argv is None:
        refuse_checkout(__file__, '~/.local/lib/context-view/current/view/step STEP', 1)
    p = argparse.ArgumentParser(prog='view.py', description=__doc__.split('\n\n')[0])
    p.add_argument('step', choices=sorted(STEPS))
    o = p.parse_args(argv)
    try:
        given = json.load(sys.stdin)
        need(isinstance(given, dict), 'stdin: one JSON object')
        print(json.dumps(STEPS[o.step](given)))
    except NotARequest as e:
        print(kept_whole(f'view.py {o.step}: {e}'), file=sys.stderr)
        return 2
    except Failed as e:
        print(kept_whole(f'view.py {o.step}: {e}'), file=sys.stderr)
        return 1
    except (KeyError, IndexError, TypeError, AttributeError, ValueError):
        traceback.print_exc()
        print(f"view.py {o.step}: a field it reads is missing or of another shape, or the step's own code failed; the "
              'traceback above says which', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

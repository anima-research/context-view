"""The words every part of the view's comment shares: counts and lists in words, a collapsible's summary line, and items
folded into collapsibles within a comment's room."""
import html

from pr_comment import ACTIVE, COMMENT_MAX, one_line
from pr_run import need


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

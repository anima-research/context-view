"""The context view's poll (poll.py): its views step, a line only while no view's run holds the runners when it lists
them, the line not yet taken or else one for the pull request whose review started first of those waiting; and its asks
step, a line for each /context-deltas comment from the one account that may ask, one view's runners at a time."""
import contextlib, http.client, io, json, os, re, shutil, subprocess, tempfile, unittest, urllib.parse
from unittest import mock

import poll
import pr_poll
import pr_review
import pr_run
import view

APP_ID = 77
ACCOUNT = 7001
# A stand-in for `astra-workflows runs`: the runs in RUNS whose key starts with --key-prefix, newest first.
WORKFLOWS = '''#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
assert args[0] == 'runs', args
prefix = args[args.index('--key-prefix') + 1]
for r in sorted(json.load(open(RUNS)), key=lambda r: r['createdAt'], reverse=True):
    if r['key'].startswith(prefix):
        print(json.dumps(r))
'''


class GitHub:
    """A stand-in for the GitHub API calls the poll makes, answering as GitHub does: the App's installations, a token for
    one, the repositories it's installed on, and a repository's open pull requests, or its closed ones last updated
    first, paged by 100 with an ETag."""

    def __init__(self):
        self.repos = {'o/r': {'id': 1001, 'pulls': []}}
        self.calls = []
        self.installs = {5: {'id': ACCOUNT, 'login': 'org'}}
        self.tokens = {}
        self.minted = 0
        self.fail = None
        self.after_pulls = None

    def tag(self, value):
        return 'W/"' + str(abs(hash(json.dumps(value, sort_keys=True)))) + '"'

    def request(self, method, path, token=None, bearer=None, tag=None, body=None):
        """As pr_poll.request answers: a 2xx with its body, a 304 or a 404 with none, and any other status GitHub gives
        raises Failed."""
        status, value, etag, link = self.answer(method, path, token, bearer, tag, body)
        if status == 304:
            return 304, None, tag, None
        if status == 404:
            return 404, None, None, None
        if not 200 <= status < 300:
            raise pr_poll.Failed(f'GitHub answered {status} to {method} {path.split("?")[0]}: {json.dumps(value)[:300]}')
        return status, value, etag, link

    def answer(self, method, path, token, bearer, tag, body):
        self.calls.append((method, path))
        if self.fail and self.fail[0] in path:
            raise self.fail[1]
        if path.startswith('/app/installations?'):
            assert bearer == 'jwt', bearer
            return 200, [{'id': i, 'account': account} for i, account in self.installs.items()], None, None
        minting = re.fullmatch(r'/app/installations/(\d+)/access_tokens', path)
        if method == 'POST' and minting and int(minting[1]) in self.installs:
            self.minted += 1
            self.tokens[f'tok{self.minted}'] = int(minting[1])
            return 201, {'token': f'tok{self.minted}', 'expires_at': '2999-01-01T00:00:00Z'}, None, None
        if path.startswith('/installation/repositories'):
            held = [n for n, r in self.repos.items() if r.get('installation', 5) == self.tokens[token]]
            shown = [{'id': self.repos[n]['id'], 'full_name': n, **{k: self.repos[n][k] for k in ('archived', 'disabled') if k in self.repos[n]}}
                     for n in held]
            return 200, {'repositories': shown}, None, None
        for name, repo in self.repos.items():
            if method == 'GET' and path.startswith(f'/repos/{name}/pulls?'):
                assert self.tokens.get(token) == repo.get('installation', 5), token
                if 'state=closed' in path:
                    assert 'sort=updated' in path and 'direction=desc' in path, path
                    listed = self.listing(path, sorted(repo.get('closed', []), key=lambda p: p.get('updated_at') or '', reverse=True), tag)
                else:
                    listed = self.listing(path, repo['pulls'], tag)
                if self.after_pulls and self.after_pulls[0] == name:
                    self.after_pulls[1]()
                return listed
            if not path.startswith(f'/repos/{name}/'):
                continue
            assert self.tokens.get(token) == repo.get('installation', 5), token
            since = re.search(r'/issues/comments\?since=([^&]+)', path)
            if method == 'GET' and since:
                at = urllib.parse.unquote(since[1])
                return self.listing(path, [c for c in repo.get('comments', []) if c['updated_at'] >= at], tag)
            asker = re.fullmatch(rf'/repos/{re.escape(name)}/collaborators/([^/]+)/permission', path)
            if method == 'GET' and asker:
                if repo.get('permissionsFail'):
                    return repo['permissionsFail'], {'message': 'Server Error'}, None, None
                held = repo.get('permissions', {}).get(urllib.parse.unquote(asker[1]))
                return (200, {'permission': held}, None, None) if held else (404, {'message': 'Not Found'}, None, None)
            one = re.fullmatch(rf'/repos/{re.escape(name)}/pulls/(\d+)', path)
            if method == 'GET' and one:
                if int(one[1]) in repo.get('pullsFail', {}):
                    return repo['pullsFail'][int(one[1])], {'message': 'Server Error'}, None, None
                found = [pr for pr in repo['pulls'] + repo.get('closed', []) if pr['number'] == int(one[1])]
                if not found:
                    return 404, {'message': 'Not Found'}, None, None
                state = 'open' if found[0] in repo['pulls'] else 'closed'
                return 200, {**found[0], 'state': state}, None, None
            reacted = re.fullmatch(rf'/repos/{re.escape(name)}/issues/comments/(\d+)/reactions', path)
            if method == 'POST' and reacted:
                if repo.get('reactFail'):
                    return repo['reactFail'], {'message': 'Forbidden'}, None, None
                made = (int(reacted[1]), body['content'])
                if made in repo.get('reactions', []):
                    return 200, {'content': body['content']}, None, None
                repo.setdefault('reactions', []).append(made)
                return 201, {'content': body['content']}, None, None
        raise AssertionError(f'unrouted {method} {path}')

    def listing(self, path, items, tag):
        page = int((re.search(r'[?&]page=(\d+)', path) or [0, 1])[1])
        chunk = items[(page - 1) * 100:page * 100]
        etag = self.tag(chunk)
        if page == 1 and tag == etag:
            return 304, None, tag, None
        following = re.sub(r'&page=\d+', '', path) + f'&page={page + 1}' if len(items) > page * 100 else None
        return 200, json.loads(json.dumps(chunk)), etag, following


def pull(n, head='a', draft=False, association='MEMBER'):
    return {'number': n, 'draft': draft, 'head': {'sha': head * 40}, 'author_association': association}


class Polling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='context-view-poll-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.gh = GitHub()
        self.clock = ['2026-10-31T04:00:00Z']
        self.runs = os.path.join(self.tmp, 'runs.json')
        self.save_runs([])
        workflows = os.path.join(self.tmp, 'astra-workflows')
        with open(workflows, 'w') as f:
            f.write(WORKFLOWS.replace('RUNS', repr(self.runs)))
        os.chmod(workflows, 0o755)
        self.patch(poll, 'WORKFLOWS', workflows)
        self.patch(poll, 'STATE', os.path.join(self.tmp, 'state'))
        self.patch(pr_poll, 'request', self.gh.request)
        self.patch(pr_review, 'ACCOUNTS', {ACCOUNT: 'org'})
        self.patch(pr_review, 'app', lambda: {'appId': APP_ID, 'privateKey': 'k'})
        self.patch(pr_review, 'app_jwt', lambda cfg: 'jwt')
        self.patch(pr_run, 'now', lambda: self.clock[0])
        self.cursor = os.path.join(self.tmp, 'cursor')
        self.out = os.path.join(self.tmp, 'cursor-out')

    def patch(self, target, name, value):
        patcher = mock.patch.object(target, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def save_runs(self, runs):
        with open(self.runs, 'w') as f:
            json.dump(runs, f)

    def load_runs(self):
        with open(self.runs) as f:
            return json.load(f)

    def manifest(self, key, before=False, after=60):
        """The run side's manifest of KEY's view, written AFTER seconds past the run's start as its runners finish, or one
        left from a minute before it started, its time set from the run's createdAt rather than the machine's clock."""
        rid, rest = key[len('context-view/'):].split('#', 1)
        number, head = rest.split(':', 1)[0].split('@')
        name = view.VIEWED[int(rid)]
        where = poll.view_dir(name, int(number), head)
        os.makedirs(where, exist_ok=True)
        path = os.path.join(where, 'manifest.json')
        with open(path, 'w') as f:
            json.dump({'outcome': 'ran'}, f)
        created = [r for r in self.load_runs() if r['key'] == key][-1]['createdAt']
        at = poll.instant(created) + (-60 if before else after)
        os.utime(path, (at, at))

    def start_run(self, key):
        """A start under KEY, which as workflow-house's starts do makes a run only where the store holds none under it, and
        otherwise answers with the one it holds."""
        runs = self.load_runs()
        if key not in [r['key'] for r in runs]:
            created = self.clock[0].replace('Z', '.000Z')
            runs.append({'run': f'wf-{len(runs) + 1}', 'key': key, 'state': 'running', 'createdAt': created})
            self.save_runs(runs)

    def review(self, repo, number, head=None, comment=None, state='completed'):
        """A review the review poll started, under the key it starts one under: an opening's names its head, an ask's
        its comment."""
        key = (f'pr-review/open:{repo}#{number}@{head * 40}' if head else f'pr-review/ask:{repo}#{number}:comment-{comment}')
        self.start_run(key)
        runs = self.load_runs()
        for r in runs:
            if r['key'] == key:
                r['state'] = state
        self.save_runs(runs)
        return key


class Views(Polling):
    def setUp(self):
        super().setUp()
        self.gh.repos['a/t'] = {'id': 1002, 'pulls': []}
        self.gh.repos['x/y'] = {'id': 1009, 'pulls': [pull(1, '9')]}
        self.patch(view, 'VIEWED', {1001: 'o/r', 1002: 'a/t'})
        self.assertEqual(self.look(), (1, []))

    def look(self, take=True):
        cursor, out = f'{self.cursor}-poll', f'{self.out}-poll'
        if os.path.exists(out):
            os.remove(out)
        with mock.patch.dict(os.environ, {'ASTRA_JOB_CURSOR': cursor, 'ASTRA_JOB_CURSOR_OUT': out}), mock.patch('sys.stdout') as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            code = poll.main(['--job'])
        self.said = err.getvalue()
        lines = [json.loads(l) for l in ''.join(c.args[0] for c in stdout.write.call_args_list).splitlines() if l.strip()]
        if code == 0:
            self.assertTrue(os.path.exists(out), 'a pass that printed a line gave no cursor')
            if take:
                shutil.copy(out, cursor)
        return code, lines

    def started(self):
        """A pass whose line Jobs takes and starts, giving the key it started."""
        code, lines = self.look()
        if code != 0 or len(lines) != 1:
            self.fail(f'the pass started nothing: exit {code}, {lines}')
        [line] = lines
        self.start_run(line['key'])
        return line['key']

    def settle(self, key, state='completed'):
        runs = self.load_runs()
        mine = [r for r in runs if r['key'] == key]
        if not mine:
            self.fail(f'no run under {key!r} to settle')
        for r in mine:
            r['state'] = state
        self.save_runs(runs)

    def at(self, t):
        self.clock[0] = t

    def opened(self, repo, n, head, **kw):
        """A pull request open at HEAD whose opening the review poll started a review of."""
        found = [p for p in self.gh.repos[repo]['pulls'] if p['number'] != n]
        self.gh.repos[repo]['pulls'] = found + [pull(n, head, **kw)]
        return self.review(repo, n, head=head)

    def view_dir(self, repo, n, head):
        return os.path.join(poll.STATE, 'views', f"{repo.replace('/', '.')}.{n}.{(head * 40)[:12]}")

    def test_the_review_polls_keys_as_the_store_holds_them_name_the_pull_request_and_no_other_kind_of_review_does(self):
        self.assertEqual(poll.reviewed('pr-review/open:anima-research/agent-framework#997@19f9a89b642da49fc947bed81cedd927cdc91b52'),
                         ('anima-research/agent-framework', 997))
        self.assertEqual(poll.reviewed('pr-review/ask:nissa-seru/rookery-scratch#82:comment-6553164401'), ('nissa-seru/rookery-scratch', 82))
        self.assertEqual(poll.reviewed('pr-review/ask:antra-tess/membrane#248:comment-6640000001'), ('antra-tess/membrane', 248))
        for key in ('pr-review/release:harness.1988b2fcf0f0.3603a22fa7f3@20261109T100614Z',
                    'pr-review/pull:anima-research/agent-framework.5b2eed3c75ea.0019be3c5b4c@20261109T093009Z',
                    'pr-review/restart:pr-review/open:nissa-seru/rookery-scratch#99@1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
                    'context-view/1001#2@' + 'b' * 40):
            with self.subTest(key=key):
                self.assertIsNone(poll.reviewed(key))

    def test_the_review_polls_own_keys_for_an_opening_and_an_ask_are_the_ones_the_poll_reads(self):
        self.assertEqual(poll.reviewed(pr_review.request_key({'repo': 'o/r', 'number': 2, 'head': 'b' * 40})), ('o/r', 2))
        self.assertEqual(poll.reviewed(pr_review.request_key({'repo': 'o/r', 'number': 2, 'comment': 41})), ('o/r', 2))
        self.assertEqual(poll.REVIEWS, ('pr-review/open:', 'pr-review/ask:'))

    def test_a_review_start_gives_its_pull_request_one_view_at_its_head_now_marked_automatic(self):
        self.opened('o/r', 2, 'b')
        _, [line] = self.look()
        self.assertEqual(line, {'key': view.key_of(1001, 2, 'b' * 40),
                                'args': {'repo': 'o/r', 'number': 2, 'head': 'b' * 40, 'auto': True}})

    def test_the_first_pass_counts_the_reviews_already_in_the_store_and_starts_nothing_for_them(self):
        fresh = tempfile.mkdtemp(dir=self.tmp)
        self.patch(poll, 'STATE', fresh)
        self.opened('o/r', 2, 'b')
        self.gh.repos['o/r']['pulls'].append(pull(3, 'c'))
        self.review('o/r', 3, comment=41)
        self.assertEqual(self.look(), (1, []))
        self.opened('o/r', 4, 'd')
        self.assertEqual(self.started(), view.key_of(1001, 4, 'd' * 40))

    def test_an_open_pull_request_no_review_started_on_gets_no_view(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c')]
        self.assertEqual(self.look(), (1, []))

    def test_an_asks_review_names_no_head_so_the_view_takes_the_pull_requests_head_when_its_line_prints(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.review('o/r', 2, comment=41)
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))

    def test_one_view_runs_at_a_time_for_the_pull_request_whose_review_started_first(self):
        self.at('2026-11-05T01:00:00Z')
        first = self.opened('o/r', 2, 'b')
        self.assertEqual(first, f"pr-review/open:o/r#2@{'b' * 40}")
        running = self.started()
        self.assertEqual(running, view.key_of(1001, 2, 'b' * 40))
        self.at('2026-11-05T01:01:00Z')
        self.opened('a/t', 7, 'c')
        self.assertEqual(self.look(), (1, []))
        self.at('2026-11-05T01:02:00Z')
        self.opened('o/r', 3, 'd')
        self.assertEqual(self.look(), (1, []))
        self.settle(running)
        self.assertEqual(self.started(), view.key_of(1002, 7, 'c' * 40))
        self.settle(view.key_of(1002, 7, 'c' * 40), 'failed')
        self.assertEqual(self.started(), view.key_of(1001, 3, 'd' * 40))
        self.settle(view.key_of(1001, 3, 'd' * 40))
        self.assertEqual(self.look(), (1, []))

    def test_a_newcomers_pull_request_gets_no_view_and_the_pass_says_so_while_a_known_authors_does(self):
        for n, association in enumerate(('FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE'), 2):
            self.opened('o/r', n, 'b', association=association)
        self.assertEqual(self.look(), (1, []))
        for n in (2, 3, 4):
            self.assertIn(f"o/r#{n}'s author is new to the repository", self.said)
        self.assertEqual(self.look(), (1, []))
        for n, association in enumerate(pr_poll.KNOWN, 10):
            with self.subTest(association=association):
                self.opened('o/r', n, 'c', association=association)
                key = self.started()
                self.assertEqual(key, view.key_of(1001, n, 'c' * 40))
                self.settle(key)

    def test_a_draft_waits_until_it_is_marked_ready(self):
        self.opened('o/r', 2, 'b', draft=True)
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.started(), view.key_of(1001, 2, 'b' * 40))

    def test_a_head_that_moves_before_its_turn_is_viewed_at_the_head_it_has_then(self):
        running = f"context-view/1002#8@{'a' * 40}"
        self.start_run(running)
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.settle(running)
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))

    def test_a_review_start_at_a_head_whose_view_ran_starts_nothing_and_one_at_a_new_head_does(self):
        self.opened('o/r', 2, 'b')
        self.settle(self.started())
        self.review('o/r', 2, comment=41)
        self.assertEqual(self.look(), (1, []))
        self.opened('o/r', 2, 'c')
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))

    def test_a_head_whose_view_stopped_at_needs_companion_isnt_viewed_so_the_next_review_start_views_it_again(self):
        self.opened('o/r', 2, 'b')
        stopped = self.started()
        self.settle(stopped)
        self.companion(stopped)
        self.assertEqual(self.look(), (1, []))
        again = self.run_of(self.review('o/r', 2, comment=41))
        retried = self.started()
        self.assertEqual(retried, f'{stopped}:review-{again}')
        self.assertEqual([r['key'] for r in self.load_runs() if r['key'].startswith(stopped)], [stopped, retried])
        self.settle(retried)
        with open(os.path.join(self.view_dir('o/r', 2, 'b'), 'view.json'), 'w') as f:
            json.dump({'repo': 'o/r', 'number': 2, 'head': 'b' * 40, 'outcome': 'ran'}, f)
        self.review('o/r', 2, comment=42)
        self.assertEqual(self.look(), (1, []))

    def run_of(self, key):
        """The run the store holds under KEY."""
        [run] = [r['run'] for r in self.load_runs() if r['key'] == key]
        return run

    def test_a_view_whose_runners_are_done_while_its_reader_reads_lets_the_next_view_start(self):
        self.opened('o/r', 2, 'b')
        reading = self.started()
        self.opened('a/t', 7, 'c')
        self.assertEqual(self.look(), (1, []))
        self.manifest(reading)
        self.assertEqual(self.started(), view.key_of(1002, 7, 'c' * 40))

    def test_a_view_with_no_manifest_since_it_started_holds_the_slot_and_one_whose_directory_cant_be_named_holds_until_it_settles(self):
        self.opened('o/r', 2, 'b')
        running = self.started()
        self.manifest(running, before=True)
        self.opened('a/t', 7, 'c')
        self.assertEqual(self.look(), (1, []))
        self.settle(running, 'failed')
        dry = f"context-view/dry:o/r#9@{'f' * 40}"
        self.start_run(dry)
        self.assertEqual(self.look(), (1, []))
        self.assertIn(f'(running, {dry})', self.said)
        self.settle(dry)
        self.assertEqual(self.started(), view.key_of(1002, 7, 'c' * 40))

    def test_a_heads_views_directory_is_its_repository_pull_request_and_short_head_under_the_polls_state(self):
        self.assertEqual(poll.view_dir('anima-research/context-manager', 7, 'b' * 40),
                         os.path.join(poll.STATE, 'views', f"anima-research.context-manager.7.{'b' * 12}"))

    def queue_asks(self, *asks):
        """The asks step's queue as it would hold these asks, each (repository id, pull request, comment)."""
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        state['asks'] = {'seq': 0, 'line': None, 'repos': {},
                         'queue': [{'rid': rid, 'number': n, 'comment': c, 'made': '2026-10-31T04:00:00Z'} for rid, n, c in asks]}
        with open(os.path.join(poll.STATE, 'poll.json'), 'w') as f:
            json.dump(state, f)

    def test_an_ask_whose_head_has_an_unsettled_view_holds_no_automatic_view_while_the_runners_are_free(self):
        self.opened('o/r', 2, 'b')
        reading = self.started()
        self.manifest(reading)
        self.queue_asks((1001, 2, 41))
        self.opened('o/r', 3, 'c')
        _, [line] = self.look()
        self.assertEqual(line['key'], view.key_of(1001, 3, 'c' * 40))

    def test_the_views_line_is_kept_apart_from_line_where_the_release_befores_asks_step_waits(self):
        self.opened('o/r', 2, 'b')
        _, [line] = self.look(take=False)
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual((state['line'], state['views_line']['key']), (None, line['key']))

    def test_a_state_file_the_release_before_wrote_with_no_views_line_gives_a_line_at_the_first_pass(self):
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        del state['views_line']
        with open(os.path.join(poll.STATE, 'poll.json'), 'w') as f:
            json.dump(state, f)
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.started(), view.key_of(1001, 2, 'b' * 40))

    def test_a_dry_views_run_puts_nothing_in_seen_and_an_entry_that_names_no_view_leaves_it(self):
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        state['seen'] = ['context-view/dry']
        with open(os.path.join(poll.STATE, 'poll.json'), 'w') as f:
            json.dump(state, f)
        dry = f"context-view/dry:o/r#9@{'f' * 40}"
        self.start_run(dry)
        self.settle(dry)
        self.assertEqual(self.look(), (1, []))
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            self.assertEqual(json.load(f)['seen'], [])

    def test_a_queued_ask_goes_first_and_the_views_line_waits_until_the_asks_queue_is_empty(self):
        self.opened('o/r', 2, 'b')
        self.gh.repos['o/r']['pulls'].append(pull(3, 'c'))
        self.queue_asks((1001, 3, 41))
        self.assertEqual(self.look(), (1, []))
        self.assertIn("waiting for the asks' queue", self.said)
        self.queue_asks()
        self.assertEqual(self.started(), view.key_of(1001, 2, 'b' * 40))

    def test_an_ask_whose_pull_request_the_pass_doesnt_list_open_holds_no_view(self):
        self.opened('o/r', 2, 'b')
        self.queue_asks((1001, 9, 41), (1003, 1, 42))
        self.assertEqual(self.started(), view.key_of(1001, 2, 'b' * 40))

    def test_a_views_line_out_when_an_ask_is_queued_prints_again_until_jobs_takes_it(self):
        self.opened('o/r', 2, 'b')
        _, [line] = self.look(take=False)
        self.gh.repos['o/r']['pulls'].append(pull(3, 'c'))
        self.queue_asks((1001, 3, 41))
        self.assertEqual(self.look(take=False)[1], [line])
        self.assertEqual(self.started(), line['key'])

    def test_a_pull_request_opened_and_reviewed_while_a_pass_lists_gets_its_view(self):
        def meanwhile():
            self.gh.after_pulls = None
            self.opened('o/r', 2, 'b')
        self.gh.after_pulls = ('o/r', meanwhile)
        self.assertEqual(self.look(), (1, []))
        self.assertEqual(self.started(), view.key_of(1001, 2, 'b' * 40))

    def test_a_review_start_during_a_view_keeps_its_pull_request_queued_so_a_push_then_gets_a_view(self):
        self.opened('o/r', 2, 'b')
        running = self.started()
        self.assertEqual(self.look(), (1, []))
        self.review('o/r', 2, comment=41)
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.manifest(running)
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))

    def test_a_review_start_during_a_view_that_ends_needs_companion_views_its_head_again(self):
        self.opened('o/r', 2, 'b')
        running = self.started()
        self.assertEqual(self.look(), (1, []))
        again = self.run_of(self.review('o/r', 2, comment=41))
        self.assertEqual(self.look(), (1, []))
        self.settle(running)
        self.companion(running)
        self.assertEqual(self.started(), f'{running}:review-{again}')

    def test_an_asks_view_running_at_a_waiting_head_keeps_its_pull_request_queued_so_a_push_then_gets_a_view(self):
        self.opened('o/r', 2, 'b')
        asked = f"{view.key_of(1001, 2, 'b' * 40)}:ask-41"
        self.start_run(asked)
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.manifest(asked)
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))

    def test_a_view_json_that_cant_be_read_is_said_and_its_head_is_viewed_again_at_its_next_review(self):
        self.opened('o/r', 2, 'b')
        ran = self.started()
        self.settle(ran)
        os.makedirs(self.view_dir('o/r', 2, 'b'))
        with open(os.path.join(self.view_dir('o/r', 2, 'b'), 'view.json'), 'w') as f:
            f.write('{"outcome": "needs-comp')
        self.assertEqual(self.look(), (1, []))
        again = self.run_of(self.review('o/r', 2, comment=41))
        self.assertEqual(self.started(), f'{ran}:review-{again}')
        self.assertIn("view.json can't be read", self.said)

    def companion(self, key):
        """The view.json of KEY's head, written by a view that no stack of releases could run."""
        rid, rest = key[len('context-view/'):].split('#', 1)
        number, head = rest.split('@')
        where = poll.view_dir(view.VIEWED[int(rid)], int(number), head)
        os.makedirs(where, exist_ok=True)
        with open(os.path.join(where, 'view.json'), 'w') as f:
            json.dump({'outcome': 'needs-companion'}, f)

    def test_a_review_in_a_repository_the_view_doesnt_cover_and_a_release_or_a_restarts_review_start_no_view(self):
        self.review('x/y', 1, head='9')
        self.start_run('pr-review/release:harness.1988b2fcf0f0.3603a22fa7f3@20261109T100614Z')
        self.start_run(f"pr-review/restart:pr-review/open:o/r#2@{'b' * 40}")
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.look(), (1, []))
        self.assertFalse(any(path.startswith('/repos/x/y/') for _, path in self.gh.calls))

    def test_a_pull_request_closed_before_its_turn_gets_no_view(self):
        running = f"context-view/1002#8@{'a' * 40}"
        self.start_run(running)
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = []
        self.settle(running)
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.look(), (1, []))

    def test_a_review_start_while_its_pull_requests_line_is_out_gives_its_newer_head_a_view_after(self):
        self.opened('o/r', 2, 'b')
        _, [line] = self.look(take=False)
        self.at('2026-10-31T04:05:00Z')
        self.opened('o/r', 2, 'c')
        self.assertEqual([l['key'] for l in self.look()[1]], [view.key_of(1001, 2, 'c' * 40)])
        self.start_run(view.key_of(1001, 2, 'c' * 40))
        self.settle(view.key_of(1001, 2, 'c' * 40))
        self.assertEqual(self.look(), (1, []))
        self.at('2026-10-31T04:06:00Z')
        self.opened('o/r', 3, 'd')
        key = self.started()
        self.assertEqual(key, view.key_of(1001, 3, 'd' * 40))
        self.at('2026-10-31T04:07:00Z')
        self.opened('o/r', 3, 'e')
        self.settle(key)
        self.assertEqual(self.started(), view.key_of(1001, 3, 'e' * 40))

    def test_a_push_while_its_view_runs_gives_the_pull_requests_new_head_a_view_after_it(self):
        self.opened('o/r', 2, 'b')
        running = self.started()
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.settle(running)
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))
        self.settle(view.key_of(1001, 2, 'c' * 40))
        self.assertEqual(self.look(), (1, []))

    def test_a_push_after_a_pass_has_seen_its_view_running_gives_the_new_head_a_view_once_the_runners_are_done(self):
        self.opened('o/r', 2, 'b')
        running = self.started()
        self.assertEqual(self.look(), (1, []))
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.manifest(running)
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))

    def test_a_push_after_its_view_settled_at_an_unchanged_head_gets_no_view_until_a_review_of_it_starts(self):
        self.opened('o/r', 2, 'b')
        running = self.started()
        self.assertEqual(self.look(), (1, []))
        other = f"context-view/1002#8@{'a' * 40}"
        self.start_run(other)
        self.settle(running)
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.settle(other)
        self.assertEqual(self.look(), (1, []))
        self.review('o/r', 2, comment=41)
        self.assertEqual(self.started(), view.key_of(1001, 2, 'c' * 40))

    def test_a_line_jobs_didnt_take_prints_again_until_its_head_is_superseded(self):
        self.opened('o/r', 2, 'b')
        _, first = self.look(take=False)
        self.assertEqual([line['key'] for line in first], [view.key_of(1001, 2, 'b' * 40)])
        self.assertEqual(self.look(take=False)[1], first)
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual([line['key'] for line in self.look(take=False)[1]], [view.key_of(1001, 2, 'c' * 40)])

    def test_any_view_at_its_runners_holds_the_slot_whatever_head_its_for_and_whoever_started_it(self):
        self.start_run(f"context-view/1002#8@{'a' * 40}")
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.look(), (1, []))
        self.assertIn(f"wf-1 (running, context-view/1002#8@{'a' * 40})", self.said)
        self.settle(f"context-view/1002#8@{'a' * 40}", 'stopped')
        self.assertEqual(self.started(), view.key_of(1001, 2, 'b' * 40))

    def test_a_line_printed_before_a_view_started_by_hand_waits_until_that_view_settles(self):
        self.opened('o/r', 2, 'b')
        _, first = self.look(take=False)
        self.assertEqual([line['key'] for line in first], [view.key_of(1001, 2, 'b' * 40)])
        self.start_run(f"context-view/1002#8@{'a' * 40}")
        self.assertEqual(self.look(take=False), (1, []))
        self.settle(f"context-view/1002#8@{'a' * 40}")
        self.assertEqual(self.look(take=False)[1], first)

    def test_a_line_whose_head_got_its_view_by_another_start_is_dropped(self):
        self.opened('o/r', 2, 'b')
        _, [line] = self.look(take=False)
        self.start_run(line['key'])
        self.settle(line['key'])
        self.assertEqual(self.look(take=False), (1, []))

    def test_a_pass_lists_the_views_runs_and_each_kind_of_review_once_however_many_wait(self):
        for n in range(1, 31):
            self.opened('o/r', n, 'b')
        first = self.started()
        listings, run = [], subprocess.run

        def counted(args, **kw):
            if args[0] == poll.WORKFLOWS:
                listings.append(args)
            return run(args, **kw)
        self.patch(poll.subprocess, 'run', counted)
        self.assertEqual(self.look(), (1, []))
        self.assertEqual(sorted(listings), sorted([[poll.WORKFLOWS, 'runs', '--key-prefix', 'context-view/'],
                                                   [poll.WORKFLOWS, 'runs', '--key-prefix', 'pr-review/open:'],
                                                   [poll.WORKFLOWS, 'runs', '--key-prefix', 'pr-review/ask:']]))
        self.settle(first)
        self.assertIsNotNone(self.started())

    def test_a_viewed_head_stays_viewed_after_the_store_clears_its_run_and_is_forgotten_once_its_pull_request_closes(self):
        self.opened('o/r', 2, 'b')
        self.opened('o/r', 3, 'c')
        self.settle(self.started())
        self.settle(self.started())
        self.assertEqual(self.look(), (1, []))
        self.save_runs([])
        self.review('o/r', 2, comment=41)
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [p for p in self.gh.repos['o/r']['pulls'] if p['number'] == 3]
        self.look()
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual(state['seen'], [view.key_of(1001, 3, 'c' * 40)])

    def test_a_repository_out_of_view_for_a_pass_keeps_its_queued_pull_request_and_a_line_dropped_for_it_is_named(self):
        busy = f"context-view/1001#9@{'f' * 40}"
        self.start_run(busy)
        self.at('2026-11-05T01:00:00Z')
        self.opened('a/t', 7, 'c')
        self.assertEqual(self.look(), (1, []))
        self.at('2026-11-05T01:01:00Z')
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['a/t']['archived'] = True
        self.assertEqual(self.look(), (1, []))
        del self.gh.repos['a/t']['archived']
        self.assertEqual(self.look(), (1, []))
        self.settle(busy)
        _, [line] = self.look(take=False)
        self.assertEqual(line['key'], view.key_of(1002, 7, 'c' * 40))
        self.gh.repos['a/t']['archived'] = True
        self.assertEqual([l['key'] for l in self.look(take=False)[1]], [view.key_of(1001, 2, 'b' * 40)])
        self.assertIn(f"{view.key_of(1002, 7, 'c' * 40)}'s line is dropped, since its repository isn't in this pass's listing", self.said)

    def test_a_review_start_in_a_covered_repository_this_pass_doesnt_list_waits_for_its_listing(self):
        self.gh.repos['a/t']['archived'] = True
        self.opened('a/t', 7, 'c')
        self.assertEqual(self.look(), (1, []))
        del self.gh.repos['a/t']['archived']
        self.assertEqual(self.started(), view.key_of(1002, 7, 'c' * 40))

    def test_a_renamed_repositorys_line_names_it_as_it_is_now_and_its_viewed_heads_stay_viewed(self):
        self.opened('o/r', 2, 'b')
        _, [first] = self.look(take=False)
        self.assertEqual(first['args']['repo'], 'o/r')
        self.gh.repos['o/renamed'] = self.gh.repos.pop('o/r')
        _, [line] = self.look()
        self.assertEqual(line, {**first, 'args': {**first['args'], 'repo': 'o/renamed'}})
        self.start_run(line['key'])
        self.settle(line['key'])
        self.review('o/renamed', 2, comment=41)
        self.assertEqual(self.look(), (1, []))

    def test_a_taken_line_whose_run_never_appeared_leaves_until_a_review_starts_again_then_prints_past_the_cursor(self):
        self.opened('o/r', 2, 'b')
        _, [line] = self.look()
        with open(f'{self.cursor}-poll') as f:
            taken = int(f.read())
        self.assertEqual(self.look(), (1, []))
        self.assertEqual(self.look(), (1, []))
        self.review('o/r', 2, comment=41)
        self.assertEqual(self.look()[1], [line])
        with open(f'{self.cursor}-poll') as f:
            self.assertGreater(int(f.read()), taken)

    def test_the_poll_keeps_its_state_in_its_own_file_and_writes_none_of_review_workflows(self):
        theirs = os.path.join(self.tmp, 'review-workflow-poll')
        self.patch(pr_poll, 'POLL', theirs)
        self.opened('o/r', 2, 'b')
        self.started()
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual(state['views_line']['key'], view.key_of(1001, 2, 'b' * 40))
        self.assertFalse(os.path.exists(theirs))

    def test_an_installation_on_an_account_the_app_doesnt_serve_is_never_read(self):
        self.gh.calls.clear()
        self.gh.installs[6] = {'id': 9999, 'login': 'elsewhere'}
        self.gh.repos['a/t'].update(installation=6)
        self.opened('a/t', 7, 'c')
        self.assertEqual(self.look(), (1, []))
        self.assertNotIn(('POST', '/app/installations/6/access_tokens'), self.gh.calls)
        self.assertFalse(any(path.startswith('/repos/a/t/') for _, path in self.gh.calls))

    def test_a_failure_exits_2_says_why_and_keeps_the_state_and_cursor_as_they_were(self):
        self.opened('o/r', 2, 'b')
        _, [taken] = self.look()
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            before = f.read()
        self.assertEqual(json.loads(before)['views_line']['key'], taken['key'])
        for failure, said in ((pr_run.Failed('GitHub answered 502 to GET /app/installations'),
                               'poll.py: GitHub answered 502 to GET /app/installations'),
                              (RuntimeError('the stand-in broke'), 'RuntimeError: the stand-in broke')):
            with self.subTest(said=said):
                self.gh.fail = ('/installation/repositories', failure)
                self.assertEqual(self.look(), (2, []))
                self.assertIn(said, self.said)
                self.assertFalse(os.path.exists(f'{self.out}-poll'))
                with open(os.path.join(poll.STATE, 'poll.json')) as f:
                    self.assertEqual(f.read(), before)
        self.gh.fail = None
        self.review('o/r', 2, comment=41)
        self.assertEqual(self.started(), view.key_of(1001, 2, 'b' * 40))

    def test_a_view_running_again_under_a_key_whose_earlier_run_settled_still_holds_the_slot(self):
        key = f"context-view/1001#2@{'b' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': key, 'state': 'completed', 'createdAt': '2026-10-31T03:00:00.000Z'},
                        {'run': 'wf-2', 'key': key, 'state': 'running', 'createdAt': '2026-10-31T03:30:00.000Z'}])
        self.opened('o/r', 3, 'c')
        self.assertEqual(self.look(), (1, []))
        self.assertIn(f'wf-2 (running, {key})', self.said)

    def test_a_command_line_from_the_main_working_copy_refuses_as_a_failure_naming_the_installed_form(self):
        asked = len(self.gh.calls)
        copy = os.path.dirname(os.path.dirname(os.path.realpath(poll.__file__)))
        with mock.patch.object(view, 'CHECKOUT', copy), mock.patch('sys.argv', ['poll.py']), \
                contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as refused:
            poll.main()
        self.assertEqual(refused.exception.code, 2)
        self.assertIn('`~/.local/lib/context-view/current/view/poll`', err.getvalue())
        self.assertEqual(len(self.gh.calls), asked, 'a refused pass asks GitHub nothing')


    def test_a_manifest_written_at_its_runs_start_is_its_runs_and_one_written_a_moment_before_is_an_earlier_views(self):
        key = f"context-view/1001#3@{'c' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': key, 'state': 'running', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        [run] = self.load_runs()
        self.manifest(key, after=0)
        self.assertFalse(poll.holds(run))
        self.manifest(key, after=-0.001)
        self.assertTrue(poll.holds(run))

    def test_a_first_pass_writes_the_earlier_polls_known_and_waiting_so_a_rollback_reads_its_state(self):
        self.assertEqual(self.look(), (1, []))
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual((state['known'], state['waiting']), ([], {}))


def comment(n, body, login='nissa-seru', at='2026-11-05T01:00:00Z', number=2, repo='o/r', app=None, kind='pull'):
    return {'id': n, 'body': body, 'user': {'login': login}, 'created_at': at, 'updated_at': at,
            'html_url': f'https://github.com/{repo}/{kind}/{number}#issuecomment-{n}',
            **({'performed_via_github_app': {'id': app}} if app else {})}


class Asks(Polling):
    def setUp(self):
        super().setUp()
        self.gh.repos['o/r'].update(permissions={'nissa-seru': 'admin', 'maintainer': 'write', 'reader': 'read'},
                                    pulls=[pull(2, 'b'), pull(3, 'c')])
        self.gh.repos['x/y'] = {'id': 1009, 'pulls': [pull(1, 'q')], 'permissions': {'nissa-seru': 'admin'}}
        self.patch(view, 'VIEWED', {1001: 'o/r'})
        self.at('2026-11-05T00:00:00Z')
        self.assertEqual(self.ask(), (1, []))

    def ask(self, take=True):
        cursor, out = f'{self.cursor}-asks', f'{self.out}-asks'
        if os.path.exists(out):
            os.remove(out)
        with mock.patch.dict(os.environ, {'ASTRA_JOB_CURSOR': cursor, 'ASTRA_JOB_CURSOR_OUT': out}), mock.patch('sys.stdout') as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            code = poll.main(['asks', '--job'])
        self.said = err.getvalue()
        lines = [json.loads(l) for l in ''.join(c.args[0] for c in stdout.write.call_args_list).splitlines() if l.strip()]
        if code == 0:
            self.assertTrue(os.path.exists(out), 'a pass that printed a line gave no cursor')
            if take:
                shutil.copy(out, cursor)
        return code, lines

    def at(self, t):
        self.clock[0] = t

    def comments(self, *made):
        self.gh.repos['o/r'].setdefault('comments', []).extend(made)

    def test_an_ask_from_the_one_account_that_may_ask_prints_its_pull_requests_head_now_under_a_key_naming_the_comment(self):
        self.comments(comment(41, '/context-deltas'))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'f'), pull(3, 'c')]
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (0, [{'key': f"context-view/1001#2@{'f' * 40}:ask-41",
                                           'args': {'repo': 'o/r', 'number': 2, 'head': 'f' * 40}}]))
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(41, 'eyes')])
        self.start_run(f"context-view/1001#2@{'f' * 40}:ask-41")
        self.assertEqual(self.ask(), (1, []))
        self.settle_all()
        self.assertEqual(self.ask(), (1, []))
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(41, 'eyes')])

    def test_the_first_pass_asks_from_now_so_comments_from_before_it_are_never_asks(self):
        self.gh.repos['o/r']['comments'] = []
        fresh = tempfile.mkdtemp(dir=self.tmp)
        self.patch(poll, 'STATE', fresh)
        self.comments(comment(40, '/context-deltas', at='2026-11-04T23:00:00Z'))
        self.at('2026-11-05T00:30:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertEqual(self.ask(), (1, []))
        self.assertNotIn('reactions', self.gh.repos['o/r'])

    def test_only_the_command_alone_on_a_comments_first_line_asks(self):
        self.comments(comment(41, '/context-deltas please', number=3), comment(42, '/review'), comment(43, 'see /context-deltas'),
                      comment(44, '  /context-deltas  \nfor this head'))
        self.at('2026-11-05T01:01:00Z')
        _, lines = self.ask()
        self.assertEqual([l['key'] for l in lines], [f"context-view/1001#2@{'b' * 40}:ask-44"])
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(44, 'eyes')])
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            self.assertEqual([q['comment'] for q in json.load(f)['asks']['queue']], [44])

    def test_no_one_else_may_ask_whatever_their_access_and_the_one_account_may_only_with_write(self):
        self.comments(comment(41, '/context-deltas', login='maintainer'), comment(42, '/context-deltas', login='reader'),
                      comment(43, '/context-deltas', login='stranger'), comment(40, '/context-deltas', number=3, at='2026-11-05T01:00:30Z'))
        self.at('2026-11-05T01:01:00Z')
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#3@{'c' * 40}:ask-40")
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(40, 'eyes')])
        self.start_run(line['key'])
        self.settle_all()
        self.gh.repos['o/r']['permissions']['nissa-seru'] = 'read'
        self.comments(comment(44, '/context-deltas', at='2026-11-05T01:02:00Z'))
        self.at('2026-11-05T01:03:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(40, 'eyes')])

    def test_the_apps_own_comment_and_one_on_an_issue_are_never_asks(self):
        self.comments(comment(41, '/context-deltas', app=APP_ID), comment(42, '/context-deltas', kind='issues'),
                      comment(43, '/context-deltas', number=3))
        self.at('2026-11-05T01:01:00Z')
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#3@{'c' * 40}:ask-43")
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(43, 'eyes')])

    def test_one_views_runners_at_a_time_and_an_ask_waits_for_a_view_at_its_runners_whatever_started_it(self):
        held = f"context-view/1001#3@{'c' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': held, 'state': 'running', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertIn(f'wf-1 (running, {held})', self.said)
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(41, 'eyes')])
        self.save_runs([{'run': 'wf-1', 'key': held, 'state': 'completed', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")

    def test_an_ask_waits_for_a_views_runners_not_its_reader(self):
        held = f"context-view/1001#3@{'c' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': held, 'state': 'running', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.manifest(held)
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")

    def test_an_ask_waits_while_a_view_of_its_own_head_is_unsettled_and_an_ask_on_another_head_goes_meanwhile(self):
        reading = f"context-view/1001#2@{'b' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': reading, 'state': 'running', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        self.manifest(reading)
        self.comments(comment(41, '/context-deltas'), comment(42, '/context-deltas', number=3, at='2026-11-05T01:00:30Z'))
        self.at('2026-11-05T01:01:00Z')
        _, [other] = self.ask()
        self.assertEqual(other['key'], f"context-view/1001#3@{'c' * 40}:ask-42")
        self.assertIn(f"the ask in comment 41 waits for wf-1, a view of its head that hasn't settled", self.said)
        self.settle_all()
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")

    def test_a_line_jobs_didnt_take_prints_again_and_asks_queued_behind_it_print_in_turn_once_its_view_settles(self):
        self.comments(comment(41, '/context-deltas'), comment(42, '/context-deltas', number=3, at='2026-11-05T01:00:30Z'))
        self.at('2026-11-05T01:01:00Z')
        _, [first] = self.ask(take=False)
        self.assertEqual(self.ask(take=False), (0, [first]))
        _, [again] = self.ask()
        self.assertEqual(again, first)
        self.start_run(first['key'])
        self.assertEqual(self.ask(), (1, []))
        self.settle_all()
        _, [second] = self.ask()
        self.assertEqual(second['key'], f"context-view/1001#3@{'c' * 40}:ask-42")

    def settle_all(self):
        self.save_runs([{**r, 'state': 'completed'} for r in self.load_runs()])

    def test_a_newer_ask_on_a_pull_request_with_one_queued_takes_its_place_at_the_head_then(self):
        held = f"context-view/1001#3@{'c' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': held, 'state': 'running', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'g'), pull(3, 'c')]
        self.comments(comment(45, '/context-deltas', at='2026-11-05T01:02:00Z'))
        self.at('2026-11-05T01:03:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.settle_all()
        self.assertEqual(self.ask(), (0, [{'key': f"context-view/1001#2@{'g' * 40}:ask-45",
                                           'args': {'repo': 'o/r', 'number': 2, 'head': 'g' * 40}}]))
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(41, 'eyes'), (45, 'eyes')])

    def test_an_ask_on_a_closed_pull_request_prints_nothing_and_says_so(self):
        self.gh.repos['o/r']['closed'] = [pull(5, 'd')]
        self.comments(comment(41, '/context-deltas', number=5))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertIn('o/r#5 is closed', self.said)
        self.assertNotIn('reactions', self.gh.repos['o/r'])

    def test_a_repository_not_in_the_views_list_is_never_read_for_asks(self):
        self.gh.repos['x/y']['comments'] = [comment(51, '/context-deltas', repo='x/y', number=1)]
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertFalse(any(path.startswith('/repos/x/y/') for _, path in self.gh.calls))

    def test_an_ask_already_run_under_its_key_prints_nothing_again(self):
        self.comments(comment(41, '/context-deltas'), comment(42, '/context-deltas', number=3))
        self.save_runs([{'run': 'wf-1', 'key': f"context-view/1001#2@{'b' * 40}:ask-41", 'state': 'completed',
                         'createdAt': '2026-11-05T00:50:00.000Z'}])
        self.at('2026-11-05T01:01:00Z')
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#3@{'c' * 40}:ask-42")

    def test_an_ask_views_its_pull_requests_head_as_it_is_when_its_line_is_printed(self):
        held = f"context-view/1001#3@{'c' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': held, 'state': 'running', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'h'), pull(3, 'c')]
        self.settle_all()
        _, [line] = self.ask(take=False)
        self.assertEqual(line, {'key': f"context-view/1001#2@{'h' * 40}:ask-41", 'args': {'repo': 'o/r', 'number': 2, 'head': 'h' * 40}})
        self.gh.repos['o/r']['pulls'] = [pull(2, 'i'), pull(3, 'c')]
        _, [again] = self.ask()
        self.assertEqual(again['args']['head'], 'i' * 40)
        self.assertEqual(again['key'], f"context-view/1001#2@{'i' * 40}:ask-41")

    def test_an_ask_whose_pull_request_closes_while_it_waits_gets_no_view_and_the_next_ask_prints(self):
        held = f"context-view/1001#9@{'c' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': held, 'state': 'running', 'createdAt': '2026-11-05T00:50:00.000Z'}])
        self.comments(comment(41, '/context-deltas'), comment(42, '/context-deltas', number=3, at='2026-11-05T01:00:30Z'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.gh.repos['o/r'].update(pulls=[pull(3, 'c')], closed=[pull(2, 'b')])
        self.settle_all()
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#3@{'c' * 40}:ask-42")
        self.assertIn('o/r#2 is closed', self.said)

    def test_a_line_either_step_printed_holds_the_other_until_its_view_shows_in_the_store(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c')]
        views = lambda: self.pass_of([])
        self.assertEqual(views(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd')]
        self.review('o/r', 4, head='d')
        code, [printed] = views()
        self.assertEqual(printed['key'], f"context-view/1001#4@{'d' * 40}")
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertIn(f"the views' line {printed['key']}", self.said)
        self.start_run(printed['key'])
        self.assertEqual(self.ask(), (1, []))
        self.settle_all()
        _, [asked] = self.ask(take=False)
        self.assertEqual(asked['key'], f"context-view/1001#2@{'b' * 40}:ask-41")
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd'), pull(5, 'e')]
        self.review('o/r', 5, head='e')
        self.assertEqual(views(), (1, []))
        self.assertIn(f"the asks' line {asked['key']}", self.said)

    def pass_of(self, argv):
        cursor, out = f'{self.cursor}-poll', f'{self.out}-poll'
        if os.path.exists(out):
            os.remove(out)
        with mock.patch.dict(os.environ, {'ASTRA_JOB_CURSOR': cursor, 'ASTRA_JOB_CURSOR_OUT': out}), mock.patch('sys.stdout') as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            code = poll.main([*argv, '--job'])
        self.said = err.getvalue()
        lines = [json.loads(l) for l in ''.join(c.args[0] for c in stdout.write.call_args_list).splitlines() if l.strip()]
        if code == 0:
            shutil.copy(out, cursor)
        return code, lines

    def test_an_asks_view_of_a_head_counts_as_that_head_viewed_for_the_views_poll(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c')]
        self.assertEqual(self.pass_of([]), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd')]
        self.comments(comment(41, '/context-deltas', number=4))
        self.at('2026-11-05T01:01:00Z')
        _, [asked] = self.ask()
        self.assertEqual(asked['key'], f"context-view/1001#4@{'d' * 40}:ask-41")
        self.start_run(asked['key'])
        self.settle_all()
        self.review('o/r', 4, comment=51)
        self.assertEqual(self.pass_of([]), (1, []))

    def test_a_pass_no_job_made_prints_what_it_would_and_leaves_the_state_and_every_comment_as_they_were(self):
        self.assertEqual(self.pass_of([]), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd')]
        self.review('o/r', 4, head='d')
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        path = os.path.join(poll.STATE, 'poll.json')
        with open(path) as f:
            before = f.read()
        for argv in (['asks'], []):
            with self.subTest(argv=argv), mock.patch.dict(os.environ, {'ASTRA_JOB_ID': '70169'}), mock.patch('sys.stdout') as stdout, \
                    contextlib.redirect_stderr(io.StringIO()):
                code = poll.main(argv)
                printed = ''.join(c.args[0] for c in stdout.write.call_args_list)
            self.assertEqual((code, [json.loads(l)['key'] for l in printed.splitlines()]),
                             (0, [f"context-view/1001#2@{'b' * 40}:ask-41" if argv else f"context-view/1001#4@{'d' * 40}"]))
            with open(path) as f:
                self.assertEqual(f.read(), before)
        self.assertNotIn('reactions', self.gh.repos['o/r'])
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(41, 'eyes')])

    def test_an_asks_line_jobs_didnt_take_prints_again_and_one_it_took_isnt_viewed_again_at_a_later_head(self):
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        _, [first] = self.ask(take=False)
        _, [again] = self.ask()
        self.assertEqual(again, first)
        self.start_run(again['key'])
        self.settle_all()
        self.gh.repos['o/r']['pulls'] = [pull(2, 'j'), pull(3, 'c')]
        self.assertEqual(self.ask(), (1, []))
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            self.assertEqual(json.load(f)['asks']['queue'], [])

    def test_a_comment_made_in_the_second_a_look_ended_at_is_read_at_the_next_and_none_is_taken_in_twice(self):
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:00:00Z')
        _, [first] = self.ask()
        self.start_run(first['key'])
        self.settle_all()
        self.comments(comment(42, '/context-deltas', number=3))
        _, [second] = self.ask()
        self.assertEqual(second['key'], f"context-view/1001#3@{'c' * 40}:ask-42")
        self.start_run(second['key'])
        self.settle_all()
        self.assertEqual(self.ask(), (1, []))
        posted = [path for method, path in self.gh.calls if method == 'POST' and path.endswith('/reactions')]
        self.assertEqual(posted, ['/repos/o/r/issues/comments/41/reactions', '/repos/o/r/issues/comments/42/reactions'])

    def test_a_pull_request_read_that_fails_as_an_ask_is_taken_in_fails_the_pass_so_the_ask_is_read_again(self):
        self.comments(comment(41, '/context-deltas', number=3))
        self.at('2026-11-05T01:01:00Z')
        for failure in ({3: 502}, TimeoutError('timed out')):
            with self.subTest(failure=failure):
                if isinstance(failure, dict):
                    self.gh.repos['o/r']['pullsFail'] = failure
                else:
                    self.gh.fail = ('/pulls/3', failure)
                self.assertEqual(self.ask(), (2, []))
                self.gh.repos['o/r'].pop('pullsFail', None)
                self.gh.fail = None
        self.assertNotIn('reactions', self.gh.repos['o/r'])
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#3@{'c' * 40}:ask-41")

    def test_eyes_that_fail_are_said_on_stderr_and_each_ask_still_views(self):
        failures = (403, 404, 502, TimeoutError('timed out'), ValueError('Expecting value'), http.client.IncompleteRead(b''))
        for n, failure in enumerate(failures):
            with self.subTest(failure=failure):
                made = f'2026-11-05T01:0{n}:30Z'
                self.comments(comment(41 + n, '/context-deltas', number=2 + n % 2, at=made))
                self.at(f'2026-11-05T01:0{n + 1}:00Z')
                if isinstance(failure, int):
                    self.gh.repos['o/r']['reactFail'] = failure
                else:
                    self.gh.fail = ('/reactions', failure)
                _, [line] = self.ask()
                self.assertTrue(line['key'].endswith(f':ask-{41 + n}'), line)
                self.assertIn(f'no 👀 on o/r comment {41 + n}: ', self.said)
                self.gh.repos['o/r'].pop('reactFail', None)
                self.gh.fail = None
                self.start_run(line['key'])
                self.settle_all()
        self.assertNotIn('reactions', self.gh.repos['o/r'])

    def test_a_permission_lookup_github_fails_fails_the_pass_so_the_ask_is_read_again(self):
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.gh.repos['o/r']['permissionsFail'] = 502
        self.assertEqual(self.ask(), (2, []))
        self.assertIn('GitHub answered 502', self.said)
        self.gh.repos['o/r'].pop('permissionsFail')
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")

    def second(self):
        self.gh.repos['a/t'] = {'id': 1002, 'pulls': [pull(7, 'e')], 'permissions': {'nissa-seru': 'admin'}}
        self.patch(view, 'VIEWED', {1001: 'o/r', 1002: 'a/t'})
        self.assertEqual(self.ask(), (1, []))

    def test_asks_found_in_one_pass_queue_in_the_order_they_were_asked_whatever_their_repositorys_place(self):
        self.second()
        self.comments(comment(41, '/context-deltas', at='2026-11-05T01:00:40Z'))
        self.gh.repos['a/t']['comments'] = [comment(51, '/context-deltas', repo='a/t', number=7, at='2026-11-05T01:00:20Z')]
        self.at('2026-11-05T01:01:00Z')
        _, [first] = self.ask()
        self.assertEqual(first['key'], f"context-view/1002#7@{'e' * 40}:ask-51")

    def test_an_ask_whose_repository_isnt_listed_waits_and_the_next_listed_ask_prints_in_its_place(self):
        self.second()
        self.comments(comment(41, '/context-deltas', at='2026-11-05T01:00:20Z'))
        self.gh.repos['a/t']['comments'] = [comment(51, '/context-deltas', repo='a/t', number=7, at='2026-11-05T01:00:40Z')]
        self.at('2026-11-05T01:01:00Z')
        _, [first] = self.ask(take=False)
        self.assertEqual(first['key'], f"context-view/1001#2@{'b' * 40}:ask-41")
        self.gh.repos['o/r']['archived'] = True
        _, [other] = self.ask(take=False)
        self.assertEqual(other['key'], f"context-view/1002#7@{'e' * 40}:ask-51")
        self.assertIn("comment 41 waits", self.said)
        self.gh.repos['o/r'].pop('archived')
        self.start_run(other['key'])
        self.settle_all()
        _, [back] = self.ask()
        self.assertEqual(back['key'], f"context-view/1001#2@{'b' * 40}:ask-41")

    def test_a_newer_ask_on_a_pull_request_takes_the_place_of_its_untaken_line(self):
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        _, [old] = self.ask(take=False)
        self.assertEqual(old['key'], f"context-view/1001#2@{'b' * 40}:ask-41")
        self.comments(comment(45, '/context-deltas', at='2026-11-05T01:02:00Z'))
        self.at('2026-11-05T01:03:00Z')
        _, [new] = self.ask()
        self.assertEqual(new['key'], f"context-view/1001#2@{'b' * 40}:ask-45")
        self.start_run(new['key'])
        self.settle_all()
        self.assertEqual(self.ask(), (1, []))

    def test_a_views_line_jobs_took_holds_the_asks_by_its_run_until_that_settles(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c')]
        self.assertEqual(self.pass_of([]), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd')]
        self.review('o/r', 4, head='d')
        _, [printed] = self.pass_of([])
        self.start_run(printed['key'])
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c')]
        self.assertEqual(self.pass_of([]), (1, []))
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertIn(f"({'running'}, {printed['key']})", self.said)
        self.settle_all()
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")

    def test_an_ask_on_a_number_github_gives_no_pull_request_for_is_dropped_and_one_it_fails_to_read_waits(self):
        self.comments(comment(41, '/context-deltas', number=99), comment(42, '/context-deltas', number=3, at='2026-11-05T01:00:30Z'))
        self.at('2026-11-05T01:01:00Z')
        _, [line] = self.ask(take=False)
        self.assertEqual(line['key'], f"context-view/1001#3@{'c' * 40}:ask-42")
        self.assertIn('o/r#99', self.said)
        self.gh.repos['o/r']['pullsFail'] = {3: 502}
        self.comments(comment(43, '/context-deltas', at='2026-11-05T01:02:00Z'))
        self.at('2026-11-05T01:03:00Z')
        _, [other] = self.ask()
        self.assertEqual(other['key'], f"context-view/1001#2@{'b' * 40}:ask-43")
        self.assertIn('GitHub answered 502 to GET /repos/o/r/pulls/3', self.said)
        self.assertIn('so its ask in comment 42 waits', self.said)
        self.gh.repos['o/r'].pop('pullsFail')
        self.gh.fail = ('/pulls/3', TimeoutError('timed out'))
        self.comments(comment(44, '/context-deltas', at='2026-11-05T01:04:00Z'))
        self.at('2026-11-05T01:05:00Z')
        self.start_run(other['key'])
        self.settle_all()
        _, [timed] = self.ask(take=False)
        self.assertEqual(timed['key'], f"context-view/1001#2@{'b' * 40}:ask-44")
        self.assertIn('poll.py: GET /repos/o/r/pulls/3 failed (timed out), so its ask in comment 42 waits', self.said)
        self.gh.fail = None
        _, [again] = self.ask()
        self.assertEqual(again, timed)
        self.start_run(again['key'])
        self.settle_all()
        _, [back] = self.ask()
        self.assertEqual(back['key'], f"context-view/1001#3@{'c' * 40}:ask-42")

    def test_a_pass_that_failed_after_its_eyes_reacts_again_and_githubs_200_for_one_already_made_is_no_failure(self):
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        broken = os.path.join(self.tmp, 'broken-workflows')
        with open(broken, 'w') as f:
            f.write('#!/bin/sh\necho store down >&2\nexit 1\n')
        os.chmod(broken, 0o755)
        with mock.patch.object(poll, 'WORKFLOWS', broken):
            self.assertEqual(self.ask(), (2, []))
        self.assertEqual(self.gh.repos['o/r']['reactions'], [(41, 'eyes')])
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")
        self.assertNotIn('no 👀', self.said)

    def test_the_first_asks_pass_on_a_state_file_the_views_step_wrote_keeps_it_and_waits_for_its_line(self):
        fresh = tempfile.mkdtemp(dir=self.tmp)
        self.patch(poll, 'STATE', fresh)
        os.makedirs(fresh, exist_ok=True)
        line = {'seq': 3, 'key': f"context-view/1001#9@{'z' * 40}", 'args': {'repo': 'o/r', 'number': 9, 'head': 'z' * 40, 'auto': True}}
        base = {'seq': 3, 'line': None, 'views_line': line, 'queue': {}, 'reviews': [], 'seen': ['x'], 'repos': {}, 'tokens': {}}
        with open(os.path.join(fresh, 'poll.json'), 'w') as f:
            json.dump(base, f)
        self.assertEqual(self.ask(), (1, []))
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertIn(f"the views' line {line['key']}", self.said)
        with open(os.path.join(fresh, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual((state['line'], state['views_line'], state['seen'], state['reviews']), (None, line, ['x'], []))

    def test_the_asks_and_the_views_keep_their_own_lines_and_cursors_in_one_state_file(self):
        path = os.path.join(poll.STATE, 'poll.json')
        self.assertEqual(self.pass_of([]), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd')]
        self.review('o/r', 4, head='d')
        _, [views] = self.pass_of([])
        self.start_run(views['key'])
        self.settle_all()
        self.comments(comment(41, '/context-deltas', number=3))
        self.at('2026-11-05T01:01:00Z')
        _, [asked] = self.ask()
        with open(path) as f:
            state = json.load(f)
        self.assertEqual((state['views_line']['key'], state['asks']['line']['key']), (views['key'], asked['key']))
        self.start_run(asked['key'])
        self.settle_all()
        self.assertEqual(self.pass_of([]), (1, []))
        self.assertEqual(self.ask(), (1, []))
        with open(path) as f:
            state = json.load(f)
        self.assertEqual((state['views_line'], state['asks']['line'], state['asks']['queue']), (None, None, []))


def merge(n, at, commit, updated=None, base='main'):
    """A pull request GitHub lists closed, merged at AT as COMMIT * 40, last updated at UPDATED or then."""
    return {'number': n, 'merged_at': at, 'merge_commit_sha': commit * 40, 'updated_at': updated or at, 'base': {'ref': base},
            'head': {'sha': 'e' * 40}, 'draft': False, 'author_association': 'MEMBER'}


def unmerged(n, updated):
    """A pull request closed without merging, which GitHub still gives its test merge's commit."""
    return {'number': n, 'merged_at': None, 'merge_commit_sha': 'f' * 40, 'updated_at': updated, 'base': {'ref': 'main'},
            'head': {'sha': 'e' * 40}, 'draft': False, 'author_association': 'MEMBER'}


def merge_key(rid, n, commit):
    return f"context-view/{rid}#{n}@merged:{commit * 40}"


class Merges(Polling):
    """The merges step: a line for each pull request merged in a covered repository since its start, oldest first, one view's
    runners at a time across the three steps, and after the asks and the pull requests' views."""

    def setUp(self):
        super().setUp()
        self.gh.repos['o/r'].update(permissions={'nissa-seru': 'admin'}, pulls=[pull(2, 'b'), pull(3, 'c')], closed=[])
        self.gh.repos['a/t'] = {'id': 1002, 'pulls': [], 'closed': []}
        self.gh.repos['x/y'] = {'id': 1009, 'pulls': [], 'closed': [merge(1, '2026-11-09T11:00:00Z', 'd')]}
        self.patch(view, 'VIEWED', {1001: 'o/r', 1002: 'a/t'})
        self.at('2026-11-09T10:00:00Z')
        for argv in ([], ['asks'], ['merges']):
            self.assertEqual(self.step(argv), (1, []), argv)
        self.at('2026-11-09T12:00:00Z')

    def step(self, argv, take=True, job=True):
        name = argv[0] if argv else 'poll'
        cursor, out = f'{self.cursor}-{name}', f'{self.out}-{name}'
        if os.path.exists(out):
            os.remove(out)
        with mock.patch.dict(os.environ, {'ASTRA_JOB_CURSOR': cursor, 'ASTRA_JOB_CURSOR_OUT': out}), mock.patch('sys.stdout') as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            code = poll.main([*argv, *(['--job'] if job else [])])
        self.said = err.getvalue()
        lines = [json.loads(l) for l in ''.join(c.args[0] for c in stdout.write.call_args_list).splitlines() if l.strip()]
        if code == 0 and job:
            self.assertTrue(os.path.exists(out), 'a pass that printed a line gave no cursor')
            if take:
                shutil.copy(out, cursor)
        return code, lines

    def at(self, t):
        self.clock[0] = t

    def merges(self, take=True):
        return self.step(['merges'], take)

    def views(self, take=True):
        return self.step([], take)

    def asks(self, take=True):
        return self.step(['asks'], take)

    def settle(self, key):
        self.save_runs([{**r, 'state': 'completed'} if r['key'] == key else r for r in self.load_runs()])

    def closed(self, repo, *pulls):
        self.gh.repos[repo]['closed'].extend(pulls)

    def done(self, key):
        """A run Jobs started under KEY that has settled."""
        self.start_run(key)
        self.settle(key)

    def written(self, key, where, after=60):
        """The run side's manifest.json in WHERE, under the views' directory, written AFTER seconds past KEY's run's start."""
        path = os.path.join(poll.STATE, 'views', where, 'manifest.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump({'outcome': 'ran'}, f)
        at = poll.instant([r for r in self.load_runs() if r['key'] == key][-1]['createdAt']) + after
        os.utime(path, (at, at))

    def test_each_merge_from_the_start_prints_oldest_first_across_repositories_under_its_merge_key(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'), merge(4, '2026-11-09T10:50:00Z', 'b'))
        self.closed('a/t', merge(7, '2026-11-09T10:58:00Z', 'c'))
        self.assertEqual(self.merges(), (0, [{'key': merge_key(1002, 7, 'c'), 'args': {'repo': 'a/t', 'number': 7, 'merged': 'c' * 40}}]))
        self.done(merge_key(1002, 7, 'c'))
        self.assertEqual(self.merges(), (0, [{'key': merge_key(1001, 5, 'a'), 'args': {'repo': 'o/r', 'number': 5, 'merged': 'a' * 40}}]))
        self.done(merge_key(1001, 5, 'a'))
        self.assertEqual(self.merges(), (1, []))
        self.assertFalse([c for c in self.gh.calls if c[1].startswith('/repos/x/y/')], 'a repository the view doesn\'t cover was read')

    def test_the_first_pass_takes_merges_from_membrane_248s_at_2026_11_09T10_57_53Z_on(self):
        self.closed('o/r', merge(3, '2026-11-09T10:57:52Z', 'a'), merge(4, '2026-11-09T10:57:53Z', 'b'))
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 4, 'b')])
        self.done(merge_key(1001, 4, 'b'))
        self.assertEqual(self.merges(), (1, []))

    def test_a_pull_request_closed_without_merging_is_no_merge(self):
        self.closed('o/r', unmerged(9, '2026-11-09T11:30:00Z'), merge(8, '2026-11-09T11:00:00Z', 'a'))
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 8, 'a')])
        self.done(merge_key(1001, 8, 'a'))
        self.assertEqual(self.merges(), (1, []))

    def test_a_line_jobs_didnt_take_prints_again_and_a_taken_merge_isnt_checked_again_once_the_store_clears_its_run(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'), merge(6, '2026-11-09T11:10:00Z', 'b'))
        _, first = self.merges(take=False)
        self.assertEqual(self.merges(take=False)[1], first)
        self.assertEqual(self.merges()[1], first)
        self.done(first[0]['key'])
        _, second = self.merges()
        self.assertEqual([l['key'] for l in second], [merge_key(1001, 6, 'b')])
        self.done(second[0]['key'])
        self.save_runs([])
        self.assertEqual(self.merges(), (1, []))

    def test_a_merge_whose_key_the_store_holds_with_or_without_an_again_isnt_printed(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'), merge(6, '2026-11-09T11:10:00Z', 'b'),
                    merge(7, '2026-11-09T11:20:00Z', 'c'))
        self.done(merge_key(1001, 5, 'a'))
        self.done(f"{merge_key(1001, 6, 'b')}:again-1")
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 7, 'c')])

    def test_a_merge_another_start_ran_moves_its_repositorys_place_once_no_earlier_merge_there_waits_so_it_isnt_checked_again(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, [line] = self.merges(take=False)
        self.done(line['key'])
        self.assertEqual(self.merges(take=False), (1, []))
        self.save_runs([])
        self.assertEqual(self.merges(take=False), (1, []))
        self.closed('o/r', merge(6, '2026-11-09T11:10:00Z', 'b'), merge(7, '2026-11-09T11:20:00Z', 'c'))
        self.done(f"{merge_key(1001, 7, 'c')}:again-1")
        busy = view.key_of(1001, 3, 'c' * 40)
        self.start_run(busy)
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.views(), (1, []))
        self.written(busy, f"o.r.3.{'c' * 12}")
        self.assertEqual(self.merges(), (1, []))
        _, [viewed] = self.views()
        self.done(viewed['key'])
        self.assertEqual(self.views(), (1, []))
        _, [six] = self.merges()
        self.assertEqual(six['key'], merge_key(1001, 6, 'b'))
        self.done(six['key'])
        self.assertEqual(self.merges(), (1, []))
        self.save_runs([])
        self.assertEqual(self.merges(), (1, []))

    def test_two_merges_in_one_second_print_in_number_order_and_neither_twice(self):
        self.closed('o/r', merge(12, '2026-11-09T11:00:00Z', 'a'), merge(11, '2026-11-09T11:00:00Z', 'b'))
        for n, c in ((11, 'b'), (12, 'a')):
            self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, n, c)])
            self.done(merge_key(1001, n, c))
        self.save_runs([])
        self.assertEqual(self.merges(), (1, []))

    def test_a_merge_waits_while_a_views_run_holds_the_runners(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        held = view.key_of(1001, 3, 'c' * 40)
        self.start_run(held)
        self.assertEqual(self.merges(), (1, []))
        self.assertIn('waiting for the runners', self.said)
        self.written(held, f"o.r.3.{'c' * 12}")
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 5, 'a')])

    def test_a_merge_check_holds_the_runners_until_its_manifest_is_written_in_the_merges_own_directory(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        for key in (merge_key(1001, 5, 'a'), f"{merge_key(1001, 5, 'a')}:again-1"):
            with self.subTest(key=key):
                self.save_runs([])
                shutil.rmtree(os.path.join(poll.STATE, 'views'), True)
                self.start_run(key)
                self.opened('o/r', 2, 'b')
                self.assertEqual(self.views(take=False), (1, []))
                self.assertIn(f'held by wf-1 (running, {key})', self.said)
                self.written(key, f"o.r.5.{'a' * 12}")
                self.assertEqual(self.views(take=False), (1, []))
                self.written(key, f"merged.o.r.5.{'a' * 12}")
                self.assertEqual([l['key'] for l in self.views(take=False)[1]], [view.key_of(1001, 2, 'b' * 40)])

    def opened(self, repo, n, head):
        self.gh.repos[repo]['pulls'] = [p for p in self.gh.repos[repo]['pulls'] if p['number'] != n] + [pull(n, head)]
        return self.review(repo, n, head=head)

    def test_a_merge_waits_while_the_views_or_the_asks_line_is_out_and_unstarted(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        self.opened('o/r', 2, 'b')
        _, [line] = self.views()
        self.assertEqual(self.merges(), (1, []))
        self.assertIn(f"the views' line {line['key']}", self.said)
        self.done(line['key'])
        self.assertEqual(self.views(), (1, []))
        self.gh.repos['o/r'].setdefault('comments', []).append(comment(41, '/context-deltas', at='2026-11-09T11:59:00Z', number=3))
        _, [asked] = self.asks()
        self.assertEqual(self.merges(), (1, []))
        self.assertIn(f"the asks' line {asked['key']}", self.said)
        self.done(asked['key'])
        self.assertEqual(self.asks(), (1, []))
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 5, 'a')])

    def test_the_views_and_the_asks_steps_wait_while_the_merges_line_is_out_and_unstarted(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, [line] = self.merges()
        self.opened('o/r', 2, 'b')
        self.gh.repos['o/r'].setdefault('comments', []).append(comment(41, '/context-deltas', at='2026-11-09T11:59:00Z', number=3))
        for step in (self.views, self.asks):
            self.assertEqual(step(), (1, []))
            self.assertIn(f"the merges' line {line['key']}", self.said)
        self.start_run(line['key'])
        self.written(line['key'], f"merged.o.r.5.{'a' * 12}")
        self.assertEqual([l['key'] for l in self.asks()[1]], [f"{view.key_of(1001, 3, 'c' * 40)}:ask-41"])

    def test_merges_wait_for_an_ask_queued_on_an_open_head_with_no_unsettled_view_and_for_no_other(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        busy = view.key_of(1001, 3, 'c' * 40)
        self.start_run(busy)
        self.gh.repos['o/r'].setdefault('comments', []).append(comment(41, '/context-deltas', at='2026-11-09T11:59:00Z', number=2))
        self.assertEqual(self.asks(), (1, []))
        self.written(busy, f"o.r.3.{'c' * 12}")
        self.assertEqual(self.merges(), (1, []))
        self.assertIn("the asks' queue", self.said)
        self.gh.repos['o/r']['pulls'] = [pull(3, 'c')]
        self.gh.repos['o/r'].setdefault('comments', []).append(comment(42, '/context-deltas', at='2026-11-09T11:59:30Z', number=3))
        self.at('2026-11-09T12:01:00Z')
        self.assertEqual(self.asks(take=False), (1, []))
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 5, 'a')])

    def test_merges_wait_while_the_views_steps_last_job_pass_left_a_pull_request_waiting(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        busy = view.key_of(1001, 9, 'f' * 40)
        self.start_run(busy)
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.views(), (1, []))
        self.written(busy, f"o.r.9.{'f' * 12}")
        self.assertEqual(self.merges(), (1, []))
        self.assertIn('the views step left 1 pull request waiting', self.said)
        _, [line] = self.views()
        self.done(line['key'])
        self.assertEqual(self.views(), (1, []))
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 5, 'a')])

    def test_a_merges_line_out_prints_again_whatever_waits_since_the_other_steps_wait_for_its_run(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, first = self.merges(take=False)
        self.assertEqual([l['key'] for l in first], [merge_key(1001, 5, 'a')])
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.views(), (1, []))
        self.assertEqual(self.merges(take=False)[1], first)

    def test_a_merges_line_out_waits_while_a_run_that_took_the_runners_after_it_printed_holds_them(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, first = self.merges(take=False)
        self.assertEqual([l['key'] for l in first], [merge_key(1001, 5, 'a')])
        held = view.key_of(1001, 3, 'c' * 40)
        self.start_run(held)
        self.assertEqual(self.merges(take=False), (1, []))
        self.assertIn('waiting for the runners', self.said)
        self.written(held, f"o.r.3.{'c' * 12}")
        self.assertEqual(self.merges(take=False)[1], first)

    def test_the_views_step_prints_once_the_merges_line_it_waited_on_has_started(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, [line] = self.merges()
        self.opened('o/r', 2, 'b')
        self.assertEqual(self.views(take=False), (1, []))
        self.assertIn(f"the merges' line {line['key']}", self.said)
        self.start_run(line['key'])
        self.written(line['key'], f"merged.o.r.5.{'a' * 12}")
        self.assertEqual([l['key'] for l in self.views()[1]], [view.key_of(1001, 2, 'b' * 40)])

    def test_a_merges_line_out_whose_repository_a_pass_doesnt_list_is_dropped_and_prints_again_once_its_listed(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, first = self.merges(take=False)
        self.assertEqual([l['key'] for l in first], [merge_key(1001, 5, 'a')])
        self.gh.repos['o/r']['archived'] = True
        self.assertEqual(self.merges(take=False), (1, []))
        self.assertIn(f"{first[0]['key']}'s line is dropped", self.said)
        del self.gh.repos['o/r']['archived']
        self.assertEqual(self.merges(take=False)[1], first)

    def test_a_merges_line_out_prints_again_under_its_repositorys_name_now(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        self.assertEqual([l['args']['repo'] for l in self.merges(take=False)[1]], ['o/r'])
        self.gh.repos['o/renamed'] = self.gh.repos.pop('o/r')
        self.assertEqual(self.merges(take=False)[1], [{'key': merge_key(1001, 5, 'a'), 'args': {'repo': 'o/renamed', 'number': 5, 'merged': 'a' * 40}}])

    def test_merges_wait_for_the_views_steps_first_job_pass_where_none_has_counted_the_pull_requests_waiting(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        path = os.path.join(poll.STATE, 'poll.json')
        with open(path) as f:
            state = json.load(f)
        del state['views_waiting']
        with open(path, 'w') as f:
            json.dump(state, f)
        self.assertEqual(self.merges(), (1, []))
        self.assertIn("the views step's first job pass", self.said)
        self.assertEqual(self.views(), (1, []))
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 5, 'a')])

    def test_the_listing_pages_until_a_page_ends_before_the_repositorys_place(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'), *(unmerged(100 + i, '2026-11-09T11:30:00Z') for i in range(150)))
        self.closed('a/t', *(unmerged(100 + i, '2026-11-08T00:00:00Z') for i in range(150)))
        self.gh.calls.clear()
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 5, 'a')])
        listed = lambda repo: [p for m, p in self.gh.calls if p.startswith(f'/repos/{repo}/pulls?state=closed')]
        self.assertEqual((len(listed('o/r')), len(listed('a/t'))), (2, 1))

    def test_a_pass_no_job_made_prints_what_it_would_and_changes_nothing(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        path = os.path.join(poll.STATE, 'poll.json')
        with open(path) as f:
            before = f.read()
        self.assertEqual([l['key'] for l in self.step(['merges'], job=False)[1]], [merge_key(1001, 5, 'a')])
        self.assertFalse(os.path.exists(f'{self.out}-merges'))
        with open(path) as f:
            self.assertEqual(f.read(), before)

    def test_the_merges_line_is_kept_apart_from_the_views_and_asks_lines_so_the_release_before_reads_none(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, [line] = self.merges(take=False)
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual((state['line'], state['views_line'], state['asks']['line']), (None, None, None))
        self.assertNotIn(line['key'], json.dumps({k: v for k, v in state.items() if k != 'merges'}))

    def test_a_repository_out_of_a_passes_listing_keeps_its_place(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'), merge(6, '2026-11-09T11:10:00Z', 'b'))
        self.closed('a/t', merge(7, '2026-11-09T11:20:00Z', 'c'))
        self.done(self.merges()[1][0]['key'])
        self.gh.repos['o/r']['archived'] = True
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1002, 7, 'c')])
        self.done(merge_key(1002, 7, 'c'))
        del self.gh.repos['o/r']['archived']
        self.save_runs([])
        self.assertEqual([l['key'] for l in self.merges()[1]], [merge_key(1001, 6, 'b')])

    def test_a_renamed_repositorys_merge_is_named_as_it_is_now(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        self.gh.repos['o/renamed'] = self.gh.repos.pop('o/r')
        self.assertEqual(self.merges()[1], [{'key': merge_key(1001, 5, 'a'), 'args': {'repo': 'o/renamed', 'number': 5, 'merged': 'a' * 40}}])

    def test_a_failure_exits_2_says_why_and_keeps_the_state_and_cursor_as_they_were(self):
        self.closed('o/r', merge(5, '2026-11-09T11:00:00Z', 'a'))
        _, [line] = self.merges(take=False)
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            before = f.read()
        self.gh.fail = ('/repos/o/r/pulls?state=closed', pr_run.Failed('GitHub answered 502 to GET /repos/o/r/pulls'))
        self.assertEqual(self.merges(), (2, []))
        self.assertIn('poll.py: GitHub answered 502 to GET /repos/o/r/pulls', self.said)
        self.assertFalse(os.path.exists(f'{self.out}-merges'))
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            self.assertEqual(f.read(), before)
        self.gh.fail = None
        self.assertEqual(self.merges(take=False)[1], [{'key': line['key'], 'args': line['args']}])


if __name__ == '__main__':
    unittest.main()

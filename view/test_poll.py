"""The context view's poll (poll.py): a line only while no view's run is unsettled when it lists them, the line not yet
taken or else one for the head that has waited longest, of the heads not in its `seen` list; and its asks step, a line for
each /context-deltas comment from the one account that may ask, one view at a time."""
import contextlib, io, json, os, re, shutil, subprocess, tempfile, unittest, urllib.parse
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
    one, the repositories it's installed on, and a repository's open pull requests, paged by 100 with an ETag."""

    def __init__(self):
        self.repos = {'o/r': {'id': 1001, 'pulls': []}}
        self.calls = []
        self.installs = {5: {'id': ACCOUNT, 'login': 'org'}}
        self.tokens = {}
        self.minted = 0
        self.fail = None

    def tag(self, value):
        return 'W/"' + str(abs(hash(json.dumps(value, sort_keys=True)))) + '"'

    def request(self, method, path, token=None, bearer=None, tag=None, body=None):
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
                return self.listing(path, repo['pulls'], tag)
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


def pull(n, head='a', draft=False):
    return {'number': n, 'draft': draft, 'head': {'sha': head * 40}}


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

    def start_run(self, key):
        runs = self.load_runs()
        if key not in [r['key'] for r in runs]:
            created = self.clock[0].replace('Z', '.000Z')
            runs.append({'run': f'wf-{len(runs) + 1}', 'key': key, 'state': 'running', 'createdAt': created})
            self.save_runs(runs)


class Views(Polling):
    def setUp(self):
        super().setUp()
        self.gh.repos['a/t'] = {'id': 1002, 'pulls': []}
        self.gh.repos['x/y'] = {'id': 1009, 'pulls': [pull(1, 'q')]}
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

    def test_one_view_runs_at_a_time_for_the_head_that_waited_longest(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.at('2026-11-05T01:00:00Z')
        first = self.started()
        self.assertEqual(first, f"context-view/1001#2@{'b' * 40}")
        self.at('2026-11-05T01:01:00Z')
        self.gh.repos['a/t']['pulls'] = [pull(7, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.at('2026-11-05T01:02:00Z')
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(4, 'e'), pull(3, 'd')]
        self.assertEqual(self.look(), (1, []))
        self.settle(first)
        self.assertEqual(self.started(), f"context-view/1002#7@{'c' * 40}")
        self.settle(f"context-view/1002#7@{'c' * 40}", 'failed')
        self.assertEqual(self.started(), f"context-view/1001#3@{'d' * 40}")
        self.settle(f"context-view/1001#3@{'d' * 40}")
        self.assertEqual(self.started(), f"context-view/1001#4@{'e' * 40}")

    def test_a_line_carries_the_view_runs_args(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        _, [line] = self.look()
        self.assertEqual(line, {'key': f"context-view/1001#2@{'b' * 40}", 'args': {'repo': 'o/r', 'number': 2, 'head': 'b' * 40}})
        self.assertEqual(line['key'], view.key_of(1001, 2, 'b' * 40))

    def test_a_draft_waits_until_it_is_marked_ready(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b', draft=True)]
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.started(), f"context-view/1001#2@{'b' * 40}")

    def test_a_head_superseded_before_its_turn_never_runs(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c')]
        first = self.started()
        self.assertEqual(first, f"context-view/1001#2@{'b' * 40}")
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'f')]
        self.look()
        self.settle(first)
        self.assertEqual(self.started(), f"context-view/1001#3@{'f' * 40}")
        self.settle(f"context-view/1001#3@{'f' * 40}")
        self.assertEqual(self.look(), (1, []))

    def test_a_head_whose_view_already_ran_makes_no_line(self):
        self.start_run(f"context-view/1001#2@{'b' * 40}")
        self.settle(f"context-view/1001#2@{'b' * 40}")
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.look(), (1, []))

    def test_a_line_jobs_didnt_take_prints_again_until_its_head_is_superseded(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        _, first = self.look(take=False)
        self.assertEqual([line['key'] for line in first], [f"context-view/1001#2@{'b' * 40}"])
        self.assertEqual(self.look(take=False)[1], first)
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual([line['key'] for line in self.look(take=False)[1]], [f"context-view/1001#2@{'c' * 40}"])

    def test_a_view_still_running_for_a_head_since_superseded_holds_the_slot(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        first = self.started()
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c'), pull(3, 'd')]
        self.assertEqual(self.look(), (1, []))
        self.settle(first)
        self.assertEqual(self.started(), f"context-view/1001#2@{'c' * 40}")

    def test_a_lost_state_file_takes_the_heads_open_then_as_seen_and_still_waits_for_a_running_view(self):
        self.gh.repos['o/r']['pulls'] = [pull(9, 'b')]
        running = self.started()
        self.assertEqual(running, f"context-view/1001#9@{'b' * 40}")
        os.remove(os.path.join(poll.STATE, 'poll.json'))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c'), pull(9, 'f')]
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'd'), pull(9, 'f')]
        self.assertEqual(self.look(), (1, []))
        self.settle(running)
        self.assertEqual(self.started(), f"context-view/1001#2@{'d' * 40}")

    def test_a_repositorys_open_heads_when_the_poll_first_sees_it_are_taken_as_seen_and_its_next_push_is_viewed(self):
        self.gh.repos['n/v'] = {'id': 1003, 'pulls': [pull(4, 'b'), pull(5, 'c')]}
        self.patch(view, 'VIEWED', {1001: 'o/r', 1002: 'a/t', 1003: 'n/v'})
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = [pull(4, 'b'), pull(5, 'e')]
        self.assertEqual(self.started(), f"context-view/1003#5@{'e' * 40}")
        self.settle(f"context-view/1003#5@{'e' * 40}")
        self.assertEqual(self.look(), (1, []))

    def test_any_unsettled_view_holds_the_slot_whatever_head_its_for_and_whoever_started_it(self):
        self.start_run(f"context-view/1002#8@{'a' * 40}")
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.look(), (1, []))
        self.settle(f"context-view/1002#8@{'a' * 40}", 'stopped')
        self.assertEqual(self.started(), f"context-view/1001#2@{'b' * 40}")

    def test_a_line_printed_before_a_view_started_by_hand_waits_until_that_view_settles(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        _, first = self.look(take=False)
        self.assertEqual([line['key'] for line in first], [f"context-view/1001#2@{'b' * 40}"])
        self.start_run(f"context-view/1002#8@{'a' * 40}")
        self.assertEqual(self.look(take=False), (1, []))
        self.settle(f"context-view/1002#8@{'a' * 40}")
        self.assertEqual(self.look(take=False)[1], first)

    def test_a_line_whose_head_got_its_view_by_another_start_is_dropped(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        _, [line] = self.look(take=False)
        self.start_run(line['key'])
        self.settle(line['key'])
        self.assertEqual(self.look(take=False), (1, []))

    def test_a_pass_lists_the_views_runs_once_however_many_heads_wait(self):
        self.gh.repos['o/r']['pulls'] = [pull(n, 'b') for n in range(1, 31)]
        first = self.started()
        listings, run = [], subprocess.run

        def counted(args, **kw):
            if args[0] == poll.WORKFLOWS:
                listings.append(args)
            return run(args, **kw)
        self.patch(poll.subprocess, 'run', counted)
        self.assertEqual(self.look(), (1, []))
        self.assertEqual(listings, [[poll.WORKFLOWS, 'runs', '--key-prefix', 'context-view/']])
        self.settle(first)
        listings.clear()
        self.assertIsNotNone(self.started())
        self.assertEqual(len(listings), 1)

    def test_a_head_seen_at_first_sight_stays_seen_through_a_draft_pass_and_a_push_away_and_back(self):
        self.gh.repos['n/v'] = {'id': 1003, 'pulls': [pull(4, 'b'), pull(5, 'd', draft=True)]}
        self.patch(view, 'VIEWED', {1001: 'o/r', 1002: 'a/t', 1003: 'n/v'})
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = [pull(4, 'b', draft=True), pull(5, 'd')]
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = [pull(4, 'b'), pull(5, 'd')]
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = [pull(4, 'c'), pull(5, 'd')]
        self.settle(self.started())
        self.gh.repos['n/v']['pulls'] = [pull(4, 'b'), pull(5, 'd')]
        self.assertEqual(self.look(), (1, []))

    def test_a_viewed_head_stays_viewed_after_the_store_clears_its_run_and_is_forgotten_once_its_pull_request_closes(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c')]
        self.settle(self.started())
        self.settle(self.started())
        self.assertEqual(self.look(), (1, []))
        self.save_runs([])
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(3, 'c')]
        self.look()
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual(state['seen'], [f"context-view/1001#3@{'c' * 40}"])

    def test_a_repository_out_of_view_for_a_pass_keeps_its_seen_heads(self):
        self.gh.repos['n/v'] = {'id': 1003, 'pulls': [pull(4, 'b')]}
        self.patch(view, 'VIEWED', {1001: 'o/r', 1002: 'a/t', 1003: 'n/v'})
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['archived'] = True
        self.assertEqual(self.look(), (1, []))
        del self.gh.repos['n/v']['archived']
        self.assertEqual(self.look(), (1, []))

    def test_a_repository_out_of_view_for_a_pass_keeps_its_heads_wait_and_a_line_dropped_for_it_is_named(self):
        busy = f"context-view/1001#9@{'f' * 40}"
        self.start_run(busy)
        self.at('2026-11-05T01:00:00Z')
        self.gh.repos['a/t']['pulls'] = [pull(7, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.at('2026-11-05T01:01:00Z')
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.look(), (1, []))
        self.at('2026-11-05T01:02:00Z')
        self.gh.repos['a/t']['archived'] = True
        self.assertEqual(self.look(), (1, []))
        self.at('2026-11-05T01:03:00Z')
        del self.gh.repos['a/t']['archived']
        self.assertEqual(self.look(), (1, []))
        self.settle(busy)
        _, [line] = self.look(take=False)
        self.assertEqual(line['key'], f"context-view/1002#7@{'c' * 40}")
        self.gh.repos['a/t']['archived'] = True
        self.assertEqual([l['key'] for l in self.look(take=False)[1]], [f"context-view/1001#2@{'b' * 40}"])
        self.assertIn(f"context-view/1002#7@{'c' * 40}'s line is dropped, since its repository isn't in this pass's listing", self.said)

    def test_a_head_whose_view_ran_after_it_was_superseded_stays_seen_when_the_pull_request_returns_to_it(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        first = self.started()
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.settle(first)
        self.settle(self.started())
        self.save_runs([])
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.look(), (1, []))

    def test_a_line_not_taken_carries_the_repositorys_name_as_it_is_now(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        _, [first] = self.look(take=False)
        self.assertEqual(first['args']['repo'], 'o/r')
        self.gh.repos['o/renamed'] = self.gh.repos.pop('o/r')
        _, [line] = self.look(take=False)
        self.assertEqual(line['args']['repo'], 'o/renamed')
        self.assertEqual(line['key'], first['key'])

    def test_a_pass_that_waits_on_a_view_names_it(self):
        self.start_run(f"context-view/1002#8@{'a' * 40}")
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.assertEqual(self.look(), (1, []))
        self.assertIn(f"wf-1 (running, context-view/1002#8@{'a' * 40})", self.said)

    def test_a_repository_out_of_view_for_a_pass_and_back_has_its_new_heads_viewed(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.settle(self.started())
        self.gh.repos['o/r']['archived'] = True
        self.assertEqual(self.look(), (1, []))
        del self.gh.repos['o/r']['archived']
        self.gh.repos['o/r']['pulls'] = [pull(2, 'c')]
        self.assertEqual(self.started(), f"context-view/1001#2@{'c' * 40}")

    def test_a_renamed_repositorys_viewed_heads_stay_viewed_and_its_lines_name_it_as_it_is_now(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.settle(self.started())
        self.gh.repos['o/renamed'] = self.gh.repos.pop('o/r')
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['o/renamed']['pulls'] = [pull(2, 'c')]
        _, [line] = self.look()
        self.assertEqual(line, {'key': f"context-view/1001#2@{'c' * 40}", 'args': {'repo': 'o/renamed', 'number': 2, 'head': 'c' * 40}})

    def test_a_taken_line_whose_run_never_appeared_prints_again_as_a_new_line_past_the_cursor(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        _, [line] = self.look()
        with open(f'{self.cursor}-poll') as f:
            taken = int(f.read())
        self.assertEqual(self.look()[1], [line])
        with open(f'{self.cursor}-poll') as f:
            self.assertGreater(int(f.read()), taken)

    def test_a_repository_not_in_the_views_list_is_never_read(self):
        self.gh.repos['o/r']['pulls'] = []
        self.assertEqual(self.look(), (1, []))
        self.assertFalse(any(path.startswith('/repos/x/y/') for _, path in self.gh.calls))


    def test_the_poll_keeps_its_state_in_its_own_file_and_writes_none_of_review_workflows(self):
        theirs = os.path.join(self.tmp, 'review-workflow-poll')
        self.patch(pr_poll, 'POLL', theirs)
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        self.started()
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual(state['line']['key'], f"context-view/1001#2@{'b' * 40}")
        self.assertFalse(os.path.exists(theirs))

    def test_an_installation_on_an_account_the_app_doesnt_serve_is_never_read(self):
        self.gh.calls.clear()
        self.gh.installs[6] = {'id': 9999, 'login': 'elsewhere'}
        self.gh.repos['a/t'].update(installation=6, pulls=[pull(7, 'c')])
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['a/t']['pulls'] = [pull(7, 'd')]
        self.assertEqual(self.look(), (1, []))
        self.assertNotIn(('POST', '/app/installations/6/access_tokens'), self.gh.calls)
        self.assertFalse(any(path.startswith('/repos/a/t/') for _, path in self.gh.calls))

    def test_a_failure_exits_2_says_why_and_keeps_the_state_and_cursor_as_they_were(self):
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b')]
        _, [taken] = self.look()
        with open(os.path.join(poll.STATE, 'poll.json')) as f:
            before = f.read()
        self.assertEqual(json.loads(before)['line']['key'], taken['key'])
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
        self.assertEqual(self.started(), f"context-view/1001#2@{'b' * 40}")

    def test_a_pull_request_a_pass_finds_closed_gets_a_view_when_it_reopens_unless_the_store_still_holds_its_heads_run(self):
        self.gh.repos['n/v'] = {'id': 1003, 'pulls': [pull(4, 'b')]}
        self.patch(view, 'VIEWED', {1001: 'o/r', 1002: 'a/t', 1003: 'n/v'})
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = []
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = [pull(4, 'b')]
        viewed = self.started()
        self.assertEqual(viewed, f"context-view/1003#4@{'b' * 40}")
        self.settle(viewed)
        self.gh.repos['n/v']['pulls'] = []
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = [pull(4, 'b')]
        self.assertEqual(self.look(), (1, []))
        self.gh.repos['n/v']['pulls'] = []
        self.assertEqual(self.look(), (1, []))
        self.save_runs([])
        self.gh.repos['n/v']['pulls'] = [pull(4, 'b')]
        self.assertEqual(self.started(), viewed)

    def test_a_view_running_again_under_a_key_whose_earlier_run_settled_still_holds_the_slot(self):
        key = f"context-view/1001#2@{'b' * 40}"
        self.save_runs([{'run': 'wf-1', 'key': key, 'state': 'completed', 'createdAt': '2026-10-31T03:00:00.000Z'},
                        {'run': 'wf-2', 'key': key, 'state': 'running', 'createdAt': '2026-10-31T03:30:00.000Z'}])
        self.gh.repos['o/r']['pulls'] = [pull(3, 'c')]
        self.assertEqual(self.look(), (1, []))
        self.assertIn(f'wf-2 (running, {key})', self.said)

    def test_a_command_line_from_the_main_working_copy_refuses_as_a_failure_naming_the_installed_form(self):
        asked = len(self.gh.calls)
        copy = os.path.dirname(os.path.dirname(os.path.realpath(poll.__file__)))
        with mock.patch.object(view, 'CHECKOUT', copy), mock.patch('sys.argv', ['poll.py']), \
                contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as refused:
            poll.main()
        self.assertEqual(refused.exception.code, 2)
        self.assertIn('`~/.local/lib/context-view/current/view/.venv/bin/python -I -m poll`', err.getvalue())
        self.assertEqual(len(self.gh.calls), asked, 'a refused pass asks GitHub nothing')


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

    def test_one_view_runs_at_a_time_and_an_ask_waits_for_an_unsettled_view_whatever_started_it(self):
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
        self.assertEqual(self.pass_of([]), (1, []))

    def test_a_pass_no_job_made_prints_what_it_would_and_leaves_the_state_and_every_comment_as_they_were(self):
        self.assertEqual(self.pass_of([]), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd')]
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

    def test_a_refused_eyes_is_said_on_stderr_and_the_ask_still_views(self):
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.gh.repos['o/r']['reactFail'] = 403
        _, [line] = self.ask()
        self.assertEqual(line['key'], f"context-view/1001#2@{'b' * 40}:ask-41")
        self.assertIn('no 👀 on o/r comment 41: GitHub answered 403', self.said)

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
        self.assertIn('GitHub answered 502', self.said)
        self.start_run(other['key'])
        self.settle_all()
        self.gh.repos['o/r'].pop('pullsFail')
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
        line = {'seq': 3, 'key': f"context-view/1001#9@{'z' * 40}", 'args': {'repo': 'o/r', 'number': 9, 'head': 'z' * 40}}
        base = {'seq': 3, 'line': line, 'waiting': {}, 'seen': ['x'], 'repos': {}, 'known': ['1001'], 'tokens': {}}
        with open(os.path.join(fresh, 'poll.json'), 'w') as f:
            json.dump(base, f)
        self.assertEqual(self.ask(), (1, []))
        self.comments(comment(41, '/context-deltas'))
        self.at('2026-11-05T01:01:00Z')
        self.assertEqual(self.ask(), (1, []))
        self.assertIn(f"the views' line {line['key']}", self.said)
        with open(os.path.join(fresh, 'poll.json')) as f:
            state = json.load(f)
        self.assertEqual((state['line'], state['seen'], state['known']), (line, ['x'], ['1001']))

    def test_the_asks_and_the_views_keep_their_own_lines_and_cursors_in_one_state_file(self):
        path = os.path.join(poll.STATE, 'poll.json')
        self.assertEqual(self.pass_of([]), (1, []))
        self.gh.repos['o/r']['pulls'] = [pull(2, 'b'), pull(3, 'c'), pull(4, 'd')]
        _, [views] = self.pass_of([])
        self.start_run(views['key'])
        self.settle_all()
        self.comments(comment(41, '/context-deltas', number=3))
        self.at('2026-11-05T01:01:00Z')
        _, [asked] = self.ask()
        with open(path) as f:
            state = json.load(f)
        self.assertEqual((state['line']['key'], state['asks']['line']['key']), (views['key'], asked['key']))
        self.start_run(asked['key'])
        self.settle_all()
        self.assertEqual(self.pass_of([]), (1, []))
        self.assertEqual(self.ask(), (1, []))
        with open(path) as f:
            state = json.load(f)
        self.assertEqual((state['line'], state['asks']['line'], state['asks']['queue']), (None, None, []))


if __name__ == '__main__':
    unittest.main()

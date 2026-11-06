"""view/build.sh, run on a stage of its own: it builds the environment the steps run from, and refuses a release whose lock
would have a package from the index built rather than installed from a wheel."""
import os, re, shutil, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class Build(unittest.TestCase):
    def stage(self):
        root = tempfile.mkdtemp(prefix='context-view-stage-')
        self.addCleanup(shutil.rmtree, root, True)
        shutil.copytree(HERE, os.path.join(root, 'view'), ignore=shutil.ignore_patterns('.venv', '__pycache__', '*.egg-info'))
        return root

    def build(self, root):
        env = {k: v for k, v in os.environ.items() if k != 'VIRTUAL_ENV'}
        return subprocess.run(['bash', os.path.join(root, 'view', 'build.sh'), root], capture_output=True, text=True,
                              timeout=600, env=env)

    def test_a_stage_builds_and_its_interpreter_reads_the_steps_back_from_its_own_environment(self):
        root = self.stage()
        built = self.build(root)
        self.assertEqual(built.returncode, 0, built.stderr[-2000:])
        self.assertIn(f'view/build.sh: {root}/view/.venv imports view, poll and pr_review from its own site-packages', built.stdout)

    def test_a_package_from_the_index_with_no_wheel_in_the_lock_is_refused_rather_than_built(self):
        root = self.stage()
        lock = os.path.join(root, 'view', 'uv.lock')
        with open(lock) as f:
            text = f.read()
        start = text.index('[[package]]\nname = "idna"')
        end = text.index('[[package]]', start + 1)
        section = re.sub(r'\nwheels = \[\n(?:    .*\n)*?\]\n', '\n', text[start:end])
        self.assertNotIn('wheels', section)
        with open(lock, 'w') as f:
            f.write(text[:start] + section + text[end:])
        built = self.build(root)
        self.assertNotEqual(built.returncode, 0)
        self.assertIn("idna==3.20 @ registry+https://pypi.org/simple` can't be installed because it is marked as `--no-build`",
                      built.stderr)


if __name__ == '__main__':
    unittest.main()

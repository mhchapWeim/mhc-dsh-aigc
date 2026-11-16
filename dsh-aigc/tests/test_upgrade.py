"""Exercise upgrade isolation, provenance checks and repeated real Git merges."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("upgrade", Path(__file__).parents[1] / "upgrade.py")
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)


class SafetyTests(unittest.TestCase):
    def test_json_merges_disjoint_dependencies_without_replacing_versions_or_lists(self):
        base = {"version": "0.1", "dependencies": {"a": "1"}, "obsolete": True}
        local = {"version": "0.1", "dependencies": {"a": "1", "managed": "workspace:*"}}
        target = {"version": "0.2", "dependencies": {"a": "2"}, "obsolete": True}
        self.assertEqual(upgrade.merge_json(base, local, target),
                         {"version": "0.2", "dependencies": {"a": "2", "managed": "workspace:*"}})
        for values in ((1, 2, 3), ([1], [1, 2], [1, 3]),
                       ({"a": 1}, {}, {"a": 2})):
            with self.subTest(values=values), self.assertRaises(upgrade.UpgradeError):
                upgrade.merge_json(*values)

    def test_classification_includes_deletions_modes_and_shared_changes(self):
        blob = lambda oid, mode="100644": {"kind": "blob", "mode": mode, "oid": oid}
        base = {"upstream": blob("a"), "custom": blob("a"), "both": blob("a"),
                "same": blob("a"), "deleted": blob("a"), "mode": blob("a")}
        local = {**base, "custom": blob("b"), "both": blob("b"), "same": blob("c"),
                 "mode": blob("a", "100755")}
        target = {**base, "upstream": blob("c"), "both": blob("d"), "same": blob("c")}
        del target["deleted"]
        rows = {r["path"]: r["category"] for r in upgrade.classify(base, local, target)}
        self.assertEqual(rows, {"upstream": "upstream-only", "custom": "aigc-only",
                                "both": "both-changed", "same": "already-upstream",
                                "deleted": "upstream-only", "mode": "aigc-only"})

    def test_paths_cannot_escape_workspace_or_write_git_metadata(self):
        for name in ("../secret", "/absolute", "D:/secret", "a/../../b", "a\\b", ".git/config", "a/.GIT/config", ""):
            with self.subTest(name=name), self.assertRaises(upgrade.UpgradeError):
                upgrade.safe_relative(name)
        upgrade.safe_relative("packages/测试/a.ts")
        for name in (".", "..", "../escape", "a/b", "a\\b"):
            with self.subTest(candidate=name), self.assertRaises(upgrade.UpgradeError):
                upgrade.candidate_paths(name)

    def test_failed_promotion_restores_existing_bytes_and_removes_partial_additions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "runtime"
            staging = root / "incoming"
            destination.mkdir()
            staging.mkdir()
            (destination / "a.txt").write_bytes(b"original\r\n")
            (staging / "a.txt").write_bytes(b"updated\n")
            (staging / "b.txt").write_bytes(b"new\n")
            replace = upgrade.replace_source_file

            def fail_second(incoming, target):
                if target.name == "b.txt":
                    raise OSError("simulated disk error")
                replace(incoming, target)

            with patch.object(upgrade, "replace_source_file", fail_second):
                with self.assertRaises(OSError):
                    upgrade.apply_source_changes(destination, staging, {"a.txt": {}},
                                                 {"a.txt": {}, "b.txt": {}}, ["a.txt", "b.txt"], root / "backup")
            self.assertEqual((destination / "a.txt").read_bytes(), b"original\r\n")
            self.assertFalse((destination / "b.txt").exists())

    def test_receipt_cannot_accept_stale_tree_missing_gate_or_failed_result(self):
        good = {"passed": True, "tree": "a", "target": {"commit": "b"},
                "gatesSha256": "c", "profile": "release", "results": [{"id": "model", "exitCode": 0}]}
        args = dict(tree="a", target={"commit": "b"}, digest="c", required=["model"])
        upgrade.check_receipt(good, **args)
        for update in ({"tree": "changed"}, {"gatesSha256": "changed"}, {"passed": False},
                       {"profile": "contracts"}, {"results": []},
                       {"results": [{"id": "model", "exitCode": 1}]}):
            with self.subTest(update=update), self.assertRaises(upgrade.UpgradeError):
                upgrade.check_receipt({**good, **update}, **args)

    def test_archive_cannot_traverse_or_create_git_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("../escape", ".git/config"):
                archive = root / "bad.tar"
                with tarfile.open(archive, "w") as stream:
                    record = tarfile.TarInfo(name)
                    record.size = 1
                    stream.addfile(record, io.BytesIO(b"x"))
                with self.subTest(name=name), self.assertRaises(upgrade.UpgradeError):
                    upgrade.extract_archive(archive, root / "output")
            self.assertFalse((root.parent / "escape").exists())


class GitIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "app"
        self.repo.mkdir()
        self.origin = self.root / "origin"
        self.origin.mkdir()
        self.command("init", cwd=self.origin)
        self.command("config", "user.name", "Test", cwd=self.origin)
        self.command("config", "user.email", "test@example.invalid", cwd=self.origin)
        self.command("config", "core.autocrlf", "input", cwd=self.origin)
        (self.origin / "code.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")
        self.command("add", ".", cwd=self.origin)
        self.command("commit", "-m", "base", cwd=self.origin)
        self.base = self.command("rev-parse", "HEAD", cwd=self.origin)
        self.command("tag", "dsh-v0.1.0", cwd=self.origin)
        self.command("init", cwd=self.repo)
        self.command("config", "user.name", "Test", cwd=self.repo)
        self.command("config", "user.email", "test@example.invalid", cwd=self.repo)
        self.command("config", "core.autocrlf", "input", cwd=self.repo)
        self.config = self.repo / "dsh-aigc"
        self.config.mkdir()
        upgrade.write_json(self.config / "gates.json", {"profiles": {"release": ["check"]},
                            "gates": {"check": {"argv": ["git", "diff", "--check"]}}})
        self.cache = self.repo / ".cache" / "dsh-upgrades"
        self.git_dir = self.cache / "upstream.git"
        for key, value in (("ROOT", self.repo), ("CONFIG", self.config), ("CACHE", self.cache), ("GIT", self.git_dir)):
            context = patch.object(upgrade, key, value)
            context.start()
            self.addCleanup(context.stop)
        self.source = self.repo / "deepseek-harness"
        self.source.mkdir()
        (self.source / "code.txt").write_text("one\ntwo\nthree\ncustom\n", encoding="utf-8")
        (self.repo / ".gitignore").write_text(".cache/\n", encoding="utf-8")
        self.command("add", ".", cwd=self.repo)
        self.command("commit", "-m", "downstream", cwd=self.repo)

    @staticmethod
    def command(*args, cwd):
        return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.PIPE).decode().strip()

    def lock(self, target):
        value = {"schemaVersion": 1, "repository": str(self.origin), "sourceDirectory": "deepseek-harness",
                 "baseline": {"tag": "dsh-v0.1.0", "commit": self.base},
                 "candidate": {"tag": "dsh-v0.2.0", "commit": target}}
        upgrade.write_json(self.config / "upstream.lock.json", value)

    def target(self, contents):
        (self.origin / "code.txt").write_text(contents, encoding="utf-8")
        self.command("add", ".", cwd=self.origin)
        self.command("commit", "-m", "next", cwd=self.origin)
        self.command("tag", "dsh-v0.2.0", cwd=self.origin)
        return self.command("rev-parse", "HEAD", cwd=self.origin)

    def test_prepare_merges_real_git_history_without_changing_runtime(self):
        self.lock(self.target("upstream\ntwo\nthree\n"))
        before = (self.source / "code.txt").read_bytes()
        self.assertEqual(upgrade.main(["prepare", "--name", "clean"]), 0)
        _, candidate, state = upgrade.load_candidate("clean")
        self.assertEqual((candidate / "code.txt").read_text(), "upstream\ntwo\nthree\ncustom\n")
        self.assertEqual((self.source / "code.txt").read_bytes(), before)
        self.assertEqual(state["conflicts"], [])
        # A second prepare must preserve existing work, not overwrite it.
        self.assertEqual(upgrade.main(["prepare", "--name", "clean", "--offline"]), 1)
        self.assertEqual(upgrade.main(["promote", "clean"]), 1)
        self.assertEqual((self.source / "code.txt").read_bytes(), before)

    def test_verified_promotion_preserves_customization_and_supports_next_upgrade(self):
        self.lock(self.target("upstream\ntwo\nthree\n"))
        self.assertEqual(upgrade.main(["prepare", "--name", "first"]), 0)
        _, candidate, state = upgrade.load_candidate("first")
        self.assertEqual(upgrade.main(["verify", "first", "--profile", "release"]), 0)
        self.assertEqual(upgrade.main(["promote", "first"]), 0)
        self.assertEqual((self.source / "code.txt").read_text(), "upstream\ntwo\nthree\ncustom\n")
        self.assertEqual(upgrade.load_lock()["baseline"], state["target"])
        self.command("add", ".", cwd=self.repo)
        self.command("commit", "-m", "promoted", cwd=self.repo)
        (self.origin / "second.txt").write_text("second upgrade", encoding="utf-8")
        self.command("add", ".", cwd=self.origin)
        self.command("commit", "-m", "second upstream", cwd=self.origin)
        self.command("tag", "dsh-v0.3.0", cwd=self.origin)
        target = self.command("rev-parse", "HEAD", cwd=self.origin)
        self.assertEqual(upgrade.main(["prepare", "--tag", "dsh-v0.3.0", "--commit", target, "--name", "second"]), 0)
        _, second, _ = upgrade.load_candidate("second")
        self.assertEqual((second / "code.txt").read_text(), "upstream\ntwo\nthree\ncustom\n")
        self.assertEqual((second / "second.txt").read_text(), "second upgrade")

    def test_changed_candidate_invalidates_passing_receipt(self):
        self.lock(self.target("upstream\ntwo\nthree\n"))
        self.assertEqual(upgrade.main(["prepare", "--name", "stale"]), 0)
        self.assertEqual(upgrade.main(["verify", "stale", "--profile", "release"]), 0)
        _, candidate, _ = upgrade.load_candidate("stale")
        (candidate / "code.txt").write_text("changed after verification\n", encoding="utf-8", newline="\n")
        self.command("add", ".", cwd=candidate)
        self.assertEqual(upgrade.main(["promote", "stale"]), 1)
        self.assertEqual((self.source / "code.txt").read_text(), "one\ntwo\nthree\ncustom\n")

    def test_conflict_is_reported_and_does_not_touch_runtime(self):
        (self.source / "code.txt").write_text("local\ntwo\nthree\n", encoding="utf-8")
        self.command("add", ".", cwd=self.repo)
        self.command("commit", "-m", "conflicting change", cwd=self.repo)
        self.lock(self.target("upstream\ntwo\nthree\n"))
        self.assertEqual(upgrade.main(["prepare", "--name", "conflict"]), 2)
        _, candidate, state = upgrade.load_candidate("conflict")
        self.assertEqual(state["conflicts"], ["code.txt"])
        self.assertIn("<<<<<<<", (candidate / "code.txt").read_text())
        self.assertEqual((self.source / "code.txt").read_text(), "local\ntwo\nthree\n")
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.candidate_tree(candidate)

    def test_dirty_source_and_wrong_release_pin_are_rejected(self):
        self.lock(self.target("upstream\ntwo\nthree\n"))
        (self.source / "code.txt").write_text("uncommitted", encoding="utf-8")
        self.assertEqual(upgrade.main(["prepare", "--name", "dirty"]), 1)
        self.command("restore", "deepseek-harness", cwd=self.repo)
        lock = upgrade.load_lock()
        lock["candidate"]["commit"] = self.base
        upgrade.write_json(self.config / "upstream.lock.json", lock)
        self.assertEqual(upgrade.main(["prepare", "--name", "bad-pin"]), 1)
        self.assertFalse((self.cache / "candidates" / "bad-pin").exists())

    def test_companion_snapshot_is_reproducible_and_invalidation_requires_reverification(self):
        plugin = self.repo / "plugins" / "managed" / "src"
        plugin.mkdir(parents=True)
        (plugin / "index.js").write_text("export const version = 1\n", encoding="utf-8", newline="\n")
        self.command("add", ".", cwd=self.repo)
        self.command("commit", "-m", "plugin source", cwd=self.repo)
        self.lock(self.target("upstream\ntwo\nthree\n"))
        lock = upgrade.load_lock()
        lock["companionDirectories"] = ["plugins/managed"]
        upgrade.write_json(self.config / "upstream.lock.json", lock)
        self.assertEqual(upgrade.main(["prepare", "--name", "plugins"]), 0)
        folder, _, _ = upgrade.load_candidate("plugins")
        copied = folder / "plugins" / "managed" / "src" / "index.js"
        self.assertEqual(copied.read_text(), "export const version = 1\n")
        self.assertEqual(upgrade.main(["verify", "plugins", "--profile", "release"]), 0)
        (plugin / "index.js").write_text("export const version = 2\n", encoding="utf-8", newline="\n")
        self.command("add", ".", cwd=self.repo)
        self.command("commit", "-m", "plugin adapted", cwd=self.repo)
        self.assertEqual(upgrade.main(["promote", "plugins"]), 1)
        self.assertEqual(upgrade.main(["refresh-companions", "plugins"]), 0)
        self.assertEqual(copied.read_text(), "export const version = 2\n")
        self.assertEqual(upgrade.main(["promote", "plugins"]), 1)
        self.assertEqual(upgrade.main(["verify", "plugins", "--profile", "release"]), 0)
        self.assertEqual(upgrade.main(["promote", "plugins"]), 0)

    def test_failed_gate_cannot_create_a_passing_release_receipt(self):
        self.lock(self.target("upstream\ntwo\nthree\n"))
        self.assertEqual(upgrade.main(["prepare", "--name", "failed"]), 0)
        gates = upgrade.read_json(self.config / "gates.json")
        gates["gates"]["check"]["argv"] = ["git", "not-a-real-command"]
        upgrade.write_json(self.config / "gates.json", gates)
        self.assertEqual(upgrade.main(["verify", "failed", "--profile", "release"]), 1)
        folder, _, _ = upgrade.load_candidate("failed")
        receipt = upgrade.read_json(folder / "verification-release.json")
        self.assertFalse(receipt["passed"])
        self.assertNotEqual(receipt["results"][0]["exitCode"], 0)
        self.assertEqual(upgrade.main(["promote", "failed"]), 1)

    def test_reviewed_resolution_is_saved_restored_and_reused(self):
        (self.source / "code.txt").write_text("local\ntwo\nthree\n", encoding="utf-8", newline="\n")
        self.command("add", ".", cwd=self.repo)
        self.command("commit", "-m", "local edit", cwd=self.repo)
        self.lock(self.target("upstream\ntwo\nthree\n"))
        self.assertEqual(upgrade.main(["prepare", "--name", "resolved"]), 2)
        _, candidate, _ = upgrade.load_candidate("resolved")
        resolution = "upstream and local\ntwo\nthree\n"
        (candidate / "code.txt").write_text(resolution, encoding="utf-8", newline="\n")
        self.command("add", "code.txt", cwd=candidate)
        self.assertEqual(upgrade.main(["record-resolutions", "resolved"]), 0)
        manifest = upgrade.read_json(self.config / "resolutions" / "manifest.json")
        self.assertEqual(len(manifest["entries"]), 1)
        key = manifest["entries"][0]["id"]
        for name in ("preimage", "postimage"):
            (self.git_dir / "rr-cache" / key / name).unlink()
        upgrade.restore_resolutions()
        self.assertTrue((self.git_dir / "rr-cache" / key / "postimage").exists())
        self.assertEqual(upgrade.main(["prepare", "--name", "reused", "--offline"]), 2)
        _, reused, _ = upgrade.load_candidate("reused")
        self.assertEqual((reused / "code.txt").read_text(), resolution)


if __name__ == "__main__":
    unittest.main()

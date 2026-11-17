"""Repeatable, isolated upstream integration for the DSH source subtree.

Only `promote` changes the checked-in runtime. Git owns three-way merging and
records reusable resolutions; immutable object ids own every validation receipt.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "dsh-aigc"
CACHE = ROOT / ".cache" / "dsh-upgrades"
GIT = CACHE / "upstream.git"
SHA = re.compile(r"^[0-9a-f]{40}$")
TAG = re.compile(r"^dsh-v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$")


class UpgradeError(Exception):
    """An actionable upgrade precondition or verification failure."""


def run(args, *, cwd=None, data=None, check=True):
    result = subprocess.run([str(x) for x in args], cwd=ROOT if cwd is None else cwd, input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise UpgradeError(f"Command failed: {' '.join(map(str, args))}\n"
                           + (result.stdout + result.stderr).decode("utf-8", errors="replace"))
    return result


def git(*args, cwd=None, data=None, check=True):
    return run(["git", *args], cwd=cwd, data=data, check=check)


def upstream(*args, data=None, check=True):
    return git(f"--git-dir={GIT}", *args, data=data, check=check)


def output(result):
    return result.stdout.decode("utf-8", errors="strict").strip()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def safe_relative(value):
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or ".." in path.parts or "\\" in value
            or ":" in value or any(p.lower() == ".git" for p in path.parts)):
        raise UpgradeError(f"Unsafe repository path: {value!r}")
    return path


def contained_symlink(name, target):
    """Accept only a relative link whose resolved path remains inside the runtime tree."""
    safe_relative(name)
    if (not target or "\\" in target or ":" in target or "\0" in target or "\n" in target
            or "\r" in target or target.startswith("/") or PurePosixPath(target).is_absolute()):
        raise UpgradeError(f"Symlink target must stay relative: {name}")
    parts = []
    for part in (*(PurePosixPath(name).parent.parts), *PurePosixPath(target).parts):
        if part == "..":
            if not parts:
                raise UpgradeError(f"Symlink escapes runtime directory: {name}")
            parts.pop()
        elif part not in (".", ""):
            if part.lower() == ".git":
                raise UpgradeError(f"Symlink enters git metadata: {name}")
            parts.append(part)
    if not parts:
        raise UpgradeError(f"Symlink escapes runtime directory: {name}")
    return target


def symlink_target(oid, cwd):
    raw = git("cat-file", "blob", oid, cwd=cwd).stdout
    try:
        text = raw.decode("utf-8")
    except UnicodeError as error:
        raise UpgradeError(f"Symlink target is not UTF-8: {oid}") from error
    return text


def accept_promoted_entry(name, entry, cwd):
    if entry is None:
        return
    if entry["mode"] in ("100644", "100755"):
        return
    if entry["mode"] == "120000" and entry["kind"] == "blob":
        contained_symlink(name, symlink_target(entry["oid"], cwd))
        return
    raise UpgradeError(f"Changed links and submodules require explicit handling: {name}")


def load_lock():
    lock = read_json(CONFIG / "upstream.lock.json")
    if lock.get("schemaVersion") != 1:
        raise UpgradeError("Unsupported upstream lock schema")
    safe_relative(lock["sourceDirectory"])
    for field in ("baseline", "candidate"):
        if not SHA.fullmatch(lock[field]["commit"]) or not TAG.fullmatch(lock[field]["tag"]):
            raise UpgradeError(f"Invalid {field} pin")
    return lock


def source_snapshot(lock):
    directory = lock["sourceDirectory"]
    directories = [directory, *lock.get("companionDirectories", [])]
    for name in directories:
        safe_relative(name)
    dirty = git("status", "--porcelain", "--untracked-files=all", "--", *directories).stdout
    if dirty:
        raise UpgradeError("Commit DSH and companion plugin source changes before preparing or promoting an upgrade")
    commit = output(git("rev-parse", "HEAD"))
    tree = output(git("rev-parse", f"HEAD:{directory}"))
    return commit, tree


def companion_snapshot(lock, commit):
    files = []
    for directory in lock.get("companionDirectories", []):
        safe_relative(directory)
        if not directory.startswith("plugins/"):
            raise UpgradeError("Companion sources must be explicit plugin directories")
        revision = f"{commit}:{directory}"
        for name, entry in entries(revision, cache=False).items():
            parts = PurePosixPath(name).parts
            if any(p in ("lib", "node_modules", "dist") for p in parts) or name.endswith(".tgz"):
                continue
            if entry["mode"] not in ("100644", "100755"):
                raise UpgradeError(f"Companion links require explicit handling: {directory}/{name}")
            files.append({"path": f"{directory}/{name}", **entry})
    return sorted(files, key=lambda entry: entry["path"])


def materialize_companions(folder, commit, files):
    for entry in files:
        name = entry["path"]
        safe_relative(name)
        destination = folder / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(git("show", f"{commit}:{name}").stdout)


def check_companions(folder, state):
    expected = state.get("companionFiles", [])
    expected_names = {entry["path"] for entry in expected}
    for directory in state.get("companionDirectories", []):
        actual_names = set()
        for file in (folder / directory).rglob("*"):
            name = file.relative_to(folder).as_posix()
            relative = file.relative_to(folder / directory)
            if any(p in ("lib", "node_modules", "dist") for p in relative.parts) or name.endswith(".tgz"):
                continue
            if file.is_file():
                actual_names.add(name)
        if actual_names != {p for p in expected_names if p.startswith(directory + "/")}:
            raise UpgradeError(f"Candidate companion file list changed: {directory}")
    for entry in expected:
        file = folder / entry["path"]
        data = file.read_bytes()
        oid = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        if oid != entry["oid"]:
            raise UpgradeError(f"Candidate companion changed: {entry['path']}; edit and commit the primary plugin source, then refresh-companions")
    return hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()


def refresh_companions(args):
    lock = load_lock()
    commit, tree = source_snapshot(lock)
    folder, _, state = load_candidate(args.name)
    if tree != state["sourceTree"]:
        raise UpgradeError("DSH source changed; prepare a new candidate")
    check_companions(folder, state)
    files = companion_snapshot(lock, commit)
    names = {entry["path"] for entry in files}
    for entry in state.get("companionFiles", []):
        if entry["path"] not in names:
            (folder / entry["path"]).unlink()
    materialize_companions(folder, commit, files)
    state["companionFiles"] = files
    state["companionDirectories"] = lock.get("companionDirectories", [])
    state["sourceCommit"] = commit
    write_json(folder / "state.json", state)
    print("Companion snapshot refreshed; run verification again before promotion")
    return 0


def ensure_cache(lock, offline=False):
    CACHE.mkdir(parents=True, exist_ok=True)
    if not GIT.exists():
        if offline:
            raise UpgradeError("Upstream cache missing; run prepare once with network access")
        git("init", "--bare", GIT)
        upstream("remote", "add", "origin", lock["repository"])
    if output(upstream("remote", "get-url", "origin")) != lock["repository"]:
        raise UpgradeError("Upstream cache remote does not match the lock")
    for key, value in (("user.name", "AIGC integration"), ("user.email", "integration@aigc.local"),
                       ("rerere.enabled", "true"), ("rerere.autoupdate", "false"),
                       ("core.longpaths", "true"), ("core.autocrlf", "false")):
        upstream("config", key, value)


def fetch_pin(pin, offline=False):
    if not TAG.fullmatch(pin["tag"]) or not SHA.fullmatch(pin["commit"]):
        raise UpgradeError("Target must be a release tag and a full immutable commit id")
    ref = f"refs/tags/{pin['tag']}"
    if not offline:
        # No force: a moved release tag is an error, never an implicit new baseline.
        upstream("fetch", "--no-tags", "origin", f"{ref}:{ref}")
    actual = output(upstream("rev-parse", f"{ref}^{{commit}}"))
    if actual != pin["commit"]:
        raise UpgradeError(f"Release pin mismatch: {pin['tag']} is {actual}, expected {pin['commit']}")


def restore_resolutions():
    manifest = CONFIG / "resolutions" / "manifest.json"
    if not manifest.exists():
        return
    records = read_json(manifest)
    for record in records["entries"]:
        key = record["id"]
        if not re.fullmatch(r"[0-9a-f]{40,64}", key):
            raise UpgradeError("Invalid saved merge resolution id")
        for name in ("preimage", "postimage"):
            source = manifest.parent / key / name
            if hashlib.sha256(source.read_bytes()).hexdigest() != record[name]:
                raise UpgradeError(f"Saved merge resolution checksum mismatch: {key}/{name}")
            destination = GIT / "rr-cache" / key / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists() and destination.read_bytes() != source.read_bytes():
                raise UpgradeError(f"Local and saved resolutions differ: {key}/{name}")
            shutil.copyfile(source, destination)


def record_resolutions(args):
    _, source, _ = load_candidate(args.name)
    candidate_tree(source)
    git("rerere", cwd=source)
    records = []
    cache = GIT / "rr-cache"
    for directory in sorted(cache.iterdir() if cache.exists() else []):
        if not re.fullmatch(r"[0-9a-f]{40,64}", directory.name):
            continue
        if not all((directory / name).is_file() for name in ("preimage", "postimage")):
            continue
        record = {"id": directory.name}
        for name in ("preimage", "postimage"):
            data = (directory / name).read_bytes()
            destination = CONFIG / "resolutions" / directory.name / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            record[name] = hashlib.sha256(data).hexdigest()
        records.append(record)
    write_json(CONFIG / "resolutions" / "manifest.json", {"schemaVersion": 1, "entries": records})
    print(f"Saved {len(records)} reusable resolutions; review and commit dsh-aigc/resolutions")
    return 0


def entries(revision, *, cache=True):
    result = upstream("ls-tree", "-r", "-z", revision) if cache else git("ls-tree", "-r", "-z", revision)
    found = {}
    for row in result.stdout.split(b"\0"):
        if not row:
            continue
        metadata, name = row.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        path = name.decode("utf-8")
        safe_relative(path)
        found[path] = {"mode": mode, "kind": kind, "oid": oid}
    return found


def classify(base, local, target):
    """Classify by Git object identity, preserving binary files and file modes."""
    changes = []
    for path in sorted(set(base) | set(local) | set(target)):
        b, l, t = base.get(path), local.get(path), target.get(path)
        if l == b and t == b:
            continue
        if l == b:
            category = "upstream-only"
        elif t == b:
            category = "aigc-only"
        elif l == t:
            category = "already-upstream"
        else:
            category = "both-changed"
        changes.append({"path": path, "category": category,
                        "base": b, "local": l, "target": t})
    return changes


def inventory(args):
    lock = load_lock()
    _, tree = source_snapshot(lock)
    ensure_cache(lock, offline=True)
    fetch_pin(lock["baseline"], offline=True)
    base = entries(lock["baseline"]["commit"])
    local = entries(tree, cache=False)
    extensions = sorted(p.removesuffix("/package.json") for p in local
                        if p.startswith("packages/") and p.endswith("/package.json") and p not in base)
    files = []
    for path in sorted(set(base) | set(local)):
        if base.get(path) == local.get(path):
            continue
        extension = next((root for root in extensions if path.startswith(root + "/")), None)
        category = "extension" if extension else "patch" if path in base else "addition"
        files.append({"path": path, "category": category, "upstream": base.get(path), "aigc": local.get(path)})
    value = {"schemaVersion": 1, "baseline": lock["baseline"], "sourceTree": tree,
             "extensionRoots": extensions, "files": files}
    destination = CONFIG / "customizations.json"
    if args.check:
        if not destination.exists() or read_json(destination) != value:
            raise UpgradeError("Customization inventory is stale; commit source changes and run inventory")
    else:
        write_json(destination, value)
    print(f"Customization inventory: {len(files)} files; {len(extensions)} independent extension packages")
    return 0


def import_tree(tree):
    # Transfer only the DSH subtree, never server configuration or other monorepo history.
    pack = git("pack-objects", "--stdout", "--revs", data=(tree + "\n").encode()).stdout
    upstream("index-pack", "--stdin", data=pack)


MISSING = object()


def merge_json(base, local, target):
    """Merge disjoint object-key changes; never guess conflicting scalar or list intent."""
    if local == base:
        return target
    if target == base or local == target:
        return local
    if isinstance(local, dict) and isinstance(target, dict) and (base is MISSING or isinstance(base, dict)):
        previous = {} if base is MISSING else base
        result = {}
        for key in sorted(set(previous) | set(local) | set(target)):
            value = merge_json(previous.get(key, MISSING), local.get(key, MISSING), target.get(key, MISSING))
            if value is not MISSING:
                result[key] = value
        return result
    raise UpgradeError("JSON contains overlapping changes requiring human review")


def resolve_json_files(source):
    conflicts = git("diff", "--name-only", "--diff-filter=U", "-z", cwd=source).stdout
    resolved = []
    for value in conflicts.split(b"\0"):
        if not value:
            continue
        name = value.decode()
        if not name.endswith(".json"):
            continue
        versions = []
        for stage in (1, 2, 3):
            blob = git("show", f":{stage}:{name}", cwd=source, check=False)
            if blob.returncode:
                versions.append(MISSING)
            else:
                try:
                    versions.append(json.loads(blob.stdout))
                except (UnicodeError, ValueError):
                    break
        if len(versions) != 3:
            continue
        try:
            merged = merge_json(*versions)
        except UpgradeError:
            continue
        if merged is MISSING:
            continue
        safe_relative(name)
        write_json(source / name, merged)
        git("add", "--", name, cwd=source)
        resolved.append(name)
    return resolved


def candidate_paths(name):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}", name):
        raise UpgradeError("Candidate id may contain only letters, digits, dot, underscore and hyphen")
    folder = CACHE / "candidates" / name
    return folder, folder / "source", folder / "state.json"


def report(folder, state):
    source = folder / "source"
    conflicts = git("diff", "--name-only", "--diff-filter=U", "-z", cwd=source).stdout
    state["conflicts"] = [p.decode() for p in conflicts.split(b"\0") if p]
    state["status"] = "conflicts" if state["conflicts"] else "needs-validation"
    write_json(folder / "state.json", state)
    counts = Counter(row["category"] for row in state["changes"])
    text = [f"# DSH upgrade {state['target']['tag']}", "",
            f"Source commit: `{state['sourceCommit']}`", "",
            f"Upstream baseline: `{state['baseline']['tag']}` / `{state['baseline']['commit']}`", "",
            f"Target: `{state['target']['tag']}` / `{state['target']['commit']}`", "",
            f"Status: **{state['status']}**", "", "| Change | Files |", "|---|---:|"]
    text += [f"| {key} | {value} |" for key, value in sorted(counts.items())]
    text += ["", "## Unresolved files", ""]
    text += [f"- `{p}`" for p in state["conflicts"]] or ["None."]
    text += ["", "The candidate is isolated. No runtime source or upstream lock has been promoted.", ""]
    (folder / "REPORT.md").write_text("\n".join(text), encoding="utf-8")
    print(f"Candidate: {source}\nReport: {folder / 'REPORT.md'}\nUnresolved files: {len(state['conflicts'])}")
    return not state["conflicts"]


def prepare(args):
    lock = load_lock()
    commit, tree = source_snapshot(lock)
    companions = companion_snapshot(lock, commit)
    target = dict(lock["candidate"])
    if bool(args.tag) != bool(args.commit):
        raise UpgradeError("Use --tag and --commit together")
    if args.tag:
        target = {"tag": args.tag, "commit": args.commit}
    ensure_cache(lock, args.offline)
    fetch_pin(lock["baseline"], args.offline)
    fetch_pin(target, args.offline)
    restore_resolutions()
    name = args.name or f"{target['tag']}-{tree[:12]}"
    folder, source, state_file = candidate_paths(name)
    if folder.exists():
        raise UpgradeError(f"Candidate exists: {name}; use status or a new --name (never overwrite resolutions)")
    base = entries(lock["baseline"]["commit"])
    local = entries(tree, cache=False)
    changes = classify(base, local, entries(target["commit"]))
    import_tree(tree)
    overlay = output(upstream("commit-tree", tree, "-p", lock["baseline"]["commit"],
                              "-m", f"AIGC DSH snapshot from {commit}; upstream {lock['baseline']['tag']}"))
    folder.mkdir(parents=True)
    upstream("update-ref", f"refs/aigc/candidates/{name}", overlay)
    upstream("worktree", "add", "--quiet", "--detach", source, overlay)
    state = {"schemaVersion": 1, "id": name, "sourceCommit": commit, "sourceTree": tree,
             "baseline": lock["baseline"], "target": target, "overlay": overlay, "changes": changes,
             "companionFiles": companions, "companionDirectories": lock.get("companionDirectories", [])}
    materialize_companions(folder, commit, companions)
    write_json(state_file, state)
    merge = git("merge", "--no-commit", "--no-ff", target["commit"], cwd=source, check=False)
    state["structuredResolutions"] = resolve_json_files(source)
    clean = report(folder, state)
    if merge.returncode and clean:
        # A content conflict may have been fully resolved by the object-key merger.
        if not git("rev-parse", "--verify", "MERGE_HEAD", cwd=source, check=False).returncode == 0:
            raise UpgradeError("Merge failed without merge conflicts:\n" + merge.stderr.decode(errors="replace"))
    return 0 if clean else 2


def load_candidate(name):
    folder, source, state_file = candidate_paths(name)
    if not state_file.exists() or not (source / ".git").is_file():
        raise UpgradeError(f"Candidate not found: {name}")
    state = read_json(state_file)
    if state.get("id") != name or state.get("schemaVersion") != 1:
        raise UpgradeError("Invalid candidate state")
    common = Path(output(git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=source))).resolve()
    if common != GIT.resolve():
        raise UpgradeError("Candidate is not owned by the upstream cache")
    return folder, source, state


def candidate_tree(source):
    if git("diff", "--name-only", "--diff-filter=U", cwd=source).stdout:
        raise UpgradeError("Resolve and stage all merge conflicts before verification")
    if git("diff", "--name-only", cwd=source).stdout:
        raise UpgradeError("Stage candidate changes before verification; receipts cover the Git index")
    if git("ls-files", "--others", "--exclude-standard", cwd=source).stdout:
        raise UpgradeError("Stage candidate new files before verification")
    git("diff", "--cached", "--check", cwd=source)
    # Recognize full Git conflict delimiters, not Markdown separators or quoted examples.
    markers = git("grep", "--cached", "-n", "-E", "^(<<<<<<< |>>>>>>> )", "--", ".",
                  cwd=source, check=False)
    if markers.returncode == 0:
        raise UpgradeError("Candidate still contains conflict markers:\n" + output(markers))
    if markers.returncode != 1:
        raise UpgradeError("Could not inspect candidate for conflict markers")
    return output(git("write-tree", cwd=source))


def resolve_command(argv):
    executable = shutil.which(argv[0])
    if executable is None:
        raise UpgradeError(f"Required executable missing: {argv[0]}")
    return [executable, *argv[1:]]


def verify(args):
    folder, source, state = load_candidate(args.name)
    tree = candidate_tree(source)
    companions_digest = check_companions(folder, state)
    gates_path = CONFIG / "gates.json"
    gates = read_json(gates_path)
    digest = hashlib.sha256(gates_path.read_bytes()).hexdigest()
    selected = gates["profiles"].get(args.profile)
    if selected is None:
        raise UpgradeError(f"Unknown verification profile: {args.profile}")
    # Local extension packages cannot silently disappear in an upstream merge.
    local = entries(state["sourceTree"])
    baseline = entries(state["baseline"]["commit"])
    for name in local:
        if name.startswith("packages/") and name.endswith("/package.json") and name not in baseline:
            if not (source / name).is_file():
                raise UpgradeError(f"AIGC extension missing from candidate: {name}")
    receipt = {"schemaVersion": 1, "tree": tree, "target": state["target"],
               "gatesSha256": digest, "companionsSha256": companions_digest,
               "profile": args.profile, "results": [], "passed": False}
    receipt_file = folder / f"verification-{args.profile}.json"
    write_json(receipt_file, receipt)
    for gate_id in selected:
        gate = gates["gates"][gate_id]
        for name in gate.get("requiredPaths", []):
            safe_relative(name)
            if not (source / name).exists():
                raise UpgradeError(f"Gate {gate_id} lost required test or policy: {name}")
        print(f"Running {gate_id}", flush=True)
        log = folder / f"{gate_id}.log"
        with log.open("wb") as handle:
            result = subprocess.run(resolve_command(gate["argv"]), cwd=source,
                                    stdout=handle, stderr=subprocess.STDOUT)
        receipt["results"].append({"id": gate_id, "exitCode": result.returncode, "log": log.name})
        write_json(receipt_file, receipt)
        if result.returncode:
            raise UpgradeError(f"Gate {gate_id} failed; see {log}")
    if candidate_tree(source) != tree:
        raise UpgradeError("Verification changed source files; stage changes and run again")
    if check_companions(folder, state) != companions_digest:
        raise UpgradeError("Companion snapshot changed during verification")
    receipt["passed"] = True
    write_json(receipt_file, receipt)
    print(f"Passed {args.profile}: {tree}")
    return 0


def check_receipt(receipt, *, tree, target, digest, required):
    if (receipt.get("passed") is not True or receipt.get("tree") != tree
            or receipt.get("target") != target or receipt.get("gatesSha256") != digest
            or receipt.get("profile") != "release"):
        raise UpgradeError("A passing release receipt for the exact current tree and gate configuration is required")
    results = receipt.get("results", [])
    if [r.get("id") for r in results] != required or any(r.get("exitCode") != 0 for r in results):
        raise UpgradeError("Release receipt does not contain every required passing gate")


def extract_archive(archive, destination, allowed_files=None):
    """Extract tracked source only; reject links that could escape the staging tree."""
    with tarfile.open(archive) as stream:
        for member in stream:
            name = member.name.rstrip("/")
            safe_relative(name)
            if allowed_files is not None and name not in allowed_files:
                continue
            file = destination / name
            if member.isdir():
                file.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                file.parent.mkdir(parents=True, exist_ok=True)
                with stream.extractfile(member) as incoming, file.open("wb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                file.chmod(member.mode & 0o777)
            elif member.issym():
                contained_symlink(name, member.linkname or "")
                file.parent.mkdir(parents=True, exist_ok=True)
                if file.is_symlink() or file.exists():
                    file.unlink()
                os.symlink(member.linkname, file)
            else:
                raise UpgradeError(f"Archive links require explicit handling: {name}")


def remove_leaf(file):
    """Remove a file or symlink without following it into another directory."""
    if file.is_symlink() or file.is_file():
        file.unlink()
        return True
    return False


def replace_source_file(incoming, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".aigc-upgrade-tmp")
    if incoming.is_symlink():
        if temporary.is_symlink() or temporary.exists():
            temporary.unlink()
        os.symlink(os.readlink(incoming), temporary)
    else:
        if destination.is_dir():
            destination.rmdir()  # Only an empty directory may be replaced; preserve untracked data.
        shutil.copy2(incoming, temporary)
    if destination.is_symlink():
        destination.unlink()
    elif destination.is_dir():
        destination.rmdir()
    elif destination.exists():
        destination.unlink()
    temporary.replace(destination)


def prune_empty_parents(file, root):
    parent = file.parent
    while parent != root and parent.is_relative_to(root):
        try:
            parent.rmdir()
        except OSError:
            break  # A nonempty or externally owned directory must remain intact.
        parent = parent.parent


def apply_source_changes(destination, staging, old, new, changed, backup):
    """Back up actual working bytes and return a rollback function before mutations."""
    for name in changed:
        file = destination / name
        if name in old and file.is_file():
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, saved)

    def rollback():
        for name in sorted(changed, key=lambda name: len(PurePosixPath(name).parts), reverse=True):
            file = destination / name
            if name not in old and remove_leaf(file):
                prune_empty_parents(file, destination)
            temporary = file.with_name(file.name + ".aigc-upgrade-tmp")
            if temporary.is_symlink() or temporary.is_file():
                temporary.unlink()
        for name in sorted(changed):
            if name in old and (backup / name).is_file():
                file = destination / name
                file.parent.mkdir(parents=True, exist_ok=True)
                if file.is_dir():
                    file.rmdir()
                shutil.copy2(backup / name, file)

    try:
        for name in sorted(set(old) - set(new), key=lambda name: len(PurePosixPath(name).parts), reverse=True):
            if name in changed:
                file = destination / name
                if remove_leaf(file):
                    prune_empty_parents(file, destination)
        for name in sorted(changed):
            if name in new:
                replace_source_file(staging / name, destination / name)
    except OSError:
        rollback()
        raise
    return rollback


def promote(args):
    lock = load_lock()
    current_commit, current_tree = source_snapshot(lock)
    folder, source, state = load_candidate(args.name)
    if current_tree != state["sourceTree"] or lock["baseline"] != state["baseline"]:
        raise UpgradeError("Runtime source or baseline changed since prepare; prepare a new candidate")
    if companion_snapshot(lock, current_commit) != state.get("companionFiles", []):
        raise UpgradeError("Companion source changed; run refresh-companions and verify again")
    companions_digest = check_companions(folder, state)
    tree = candidate_tree(source)
    gates_path = CONFIG / "gates.json"
    gates = read_json(gates_path)
    receipt_file = folder / "verification-release.json"
    if not receipt_file.exists():
        raise UpgradeError("Run verify --profile release before promotion")
    receipt = read_json(receipt_file)
    if receipt.get("companionsSha256") != companions_digest:
        raise UpgradeError("Release receipt belongs to a different companion plugin snapshot")
    check_receipt(receipt, tree=tree, target=state["target"],
                  digest=hashlib.sha256(gates_path.read_bytes()).hexdigest(),
                  required=gates["profiles"]["release"])
    destination = (ROOT / lock["sourceDirectory"]).resolve()
    if not destination.is_relative_to(ROOT.resolve()) or destination == ROOT.resolve():
        raise UpgradeError("Runtime source must stay inside the workspace")
    old = entries(current_tree, cache=False)
    new = entries(tree)
    changed = [p for p in set(old) | set(new) if old.get(p) != new.get(p)]
    # Check every target before writing any source. Do not traverse local directory links.
    for name in changed:
        safe_relative(name)
        file = destination / name
        if not file.resolve().is_relative_to(destination):
            raise UpgradeError(f"Local link escapes runtime directory: {name}")
        if name not in old and (file.is_symlink() or file.is_file()):
            raise UpgradeError(f"New upstream file would overwrite an untracked local file: {name}")
        accept_promoted_entry(name, old.get(name), ROOT)
        accept_promoted_entry(name, new.get(name), source)
    git("-c", "rerere.enabled=true", "rerere", cwd=source)
    commit = output(upstream("commit-tree", tree, "-p", state["overlay"], "-p", state["target"]["commit"],
                              "-m", f"Integrate {state['target']['tag']} with AIGC controls"))
    upstream("update-ref", f"refs/aigc/integrated/{state['id']}", commit)
    with tempfile.TemporaryDirectory(prefix="promote-", dir=CACHE) as temporary:
        staging = Path(temporary)
        archive = staging / "source.tar"
        git("archive", "--format=tar", f"--output={archive}", tree, cwd=source)
        files = staging / "files"
        files.mkdir()
        extract_archive(archive, files, {name for name in changed if name in new})
        write_json(folder / "promotion-journal.json", {"fromTree": current_tree, "toTree": tree,
                                                       "paths": sorted(changed), "complete": False})
        rollback = apply_source_changes(destination, files, old, new, changed, folder / "promotion-backup")
    lock["baseline"] = state["target"]
    lock["candidate"] = state["target"]
    lock["integration"] = {"commit": commit, "tree": tree, "sourceCommit": state["sourceCommit"]}
    old_lock = (CONFIG / "upstream.lock.json").read_bytes()
    integration_file = CONFIG / "last-integration.json"
    old_integration = integration_file.read_bytes() if integration_file.exists() else None
    try:
        write_json(CONFIG / "upstream.lock.json", lock)
        write_json(integration_file, {"baseline": state["baseline"], "target": state["target"],
                                     "integrationCommit": commit, "tree": tree,
                                     "verification": read_json(receipt_file)})
    except OSError:
        rollback()
        (CONFIG / "upstream.lock.json").write_bytes(old_lock)
        if old_integration is None:
            integration_file.unlink(missing_ok=True)
        else:
            integration_file.write_bytes(old_integration)
        raise
    write_json(folder / "promotion-journal.json", {"fromTree": current_tree, "toTree": tree,
                                                   "paths": sorted(changed), "complete": True})
    print(f"Promoted {len(changed)} paths. Review and commit the runtime and lock together. No release was published.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("prepare", help="Fetch pinned upstream and create an isolated three-way merge")
    command.add_argument("--tag")
    command.add_argument("--commit")
    command.add_argument("--name")
    command.add_argument("--offline", action="store_true")
    command = commands.add_parser("status", help="Refresh candidate report after conflict resolution")
    command.add_argument("name")
    command = commands.add_parser("verify", help="Run reusable gates against the staged candidate tree")
    command.add_argument("name")
    command.add_argument("--profile", choices=("contracts", "release"), default="contracts")
    command = commands.add_parser("promote", help="Copy only an exactly validated candidate into the runtime subtree")
    command.add_argument("name")
    command = commands.add_parser("record-resolutions", help="Persist reviewed conflict resolutions for clean machines and CI")
    command.add_argument("name")
    command = commands.add_parser("inventory", help="Record every downstream file difference and independent extension")
    command.add_argument("--check", action="store_true")
    command = commands.add_parser("resolve-json", help="Merge non-overlapping JSON object keys without choosing conflicting values")
    command.add_argument("name")
    command = commands.add_parser("refresh-companions", help="Refresh committed primary plugin sources without changing the candidate runtime")
    command.add_argument("name")
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            folder, _, state = load_candidate(args.name)
            return 0 if report(folder, state) else 2
        if args.command == "resolve-json":
            folder, source, state = load_candidate(args.name)
            state.setdefault("structuredResolutions", []).extend(resolve_json_files(source))
            return 0 if report(folder, state) else 2
        return {"prepare": prepare, "verify": verify, "promote": promote,
                "record-resolutions": record_resolutions, "inventory": inventory,
                "refresh-companions": refresh_companions}[args.command](args)
    except (UpgradeError, OSError, ValueError, KeyError) as error:
        print(f"Upgrade stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

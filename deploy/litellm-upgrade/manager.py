#!/usr/bin/env python3
"""Scoped Docker Compose LiteLLM upgrade. Python standard library only."""
import argparse
import contextlib
import copy
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(args, *, output=None, input_file=None, timeout=120, data=None):
    # Keep raw stderr private; never persist argv, stdout, configs or backup bodies.
    p = subprocess.run(args, stdout=output or subprocess.PIPE,
                       stdin=input_file, input=data,
                       stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode != 0:
        operation = next((word for word in args if word in ('pg_dump', 'pg_restore', 'psql')), '')
        details = '诊断日志保存失败'
        try:
            folder = ROOT / '.upgrade-errors'
            folder.mkdir(mode=0o700, exist_ok=True)
            os.chmod(folder, 0o700)
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            logfile = folder / ('%s-%s.stderr.log' % (stamp, os.getpid()))
            logfile.write_bytes(p.stderr)
            os.chmod(logfile, 0o600)
            details = '私有诊断日志：' + str(logfile)
        except OSError:
            pass  # Preserve the original command failure if diagnostics cannot be saved.
        raise RuntimeError('命令失败：%s%s（退出码 %s；%s）' %
                           (' '.join(args[:2]), ' / ' + operation if operation else '', p.returncode, details))
    return p.stdout if output is None else b''


def docker(*args, **kwargs):
    return run(['docker', *args], **kwargs)


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def envmap(container):
    return dict(x.split('=', 1) for x in container['Config'].get('Env', []) if '=' in x)


MASTER_KEY_PROBE = r'''
import json, os, sys
result = 'unknown'
try:
    command = json.loads(sys.argv[1])
    paths = []
    for i, arg in enumerate(command):
        if arg == '--config' and i + 1 < len(command):
            paths.append(command[i + 1])
        elif arg.startswith('--config='):
            paths.append(arg.split('=', 1)[1])
    key = os.environ.get('LITELLM_MASTER_KEY')
    if len(paths) == 1:
        import yaml
        with open(paths[0], encoding='utf-8') as f:
            config = yaml.safe_load(f) or {}
        settings = config.get('general_settings') or {}
        if 'master_key' in settings:
            key = settings['master_key']
            if isinstance(key, str) and key.startswith('os.environ/'):
                key = os.environ.get(key[len('os.environ/'):])
    elif len(paths) > 1:
        raise ValueError('multiple config sources')
    if key is None or not isinstance(key, str) or not key.strip() or key.strip() == 'sk-1234':
        result = 'unsafe'
    elif key.startswith(('os.environ/', 'os.environ.', 'secret/')):
        result = 'unknown'
    else:
        result = 'safe'
except Exception:
    pass
print(result)
'''


def check_master_key(app):
    command = (app['Config'].get('Entrypoint') or []) + (app['Config'].get('Cmd') or [])
    require(isinstance(command, list) and all(isinstance(x, str) for x in command),
            '无法解析 LiteLLM 启动命令以检查 Master Key。')
    # Only pass config paths, never unrelated command arguments which may contain secrets.
    config_args = []
    for i, arg in enumerate(command):
        if arg == '--config' and i + 1 < len(command):
            config_args += ['--config', command[i + 1]]
        elif arg.startswith('--config='):
            config_args.append(arg)
    result = docker('exec', app['Name'].lstrip('/'), 'python', '-c', MASTER_KEY_PROBE,
                    json.dumps(config_args)).decode().strip()
    require(result == 'safe', '新版 Master Key 启动检查未通过（未设置、空值、已知默认值或无法解析配置）。'
            '请先按官方密钥轮换/加密迁移流程处理；本工具不会修改密钥，也不会停服。')


def write_json(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while True:
            part = f.read(1024 * 1024)
            if not part:
                break
            h.update(part)
    return h.hexdigest()


def compose(ctx, path):
    return ['docker', 'compose', '--project-directory', ctx['workdir'],
            '-p', ctx['project'], '-f', str(path)]


def scoped_up(ctx, path):
    run(compose(ctx, path) + ['up', '-d', '--no-deps', '--pull', 'never',
                            '--force-recreate', ctx['service']], timeout=300)


def stop(ctx, path, seconds):
    run(compose(ctx, path) + ['stop', '-t', str(seconds), ctx['service']], timeout=seconds + 60)


def discover(args):
    docker('info')
    docker('compose', 'version')
    ids = docker('ps', '-q').decode().split()
    require(ids, '未发现运行中的容器。此工具用于升级已有 Compose 部署。')
    containers = [inspect(i) for i in ids]
    if args.container:
        app = inspect(args.container)
    else:
        candidates = [c for c in containers if re.search(r'(^|/)litellm(?:-database|-non_root)?(?=[:@]|$)',
                                                         c['Config']['Image'])]
        require(len(candidates) == 1, '无法唯一识别 LiteLLM，请使用 --container 实际容器名。')
        app = candidates[0]
    require(app['State']['Running'], '目标容器未运行。')
    labels = app['Config'].get('Labels') or {}
    project = labels.get('com.docker.compose.project')
    service = labels.get('com.docker.compose.service')
    workdir = labels.get('com.docker.compose.project.working_dir')
    files = labels.get('com.docker.compose.project.config_files', '').split(',')
    require(project and service and workdir and files[0],
            '当前容器不是可识别的 Compose 部署；停止，请先提供真实 docker run 启动定义。')
    require(pathlib.Path(workdir).is_dir(), 'Compose 工作目录不存在。')
    base = ['docker', 'compose', '--project-directory', workdir, '-p', project]
    for file in files:
        require(pathlib.Path(file).is_file(), 'Compose 源文件不存在：' + file)
        base += ['-f', file]
    resolved = json.loads(run(base + ['config', '--format', 'json']))
    require(service in resolved['services'], 'Compose 中不存在目标服务。')
    live_hash = labels.get('com.docker.compose.config-hash')
    source_hash = run(base + ['config', '--hash', service]).decode().strip().split()[-1]
    require(live_hash == source_hash,
            'Compose 文件/环境与运行容器存在差异，请先核对；不会覆盖尚未部署的配置。')
    spec = resolved['services'][service]
    require(not spec.get('build'), '目标服务含 build，请先确认使用官方预构建镜像。')
    require(not spec.get('scale', 1) > 1 and
            not spec.get('deploy', {}).get('replicas', 1) > 1,
            '此工具仅支持单实例 LiteLLM。')
    require(sum((c['Config'].get('Labels') or {}).get('com.docker.compose.project') == project and
                (c['Config'].get('Labels') or {}).get('com.docker.compose.service') == service
                for c in containers) == 1, '检测到多个目标实例；需要专门的迁移编排。')
    runtime = envmap(app)
    url = runtime.get('DATABASE_URL', '')
    require(url, '未在运行容器 DATABASE_URL 中找到数据库；配置文件内连接或无数据库部署需单独适配。')
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme in ('postgres', 'postgresql') and parsed.hostname and parsed.path.strip('/'),
            '仅支持明确的 PostgreSQL DATABASE_URL。')
    dbname = urllib.parse.unquote(parsed.path.lstrip('/'))
    owner = urllib.parse.unquote(parsed.username or '')
    require(dbname not in ('postgres', 'template0', 'template1') and owner, '数据库名称或所有者不适合专用库回退。')
    matches = []
    for c in containers:
        aliases = {c['Name'].lstrip('/')}
        for net in c.get('NetworkSettings', {}).get('Networks', {}).values():
            aliases.update(net.get('Aliases') or [])
            aliases.add(net.get('IPAddress'))
        if parsed.hostname in aliases:
            matches.append(c)
    require(len(matches) == 1, '无法通过 DATABASE_URL 唯一定位本机数据库容器；外部/host 网络数据库需专门适配。')
    db = matches[0]
    if args.db_container:
        require(inspect(args.db_container)['Id'] == db['Id'], '--db-container 与 DATABASE_URL 指向不一致。')
    require(parsed.port in (None, 5432), '仅支持数据库容器内部 PostgreSQL 5432 端口。')
    admin = envmap(db).get('POSTGRES_USER', 'postgres')
    ctx = {'project': project, 'service': service, 'workdir': workdir,
           'container': app['Name'].lstrip('/'), 'db_container': db['Name'].lstrip('/'),
           'db_id': db['Id'], 'database': dbname, 'db_owner': owner, 'db_admin': admin,
           'old_image': app['Image'], 'old_reference': app['Config']['Image'],
           'health_url': args.health_url, 'files': files}
    # Local container authentication; a configured password is never printed or put on argv.
    docker('exec', ctx['db_container'], 'psql', '-U', admin, '-d', dbname,
           '-v', 'ON_ERROR_STOP=1', '-Atc', 'SELECT 1')
    version = docker('exec', ctx['container'], 'python', '-c',
                     "import importlib.metadata; print(importlib.metadata.version('litellm'))").decode().strip()
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:[a-zA-Z0-9.+-]*)?', version), '无法识别当前 LiteLLM 版本。')
    ctx['old_version'] = version
    check_master_key(app)
    return ctx, resolved, app


def image_metadata():
    meta = json.loads((ROOT / 'image.json').read_text(encoding='utf-8'))
    require(re.fullmatch(r'v\d+\.\d+\.\d+', meta['version']), '目标必须是明确的正式版本。')
    require(meta['version'] != 'v1.107.0', '拒绝已报告安全事件的 v1.107.0。')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', meta['image_id']), '无效 image_id。')
    require(meta['platform'] == 'linux/amd64', '此交付包只支持 linux/amd64。')
    return meta


def verify_archive(meta):
    archive = ROOT / meta['archive']
    require(archive.parent == ROOT and archive.is_file(), '离线镜像缺失。')
    print('校验离线镜像 SHA256…', flush=True)
    require(sha256(archive) == meta['archive_sha256'], '离线镜像校验失败。')
    return archive


def archive_config(archive, image):
    # Do not extract files onto disk. Both traditional and OCI-backed Docker save
    # archives expose manifest.json, but their Config paths differ.
    with tarfile.open(archive, 'r:*') as saved:
        manifest = json.load(saved.extractfile('manifest.json'))
        matches = [item for item in manifest if image in (item.get('RepoTags') or [])]
        if not matches and len(manifest) == 1:
            matches = manifest
        require(len(matches) == 1, '离线归档中的目标镜像不唯一。')
        config = json.load(saved.extractfile(matches[0]['Config']))
    require(config.get('architecture') == 'amd64' and config.get('os') == 'linux',
            '离线归档配置的平台不匹配。')
    return config


def resolve_loaded_image(meta, archive):
    # A registry config digest is not always a Docker image ID. In particular,
    # containerd-backed Docker can assign an index/manifest digest after load.
    # Inspect the archive's explicit version tag, verify its payload/config, then
    # pin the actual local ID for all following operations.
    config = archive_config(archive, meta['image'])
    target = json.loads(docker('image', 'inspect', meta['image']))[0]
    require(target['Architecture'] == 'amd64' and target['Os'] == 'linux', '导入镜像平台不匹配。')
    require(target.get('RootFS', {}).get('Layers') == config.get('rootfs', {}).get('diff_ids')
            and bool(config.get('rootfs', {}).get('diff_ids')), '导入镜像层与已校验离线归档不一致。')
    for key in ('Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'User'):
        require((target.get('Config', {}).get(key) or None) == (config.get('config', {}).get(key) or None),
                '导入镜像启动配置与离线归档不一致：' + key)
    identity = target.get('Id', '')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', identity), 'Docker 未返回有效的本地镜像 ID。')
    return identity


def health(url):
    # Restrict automatic readiness to loopback; no production credential required.
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1'),
            '--health-url 必须是本机 HTTP readiness 地址。')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(url, timeout=5) as r:
            return r.status == 200
    except (OSError, urllib.error.URLError):
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def wait_ready(ctx, path, expected, timeout):
    deadline = time.monotonic() + timeout
    streak = 0
    while time.monotonic() < deadline:
        try:
            ids = run(compose(ctx, path) + ['ps', '-q', ctx['service']]).decode().split()
            require(len(ids) == 1, '目标实例数量异常。')
            c = inspect(ids[0])
            good = c['Image'] == expected and c['State']['Running'] and health(ctx['health_url'])
            if c['State'].get('Health'):
                good = good and c['State']['Health']['Status'] == 'healthy'
            streak = streak + 1 if good else 0
            if streak >= 3:
                return
        except RuntimeError:
            streak = 0
        time.sleep(3)
    raise RuntimeError('新服务未在期限内连续通过就绪检查；保持维护状态，按 README 诊断/回退。')


@contextlib.contextmanager
def locked(workdir):
    root = pathlib.Path(workdir) / '.litellm-upgrade'
    root.mkdir(mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)
    with (root / 'lock').open('w') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('另一个升级/回退正在运行。')
        yield root


def backup_binds(app, folder):
    import tarfile
    sources = [pathlib.Path(m['Source']) for m in app.get('Mounts', []) if m['Type'] == 'bind']
    require(not any(m['Type'] == 'volume' and m.get('RW') for m in app.get('Mounts', [])),
            'LiteLLM 存在可写命名卷；请先提供独立数据卷备份方案。数据库容器卷不受此限制。')
    # Do not archive arbitrary huge data trees or sockets such as docker.sock.
    total = 0
    for source in sources:
        require(source.is_file() or source.is_dir(), '不支持的 bind mount：' + str(source))
        entries = [source] if source.is_file() else source.rglob('*')
        for entry in entries:
            require(not entry.is_symlink(), 'bind mount 含符号链接，需要人工确认备份范围：' + str(source))
            if entry.is_file():
                total += entry.stat().st_size
    require(total <= 256 * 1024 * 1024, 'LiteLLM bind 数据超过 256MiB，需要独立备份方案。')
    with tarfile.open(folder / 'bind-mounts.tar.gz', 'w:gz') as archive:
        for i, source in enumerate(sources):
            archive.add(source, arcname='mount-%s' % i)
    write_json(folder / 'bind-mounts.json', [str(p) for p in sources])


def upgrade(args):
    ctx, resolved, app = discover(args)
    meta = image_metadata()
    require(ctx['old_reference'].split('@')[0].split(':')[0].rsplit('/', 1)[-1] == 'litellm',
            '当前为不同镜像类型（例如 database/non_root）；需制备相同类型的目标镜像，禁止静默替换。')
    require(tuple(map(int, ctx['old_version'].split('.')[:3])) < tuple(map(int, meta['version'][1:].split('.'))),
            '目标必须高于当前版本；同版本重装或降级请使用专门流程。')
    info = json.loads(docker('info', '--format', '{{json .}}'))
    require(info['OSType'] == 'linux' and info['Architecture'] in ('x86_64', 'amd64'), '服务器架构不匹配。')
    archive = verify_archive(meta)
    require(health(ctx['health_url']), '升级前本机 readiness 未通过，请先恢复当前服务。')
    require(args.dedicated_database, '执行升级必须声明 --dedicated-database，确认该库仅供此 LiteLLM 使用。')
    with locked(ctx['workdir']) as state:
        require(not (state / 'pending.json').exists(), '存在未完成升级；先按 pending.json 指向的备份诊断/回退。')
        require(inspect(ctx['container'])['Id'] == app['Id'], '识别后目标容器发生变化，请重新执行检查。')
        free = shutil.disk_usage(state).free
        require(free > archive.stat().st_size * 3 + 1024 ** 3, '备份目录可用空间不足。')
        print('加载已校验离线镜像…', flush=True)
        docker('load', '-i', str(archive), timeout=1200)
        target_image = resolve_loaded_image(meta, archive)
        actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'python', target_image,
                        '-c', "import importlib.metadata; print(importlib.metadata.version('litellm'))").decode().strip()
        require(actual == meta['version'][1:], '镜像包内 LiteLLM 版本不匹配。')
        folder = state / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid()))
        folder.mkdir(mode=0o700)
        ctx['target_image'] = target_image
        ctx['target_version'] = meta['version']
        write_json(folder / 'context.json', ctx)
        old = copy.deepcopy(resolved)
        old['services'][ctx['service']]['image'] = ctx['old_image']
        new = copy.deepcopy(old)
        new['services'][ctx['service']]['image'] = target_image
        # `docker compose config` already escapes literal dollars for round-tripping.
        # Escaping them again changes passwords/commands in the recreated container.
        write_json(folder / 'old.compose.json', old)
        write_json(folder / 'new.compose.json', new)
        for p, expected in ((folder / 'old.compose.json', old), (folder / 'new.compose.json', new)):
            roundtrip = json.loads(run(compose(ctx, p) + ['config', '--format', 'json']))
            require(roundtrip == expected, 'Compose 快照往返解析不一致；不会停止服务。')
        print('保存旧镜像、配置和数据库预备备份…', flush=True)
        docker('image', 'save', '-o', str(folder / 'old-image.tar'), ctx['old_image'], timeout=1200)
        backup_binds(app, folder)
        print('执行 PostgreSQL 预备备份…', flush=True)
        dump(ctx, folder / 'preflight.dump')
        verify_dump(ctx, folder / 'preflight.dump')
        write_json(folder / 'backup-checksums.json', {p.name: sha256(p) for p in folder.iterdir()
                    if p.is_file() and p.name != 'backup-checksums.json'})
        print('备份目录：', folder, flush=True)
        # Pending marker precedes stopping; failures can never silently resume a migrated DB.
        write_json(state / 'pending.json', {'backup': str(folder), 'phase': 'before-migration'})
        print('停止 LiteLLM 并等待请求退出（最多 %ss），其他服务保持运行…' % args.drain_seconds, flush=True)
        stop(ctx, folder / 'old.compose.json', args.drain_seconds)
        dump(ctx, folder / 'database.dump.partial')
        verify_dump(ctx, folder / 'database.dump.partial')
        (folder / 'database.dump.partial').replace(folder / 'database.dump')
        write_json(folder / 'backup-checksums.json', {p.name: sha256(p) for p in folder.iterdir()
                    if p.is_file() and p.name != 'backup-checksums.json'})
        print('最终数据库备份完成；启动新版（迁移可能在启动时执行）…', flush=True)
        write_json(state / 'pending.json', {'backup': str(folder), 'phase': 'migration-may-have-started'})
        scoped_up(ctx, folder / 'new.compose.json')
        wait_ready(ctx, folder / 'new.compose.json', target_image, args.timeout)
        write_json(state / 'current.json', {'backup': str(folder), 'config': str(folder / 'new.compose.json')})
        (state / 'pending.json').unlink()
        print('升级及本机 readiness 检查通过。版本：', actual)
        print('仍需按 README 验收真实模型、虚拟 Key、费用、内网入口和博查。')
        print('后续管理请使用 service.sh --workdir %s status/up/stop，避免原始 Compose 将版本降回。' % ctx['workdir'])


def dump(ctx, path):
    with path.open('wb') as f:
        docker('exec', ctx['db_container'], 'pg_dump', '-U', ctx['db_admin'], '-d', ctx['database'],
               '--format=custom', '--create', output=f, timeout=1800)
    require(path.stat().st_size > 0, '数据库备份为空。')
    with path.open('rb') as f:
        require(f.read(5) == b'PGDMP', '数据库备份不是有效的 PostgreSQL custom 格式。')


def verify_dump(ctx, path):
    print('校验 PostgreSQL 备份目录：' + path.name, flush=True)
    # Omit a filename so pg_restore treats stdin as a non-seekable stream.
    # /dev/stdin can be reopened after format detection and lose the header bytes.
    with path.open('rb') as f:
        docker('exec', '-i', ctx['db_container'], 'pg_restore', '--list', input_file=f)


def sql_ident(value):
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"


def rollback(args):
    folder = pathlib.Path(args.backup).resolve()
    ctx = json.loads((folder / 'context.json').read_text(encoding='utf-8'))
    require(args.restore_database, '回退必须显式使用 --restore-database：将恢复备份时刻，覆盖其后全部数据库写入。')
    with locked(ctx['workdir']) as state:
        current = json.loads((state / 'current.json').read_text()) if (state / 'current.json').exists() else {}
        pending = json.loads((state / 'pending.json').read_text()) if (state / 'pending.json').exists() else {}
        require(str(folder) == pending.get('backup', current.get('backup')), '仅允许回退最近的当前/未完成升级。')
        require(not current.get('rolled_back') or pending, '此升级已完成回退，禁止重复覆盖数据库。')
        checks = json.loads((folder / 'backup-checksums.json').read_text())
        for name, digest in checks.items():
            require(pathlib.Path(name).name == name and sha256(folder / name) == digest, '备份校验失败：' + name)
        require(inspect(ctx['db_container'])['Id'] == ctx['db_id'], '数据库容器已被替换，请人工复核恢复目标。')
        docker('load', '-i', str(folder / 'old-image.tar'), timeout=1200)
        if pending.get('phase') == 'before-migration':
            scoped_up(ctx, folder / 'old.compose.json')
            wait_ready(ctx, folder / 'old.compose.json', ctx['old_image'], args.timeout)
            write_json(state / 'current.json', {'backup': str(folder), 'config': str(folder / 'old.compose.json'),
                                              'rolled_back': True})
            (state / 'pending.json').unlink()
            print('新版尚未启动，原数据库保持原状，旧服务已恢复。')
            return
        stop(ctx, folder / 'new.compose.json', args.drain_seconds)
        if pending.get('phase') == 'rollback-in-progress':
            recovery = pathlib.Path(pending['recovery'])
            print('继续先前中断的数据库回退…', flush=True)
        else:
            print('保存回退前数据库（用于找回升级后写入）…', flush=True)
            recovery = folder / ('before-rollback-%s.dump' % time.time_ns())
            dump(ctx, recovery)
            write_json(state / 'pending.json', {'backup': str(folder), 'phase': 'rollback-in-progress',
                                              'recovery': str(recovery)})
        database = sql_ident(ctx['database'])
        # Disable new sessions before terminating existing ones; fail safely on any SQL error.
        sql = ('SELECT format(\'ALTER DATABASE %%I ALLOW_CONNECTIONS false\', datname) '
               'FROM pg_database WHERE datname=%s \\gexec\n' % sql_literal(ctx['database']) +
               'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s;\n' % sql_literal(ctx['database']) +
               'DROP DATABASE IF EXISTS %s;\n' % database)
        print('恢复升级前数据库…', flush=True)
        docker('exec', '-i', ctx['db_container'], 'psql', '-U', ctx['db_admin'], '-d', 'postgres',
               '-v', 'ON_ERROR_STOP=1', data=sql.encode())
        with (folder / 'database.dump').open('rb') as f:
            docker('exec', '-i', ctx['db_container'], 'pg_restore', '-U', ctx['db_admin'],
                   '-d', 'postgres', '--create', '--exit-on-error', input_file=f, timeout=1800)
        scoped_up(ctx, folder / 'old.compose.json')
        wait_ready(ctx, folder / 'old.compose.json', ctx['old_image'], args.timeout)
        write_json(state / 'current.json', {'backup': str(folder), 'config': str(folder / 'old.compose.json'),
                                          'rolled_back': True})
        (state / 'pending.json').unlink(missing_ok=True)
        print('数据库和旧镜像已恢复；请执行业务验收。回退前数据库保留在：', recovery)


def service(args):
    with locked(args.workdir) as state:
        require(not (state / 'pending.json').exists(), '存在未完成升级，请先诊断/回退。')
        current = json.loads((state / 'current.json').read_text())
        folder = pathlib.Path(current['backup'])
        ctx = json.loads((folder / 'context.json').read_text())
        path = pathlib.Path(current['config'])
        if args.operation == 'up':
            scoped_up(ctx, path)
        elif args.operation == 'stop':
            stop(ctx, path, args.drain_seconds)
        else:
            print(run(compose(ctx, path) + ['ps', ctx['service']]).decode())


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    for action in ('check', 'upgrade'):
        s = sub.add_parser(action)
        s.add_argument('--container')
        s.add_argument('--db-container')
        s.add_argument('--health-url', default='http://127.0.0.1:4000/health/readiness')
        s.add_argument('--dedicated-database', action='store_true')
        s.add_argument('--drain-seconds', type=int, default=120)
        s.add_argument('--timeout', type=int, default=300)
    s = sub.add_parser('rollback')
    s.add_argument('--backup', required=True)
    s.add_argument('--restore-database', action='store_true')
    s.add_argument('--drain-seconds', type=int, default=120)
    s.add_argument('--timeout', type=int, default=300)
    s = sub.add_parser('service')
    s.add_argument('--workdir', required=True)
    s.add_argument('--drain-seconds', type=int, default=120)
    s.add_argument('operation', choices=['status', 'up', 'stop'])
    args = p.parse_args()
    if args.action == 'check':
        ctx, _, app = discover(args)
        meta = image_metadata()
        verify_archive(meta)
        require(health(args.health_url), '当前 readiness 检查未通过。')
        print('只读检查通过；当前版本：%s，目标版本：%s' % (ctx['old_version'], meta['version']))
        print('Compose 项目：%s，服务：%s，工作目录：%s' % (ctx['project'], ctx['service'], ctx['workdir']))
        print('LiteLLM：%s，PostgreSQL：%s' % (ctx['container'], ctx['db_container']))
        print('仍需确认：数据库独占、业务维护窗口、资源容量、恢复演练。')
    else:
        globals()[args.action](args)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as e:
        print('失败：%s' % (e if not isinstance(e, KeyboardInterrupt) else '用户中断'), file=sys.stderr)
        print('若已停止服务，不会自动恢复旧程序连接可能已迁移的数据库。检查 .litellm-upgrade/pending.json 和 README。', file=sys.stderr)
        sys.exit(1)

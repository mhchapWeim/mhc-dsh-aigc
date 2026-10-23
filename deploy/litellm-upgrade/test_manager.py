import contextlib
import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

# Native Windows has no fcntl; only this test harness substitutes the lock syscall.
if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, LOCK_UN=8, flock=lambda *a: None)
spec = importlib.util.spec_from_file_location('manager', pathlib.Path(__file__).with_name('manager.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.events = []
        self.ctx = dict(project='litellm', service='litellm', workdir=str(self.root),
                        container='app', db_container='db', db_id='db-id', database='litellm',
                        db_owner='user', db_admin='postgres', old_image='sha256:'+'1'*64,
                        old_version='1.103.0', old_reference='ghcr.io/berriai/litellm:v1.103.0', health_url='http://127.0.0.1:4000/health/readiness')
        self.meta = dict(version='v1.106.2', image_id='sha256:'+'2'*64, platform='linux/amd64',
                         archive='image.tar.gz', archive_sha256='unused')
        self.archive = self.root / 'image.tar.gz'
        self.archive.write_bytes(b'fake image')
        self.resolved = {'services': {'litellm': {'image': 'old', 'environment': {'SECRET': 'pa$word'}}}}
        self.args = types.SimpleNamespace(dedicated_database=True, health_url=self.ctx['health_url'],
                                          drain_seconds=120, timeout=10)
        self.patches = [
            patch.object(m, 'ROOT', self.root),
            patch.object(m, 'discover', return_value=(self.ctx, self.resolved, {'Mounts': [], 'Id': 'app-id'})),
            patch.object(m, 'image_metadata', return_value=self.meta),
            patch.object(m, 'verify_archive', return_value=self.archive),
            patch.object(m, 'resolve_loaded_image', return_value=self.meta['image_id']),
            patch.object(m, 'health', return_value=True),
            patch.object(m, 'docker', side_effect=self.docker),
            patch.object(m, 'run', side_effect=self.run_command),
            patch.object(m, 'inspect', side_effect=self.inspect),
            patch.object(m, 'scoped_up', side_effect=lambda *a:self.events.append(('up',str(a[1])))),
            patch.object(m, 'stop', side_effect=lambda *a:self.events.append(('stop',str(a[1])))),
            patch.object(m, 'wait_ready', side_effect=lambda *a:self.events.append(('ready',a[2]))),
            patch.object(m, 'dump', side_effect=self.dump),
        ]
        for p in self.patches:
            p.start()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda:[p.stop() for p in reversed(self.patches)])

    def inspect(self, name):
        return {'Architecture':'amd64','Os':'linux','Id':'app-id' if name=='app' else 'db-id'}

    def docker(self, *args, **kw):
        self.events.append(('docker',args))
        if args[0] == 'info':
            return json.dumps({'OSType':'linux','Architecture':'x86_64'}).encode()
        if args[0] == 'run':
            return b'1.106.2\n'
        if args[:2] == ('image','save'):
            pathlib.Path(args[3]).write_bytes(b'old image')
        return b''

    def run_command(self, args, **kw):
        if args[-3:] == ['config', '--format', 'json']:
            return pathlib.Path(args[args.index('-f')+1]).read_bytes()
        return b''

    def dump(self, ctx, path):
        self.events.append(('dump',path.name))
        path.write_bytes(b'postgres custom dump')

    def state(self, name):
        return self.root / '.litellm-upgrade' / name

    def backup(self):
        return pathlib.Path(json.loads(self.state('current.json').read_text())['backup'])

    def rollback_args(self, folder):
        return types.SimpleNamespace(backup=str(folder),restore_database=True,drain_seconds=120,timeout=10)

    def test_upgrade_backs_up_final_database_before_new_start(self):
        m.upgrade(self.args)
        self.assertLess(self.events.index(('dump','database.dump.partial')),
                        next(i for i,e in enumerate(self.events) if e[0]=='up'))
        self.assertFalse(self.state('pending.json').exists())
        self.assertEqual(json.loads((self.backup()/'new.compose.json').read_text())['services']['litellm']['image'],
                         self.meta['image_id'])
        self.assertEqual(self.resolved['services']['litellm']['environment']['SECRET'],'pa$word')

    def test_failed_preflight_backup_never_stops_production(self):
        with patch.object(m,'dump',side_effect=RuntimeError('dump failed')):
            with self.assertRaises(RuntimeError):m.upgrade(self.args)
        self.assertFalse(any(e[0]=='stop' for e in self.events))

    def test_failed_readiness_preserves_pending_without_auto_downgrade(self):
        with patch.object(m,'wait_ready',side_effect=RuntimeError('timeout')):
            with self.assertRaises(RuntimeError):m.upgrade(self.args)
        self.assertEqual(json.loads(self.state('pending.json').read_text())['phase'],'migration-may-have-started')
        self.assertEqual(sum(e[0]=='up' for e in self.events),1)

    def test_failed_final_dump_allows_old_restart_without_database_reset(self):
        def fail_final(ctx,path):
            if path.name=='database.dump.partial':raise RuntimeError('disk full')
            self.dump(ctx,path)
        with patch.object(m,'dump',side_effect=fail_final):
            with self.assertRaises(RuntimeError):m.upgrade(self.args)
        folder=pathlib.Path(json.loads(self.state('pending.json').read_text())['backup'])
        self.events.clear()
        m.rollback(self.rollback_args(folder))
        self.assertTrue(any(e[0]=='up' and e[1].endswith('old.compose.json') for e in self.events))
        self.assertFalse(any(e[0]=='docker' and 'psql' in e[1] for e in self.events))

    def test_full_rollback_saves_new_writes_and_restores_before_old_start(self):
        m.upgrade(self.args)
        folder=self.backup()
        self.events.clear()
        m.rollback(self.rollback_args(folder))
        sqlpos=next(i for i,e in enumerate(self.events) if e[0]=='docker' and 'psql' in e[1])
        restorepos=next(i for i,e in enumerate(self.events) if e[0]=='docker' and 'pg_restore' in e[1])
        uppos=next(i for i,e in enumerate(self.events) if e[0]=='up')
        self.assertLess(sqlpos,restorepos)
        self.assertLess(restorepos,uppos)
        self.assertTrue(list(folder.glob('before-rollback-*.dump')))
        with self.assertRaises(RuntimeError):m.rollback(self.rollback_args(folder))

    def test_tampered_backup_prevents_stop_and_database_reset(self):
        m.upgrade(self.args)
        folder=self.backup()
        (folder/'database.dump').write_bytes(b'tampered')
        self.events.clear()
        with self.assertRaises(RuntimeError):m.rollback(self.rollback_args(folder))
        self.assertFalse(self.events)

    def test_rollback_requires_explicit_database_restore_flag(self):
        m.upgrade(self.args)
        args=self.rollback_args(self.backup());args.restore_database=False
        self.events.clear()
        with self.assertRaises(RuntimeError):m.rollback(args)
        self.assertFalse(self.events)

    def test_interrupted_restore_can_resume_without_second_snapshot(self):
        m.upgrade(self.args)
        folder=self.backup()
        real=self.docker
        def failing(*args,**kw):
            if 'pg_restore' in args:raise RuntimeError('restore interrupted')
            return real(*args,**kw)
        with patch.object(m,'docker',side_effect=failing):
            with self.assertRaises(RuntimeError):m.rollback(self.rollback_args(folder))
        self.assertEqual(json.loads(self.state('pending.json').read_text())['phase'],'rollback-in-progress')
        self.events.clear()
        m.rollback(self.rollback_args(folder))
        self.assertFalse(any(e[0]=='dump' for e in self.events))

    def test_service_up_blocked_during_incomplete_upgrade(self):
        self.state('pending.json').parent.mkdir()
        self.state('pending.json').write_text('{}')
        with self.assertRaises(RuntimeError):
            m.service(types.SimpleNamespace(workdir=str(self.root),operation='up',drain_seconds=120))

    def test_upgrade_requires_dedicated_database_declaration(self):
        self.args.dedicated_database=False
        with self.assertRaises(RuntimeError):m.upgrade(self.args)
        self.assertFalse(any(e[0]=='stop' for e in self.events))

    def test_changed_container_prevents_stale_upgrade(self):
        with patch.object(m,'inspect',return_value={'Id':'different-app'}):
            with self.assertRaises(RuntimeError):m.upgrade(self.args)
        self.assertFalse(any(e[0]=='stop' for e in self.events))

    def test_compose_snapshot_mismatch_never_stops_production(self):
        with patch.object(m,'run',return_value=b'{"services": {}}'):
            with self.assertRaises(RuntimeError):m.upgrade(self.args)
        self.assertFalse(any(e[0]=='stop' for e in self.events))


class EncodingTests(unittest.TestCase):
    def test_sql_quoting(self):
        self.assertEqual(m.sql_ident('a"b'),'"a""b"')
        self.assertEqual(m.sql_literal("a'b"),"'a''b'")

    def test_health_rejects_non_loopback_and_https_redirect_targets(self):
        with self.assertRaises(RuntimeError):m.health('http://192.168.10.30/health')
        with self.assertRaises(RuntimeError):m.health('https://example.com/health')


class BackupCommandTests(unittest.TestCase):
    def test_restore_list_uses_standard_input_without_dev_stdin_filename(self):
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'fixture.dump';path.write_bytes(b'PGDMPfixture')
            with patch.object(m,'docker',return_value=b'') as call:
                m.verify_dump({'db_container':'db'},path)
                self.assertEqual(call.call_args.args,('exec','-i','db','pg_restore','--list'))
                self.assertIsNotNone(call.call_args.kwargs['input_file'])

    def test_dump_rejects_non_archive_output(self):
        with tempfile.TemporaryDirectory() as folder:
            def corrupt(*args,**kw):kw['output'].write(b'not a dump')
            with patch.object(m,'docker',side_effect=corrupt):
                with self.assertRaises(RuntimeError):
                    m.dump({'db_container':'db','db_admin':'postgres','database':'dedicated'},pathlib.Path(folder)/'bad.dump')

    def test_failed_command_retains_only_stderr_in_private_log(self):
        with tempfile.TemporaryDirectory() as folder:
            result=types.SimpleNamespace(returncode=1,stderr=b'pg_restore: bad header',stdout=b'secret body')
            with patch.object(m,'ROOT',pathlib.Path(folder)),patch.object(m.subprocess,'run',return_value=result):
                with self.assertRaisesRegex(RuntimeError,'pg_restore'):
                    m.run(['docker','exec','db','pg_restore','--list'])
            logs=list(pathlib.Path(folder).glob('.upgrade-errors/*.log'))
            self.assertEqual(len(logs),1)
            self.assertEqual(logs[0].read_bytes(),b'pg_restore: bad header')


class MasterKeyTests(unittest.TestCase):
    def test_safe_key_passes_without_printing_credentials(self):
        app={'Name':'/app','Config':{'Entrypoint':[],'Cmd':['--config','/app/config.yaml']}}
        with patch.object(m,'docker',return_value=b'safe\n') as call:
            m.check_master_key(app)
            self.assertEqual(call.call_args.args[-1],'["--config", "/app/config.yaml"]')

    def test_unsafe_key_is_rejected_before_upgrade(self):
        app={'Name':'/app','Config':{'Cmd':[]}}
        with patch.object(m,'docker',return_value=b'unsafe\n'):
            with self.assertRaises(RuntimeError):m.check_master_key(app)


class LoadedImageTests(unittest.TestCase):
    def setUp(self):
        self.meta={'image':'ghcr.io/berriai/litellm:v1.106.2','image_id':'sha256:'+'1'*64}
        self.config={'architecture':'amd64','os':'linux','rootfs':{'diff_ids':['sha256:'+'a'*64]},
                     'config':{'Env':['SAFE=test'],'Cmd':['--port','4000'],'Entrypoint':['litellm']}}
        self.target={'Id':'sha256:'+'2'*64,'Architecture':'amd64','Os':'linux',
                     'RootFS':{'Layers':self.config['rootfs']['diff_ids']},'Config':self.config['config']}

    def resolve(self):
        with patch.object(m,'archive_config',return_value=self.config), \
             patch.object(m,'docker',return_value=json.dumps([self.target]).encode()) as call:
            result=m.resolve_loaded_image(self.meta,pathlib.Path('fixture.tar.gz'))
            self.assertEqual(call.call_args.args,('image','inspect',self.meta['image']))
            return result

    def test_containerd_local_id_can_differ_from_registry_config_digest(self):
        self.assertEqual(self.resolve(),self.target['Id'])

    def test_legacy_engine_with_config_digest_as_id_is_also_supported(self):
        self.target['Id']=self.meta['image_id']
        self.assertEqual(self.resolve(),self.meta['image_id'])

    def test_different_image_layers_are_rejected(self):
        self.target['RootFS']['Layers']=['sha256:'+'b'*64]
        with self.assertRaises(RuntimeError):self.resolve()

    def test_different_startup_configuration_is_rejected(self):
        self.target['Config']=dict(self.config['config'],Entrypoint=['unexpected'])
        with self.assertRaises(RuntimeError):self.resolve()

    def test_wrong_platform_is_rejected(self):
        self.target['Architecture']='arm64'
        with self.assertRaises(RuntimeError):self.resolve()

    def test_unresolved_config_is_rejected_before_upgrade(self):
        app={'Name':'/app','Config':{'Cmd':[]}}
        with patch.object(m,'docker',return_value=b'unknown\n'):
            with self.assertRaises(RuntimeError):m.check_master_key(app)


if __name__=='__main__':
    unittest.main(verbosity=2)

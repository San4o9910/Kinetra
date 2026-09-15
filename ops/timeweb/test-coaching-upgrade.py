import importlib.util,unittest,tempfile,pathlib,os,sys,io,json
from unittest.mock import patch
from types import SimpleNamespace
p=pathlib.Path(__file__).with_name('coaching-upgrade-host.py');spec=importlib.util.spec_from_file_location('upgrade',p);u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
class Checks(unittest.TestCase):
 def test_malformed_request_never_runs_host_commands(self):
  stream=io.TextIOWrapper(io.BytesIO(b'{"app":"wrong"}'))
  with patch.object(sys,'stdin',stream),patch.object(u,'command') as cmd,patch.object(u.os,'geteuid',return_value=0),patch.object(u.resource,'setrlimit'),patch.object(u.os,'umask'),patch('sys.stdout',new_callable=io.StringIO) as out:
   self.assertEqual(u.main(),1);cmd.assert_not_called();self.assertEqual(json.loads(out.getvalue())['error'],'INPUT_INVALID')
 def test_private_reader_rejects_symlink_and_loose_mode(self):
  with tempfile.TemporaryDirectory() as folder:
   p=pathlib.Path(folder)/'file';p.write_bytes(b'private');p.chmod(0o600);self.assertEqual(u.private(p),b'private')
   link=p.with_name('link');link.symlink_to(p)
   with self.assertRaises(u.Failure):u.private(link)
   p.chmod(0o644)
   with self.assertRaises(u.Failure):u.private(p)
 def test_atomic_configuration_preserves_private_mode(self):
  with tempfile.TemporaryDirectory() as folder:
   p=pathlib.Path(folder)/'env';u.write(p,b'old');u.replace_private(p,b'new');self.assertEqual(u.private(p),b'new');self.assertEqual(list(pathlib.Path(folder).iterdir()),[p])
 def test_environment_rejects_duplicate_keys(self):
  with self.assertRaises(u.Failure):u.env(b'A=1\nA=2\n')
 def test_preflight_rejects_foreign_containers(self):
  with patch.object(u,'command',return_value=b'one two'):
   with self.assertRaisesRegex(u.Failure,'UNEXPECTED_CONTAINERS'):u.inspect()
 def test_unhealthy_release_preserves_database_identity(self):
  with patch.object(u,'inspect',return_value={'postgres':{'Id':'changed','State':{'Running':True}}}):
   with self.assertRaisesRegex(u.Failure,'DATABASE_CHANGED'):u.healthy(u.OLD_IMAGES,'expected')
 def test_migration_public_mount_is_readable_under_private_umask(self):
  with tempfile.TemporaryDirectory() as folder:
   work=pathlib.Path(folder);old=os.umask(0o077)
   try:
    with patch.object(u,'command',return_value=b'MIGRATIONS_AND_GRANTS=PASS') as run,patch.object(u.subprocess,'run',return_value=SimpleNamespace(returncode=1)):
     u.migrate('image','pg',{'014_test.sql':'hash'},b'SELECT 1',work,'network','/ca.crt')
     self.assertEqual((work/'public').stat().st_mode&0o777,0o755)
     self.assertEqual((work/'public/migrations.json').stat().st_mode&0o777,0o644)
     self.assertIn('type=bind,source='+str(work/'public')+',target=/release,readonly',run.call_args.args[0])
     self.assertNotIn('type=bind,source='+str(work)+',target=/release,readonly',run.call_args.args[0])
   finally:os.umask(old)
if __name__=='__main__':unittest.main()

import importlib.util,unittest,tempfile,pathlib,os,sys,io,json
from unittest.mock import patch
from types import SimpleNamespace
p=pathlib.Path(__file__).with_name('trainer-signup-upgrade-host.py');spec=importlib.util.spec_from_file_location('upgrade',p);u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
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
 def healthy_containers(self):
  return {'postgres':{'Id':'pg','State':{'Running':True}},**{key:{'Config':{'Image':image},'State':{'Running':True,'Health':{'Status':'healthy'}},'HostConfig':{'ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true']},'NetworkSettings':{'Ports':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'8080'}]}}} for key,image in u.OLD_IMAGES.items()}}
 def test_http_startup_reset_waits_for_actual_acceptance(self):
  current=self.healthy_containers()
  with patch.object(u,'inspect',return_value=current),patch.object(u,'get',side_effect=[ConnectionResetError(),(200,b''),(404,b''),(401,b''),(200,b'')]),patch.object(u.time,'sleep') as sleep:
   self.assertEqual(u.healthy(u.OLD_IMAGES,'pg'),current);sleep.assert_called_once_with(2)
 def test_wrong_auth_boundary_is_not_retried_or_accepted(self):
  with patch.object(u,'inspect',return_value=self.healthy_containers()),patch.object(u,'get',side_effect=[(200,b''),(404,b''),(200,b''),(200,b'')]),patch.object(u.time,'sleep') as sleep:
   with self.assertRaisesRegex(u.Failure,'HTTP_ACCEPTANCE_FAILED'):u.healthy(u.OLD_IMAGES,'pg')
   sleep.assert_not_called()
if __name__=='__main__':unittest.main()

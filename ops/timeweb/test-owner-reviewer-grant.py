import importlib.util,json,pathlib,unittest
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('owner-reviewer-grant-host.py');spec=importlib.util.spec_from_file_location('grant',p);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
class OwnerMatch(unittest.TestCase):
 def test_missing_and_ambiguous_accounts_are_refused(self):
  for rows in ([],[{'id':'one'},{'id':'two'}]):
   with self.subTest(rows=rows),patch.object(g,'node',return_value=json.dumps(rows).encode()):
    with self.assertRaisesRegex(g.Failure,'EXACT_ACCOUNT_NOT_FOUND'):g.match('backend')
 def test_exact_existing_uuid_and_boolean_required(self):
  valid={'id':'00000000-0000-4000-8000-000000000001','reviewer':False}
  with patch.object(g,'node',return_value=json.dumps([valid]).encode()):self.assertEqual(g.match('backend'),valid)
  for bad in (dict(valid,id='not-an-id'),dict(valid,reviewer='false')):
   with patch.object(g,'node',return_value=json.dumps([bad]).encode()):
    with self.assertRaisesRegex(g.Failure,'ACCOUNT_MATCH_INVALID'):g.match('backend')
if __name__=='__main__':unittest.main()

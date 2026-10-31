from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from template_manager import library,roster
from test_metadata import account_book


class DeleteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'library'
        self.source=Path(self.tmp.name)/'source.xlsm';self.source.write_bytes(account_book(account='ATEST001'))
        self.first=self.add('v1');self.second=self.add('v2')

    def tearDown(self):self.tmp.cleanup()

    def add(self,version):
        return library.run(SimpleNamespace(command='add',library=str(self.root),source=str(self.source),shop='测试店',marketplace='AE',category='行李箱',version=version))

    def rows(self):
        return library.run(SimpleNamespace(command='list',library=str(self.root),marketplace=None,category=None))

    def test_remove_only_selected_version_and_keep_shop_directory(self):
        result=library.delete_template(self.root,self.first['id'])
        self.assertTrue(result['deleted']);self.assertFalse(result['cleanup_pending'])
        self.assertFalse((self.root/'files'/self.first['file']).exists())
        self.assertEqual([r['id'] for r in self.rows()],[self.second['id']])
        self.assertEqual(library.verified(self.root,self.rows()[0]),self.source.read_bytes())
        self.assertTrue(roster.targets(self.root,'AE')[0]['can_generate'])
        db=library.connect(self.root)
        self.assertIsNone(db.execute('SELECT * FROM template_metadata WHERE id=?',(self.first['id'],)).fetchone());db.close()

    def test_commit_failure_restores_file_and_record(self):
        connection=library.connect(self.root)
        class BrokenCommit:
            def __getattr__(self,key):return getattr(connection,key)
            def commit(self):raise OSError('simulated commit failure')
        with patch.object(library,'connect',return_value=BrokenCommit()):
            with self.assertRaises(OSError):library.delete_template(self.root,self.first['id'])
        self.assertEqual(len(self.rows()),2)
        self.assertEqual((self.root/'files'/self.first['file']).read_bytes(),self.source.read_bytes())

    def test_locked_file_does_not_delete_index(self):
        with patch.object(Path,'rename',side_effect=PermissionError('locked')):
            with self.assertRaises(PermissionError):library.delete_template(self.root,self.first['id'])
        self.assertEqual(len(self.rows()),2)

    def test_missing_file_can_remove_broken_entry_and_unknown_id_is_rejected(self):
        (self.root/'files'/self.first['file']).unlink()
        self.assertTrue(library.delete_template(self.root,self.first['id'])['deleted'])
        with self.assertRaisesRegex(ValueError,'已经删除'):library.delete_template(self.root,self.first['id'])

    def test_bulk_removes_only_selected_and_checks_all_ids_first(self):
        third=self.add('v3')
        with self.assertRaisesRegex(ValueError,'已经删除'):
            library.delete_templates(self.root,[self.first['id'],'missing'])
        self.assertEqual(len(self.rows()),3)
        result=library.delete_templates(self.root,[self.first['id'],self.second['id']])
        self.assertEqual(result['count'],2)
        self.assertEqual([r['id'] for r in self.rows()],[third['id']])

    def test_bulk_commit_failure_restores_all_files(self):
        connection=library.connect(self.root)
        class BrokenCommit:
            def __getattr__(self,key):return getattr(connection,key)
            def commit(self):raise OSError('simulated commit failure')
        with patch.object(library,'connect',return_value=BrokenCommit()):
            with self.assertRaises(OSError):library.delete_templates(self.root,[self.first['id'],self.second['id']])
        self.assertEqual(len(self.rows()),2)
        for row in self.rows():self.assertEqual(library.verified(self.root,row),self.source.read_bytes())


if __name__=='__main__':unittest.main()

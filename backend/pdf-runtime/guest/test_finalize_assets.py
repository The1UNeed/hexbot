import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("finalizer", Path(__file__).with_name("finalize-assets.py"))
finalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(finalizer)


class FinalizationTransaction(unittest.TestCase):
    def fixture(self, root):
        assets = root/'prototype'
        assets.mkdir()
        files = {}
        for name in ['kernel','initramfs','rootfs']:
            (assets/name).write_bytes(name.encode())
            files[name] = hashlib.sha256(name.encode()).hexdigest()
        package = {'name':'linux-virt','version':'1-r0','repository':'main','origin':['linux-lts'],'sourceCommit':['a'*40]}
        snapshot = finalizer.verifier.owned_snapshot(finalizer.HERE)
        config = {'sha256':hashlib.sha256(b'config').hexdigest(),'bytes':6}
        provenance = {'version':1,'architecture':'aarch64','status':'prototype-not-release-ready','packages':[package],
                      'sourceFiles':snapshot,'kernelConfig':config,
                      'sourceArchiveComplete':False,'noticesComplete':False}
        (assets/'manifest.json').write_text(json.dumps({'version':1,'architecture':'aarch64','files':files}))
        (assets/'PROVENANCE.json').write_text(json.dumps(provenance))
        (assets/'kernel.provenance.json').write_text('{}')
        (root/'lock.json').write_text(json.dumps({'architectures':{'aarch64':{'packages':[package]}}}))
        version = '1.2.3'
        filename = 'hexbot-pdf-sources-1.2.3-aarch64-'+'f'*64+'.tar.gz'
        source = {'version':1,'architecture':'aarch64','completeCorrespondingSourceArchive':False,
                  'archive':{'file':filename,'sha256':'f'*64,'url':'https://updates.hexbot.app/daemon/native/1.2.3/macos-aarch64/'+filename},'outstanding':[],
                  'materials':[{'path':'worker/'+name,'sha256':sha,'role':'source','component':'hexbot-pdf-worker','bytes':12} for name,sha in snapshot.items()]+[
                               {'path':'runtime.config','sha256':config['sha256'],'bytes':6,'role':'config','component':'alpine:main:linux-lts:'+'a'*40}]}
        (root/'SOURCES.json').write_text(json.dumps(source))
        (root/'THIRD_PARTY_NOTICES').write_bytes(b'actual full notices')
        return SimpleNamespace(assets=assets,out=root/'ready',sources=root/'SOURCES.json',notices=root/'THIRD_PARTY_NOTICES',
                               archive=root/filename,lock=root/'lock.json',arch='aarch64',version=version)

    def test_success_creates_new_ready_records_without_mutating_prototype(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            with patch.object(finalizer.verifier,'verify_materials',return_value={'verified':True}), patch.object(finalizer.verifier,'notice_bytes',return_value=b'actual full notices'):
                finalizer.finalize(args)
            self.assertFalse(json.loads((args.assets/'PROVENANCE.json').read_text())['sourceArchiveComplete'])
            self.assertFalse(json.loads(args.sources.read_text())['completeCorrespondingSourceArchive'])
            self.assertTrue(json.loads((args.out/'PROVENANCE.json').read_text())['sourceArchiveComplete'])
            self.assertTrue(json.loads((args.out/'SOURCES.json').read_text())['completeCorrespondingSourceArchive'])

    def test_source_failure_or_notice_mismatch_publishes_nothing(self):
        for invalid_notice in [False,True]:
            with tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                verify = patch.object(finalizer.verifier,'verify_materials',return_value={'verified':True}) if invalid_notice else patch.object(finalizer.verifier,'verify_materials',side_effect=ValueError('actual source missing'))
                with verify, patch.object(finalizer.verifier,'notice_bytes',return_value=b'not matching'):
                    with self.assertRaises(ValueError):finalizer.finalize(args)
                self.assertFalse(args.out.exists())
                self.assertFalse(json.loads((args.assets/'PROVENANCE.json').read_text())['sourceArchiveComplete'])

    def test_unreviewed_source_gap_cannot_be_promoted_by_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            sources = json.loads(args.sources.read_text())
            sources['completeCorrespondingSourceArchive'] = True
            sources['outstanding'] = ['unreviewed material gap']
            args.sources.write_text(json.dumps(sources))
            with self.assertRaisesRegex(ValueError,'review remains incomplete'):finalizer.finalize(args)
            self.assertFalse(args.out.exists())

    def test_unknown_review_state_is_not_an_explicit_empty_review_list(self):
        for value in [None,'',{},False]:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                sources = json.loads(args.sources.read_text())
                sources['outstanding'] = value
                args.sources.write_text(json.dumps(sources))
                with self.assertRaisesRegex(ValueError,'review remains incomplete'):
                    finalizer.finalize(args)
                self.assertFalse(args.out.exists())

    def test_output_cannot_modify_the_immutable_input_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            args.out = args.assets/'ready'
            with self.assertRaisesRegex(ValueError,'outside the immutable input'):
                finalizer.finalize(args)
            self.assertFalse(args.out.exists())

    def test_different_runtime_version_cannot_promote_an_old_companion(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            args.version = '2.0.0'
            with self.assertRaisesRegex(ValueError,'exact runtime version'):
                finalizer.finalize(args)
            self.assertFalse(args.out.exists())

    def test_input_changing_during_copy_cannot_publish_a_stale_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            original = finalizer.verifier.copy_regular
            def copy_file(source,destination,limit):
                if source.name == 'rootfs':source.write_bytes(b'concurrent replacement')
                return original(source,destination,limit)
            with patch.object(finalizer.verifier,'verify_materials',return_value={'verified':True}), patch.object(finalizer.verifier,'notice_bytes',return_value=b'actual full notices'), patch.object(finalizer.verifier,'copy_regular',side_effect=copy_file):
                with self.assertRaisesRegex(ValueError,'changed while finalizing'):finalizer.finalize(args)
            self.assertFalse(args.out.exists())
            self.assertFalse(json.loads((args.assets/'PROVENANCE.json').read_text())['sourceArchiveComplete'])

    def test_new_source_cannot_be_associated_with_an_older_build_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            snapshot = finalizer.verifier.owned_snapshot(finalizer.HERE)
            snapshot['build.rs'] = 'a'*64
            with patch.object(finalizer.verifier,'owned_snapshot',return_value=snapshot):
                with self.assertRaisesRegex(ValueError,'complete current worker source set'):
                    finalizer.finalize(args)
            self.assertFalse(args.out.exists())

    def test_concurrent_empty_output_directory_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            publish = finalizer.publish_new
            def competing_output(source,destination):
                destination.mkdir()
                return publish(source,destination)
            with patch.object(finalizer.verifier,'verify_materials',return_value={'verified':True}), patch.object(finalizer.verifier,'notice_bytes',return_value=b'actual full notices'), patch.object(finalizer,'publish_new',side_effect=competing_output):
                with self.assertRaises(FileExistsError):finalizer.finalize(args)
            self.assertTrue(args.out.is_dir())
            self.assertEqual(list(args.out.iterdir()),[])


if __name__ == '__main__':
    unittest.main()

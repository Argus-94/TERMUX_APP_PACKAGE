from __future__ import annotations
import gzip,hashlib,pathlib,sys,tempfile,unittest
KIT=pathlib.Path(__file__).resolve().parents[1]; sys.path.insert(0,str(KIT))
import validate_nodejs_npm_feed as feed
class FeedTests(unittest.TestCase):
 def test_exact_index_checks_hash_path_and_compressed_bytes(self):
  with tempfile.TemporaryDirectory() as td:
   root=pathlib.Path(td); base=root/"dists/stable/main/binary-aarch64"; base.mkdir(parents=True)
   deb=root/"pool/main/demo/demo.deb"; deb.parent.mkdir(parents=True); deb.write_bytes(b"debdata")
   specs={"demo":{"version":"1","architecture":"aarch64"}}; files={"demo":deb}; old=feed.COUNT; feed.COUNT=1
   try:
    fields={"Package":"demo","Version":"1","Architecture":"aarch64","Filename":"pool/main/demo/demo.deb","Size":"7","SHA256":hashlib.sha256(b"debdata").hexdigest()}
    def test():
     raw=("\n".join(k+": "+v for k,v in fields.items())+"\n\n").encode(); (base/"Packages").write_bytes(raw); (base/"Packages.gz").write_bytes(gzip.compress(raw)); return feed.validate_indexes(root,files,specs)
    self.assertIn("demo",test()); fields["Filename"]="../demo.deb"
    with self.assertRaisesRegex(ValueError,"INDEX_FILENAME_TRAVERSAL"): test()
    fields["Filename"]="pool/main/demo/demo.deb"; fields["SHA256"]="0"*64
    with self.assertRaisesRegex(ValueError,"INDEX_PACKAGE_SHA256_MISMATCH"): test()
    (base/"Packages.gz").write_bytes(b"invalid")
    with self.assertRaisesRegex(ValueError,"PACKAGES_GZIP_INVALID"): feed.validate_indexes(root,files,specs)
   finally: feed.COUNT=old
 def test_provider_control_is_locked(self):
  self.assertEqual(feed.NPM_DEPENDS,"nodejs | nodejs-lts")
  feed.validate_npm_provider("nodejs | nodejs-lts")
  for bad in ("nodejs", "nodejs-lts", "nodejs | nodejs-current"):
   with self.assertRaisesRegex(ValueError,"NPM_DEPENDS_NOT_EXACT"): feed.validate_npm_provider(bad)
  with self.assertRaisesRegex(ValueError,"NPM_DEPENDS_NOT_EXACT"): feed.validate_npm_provider("nodejs, openssl")
if __name__=="__main__": unittest.main()

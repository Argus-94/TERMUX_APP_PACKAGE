#!/usr/bin/env node
// Generate source only into an explicitly supplied verification/staging directory. Does not change build settings.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/aib-v493-native-generate.cjs <staging-java-directory>');
const file = path.join(root, 'plugins/withTermuxBridge.js');
const generated = new Module(file, module);
generated.filename = file;
generated.paths = Module._nodeModulePaths(path.dirname(file));
generated._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports={moduleKotlin,packageKotlin,embeddedTerminalViewKotlin};\n', file);
const pkg = 'com.karat.aibuilder';
const out = path.resolve(process.argv[2]);
if (out === root || out.startsWith(root + path.sep)) throw new Error('Staging output must be outside the source release');
fs.mkdirSync(out, { recursive: true });
const sources = {
  'TermuxBridgeModule.kt': generated.exports.moduleKotlin(pkg),
  'TermuxBridgePackage.kt': generated.exports.packageKotlin(pkg),
  'TermuxEmbeddedTerminalViewManager.kt': generated.exports.embeddedTerminalViewKotlin(pkg),
  'AibEmbeddedTermuxBootstrapInstaller.kt': require(path.join(root, 'plugins/termuxBootstrapInstallerKotlin.js'))(pkg, JSON.parse(fs.readFileSync(path.join(root, 'assets/termux-bootstrap/termux-bootstrap-aarch64.zip.provenance.json')))),
  'AibCandidateFullFeed.kt': require(path.join(root, 'plugins/candidateFullFeed.js')).candidateFullKotlin(pkg, root),
  'AibCandidateFeedProbe.kt': require(path.join(root, 'plugins/candidateFeedProbe.js')).candidateProbeKotlin(pkg),
};
const hashes = {};
for (const [name, source] of Object.entries(sources)) {
  fs.writeFileSync(path.join(out, name), source);
  hashes[name] = crypto.createHash('sha256').update(source).digest('hex');
}
console.log(JSON.stringify({ sourceRelease: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, output: out, sha256: hashes }, null, 2));

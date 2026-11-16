'use strict';

// Android's asset merger treats a trailing .gz as a transparent compressed
// representation of the same path without .gz. Keep signed bytes unchanged,
// but encode that suffix in the APK namespace; restore logical APT paths only
// when copying into the app's verified private staging tree.
function candidateAssetPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\\'))) {
    throw new Error('candidate_asset_relative_path_invalid');
  }
  return rel.endsWith('.gz') ? rel + '.aibasset' : rel;
}

function assertUniqueCandidateAssetPaths(rels) {
  const seen = new Set();
  for (const rel of rels) {
    const asset = candidateAssetPath(rel);
    const normalized = asset.endsWith('.gz') ? asset.slice(0, -3) : asset;
    if (seen.has(normalized)) throw new Error('candidate_asset_path_collision:' + rel);
    seen.add(normalized);
  }
}

// Use the same suffix rule in both generated native stagers. The original rel
// remains authoritative for output filenames, size, SHA and signature checks.
const candidateAssetPathKotlin = `    private fun assetPath(rel: String): String = if (rel.endsWith(".gz")) rel + ".aibasset" else rel`;

module.exports = { candidateAssetPath, assertUniqueCandidateAssetPaths, candidateAssetPathKotlin };

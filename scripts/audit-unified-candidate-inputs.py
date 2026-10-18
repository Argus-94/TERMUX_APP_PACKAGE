#!/usr/bin/env python3
"""Inventory-only coexistence preflight. Never assembles or authorizes a feed."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = 'unified-candidate-input-lock.json'
PROFILES = {
    'make': ('candidate-package-set.json', 'package-feed-candidate.yml', ['make']),
    'gh': ('gh-candidate-package-set.json', 'package-feed-candidate.yml', ['gh']),
    **{name: (name + '-candidate-package-set.json', name + '-package-candidate.yml', roots)
       for name, roots in {
           'git': ['git'], 'curl': ['curl'], 'wget': ['wget'],
           'pkg-config': ['pkg-config'], 'python': ['python'],
           'nodejs-npm': ['nodejs', 'npm'], 'openjdk17': ['openjdk-17'],
           'cmake-ninja': ['cmake', 'ninja'],
       }.items()},
}

class GateError(Exception):
    pass

def require(ok, code):
    if not ok:
        raise GateError(code)

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

source = module('unified_source', 'resolve-pinned-termux-recipe-closure.py')
deps = module('unified_dependencies', 'verify-candidate-dependency-closure.py')
effective = module('unified_effective', 'effective-candidate-recipes.py')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def source_identity(node, source_root):
    version = node['sourceVersionExpression']
    # Pinned ncurses/libandroid-support use a version array; Debian uses its
    # first literal element. Never evaluate shell or accept arbitrary expressions.
    if version.startswith('('):
        version = version[1:]
    require(re.fullmatch(r'[0-9][A-Za-z0-9.+:~_-]*', version) is not None,
            'SOURCE_VERSION_EXPRESSION_UNSUPPORTED:' + node['name'])
    revision = node['sourceRevisionExpression']
    require(revision is None or re.fullmatch(r'[0-9]+', revision) is not None,
            'SOURCE_REVISION_EXPRESSION_UNSUPPORTED:' + node['name'])
    version += '-' + revision if revision and revision != '0' else ''
    independent = source.shell_assignment(source_root / node['recipePath'], 'TERMUX_PKG_PLATFORM_INDEPENDENT')
    if node['subpackagePath']:
        override = source.shell_assignment(source_root / node['subpackagePath'], 'TERMUX_SUBPKG_PLATFORM_INDEPENDENT')
        if override is not None:
            independent = override
    require(independent in (None, 'true', 'false'), 'SOURCE_ARCH_EXPRESSION_UNSUPPORTED:' + node['name'])
    return {'version': version, 'architecture': 'all' if independent == 'true' else 'aarch64'}

def check_dependencies(packages, groups, profile):
    for name, relations in groups.items():
        for group in relations:
            require(any(deps.candidate_satisfies(
                (r['name'], r['qualifier'], r['operator'],
                 packages[name]['version'] if r['version'] == 'parent-build-version' else r['version']), packages)
                for r in group), 'SOURCE_DEPENDENCY_HOLE:' + profile + ':' + name)

def inventory(repo, source_root):
    scope = source.load_scope(repo / 'termux-package-source-scope.json')
    revision, _ = source.git_source_state(source_root)
    require(revision == scope['sourceCommit'], 'SOURCE_COMMIT_MISMATCH')
    profiles, union = {}, {}
    target = None
    for family, (manifest_path, workflow, roots) in sorted(PROFILES.items()):
        manifest = json.loads((repo / manifest_path).read_text())
        require(manifest['channel'] == 'candidate-only', 'CHANNEL_NOT_CANDIDATE_ONLY')
        require(manifest['releaseGate']['publicationAllowed'] is False,
                'PUBLICATION_MUST_REMAIN_DISABLED')
        modeled = {k: manifest['target'][k] for k in (
            'applicationId', 'architecture', 'modeledDataDir', 'modeledPrefix')}
        require(modeled == {
            'applicationId': 'com.karat.aibuilder', 'architecture': 'aarch64',
            'modeledDataDir': '/data/user/0/com.karat.aibuilder',
            'modeledPrefix': '/data/user/0/com.karat.aibuilder/files/usr'}, 'TARGET_MISMATCH')
        target = modeled
        choice = scope.get('dependencyChoices', {}).get(family + '-candidate', [])
        closure = source.Resolver(source_root, choice).resolve(roots)
        nodes = {p['name']: p for p in closure['packages']}
        available = {}
        for p in manifest['packages']:
            name = p['name']
            require(name not in available, 'PROFILE_DUPLICATE_PACKAGE:' + family + ':' + name)
            available[name] = {'version': p['version'], 'architecture': p['architecture']}
        require(set(nodes) == set(available), 'PROFILE_SOURCE_SET_MISMATCH:' + family)
        for name, node in nodes.items():
            require(available[name] == source_identity(node, source_root),
                    'SOURCE_IDENTITY_MISMATCH:' + family + ':' + name)
        groups = {n: p['dependencyGroups'] for n, p in nodes.items()}
        check_dependencies(available, groups, family)
        src = manifest.get('source', {})
        commit = src.get('commit', manifest['packages'][0].get('sourceCommit'))
        builder = src.get('builderImage', manifest['packages'][0].get('builderImage'))
        require(commit == revision, 'PROFILE_SOURCE_COMMIT_MISMATCH:' + family)
        require(builder == 'ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9',
                'PROFILE_BUILDER_MISMATCH:' + family)
        modifications = manifest.get('buildModifications', {})
        patches = []
        if modifications.get('patchPath'):
            patches.append((modifications['patchPath'], modifications['patchSha256']))
        for p in manifest['packages']:
            if p.get('localRecipePatchPath'):
                patches.append((p['localRecipePatchPath'], p['localRecipePatchSha256']))
        for path, sha in patches:
            require(digest(repo / path) == sha, 'LOCAL_PATCH_HASH_MISMATCH:' + family)
        inputs = effective.effective_inputs(repo, source_root, nodes, patches)
        profiles[family] = {
            'manifest': manifest_path, 'manifestSha256': digest(repo / manifest_path),
            'workflow': '.github/workflows/' + workflow,
            'workflowSha256': digest(repo / '.github/workflows' / workflow),
            'rootPackages': roots, 'packageCount': len(nodes),
            'sourceCommit': commit, 'builderImage': builder,
            'localPatches': [{'path': p, 'sha256': h} for p, h in patches],
            'buildModifications': modifications,
            'signedBinaryBundle': None,
        }
        for p in manifest['packages']:
            name = p['name']; node = nodes[name]
            require(p['recipePath'] == node['recipePath'] and p['recipeSha256'] == node['recipeSha256'],
                    'RECIPE_PROVENANCE_MISMATCH:' + family + ':' + name)
            for field in ('subpackagePath', 'subpackageSha256'):
                if field in p:
                    require(p[field] == node[field], 'SUBPACKAGE_PROVENANCE_MISMATCH:' + family + ':' + name)
            if 'dependencyGroups' in p:
                require(p['dependencyGroups'] == node['dependencyGroups'],
                        'SOURCE_DEPENDENCY_METADATA_MISMATCH:' + family + ':' + name)
            item = union.setdefault(name, {
                'name': name, **available[name], 'recipePath': node['recipePath'],
                'recipeSha256': node['recipeSha256'],
                'sourceVersionExpression': node['sourceVersionExpression'],
                'sourceRevisionExpression': node['sourceRevisionExpression'],
                'subpackagePath': node['subpackagePath'], 'subpackageSha256': node['subpackageSha256'],
                'dependencyGroups': node['dependencyGroups'], 'occurrences': [],
            })
            require(all(item[k] == available[name][k] for k in ('version', 'architecture')),
                    'DUPLICATE_IDENTITY_DISAGREES:' + name)
            require(item['recipeSha256'] == node['recipeSha256'] and item['dependencyGroups'] == node['dependencyGroups'],
                    'DUPLICATE_SOURCE_DISAGREES:' + name)
            item['occurrences'].append({'profile': family, 'binarySha256': None, **inputs[name]})
    check_dependencies(union, {n: p['dependencyGroups'] for n, p in union.items()}, 'union')
    duplicated = sorted(n for n, p in union.items() if len(p['occurrences']) > 1)
    divergent = effective.divergent_duplicates(union.values())
    return {
        'schemaVersion': 2, 'channel': 'candidate-only', 'inventoryOnly': True,
        'aggregateReady': False, 'publicationAllowed': False,
        'sourceCommit': revision, 'target': target,
        'scopeSha256': digest(repo / 'termux-package-source-scope.json'),
        'resolverSha256': digest(ROOT / 'scripts/resolve-pinned-termux-recipe-closure.py'),
        'dependencyValidatorSha256': digest(ROOT / 'scripts/verify-candidate-dependency-closure.py'),
        'effectiveRecipeValidatorSha256': digest(ROOT / 'scripts/effective-candidate-recipes.py'),
        'profiles': profiles, 'packages': [union[n] for n in sorted(union)],
        'effectiveRecipeContextScope': 'SHA-256 of compact sorted JSON mapping paths to SHA-256: parent build.sh and all existing sibling *.subpackage.sh after ordered manifest overlays; not all build flags, source archives, upstream patches, environment or binary ABI.',
        'summary': {'profileCount': len(profiles), 'occurrenceCount': sum(p['packageCount'] for p in profiles.values()),
                    'uniquePackageCount': len(union), 'duplicateNames': duplicated,
                    'effectiveRecipeDivergentDuplicateNames': divergent,
                    'sourceDependencyClosure': 'PASS; per-profile and union; not binary control or ELF evidence'},
        'duplicatePolicy': 'No provider selected. Same name/version/architecture is NOT binary equivalence. Require identical SHA-256 for automatic deduplication; otherwise stop for reviewed canonical rebuild and re-audit of every consumer.',
        'effectiveRecipeDivergences': [{
            'package': name, 'upstreamRecipeSha256': union[name]['recipeSha256'],
            'occurrences': union[name]['occurrences'],
            'resolution': 'UNRESOLVED; no canonical provider selected; reviewed common rebuild and consumer re-audits required',
        } for name in divergent],
        'binaryChecks': {k: 'NOT_RUN; signed binary inputs unavailable' for k in (
            'signedInputProvenance', 'exactDebHashes', 'controlDependsPreDepends',
            'conflictsBreaksReplacesProvides', 'payloadPathCollisions', 'elfProviderClosure',
            'aggregateSignedAptSimulation')},
        'requiredInputs': [
            'Fresh CI-only signed bundles for all ten profiles, never public uploads; include every exact .deb and SHA-256, Packages/Release/InRelease/Release.gpg and externally pinned ephemeral public key fingerprint/keyring.',
            'Hash-bound source closure, full effective recipe/patch inputs, builder digest, build-result and static audit reports for each bundle; independently re-run the audits, not just trust success booleans.',
            'Reviewed canonical provider selection for duplicate identities, especially patched libcurl, followed by cross-family consumer re-audits; no arbitrary first/last writer.',
            'Actual control metadata and full payload inventories including type, mode, symlink/hardlink targets and hashes; reject non-directory collisions and path traversal before extraction.',
            'One runner-local aggregate with ephemeral signing only, strict signed-by APT update and all exact roots in one simulated transaction; negative omission/hash/signature/cross-family-hole tests. Destroy keys, feeds and binaries afterward.'
        ],
        'androidInstallRuntimeProjectBuildUpgradeRollback': 'NOT_RUN',
    }

def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=pathlib.Path, required=True)
    parser.add_argument('--write-lock', action='store_true')
    parser.add_argument('--require-aggregate-ready', action='store_true')
    parser.add_argument('--require-unified-recipes', action='store_true')
    args = parser.parse_args()
    try:
        result = inventory(ROOT, args.source_root.resolve())
        text = encode(result)
        if args.write_lock:
            (ROOT / LOCK).write_text(text)
        else:
            require((ROOT / LOCK).read_text() == text, 'UNIFIED_INPUT_LOCK_DRIFT')
        print('UNIFIED_SOURCE_PREFLIGHT_OK profiles={} occurrences={} unique={} binary_coexistence=NOT_RUN aggregate_ready=0 publication=blocked'.format(
            result['summary']['profileCount'], result['summary']['occurrenceCount'], result['summary']['uniquePackageCount']))
        divergent = result['summary']['effectiveRecipeDivergentDuplicateNames']
        print('EFFECTIVE_RECIPE_DIVERGENCE_UNRESOLVED:' + ','.join(divergent))
        require(not args.require_unified_recipes or not divergent,
                'UNIFIED_RECIPES_DIVERGE:' + ','.join(divergent))
        require(not args.require_aggregate_ready, 'AGGREGATE_BLOCKED_SIGNED_BINARY_INPUTS_MISSING')
        return 0
    except (GateError, source.GateError, deps.GateError, effective.GateError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print('UNIFIED_INPUT_AUDIT_REJECTED:' + str(exc), file=sys.stderr)
        return 2

if __name__ == '__main__':
    raise SystemExit(main())

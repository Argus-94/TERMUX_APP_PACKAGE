#!/usr/bin/env python3
"""Reproduce existing recipe overlays as data only; no build or binary qualification."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile


class GateError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise GateError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular_input(root, name):
    path = pathlib.PurePosixPath(name)
    require(not path.is_absolute() and bool(path.parts) and
            all(p not in ('.', '..') for p in path.parts) and str(path) == name,
            'UNSAFE_INPUT_PATH')
    current = root
    for part in path.parts:
        current = current / part
        require(not current.is_symlink(), 'SYMLINK_INPUT_REJECTED')
    require(current.is_file(), 'REGULAR_INPUT_REQUIRED:' + name)
    require(current.stat().st_size <= 1024 * 1024, 'INPUT_TOO_LARGE')
    return current.read_bytes()


def git_apply(tree, *args):
    env = os.environ.copy()
    for name in list(env):
        if name.startswith('GIT_'):
            del env[name]
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    result = subprocess.run(['git', '-C', str(tree), 'apply', *args],
                            env=env, capture_output=True, timeout=30)
    require(result.returncode == 0, 'RECIPE_PATCH_APPLY_REJECTED')
    return result.stdout


def effective_inputs(repo, source_root, nodes, patches):
    """Only edit existing recipes and their sibling subpackage definitions.

    No extraction, recipe evaluation, hooks, builds, network or source mutation.
    Arbitrary patch formats, additions/deletions/renames/mode changes fail closed.
    """
    allowed = {p[field] for p in nodes.values()
               for field in ('recipePath', 'subpackagePath') if p[field]}
    # One deliberately narrow data-file exception: the OpenJDK17 closure's
    # pulseaudio node may overlay its existing meson.patch input, pinned by
    # the upstream input registry (not by caller-provided patch data).
    pulse_overlay = ('pulseaudio' in nodes and
                     nodes['pulseaudio']['recipePath'] == 'packages/pulseaudio/build.sh')
    overlay_target = 'packages/pulseaudio/meson.patch'
    overlay_base_sha = None
    if pulse_overlay:
        registry = json.loads(regular_input(repo, 'termux-private-package-kit/openjdk17/upstream-recipe-inputs.json'))
        overlay_base_sha = registry['files'].get(overlay_target)
        require(re.fullmatch(r'[0-9a-f]{64}', overlay_base_sha or '') is not None,
                'PULSEAUDIO_OVERLAY_BASE_NOT_REGISTERED')
        allowed.add(overlay_target)
    # A parent build also processes sibling subpackages outside the required
    # runtime set (e.g. mpg123). Include those existing definitions as context,
    # without adding them to the candidate dependency closure.
    for node in nodes.values():
        parent = source_root / pathlib.PurePosixPath(node['recipePath']).parent
        allowed.update(str(p.relative_to(source_root)) for p in parent.glob('*.subpackage.sh'))
    original = {name: regular_input(source_root, name) for name in allowed}
    if pulse_overlay:
        require(sha(original[overlay_target]) == overlay_base_sha,
                'PULseaUDIO_PATCH_BASE_HASH_MISMATCH')
    for node in nodes.values():
        for path_field, hash_field in (('recipePath', 'recipeSha256'), ('subpackagePath', 'subpackageSha256')):
            if node[path_field]:
                require(sha(original[node[path_field]]) == node[hash_field], 'BASE_RECIPE_HASH_MISMATCH')
    touched = set()
    with tempfile.TemporaryDirectory(prefix='aib-effective-recipes-') as temp:
        tree = pathlib.Path(temp)
        for name, data in original.items():
            target = tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        for index, (name, expected_hash) in enumerate(patches):
            data = regular_input(repo, name)
            require(sha(data) == expected_hash, 'LOCAL_PATCH_HASH_MISMATCH')
            require(b'\0' not in data, 'UNSUPPORTED_RECIPE_PATCH_FORMAT')
            text = data.decode('utf-8')
            headers, old_paths, new_paths = [], [], []
            outer_header_state = 0
            for line in text.splitlines():
                if line.startswith('diff --git '):
                    match = re.fullmatch(r'diff --git a/([A-Za-z0-9+_./-]+) b/([A-Za-z0-9+_./-]+)', line)
                    require(match is not None and match[1] == match[2] and
                            (match[1] in allowed and (match[1] != overlay_target or
                             (pulse_overlay and name == 'termux-private-package-kit/openjdk17/patches/pulseaudio-api24-source.patch'))),
                            'UNSUPPORTED_RECIPE_PATCH_HEADER')
                    headers.append(match[1])
                    outer_header_state = 1
                elif outer_header_state == 1 and line.startswith('--- '):
                    old_paths.append(line[6:] if line.startswith('--- a/') else None)
                    outer_header_state = 2
                elif outer_header_state == 2 and line.startswith('+++ '):
                    new_paths.append(line[6:] if line.startswith('+++ b/') else None)
                    outer_header_state = 0
            require(headers and headers == old_paths == new_paths and len(headers) == len(set(headers)),
                    'UNSUPPORTED_RECIPE_PATCH_HEADER')
            # Existing content edits only; mode/rename/add/delete operations are
            # not required by these pinned overlays and are intentionally unsupported.
            require(not re.search(rb'^(?:old mode|new mode|new file mode|deleted file mode|rename from|rename to|copy from|copy to|GIT binary patch|Binary files) ', data, re.M),
                    'UNSUPPORTED_RECIPE_PATCH_OPERATION')
            patch = tree / ('overlay-' + str(index) + '.patch')
            patch.write_bytes(data)
            stats = git_apply(tree, '--numstat', '-z', '--', str(patch))
            entries = stats.split(b'\0')
            require(entries[-1] == b'' and len(entries) > 1, 'EMPTY_RECIPE_PATCH')
            changed = set()
            for entry in entries[:-1]:
                fields = entry.decode('utf-8').split('\t')
                require(len(fields) == 3 and all(x.isdigit() for x in fields[:2]),
                        'UNSUPPORTED_RECIPE_PATCH_STAT')
                target = fields[2]
                normal_recipe_target = re.fullmatch(r'packages/[A-Za-z0-9+_.-]+/(?:build\.sh|[A-Za-z0-9+_.-]+\.subpackage\.sh)', target) is not None
                narrow_data_target = (pulse_overlay and target == overlay_target and
                    name == 'termux-private-package-kit/openjdk17/patches/pulseaudio-api24-source.patch')
                require((normal_recipe_target or narrow_data_target) and target in allowed,
                        'RECIPE_PATCH_OUTSIDE_CLOSURE')
                require(target not in changed, 'DUPLICATE_RECIPE_PATCH_TARGET')
                changed.add(target)
            require(changed == set(headers), 'RECIPE_PATCH_STAT_HEADER_MISMATCH')
            git_apply(tree, '--check', '--', str(patch))
            git_apply(tree, '--', str(patch))
            # The allowlisted meson.patch is itself a unified patch consumed by
            # the package build; parse it after overlay so bad inner hunk counts
            # fail during source preflight rather than in the native build.
            if overlay_target in changed:
                git_apply(tree, '--numstat', str(tree / overlay_target))
            touched.update(changed)
        effective = {name: regular_input(tree, name) for name in allowed}
        # A patch must not mutate unreported files; the isolated tree contains
        # only this closure's recipes plus our non-executable patch copies.
        expected_files = allowed | {'overlay-' + str(i) + '.patch' for i in range(len(patches))}
        actual_files = {str(p.relative_to(tree)) for p in tree.rglob('*') if p.is_file() or p.is_symlink()}
        require(actual_files == expected_files, 'RECIPE_PATCH_UNREPORTED_TARGET')
    return {name: {
        'effectiveRecipeSha256': sha(effective[p['recipePath']]),
        'effectiveSubpackageSha256': sha(effective[p['subpackagePath']]) if p['subpackagePath'] else None,
        'effectiveRecipeContextSha256': sha(json.dumps({
            path: sha(data) for path, data in sorted(effective.items())
            if pathlib.PurePosixPath(path).parent == pathlib.PurePosixPath(p['recipePath']).parent
        }, sort_keys=True, separators=(',', ':')).encode()),
        'overlayTouchesPackageInputs': (p['recipePath'] in touched or p['subpackagePath'] in touched or
            any(pathlib.PurePosixPath(x).parent == pathlib.PurePosixPath(p['recipePath']).parent for x in touched)),
    } for name, p in nodes.items()}


def divergent_duplicates(packages):
    return sorted(p['name'] for p in packages if len({
        (o['effectiveRecipeSha256'], o['effectiveSubpackageSha256'], o['effectiveRecipeContextSha256'])
        for o in p['occurrences']}) > 1)

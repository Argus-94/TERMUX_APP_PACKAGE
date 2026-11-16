'use strict';

/**
 * This is intentionally a best-effort guard for direct package-manager commands
 * entered through the generic embedded shell. It is not a shell sandbox: arbitrary
 * scripts can still perform other network or filesystem actions. Package mutation
 * remains disabled until an independently qualified signed AI Builder feed exists.
 */
const PRIVATE_PACKAGE_MUTATION_PATTERNS = Object.freeze([
  String.raw`(?:^|[^A-Za-z0-9_.-])(?:pkg|apt-get|apt)\b[^;\n\r|&]{0,256}\b(?:install|reinstall|uninstall|remove|purge|upgrade|full-upgrade|dist-upgrade|update|autoremove|autoclean|clean|build-dep|satisfy|download)\b`,
  String.raw`(?:^|[^A-Za-z0-9_.-])dpkg\b[^;\n\r|&]{0,256}(?:\s--?(?:install|unpack|remove|purge|configure|set-selections)\b|\s-[a-z]*[irp][a-z]*\b)`,
  String.raw`(?:^|[^A-Za-z0-9_.-])apt-key\b[^;\n\r|&]{0,128}\b(?:add|del|delete|adv)\b`,
  String.raw`(?:^|[^A-Za-z0-9_.-])(?:termux-change-repo|termux-repo-upgrade)\b`,
]);

function isPrivatePackageMutationCommand(command) {
  if (typeof command !== 'string') return false;
  return PRIVATE_PACKAGE_MUTATION_PATTERNS.some((pattern) => new RegExp(pattern, 'i').test(command));
}

module.exports = {
  PRIVATE_PACKAGE_MUTATION_PATTERNS,
  isPrivatePackageMutationCommand,
};

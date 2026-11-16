const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.disableHierarchicalLookup = false;
config.watchFolders = [__dirname];

// Ensure agent-tool modules under lib/ are never blocked by a broad **/build/**
// pattern from tooling or future Expo defaults.
const prev = config.resolver.blockList;
if (prev) {
  const list = Array.isArray(prev) ? prev : [prev];
  config.resolver.blockList = list;
}

module.exports = config;

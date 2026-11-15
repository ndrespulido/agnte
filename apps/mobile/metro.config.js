/**
 * `@agnte/core` lives outside this folder (packages/core) and arrives as a
 * symlink. Metro only watches the project root unless told otherwise, so the
 * package's source has to be added by hand — and its imports resolved from
 * this app's node_modules, not from the repo root's, which belong to the web
 * app and carry a different React.
 */
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const core = path.resolve(__dirname, '../../packages/core');
const config = getDefaultConfig(__dirname);

config.watchFolders = [core];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;

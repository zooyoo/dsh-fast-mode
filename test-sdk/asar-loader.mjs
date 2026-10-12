import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks, isBuiltin } from 'node:module';

// 只读安装包。测试用虚拟路径位于工作区，不提取或改写 Host 文件。
export const archivePath = process.env.DSH_TEST_ASAR || path.join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/resources/app.asar');
const fd = fs.openSync(archivePath, 'r');
const prefix = Buffer.alloc(16);
fs.readSync(fd, prefix, 0, prefix.length, 0);
const headerBytes = Buffer.alloc(prefix.readUInt32LE(12));
fs.readSync(fd, headerBytes, 0, headerBytes.length, 16);
const header = JSON.parse(headerBytes.toString('utf8'));
const dataOffset = 8 + prefix.readUInt32LE(4);
const virtualRoot = path.resolve(fileURLToPath(new URL('../.analysis/runtime/', import.meta.url)));
const virtualURL = pathToFileURL(virtualRoot + path.sep).href;
const packages = new Map();
export const loadedEntries = new Set();

function nodeAt(name) {
  let node = header;
  for (const part of name.split('/').filter(Boolean)) {
    if (node?.link) node = nodeAt(node.link);
    node = node?.files?.[part];
  }
  return node;
}
export function readArchive(name) {
  const node = nodeAt(name);
  if (!node || node.files) throw new Error(`ASAR file not found: ${name}`);
  if (node.link) return readArchive(node.link);
  if (node.unpacked) return fs.readFileSync(path.join(archivePath + '.unpacked', name), 'utf8');
  const bytes = Buffer.alloc(node.size);
  fs.readSync(fd, bytes, 0, bytes.length, dataOffset + Number(node.offset));
  return bytes.toString('utf8');
}
function packageAt(root) {
  if (!packages.has(root)) packages.set(root, nodeAt(root + '/package.json') ? JSON.parse(readArchive(root + '/package.json')) : null);
  return packages.get(root);
}
function fileAt(candidate) {
  for (const name of [candidate, candidate + '.js', candidate + '.json', candidate + '.node']) {
    const node = nodeAt(name);
    if (node && !node.files) return name;
  }
  if (nodeAt(candidate)?.files) {
    const pkg = packageAt(candidate);
    if (pkg?.main) {
      const main = fileAt(path.posix.join(candidate, pkg.main));
      if (main) return main;
    }
    for (const base of ['index.js', 'index.json']) if (nodeAt(candidate + '/' + base)) return candidate + '/' + base;
  }
  return null;
}
function selectConditional(value, conditions) {
  if (typeof value === 'string' || value === null) return value;
  if (Array.isArray(value)) return value.map(v => selectConditional(v, conditions)).find(Boolean);
  for (const [condition, target] of Object.entries(value || {})) {
    if (condition === 'default' || conditions.has(condition)) {
      const selected = selectConditional(target, conditions);
      if (selected !== undefined) return selected;
    }
  }
}
function exportedFile(pkg, subpath, conditions) {
  const exp = pkg.exports;
  if (typeof exp === 'string' || Array.isArray(exp)) return subpath === '.' ? selectConditional(exp, conditions) : null;
  if (!exp || !Object.keys(exp).some(k => k.startsWith('.'))) return subpath === '.' ? selectConditional(exp, conditions) : null;
  if (Object.hasOwn(exp, subpath)) return selectConditional(exp[subpath], conditions);
  const matches = Object.keys(exp).filter(key => key.includes('*')).sort((a, b) => b.length - a.length);
  for (const key of matches) {
    const [start, end] = key.split('*');
    if (subpath.startsWith(start) && subpath.endsWith(end)) {
      const target = selectConditional(exp[key], conditions);
      return target?.replaceAll('*', subpath.slice(start.length, end ? -end.length : undefined));
    }
  }
  return null;
}
function resolvePackage(specifier, parent, conditions) {
  const bits = specifier.split('/');
  const name = bits.splice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  const subpath = bits.length ? './' + bits.join('/') : '.';
  const roots = [];
  for (let dir = path.posix.dirname(parent || 'dsh/index.js'); dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) {
    if (!dir.endsWith('/node_modules')) roots.push(dir + '/node_modules/' + name);
  }
  roots.push('dsh/node_modules/' + name, 'node_modules/' + name);
  for (const root of new Set(roots)) {
    const pkg = packageAt(root);
    if (!pkg) continue;
    const target = pkg.exports !== undefined ? exportedFile(pkg, subpath, conditions) : (subpath === '.' ? pkg.main || 'index.js' : subpath);
    if (!target) throw new Error(`ASAR package export unavailable: ${specifier}`);
    const filename = fileAt(path.posix.join(root, target));
    if (filename) return filename;
    throw new Error(`ASAR package entry unavailable: ${specifier} -> ${target}`);
  }
  throw new Error(`ASAR dependency unavailable: ${specifier} from ${parent}`);
}
function archiveName(url) {
  if (!url?.startsWith(virtualURL)) return null;
  return path.relative(virtualRoot, fileURLToPath(url)).replaceAll('\\', '/');
}
function formatOf(name) {
  if (name.endsWith('.mjs')) return 'module';
  if (name.endsWith('.cjs')) return 'commonjs';
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.node')) throw new Error(`Native SDK module requires extraction: ${name}`);
  for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) {
    const pkg = packageAt(dir);
    if (pkg) return pkg.type === 'module' ? 'module' : 'commonjs';
  }
  return 'commonjs';
}
export const sdkVersion = JSON.parse(readArchive('dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json')).version;
if (sdkVersion !== '0.2.0-rc.2') throw new Error(`Expected DSH 0.2.0-rc.2 SDK, found ${sdkVersion}`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    const parent = archiveName(context.parentURL);
    if (!parent && !specifier.startsWith('@deepseek-ai/') && !specifier.startsWith('@earendil-works/')) return nextResolve(specifier, context);
    let filename;
    if (specifier.startsWith('.')) filename = fileAt(path.posix.join(path.posix.dirname(parent), specifier));
    else if (specifier.startsWith('file:')) filename = archiveName(specifier);
    else filename = resolvePackage(specifier, parent, new Set(context.conditions));
    if (!filename) throw new Error(`Cannot resolve SDK module ${specifier} from ${parent}`);
    return { url: pathToFileURL(path.join(virtualRoot, filename)).href, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    const filename = archiveName(url);
    if (!filename) return nextLoad(url, context);
    loadedEntries.add(filename);
    return { format: formatOf(filename), source: readArchive(filename), shortCircuit: true };
  },
});

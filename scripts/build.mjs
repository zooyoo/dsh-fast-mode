import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';

await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
for (const file of ['index.js', 'bridge.js', 'controller.js']) {
  await copyFile(new URL(`../src/${file}`, import.meta.url), new URL(`../lib/${file}`, import.meta.url));
}
const source = await readFile(new URL('../src/client.cjs', import.meta.url), 'utf8');
const bundle = `// 此文件由 npm run build 生成。\nwindow.__ModuleLoader__.load({\n  id: 'dsh-fast-mode',\n  factory: (require) => {\n    const module = { exports: {} };\n${source}\n    return module.exports;\n  },\n});\n`;
await writeFile(new URL('../lib/client.js', import.meta.url), bundle, 'utf8');
console.log('Built host modules and DSH browser module.');

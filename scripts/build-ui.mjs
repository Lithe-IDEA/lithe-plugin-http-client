import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const en = JSON.parse(await readFile(join(root, 'shared/i18n/en-US.json'), 'utf8'));
const zh = JSON.parse(await readFile(join(root, 'shared/i18n/zh-CN.json'), 'utf8'));
if (JSON.stringify(Object.keys(en).sort()) !== JSON.stringify(Object.keys(zh).sort()) ||
    [...Object.values(en), ...Object.values(zh)].some(value => typeof value !== 'string' || !value.trim())) {
  throw new Error('English and Chinese message keys must match and contain text.');
}
const output = await build({
  absWorkingDir: root, entryPoints: ['ui/src/main.js'], bundle: true,
  outfile: 'ui/main.js', format: 'iife', target: ['safari16'],
  minify: true, legalComments: 'eof', write: false, metafile: true,
});
const packages = new Set();
for (const input of Object.keys(output.metafile.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  let directory = dirname(join(root, input));
  while (directory.startsWith(join(root, 'node_modules'))) {
    try { await readFile(join(directory, 'package.json')); packages.add(directory); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; directory = dirname(directory); }
  }
}
const dependencies = [], licenses = [];
for (const directory of [...packages].sort()) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const license = await readFile(join(directory, 'LICENSE'), 'utf8');
  dependencies.push({ name: metadata.name, version: metadata.version, license: metadata.license });
  licenses.push(`${metadata.name} ${metadata.version}\n${license.trim()}\n`);
}
for (const [name, generated] of [
  ['main.js', output.outputFiles[0].text],
  ['DEPENDENCIES.json', JSON.stringify(dependencies, null, 2) + '\n'],
  ['THIRD_PARTY_LICENSES.txt', licenses.join('\n--------------------\n\n')],
]) {
  const destination = join(root, 'ui', name);
  if (process.argv.includes('--check')) {
    if (await readFile(destination, 'utf8') !== generated) throw new Error(`Run npm run build and include ui/${name}.`);
  } else {
    await writeFile(destination, generated);
  }
}

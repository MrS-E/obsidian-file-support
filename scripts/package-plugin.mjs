import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectRoot, 'dist/obsidian-file-support');
const runtimeFiles = ['main.js', 'manifest.json', 'styles.css'];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of runtimeFiles) {
  await copyFile(resolve(projectRoot, file), resolve(outputDirectory, file));
}
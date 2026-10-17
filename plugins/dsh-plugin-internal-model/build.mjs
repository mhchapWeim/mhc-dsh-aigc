import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('./lib/', import.meta.url), { recursive: true });
for (const file of ['index.js', 'index.d.ts']) await copyFile(new URL(`./src/${file}`, import.meta.url), new URL(`./lib/${file}`, import.meta.url));

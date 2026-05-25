#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const slug = manifest.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const zipName = `${slug}-${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);

if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const files = ['manifest.json', 'content.js', 'popup.html', 'popup.js'];
const dirs = ['icons'];

for (const f of [...files, ...dirs]) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error(`Missing required file: ${f}`);
    process.exit(1);
  }
}

const output = fs.createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  const size = (archive.pointer() / 1024).toFixed(1);
  console.log(`Built dist/${zipName} (${size} KB)`);
});

archive.on('warning', (err) => {
  if (err.code === 'ENOENT') console.warn(err);
  else throw err;
});

archive.on('error', (err) => { throw err; });

archive.pipe(output);

for (const f of files) {
  archive.file(path.join(root, f), { name: f });
}

for (const d of dirs) {
  archive.directory(path.join(root, d), d, (entry) => {
    if (entry.name === '.DS_Store') return false;
    return entry;
  });
}

archive.finalize();

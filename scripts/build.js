#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

const files = [
  'manifest.json',
  'content.js',
  'popup.html',
  'popup.js',
  'icons',
];

for (const f of files) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error(`Missing required file: ${f}`);
    process.exit(1);
  }
}

execFileSync('zip', ['-r', zipPath, ...files, '-x', '*.DS_Store'], {
  cwd: root,
  stdio: 'inherit',
});

const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`\nBuilt dist/${zipName} (${size} KB)`);

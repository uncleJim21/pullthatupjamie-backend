#!/usr/bin/env node
'use strict';

/**
 * build-clawhub-zip.js
 *
 * Packages the source skills/pullthatupjamie/ directory into a zip file
 * at dist/clawhub/pullthatupjamie-v{version}.zip, suitable for manual
 * upload to ClawHub at https://clawhub.ai/publish.
 *
 * Version is read from _meta.json first, then SKILL.md frontmatter.
 * All files in the skill directory are included (including _meta.json,
 * CHANGELOG.md, and references/), excluding .DS_Store and node_modules.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const archiver = require('archiver');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SKILL_DIR = path.join(REPO_ROOT, 'skills/pullthatupjamie');
const DIST_DIR = path.join(REPO_ROOT, 'dist/clawhub');

function getVersion() {
  const metaPath = path.join(SKILL_DIR, '_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.version) return meta.version;
    } catch {}
  }
  const skillContent = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const match = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match) {
    const fm = yaml.load(match[1]);
    if (fm && fm.version) return String(fm.version);
  }
  return '0.0.0';
}

async function main() {
  const version = getVersion();
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const outputPath = path.join(DIST_DIR, `pullthatupjamie-v${version}.zip`);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(output);

  // Add all visible files
  archive.glob('**/*', {
    cwd: SKILL_DIR,
    ignore: ['node_modules/**', '.DS_Store', '.smithery-overrides.yaml'],
    dot: false,
  });

  // _meta.json starts with _ so dot:false skips it — add explicitly
  const metaPath = path.join(SKILL_DIR, '_meta.json');
  if (fs.existsSync(metaPath)) {
    archive.file(metaPath, { name: '_meta.json' });
  }

  // .smithery-overrides.yaml is a build artifact, not needed in ClawHub zip

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.finalize();
  });

  const relPath = path.relative(REPO_ROOT, outputPath);
  const bytes = archive.pointer();
  console.log(`✅ ClawHub zip: ${relPath}`);
  console.log(`   Version: ${version}  |  Size: ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`   Upload at: https://clawhub.ai/publish`);
}

main().catch((err) => {
  console.error('❌ Zip build failed:', err.message);
  process.exit(1);
});

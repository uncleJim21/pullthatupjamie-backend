#!/usr/bin/env node
'use strict';

/**
 * build-smithery.js
 *
 * Transforms the source skills/pullthatupjamie/SKILL.md (ClawHub format) into
 * a dist/smithery/pullthatupjamie/SKILL.md that is fully agentskills.io-compliant,
 * ready for Smithery registry submission via gitUrl.
 *
 * Transforms applied:
 *  - Moves `version` and `homepage` from top-level frontmatter into metadata
 *  - Adds `license` from overrides (default: Proprietary)
 *  - Adds `compatibility` from overrides if not already set
 *  - Replaces `description` with the override value (required: source exceeds 1024 chars)
 *  - Copies references/ directory alongside SKILL.md
 *
 * Config: skills/pullthatupjamie/.smithery-overrides.yaml
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SKILL_DIR = path.join(REPO_ROOT, 'skills/pullthatupjamie');
const DIST_DIR = path.join(REPO_ROOT, 'dist/smithery/pullthatupjamie');
const OVERRIDES_PATH = path.join(SKILL_DIR, '.smithery-overrides.yaml');
const MAX_DESCRIPTION_LENGTH = 1024;

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('No YAML frontmatter found in SKILL.md');
  return { data: yaml.load(match[1]), body: match[2] };
}

function serializeFrontmatter(data) {
  return `---\n${yaml.dump(data, { lineWidth: -1 })}---\n`;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  const skillPath = path.join(SKILL_DIR, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`SKILL.md not found at ${skillPath}`);
  }

  const { data: fm, body } = parseFrontmatter(fs.readFileSync(skillPath, 'utf8'));
  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? yaml.load(fs.readFileSync(OVERRIDES_PATH, 'utf8')) || {}
    : {};

  const out = { ...fm };

  // Move non-spec top-level fields into metadata
  out.metadata = { ...(out.metadata || {}) };
  if (out.version !== undefined) {
    out.metadata.version = String(out.version);
    delete out.version;
  }
  if (out.homepage !== undefined) {
    out.metadata.homepage = String(out.homepage);
    delete out.homepage;
  }

  // Add license if missing
  if (!out.license) {
    out.license = overrides.license || 'Proprietary';
  }

  // Add compatibility if missing
  if (!out.compatibility && overrides.compatibility) {
    out.compatibility = overrides.compatibility;
  }

  // Apply description override (required — source exceeds 1024 chars)
  if (overrides.description) {
    out.description = overrides.description;
  } else if (out.description && out.description.length > MAX_DESCRIPTION_LENGTH) {
    console.warn(
      `⚠️  Description is ${out.description.length} chars (max ${MAX_DESCRIPTION_LENGTH}).\n` +
      `   Add a 'description' key to .smithery-overrides.yaml to provide a shorter version.\n` +
      `   Auto-truncating for now...`
    );
    out.description = out.description.slice(0, MAX_DESCRIPTION_LENGTH - 3) + '...';
  }

  if (out.description && out.description.length > MAX_DESCRIPTION_LENGTH) {
    console.error(`❌ Description still ${out.description.length} chars after transforms (max ${MAX_DESCRIPTION_LENGTH}).`);
    process.exit(1);
  }

  // Write SKILL.md to dist
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(DIST_DIR, 'SKILL.md'), serializeFrontmatter(out) + body);

  // Copy references/
  const refsDir = path.join(SKILL_DIR, 'references');
  if (fs.existsSync(refsDir)) {
    copyDir(refsDir, path.join(DIST_DIR, 'references'));
  }

  const relDist = path.relative(REPO_ROOT, DIST_DIR);
  console.log(`✅ Smithery dist written to ${relDist}/`);
  console.log(`   Description: ${out.description.length}/${MAX_DESCRIPTION_LENGTH} chars`);
  console.log(`   Fields moved to metadata: ${[fm.version && 'version', fm.homepage && 'homepage'].filter(Boolean).join(', ') || 'none'}`);
  console.log(`   License: ${out.license}`);
}

try {
  main();
} catch (err) {
  console.error('❌ Build failed:', err.message);
  process.exit(1);
}

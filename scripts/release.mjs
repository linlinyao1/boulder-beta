#!/usr/bin/env node
/**
 * SemVer release helper for boulder-beta.
 * Usage:
 *   npm run release:patch   # bugfix / physics calibration (e.g. 1.4.0 -> 1.4.1)
 *   npm run release:minor   # new feature / holds / UI (e.g. 1.4.0 -> 1.5.0)
 *   npm run release:major   # breaking architecture change (e.g. 1.4.0 -> 2.0.0)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const bumpType = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node scripts/release.mjs <patch|minor|major>');
  process.exit(1);
}

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);

const nextVersion =
  bumpType === 'major'
    ? `${maj + 1}.0.0`
    : bumpType === 'minor'
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;

console.log(`Bumping boulder-beta: v${pkg.version} -> v${nextVersion}`);

// 1. Run test suite and build before bumping
execSync('npm test && npm run build', { stdio: 'inherit' });

// 2. Update package.json
pkg.version = nextVersion;
writeFileSync(pkgUrl, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// 3. Stage, commit, and create annotated Git tag
execSync('git add package.json', { stdio: 'inherit' });
execSync(`git commit -m "chore(release): v${nextVersion}"`, { stdio: 'inherit' });
execSync(`git tag -a v${nextVersion} -m "Release v${nextVersion}"`, { stdio: 'inherit' });

console.log(`\nCreated release commit & tag v${nextVersion}.`);
console.log(`Push with: git push origin main --follow-tags`);

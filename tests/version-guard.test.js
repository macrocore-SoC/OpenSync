import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectVersionMismatches, computeNextVersion, parseSemver } from '../scripts/version.js';

const ROOT = new URL('../', import.meta.url);

function readRel(path) {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

function parseVersionNode(raw) {
  const m = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  assert.ok(m, `engines.node must be a plain ">=x.y.z" range, got "${raw}"`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// Same comparison as install.sh check_deps(): major > 22, or major == 22 && minor >= 13
function nodeVersionOk(ver) {
  const [major, minor] = ver.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

test('package.json engines.node requires at least 22.13', () => {
  const pkg = JSON.parse(readRel('package.json'));
  const { major, minor } = parseVersionNode(pkg.engines.node);
  assert.ok(
    major > 22 || (major === 22 && minor >= 13),
    `engines.node "${pkg.engines.node}" must not allow node older than 22.13`
  );
});

test('install.sh defines MIN_NODE_MINOR and rejects 22.x with minor < 13', () => {
  const script = readRel('install.sh');
  assert.match(script, /MIN_NODE_MINOR=13/, 'install.sh must define MIN_NODE_MINOR=13');
  assert.equal(nodeVersionOk('22.12.0'), false, '22.12.0 has no node:sqlite, must be rejected');
  assert.equal(nodeVersionOk('22.13.7'), true, '22.13.7 must be accepted');
  assert.equal(nodeVersionOk('23.1.0'), true, 'any 23+ must be accepted');
});

test('README.md mentions Node.js 22.13+', () => {
  const readme = readRel('README.md');
  assert.match(readme, /\*\*Node\.js 22\.13\+\*\*/, 'README prerequisites must say Node.js 22.13+');
});

test('monorepo version manifests stay lockstep with VERSION (docs/versioning-spec.md)', () => {
  const { version, mismatches } = collectVersionMismatches();
  assert.ok(parseSemver(version), `VERSION "${version}" must be valid SemVer`);
  assert.deepEqual(mismatches, [], `Version drift detected:\n${mismatches.join('\n')}`);
});

test('version bump calculation increments SemVer components accurately', () => {
  assert.equal(computeNextVersion('0.3.0', 'patch'), '0.3.1');
  assert.equal(computeNextVersion('0.3.0', 'minor'), '0.4.0');
  assert.equal(computeNextVersion('0.3.0', 'major'), '1.0.0');
  assert.equal(computeNextVersion('0.3.0', '0.4.0-rc.1'), '0.4.0-rc.1');
});
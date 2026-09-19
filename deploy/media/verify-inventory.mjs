// Read-only verification inside the final image against the reviewed recipe.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const expected = readJson(process.argv[2]);
const directory = '/usr/share/kinetra-media';
const builds = readJson(`${directory}/source-builds.json`);
const bom = readJson(`${directory}/source-components.cdx.json`);
assert.equal(expected.schemaVersion, 1);
assert.equal(builds.schemaVersion, 1);
assert.equal(bom.bomFormat, 'CycloneDX');
assert.equal(bom.specVersion, '1.6');
assert.equal(expected.components.length, 2);
assert.equal(builds.components.length, 2);
assert.equal(bom.components.length, 2);
assert.deepEqual(expected.components.map((component) => component.name).sort(), [
  'ffmpeg',
  'imagemagick',
]);
for (const component of expected.components) {
  const records = builds.components.filter((record) => record.name === component.name);
  const entries = bom.components.filter((entry) => entry.name === component.name);
  assert.equal(records.length, 1);
  assert.equal(entries.length, 1);
  const record = records[0];
  const entry = entries[0];
  for (const [key, value] of Object.entries(component)) assert.deepEqual(record[key], value);
  assert.match(record.apkSha256, /^[a-f0-9]{64}$/);
  assert.equal(entry.version, component.version);
  assert.equal(entry.cpe, component.cpe);
  assert.equal(entry.purl, `pkg:generic/${component.name}@${component.version}`);
  assert.equal(entry['bom-ref'], entry.purl);
  const distribution = entry.externalReferences.filter(
    (reference) => reference.type === 'distribution',
  );
  assert.equal(distribution.length, 1);
  assert.equal(distribution[0].url, component.sourceUrl);
  assert.deepEqual(distribution[0].hashes, [{ alg: 'SHA-256', content: component.sourceSha256 }]);
  assert.deepEqual(Object.keys(record.binaryHashes).sort(), [...component.binaries].sort());
  for (const binary of component.binaries) {
    assert.match(binary, /^usr\/bin\/[a-z]+$/);
    const digest = createHash('sha256')
      .update(readFileSync(`/${binary}`))
      .digest('hex');
    assert.equal(digest, record.binaryHashes[binary]);
    const property = entry.properties.filter(
      (item) => item.name === `kinetra:binary:sha256:/${binary}`,
    );
    assert.equal(property.length, 1);
    assert.equal(property[0].value, digest);
  }
}
console.log(
  JSON.stringify({
    result: 'KINETRA_SOURCE_MEDIA_INVENTORY=PASS',
    source_builds: builds,
    source_components: bom,
    media_apk_inventory: readJson(`${directory}/media-apk-inventory.json`),
    runtime_apk_inventory: readFileSync(`${directory}/runtime-apk-inventory.txt`, 'utf8'),
  }),
);

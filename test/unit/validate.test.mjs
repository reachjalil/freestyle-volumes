import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertVolumeName, assertMountPath, assertSubpath, assertSandboxId, assertBucket, normalizePrefix, shellQuote, mountIdFor, resolveStorage, PROTECTED_MOUNT_ROOTS, ValidationError } from '../../dist/index.js';

test('volume names are DNS-label style', () => {
  for (const ok of ['a', 'data', 'my-volume-01', 'x'.repeat(63)]) assert.equal(assertVolumeName(ok), ok);
  for (const bad of ['', 'A', '-a', 'a-', 'a_b', 'a.b', 'a/b', 'x'.repeat(64), '../x', 42, null]) assert.throws(() => assertVolumeName(bad), ValidationError, String(bad));
});

test('mount paths must be absolute, clean and outside protected roots', () => {
  for (const ok of ['/mnt/data', '/home/ubuntu/vol', '/data', '/workspace/a.b_c-d', '/var/data/x']) assert.equal(assertMountPath(ok), ok);
  for (const bad of ['', 'mnt/data', '/', '/mnt/../etc', '/mnt/./x', '/mnt//x', '/mnt/x/', '/mnt/x y', "/mnt/x'y", '/mnt/$(id)', '/mnt/x;rm', 42]) assert.throws(() => assertMountPath(bad), ValidationError, String(bad));
  for (const root of PROTECTED_MOUNT_ROOTS) {
    assert.throws(() => assertMountPath(root), ValidationError, root);
    assert.throws(() => assertMountPath(`${root}/x`), ValidationError, root);
  }
  assert.equal(assertMountPath('/usrdata'), '/usrdata', 'prefix match must be on path segments');
});

test('subpaths and prefixes reject traversal and hidden segments', () => {
  assert.equal(assertSubpath('users/alice'), 'users/alice');
  assert.equal(assertSubpath('/users/alice/'), 'users/alice');
  assert.equal(normalizePrefix('/tenant-a/'), 'tenant-a');
  for (const bad of ['', '..', 'users/../bob', 'users//bob', '.hidden', 'a b', "a'b", 'a$b', 'a\\b']) {
    assert.throws(() => assertSubpath(bad), ValidationError, bad);
    assert.throws(() => normalizePrefix(bad), ValidationError, bad);
  }
});

test('sandbox ids and buckets are validated', () => {
  assert.equal(assertSandboxId('vm-1234_ab.cd'), 'vm-1234_ab.cd');
  for (const bad of ['', ' x', 'a b', 'a;b', '$x', '/x']) assert.throws(() => assertSandboxId(bad), ValidationError, bad);
  assert.equal(assertBucket('my-bucket.01'), 'my-bucket.01');
  for (const bad of ['', 'ab', 'My-Bucket', 'a..b', 'a_b', '-ab', 'ab-']) assert.throws(() => assertBucket(bad), ValidationError, bad);
});

test('shellQuote produces a single POSIX word and rejects NUL', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('$(id) `x` "y"'), "'$(id) `x` \"y\"'");
  assert.throws(() => shellQuote('a\0b'), ValidationError);
});

test('mount ids are stable and distinct per volume, subpath and path', () => {
  const a = mountIdFor('vol', undefined, '/mnt/a');
  assert.equal(a, mountIdFor('vol', undefined, '/mnt/a'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, mountIdFor('vol2', undefined, '/mnt/a'));
  assert.notEqual(a, mountIdFor('vol', 'sub', '/mnt/a'));
  assert.notEqual(a, mountIdFor('vol', undefined, '/mnt/b'));
});

test('mount ids include resolved storage identity but exclude credentials and timeouts', () => {
  const storage = resolveStorage({ endpoint: 'https://one.example', bucket: 'bucket', accessKeyId: 'key', secretAccessKey: 'secret' });
  const id = value => mountIdFor('vol', undefined, '/mnt/data', value);
  const original = id(storage);
  assert.notEqual(original, mountIdFor('vol', undefined, '/mnt/data'), 'legacy cache is not rebound');
  for (const [key, value] of Object.entries({ endpoint: 'https://two.example', sandboxEndpoint: 'https://guest.example', bucket: 'other-bucket', prefix: 'other', region: 'eu-west-1', provider: 'Minio', forcePathStyle: false })) {
    assert.notEqual(original, id({ ...storage, [key]: value }), key);
  }
  assert.equal(original, id({ ...storage, accessKeyId: 'rotated', secretAccessKey: 'rotated-secret', sessionToken: 'token', requestTimeoutMs: 20000 }));
  assert.equal(original, id(resolveStorage({ ...storage, sandboxEndpoint: undefined })), 'default endpoint resolves identically');
});

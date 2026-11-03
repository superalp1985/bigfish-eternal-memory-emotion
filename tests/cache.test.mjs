import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteCache } from '../src/cache.mjs';
test('hot recall cache stays under byte budget and results are detached', () => {
  const cache = new ByteCache(128);
  for (let i=0;i<1000;i++) cache.set(String(i),{text:'记忆'.repeat(5)});
  assert.ok(cache.bytes<=128);
  assert.equal(cache.get('0'),undefined);
  const last=cache.get('999');last.text='changed';
  assert.notEqual(cache.get('999').text,'changed');
  cache.set('huge','x'.repeat(200));assert.equal(cache.get('huge'),undefined);
});

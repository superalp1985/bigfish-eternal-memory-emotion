import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../runtime');
const keyPath = join(root, 'credential-local.key');
const dataPath = join(root, 'credential-local.aes');
try {
  if (process.argv[2] === 'store') {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error();
    const key = existsSync(keyPath) ? readFileSync(keyPath) : randomBytes(32);
    if (!existsSync(keyPath)) writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(process.env.DEEPSEEK_API_KEY, 'utf8'), cipher.final()]);
    writeFileSync(dataPath, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flush: true });
    key.fill(0);
  } else if (process.argv[2] === 'read') {
    const key = readFileSync(keyPath), data = readFileSync(dataPath);
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    process.stdout.write(plain);
    plain.fill(0); key.fill(0);
  } else throw new Error();
} catch {
  console.error('BigFish local model connection could not be loaded.');
  process.exitCode = 1;
}

import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, linkSync, mkdtempSync,
  mkdirSync, readdirSync, rmSync, statSync, openSync, fsyncSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const cleanName = value => {
  const name = String(value ?? 'attachment').replaceAll('\\', '/').split('/').at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
  return name || 'attachment';
};

export class MediaStore {
  constructor(root) {
    this.root = join(root, 'media');
    this.objects = join(this.root, 'sha256');
  }

  path(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid media SHA-256');
    return join(this.objects, id.slice(0, 2), id);
  }

  async putStream(source, { name, mediaType = 'application/octet-stream', kind = 'file', expectedId, expectedBytes } = {}) {
    if (!['image', 'file'].includes(kind) || typeof mediaType !== 'string' ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) throw new Error('Invalid media metadata');
    mkdirSync(this.objects, { recursive: true });
    const staging = mkdtempSync(join(this.root, '.staging-'));
    const staged = join(staging, 'payload');
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(source, new Transform({ transform(chunk, encoding, done) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (!Number.isSafeInteger(bytes)) return done(new Error('Media object exceeds the supported byte count'));
        digest.update(value);
        done(null, value);
      } }), createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
      const handle = openSync(staged, 'r+');
      try { fsyncSync(handle); } finally { closeSync(handle); }
      const id = digest.digest('hex');
      if (expectedId !== undefined && (id !== expectedId || bytes !== expectedBytes)) throw new Error('Media archive checksum mismatch');
      const target = this.path(id);
      mkdirSync(join(this.objects, id.slice(0, 2)), { recursive: true });
      try { linkSync(staged, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.verify({ id, bytes });
      }
      return { id, bytes, name: cleanName(name), mediaType, kind };
    } finally {
      rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  exists(id) { return existsSync(this.path(id)); }

  async verify(ref) {
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(this.path(ref.id))) {
      bytes += chunk.length;
      digest.update(chunk);
    }
    if (bytes !== ref.bytes || digest.digest('hex') !== ref.id) throw new Error('Media checksum mismatch');
    return true;
  }

  async *readStream(ref) {
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(this.path(ref.id))) {
      bytes += chunk.length;
      digest.update(chunk);
      yield chunk;
    }
    if (bytes !== ref.bytes || digest.digest('hex') !== ref.id) throw new Error('Media checksum mismatch');
  }

  list() {
    if (!existsSync(this.objects)) return [];
    const output = [];
    for (const prefix of readdirSync(this.objects, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = join(this.objects, prefix.name);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name) || !entry.name.startsWith(prefix.name)) continue;
        const path = join(directory, entry.name);
        const stat = statSync(path);
        if (stat.isFile()) output.push({ id: entry.name, bytes: stat.size, path });
      }
    }
    return output.sort((a, b) => a.id.localeCompare(b.id));
  }

  importStream(source, { id, bytes }) {
    return this.putStream(source, { expectedId: id, expectedBytes: bytes });
  }
}

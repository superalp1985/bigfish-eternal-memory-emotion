export class ByteCache {
  constructor(maxBytes = 2 * 1024 * 1024) { this.maxBytes = maxBytes; this.bytes = 0; this.entries = new Map(); }
  get(key) {
    const row = this.entries.get(key);
    if (!row) return undefined;
    this.entries.delete(key); this.entries.set(key, row);
    return JSON.parse(row.json);
  }
  set(key, value) {
    this.delete(key);
    const json = JSON.stringify(value), bytes = Buffer.byteLength(key) + Buffer.byteLength(json);
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes && this.entries.size) this.delete(this.entries.keys().next().value);
    this.entries.set(key, { json, bytes }); this.bytes += bytes;
  }
  delete(key) { const row = this.entries.get(key); if (row) { this.bytes -= row.bytes; this.entries.delete(key); } }
  clear() { this.entries.clear(); this.bytes = 0; }
}

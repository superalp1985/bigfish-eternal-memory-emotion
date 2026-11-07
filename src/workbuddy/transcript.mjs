import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

const MEDIA_TYPES = new Set(['image_blob_ref', 'input_image', 'input_audio', 'input_video',
  'input_file', 'file', 'image', 'audio', 'video', 'document']);

const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

export function mimeFromName(name) {
  return MIME_BY_EXTENSION[extname(String(name ?? '')).toLowerCase()] || 'application/octet-stream';
}

export function parseTranscriptLine(raw, line = 0) {
  try {
    const text = line === 0 ? raw.replace(/^\uFEFF/u, '') : raw;
    const record = JSON.parse(text);
    return { ok: true, record };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function* readTranscriptLines(path, { offset = 0, line = 0 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(line) || line < 0) {
    throw new Error('Invalid transcript cursor');
  }
  const size = statSync(path).size;
  if (offset > size) throw new Error('Transcript cursor exceeds file size');
  let position = offset;
  let lineIndex = line;
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { start: offset })) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      if (newline === -1) {
        pending = pending.length ? Buffer.concat([pending, chunk.subarray(cursor)]) : chunk.subarray(cursor);
        break;
      }
      const segment = chunk.subarray(cursor, newline);
      const rawBytes = pending.length ? Buffer.concat([pending, segment]) : segment;
      const lineOffset = position;
      const nextOffset = position + rawBytes.length + 1;
      yield {
        raw: rawBytes.toString('utf8'),
        line: lineIndex,
        offset: lineOffset,
        nextOffset,
      };
      position = nextOffset;
      lineIndex++;
      pending = Buffer.alloc(0);
      cursor = newline + 1;
    }
  }
}

function resolveBlobPath(block, transcriptPath) {
  const value = block.blob_path ?? block.blobPath ?? block.path;
  if (typeof value !== 'string' || !value) return null;
  if (isAbsolute(value)) return value;
  const transcriptRelative = resolve(transcriptPath, '..', value);
  if (existsSync(transcriptRelative)) return transcriptRelative;
  return resolve(value);
}

function mediaCandidate(block, transcriptPath) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const blobPath = resolveBlobPath(block, transcriptPath);
  const declaredType = String(block.mime ?? block.media_type ?? block.mediaType ?? '').toLowerCase();
  const name = String(block.original_filename ?? block.originalFilename ?? block.name ??
    (blobPath ? blobPath.replaceAll('\\', '/').split('/').at(-1) : 'attachment'));
  const mime = /^[\w.+-]+\/[\w.+-]+$/u.test(declaredType) ? declaredType : mimeFromName(name);
  const size = Number.isSafeInteger(block.size) && block.size >= 0 ? block.size :
    Number.isSafeInteger(block.bytes) && block.bytes >= 0 ? block.bytes : null;
  const blobId = /^[a-f0-9]{64}$/u.test(String(block.blob_id ?? block.blobId ?? ''))
    ? String(block.blob_id ?? block.blobId) : null;
  if (!blobPath && !blobId) return null;
  return {
    type: String(block.type ?? 'file'),
    blobPath,
    blobId,
    name,
    mediaType: mime,
    size,
  };
}

export function mediaCandidatesFromRecord(record, transcriptPath) {
  const output = [];
  const seen = new Set();
  const walk = (value, depth = 0) => {
    if (depth > 30 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const type = String(value.type ?? '');
    const candidate = MEDIA_TYPES.has(type) || Object.hasOwn(value, 'blob_path') ||
      Object.hasOwn(value, 'blobPath') ? mediaCandidate(value, transcriptPath) : null;
    if (candidate) {
      const key = `${candidate.blobPath ?? ''}\0${candidate.blobId ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push(candidate);
      }
      return;
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(record);
  return output;
}

export function titleFromRecord(record) {
  if (record?.type !== 'ai-title') return null;
  const title = String(record.aiTitle ?? record.title ?? '').trim();
  return title && title.length <= 200 ? title : null;
}

export function firstUserText(record) {
  if (record?.type !== 'message' || record.role !== 'user' || !Array.isArray(record.content)) return null;
  const text = record.content
    .filter(block => ['input_text', 'text'].includes(block?.type) && typeof block.text === 'string')
    .map(block => block.text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu, '')
      .replace(/<user_query>([\s\S]*?)<\/user_query>/iu, '$1'))
    .join('\n').trim();
  return text ? text.slice(0, 80) : null;
}

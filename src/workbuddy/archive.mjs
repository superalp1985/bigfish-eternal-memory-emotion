import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { hash } from '../memory-store.mjs';
import { mediaKind } from '../media-store.mjs';
import {
  firstUserText, mediaCandidatesFromRecord, parseTranscriptLine, readTranscriptLines, titleFromRecord,
} from './transcript.mjs';

const REVISION_BASE = 1_000_000_000_000;

function offsetKey(sessionId) {
  return `workbuddy-offset:${sessionId}`;
}

function ensureSession(store, sessionId, transcriptPath) {
  try {
    return store.getSession(sessionId);
  } catch {
    try {
      return store.createSession(sessionId, `WorkBuddy ${basename(transcriptPath, '.jsonl').slice(0, 8)}`, {
        platform: 'workbuddy', transcriptPath,
      });
    } catch (error) {
      if (!/UNIQUE|constraint/iu.test(error.message)) throw error;
      return store.getSession(sessionId);
    }
  }
}

async function importMedia(mediaStore, candidate) {
  if (!candidate.blobPath) throw new Error('WorkBuddy media blob path is unavailable');
  const stat = statSync(candidate.blobPath);
  const ref = await mediaStore.putFile(candidate.blobPath, {
    name: candidate.name,
    mediaType: candidate.mediaType,
    kind: mediaKind(candidate.mediaType, candidate.type === 'input_image' ? 'image' : 'file'),
  });
  return {
    ...ref,
    sourceBlobId: candidate.blobId,
    sourcePath: candidate.blobPath,
    declaredBytes: candidate.size,
    sourceBytes: stat.size,
  };
}

function eventType(result) {
  return result.ok ? `workbuddy/${String(result.record?.type ?? 'unknown')}` : 'workbuddy/invalid';
}

async function appendArchiveEvent(store, sessionId, event) {
  try {
    return { appended: await store.appendEvent(sessionId, 0, event), seq: event.seq };
  } catch (error) {
    if (!/conflict/iu.test(error.message)) throw error;
    const existing = store.getEvent(sessionId, event.seq, 0);
    if (existing?.event?.workbuddy?.lineSha256 === event.workbuddy.lineSha256) {
      return { appended: false, seq: event.seq };
    }
    const revision = REVISION_BASE + (Number.parseInt(hash(event.raw).slice(0, 12), 16) % 1_000_000_000);
    const revised = { ...event, seq: revision };
    return { appended: await store.appendEvent(sessionId, 0, revised), seq: revision };
  }
}

export async function archiveTranscript({
  store, mediaStore, sessionId, transcriptPath, maxRecords = Infinity,
}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) throw new Error('Transcript path is required');
  if (!Number.isSafeInteger(maxRecords) && maxRecords !== Infinity) throw new Error('Invalid archive limit');
  const size = statSync(transcriptPath).size;
  ensureSession(store, sessionId, transcriptPath);
  const key = offsetKey(sessionId);
  const saved = store.getMeta(key);
  let offset = Number.isSafeInteger(saved?.offset) && saved.offset >= 0 ? saved.offset : 0;
  let line = Number.isSafeInteger(saved?.nextLine) && saved.nextLine >= 0 ? saved.nextLine : 0;
  if (saved?.path !== transcriptPath || offset > size) {
    offset = 0;
    line = 0;
  }
  let records = 0;
  let events = 0;
  let duplicateEvents = 0;
  let mediaObjects = 0;
  let mediaErrors = 0;
  let latestTitle = null;
  let derivedTitle = null;
  let lastOffset = offset;
  let lastLine = line;
  const startedAt = Date.now();

  for await (const item of readTranscriptLines(transcriptPath, { offset, line })) {
    if (records >= maxRecords) break;
    const parsed = parseTranscriptLine(item.raw, item.line);
    const lineSha256 = hash(item.raw);
    const record = parsed.ok ? parsed.record : {
      type: 'invalid', parseError: parsed.error,
    };
    const title = parsed.ok ? titleFromRecord(parsed.record) : null;
    if (title) latestTitle = title;
    if (!derivedTitle && parsed.ok) derivedTitle = firstUserText(parsed.record);

    const workbuddyMedia = [];
    const workbuddyMediaErrors = [];
    if (parsed.ok) {
      for (const candidate of mediaCandidatesFromRecord(parsed.record, transcriptPath)) {
        try {
          const ref = await importMedia(mediaStore, candidate);
          workbuddyMedia.push(ref);
          mediaObjects++;
        } catch (error) {
          mediaErrors++;
          workbuddyMediaErrors.push({
            blobPath: candidate.blobPath, blobId: candidate.blobId,
            name: candidate.name, error: error.message,
          });
        }
      }
    }

    const event = {
      seq: item.line,
      type: eventType(parsed),
      data: record,
      raw: item.raw,
      workbuddy: {
        sessionId,
        transcriptPath,
        line: item.line,
        offset: item.offset,
        lineSha256,
        recordType: String(record.type ?? 'unknown'),
        timestamp: record.timestamp ?? null,
      },
      ...(workbuddyMedia.length ? { workbuddyMedia } : {}),
      ...(workbuddyMediaErrors.length ? { workbuddyMediaErrors } : {}),
    };
    const result = await appendArchiveEvent(store, sessionId, event);
    if (result.appended) events++;
    else duplicateEvents++;
    records++;
    lastOffset = item.nextOffset;
    lastLine = item.line + 1;
    store.setMeta(key, {
      path: transcriptPath, offset: lastOffset, nextLine: lastLine,
      fileSize: size, updatedAt: new Date().toISOString(),
    });
  }

  if (latestTitle) store.updateSessionTitle(sessionId, latestTitle);
  else {
    const session = store.getSession(sessionId);
    if (derivedTitle && (/^WorkBuddy /u.test(session.title) || session.title === 'New conversation')) {
      store.updateSessionTitle(sessionId, derivedTitle);
    }
  }
  store.setMeta(key, {
    path: transcriptPath, offset: lastOffset, nextLine: lastLine,
    fileSize: size, updatedAt: new Date().toISOString(),
  });
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    records,
    events,
    duplicate_events: duplicateEvents,
    media_objects: mediaObjects,
    media_errors: mediaErrors,
    offset: lastOffset,
    next_line: lastLine,
    bytes: size,
    duration_ms: Date.now() - startedAt,
  };
}

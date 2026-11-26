import {Message,Batch} from '../contracts/contract.mjs';
export {Message,Batch} from '../contracts/contract.mjs';

export class SyncError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

/** Explicit source adapter for inline-content V2 rows. Never forward raw JSON. */
export function projectMessage(row) {
  if (!row || !['user', 'assistant'].includes(row.type)) return null;
  let data;
  try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; }
  catch { throw new SyncError('unsupported_source_message', 422); }
  if (!data || typeof data !== 'object') throw new SyncError('unsupported_source_message', 422);
  let text;
  if (row.type === 'user') {
    if (typeof data.text !== 'string') throw new SyncError('unsupported_source_user', 422);
    text = data.text;
  } else {
    // Missing content can indicate the newer split-parts schema. Do not silently drop it.
    if (!Array.isArray(data.content)) throw new SyncError('unsupported_source_assistant', 422);
    const parts = [];
    for (const part of data.content) {
      if (!part || typeof part !== 'object') throw new SyncError('unsupported_source_part', 422);
      if (part.type === 'text') {
        if (typeof part.text !== 'string') throw new SyncError('unsupported_source_text', 422);
        parts.push(part.text);
      } else if (part.type !== 'tool' && part.type !== 'reasoning') {
        throw new SyncError('unsupported_source_part', 422);
      }
    }
    text = parts.join('\n');
  }
  if (!text.trim()) return null;
  const result = Message.safeParse({ id: row.id, role: row.type, order: row.seq,
    created_at: row.time_created, updated_at: row.time_updated, text });
  if (!result.success) throw new SyncError('unsupported_source_message', 422);
  return result.data;
}

export function parseBatch(value) {
  const parsed = Batch.safeParse(value);
  // Never include zod's errors/input in an HTTP response or log.
  if (!parsed.success) throw new SyncError('invalid_batch', 400);
  return parsed.data;
}

/** Same bytes on the Mac and in the Worker. A verify mismatch means the copies differ. */
export function projectionText(state, messages) {
  // No cursor: it moves on events that change no visible text. The Mac compares pointers itself.
  const head = [
    `archived=${Boolean(state?.archived)}`,
    `deleted=${Boolean(state?.deleted)}`,
    `title=${state?.title ?? ''}`,
    `visible_before=${state?.visible_before ?? ''}`,
  ];
  const body = [...messages]
    .sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)))
    .map(m => `${m.id}\t${m.order}\t${m.role}\t${m.text}`);
  return [...head, ...body].join('\n');
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function digest(value) {
  const bytes = typeof value === 'string' ? value : canonical(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes))), n => n.toString(16).padStart(2, '0')).join('');
}

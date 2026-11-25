// Generated. Edit the .mts source, not this file.
// The only hand-written bridge wire contract. Generate Rust/JSON Schema with
// npm run contracts:generate. Never add a second validator or wire DTO elsewhere.
import { z } from 'zod';
export const limits = { cursorBatch: 1000, cursorMax: 4000, batchChunk: 400, batchMessages: 500, snapshotStatuses: 1000, artifactBytes: 512_000 };
export const routes = { runtime: '/v1/connector/runtime', checked: '/v1/connector/checked', poll: '/v1/connector/poll', lease: '/v1/connector/lease', ack: '/v1/connector/ack', startLease: '/v1/connector/start-lease', startAck: '/v1/connector/start-ack', cursors: '/v1/sync/cursors', verify: '/v1/sync/verify', batches: '/v1/sync/batches', artifact: '/v1/artifacts', pairStart: '/pair/start', pairToken: '/pair/token' };
const id = z.string().min(1).max(200);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const operation = z.string().regex(/^[A-Za-z0-9_-]{8,160}$/);
export const Status = z.enum(['working', 'needs_you', 'done', 'scheduled', 'unknown']).meta({ id: 'Status' });
export const statusRank = { needs_you: 0, working: 1, unknown: 2, scheduled: 3, done: 4 };
export const Completion = z.enum(['unconfirmed', 'task_done', 'project_done']).default('unconfirmed').meta({ id: 'Completion' });
export const Reason = z.enum(['question', 'approval', 'failed', 'reply']).meta({ id: 'Reason' });
export const Health = z.enum(['running', 'idle', 'potentially_stalled', 'failed', 'unknown']).default('unknown').meta({ id: 'Health' });
export const ProgressKind = z.enum(['tool', 'shell', 'text']).meta({ id: 'ProgressKind' });
export const InFlight = z.enum(['tool', 'shell']).meta({ id: 'InFlight' });
export const RuntimeStatus = z.object({
    session_id: id, status: Status, completion: Completion, reason: Reason.nullable(),
    updated_at: counter, can_message: z.boolean(), last_user_message_id: id.nullable().default(null),
    last_user_ms: counter.default(0), top_level: z.boolean().default(true), attention_assessed: z.boolean().default(false),
    directory: z.string().min(1).max(4096).nullable().default(null), health: Health,
    turn_started_at: counter.nullable().optional(), last_progress_at: counter.nullable().optional(),
    last_progress_kind: ProgressKind.nullable().optional(), in_flight: InFlight.nullable().optional(),
}).strict().meta({ id: 'RuntimeStatus' });
export const DashboardCategory = z.enum(['needs_input', 'working', 'task_done', 'project_done', 'idle', 'ready_for_review', 'scheduled', 'paused', 'unknown']).meta({ id: 'DashboardCategory' });
export const DashboardSession = z.object({ id, session_id: id, title: z.string().max(1000), provider: z.string().max(100), directory: z.string().max(4096), directory_id: z.string().max(4100), directory_path: z.string().max(4096), directory_label: z.string().max(4096), category: DashboardCategory, group_key: z.string().max(4096), listed: z.boolean() }).strict().meta({ id: 'DashboardSession' });
export const DashboardGroup = z.object({ key: z.string().max(4096), label: z.string().max(4096), total: counter, listed: counter }).strict().meta({ id: 'DashboardGroup' });
export const DashboardSnapshot = z.object({ dashboard_id: id, captured_at: counter, terminal_title: z.string().max(4096), filter: z.string().max(4096), view: z.enum(['status', 'directory']), partial: z.boolean(), sessions: z.array(DashboardSession).max(1000), groups: z.array(DashboardGroup).max(1000) }).strict().meta({ id: 'DashboardSnapshot' });
export const RuntimeSnapshot = z.object({ available: z.boolean(), partial: z.boolean(), truncated: z.boolean().default(false), statuses: z.array(RuntimeStatus).max(limits.snapshotStatuses), dashboard: DashboardSnapshot.optional() }).strict().meta({ id: 'RuntimeSnapshot' });
export const ObservedRuntimeSnapshot = RuntimeSnapshot.extend({ checked_at: counter.nullable().default(null) }).meta({ id: 'ObservedRuntimeSnapshot' });
export const Role = z.enum(['user', 'assistant']).meta({ id: 'Role' });
export const BatchKind = z.enum(['baseline', 'delta', 'replace']).meta({ id: 'BatchKind' });
export const AckStatus = z.enum(['accepted', 'needs_confirmation', 'failed']).meta({ id: 'AckStatus' });
export const StartAckStatus = z.enum(['started', 'created_not_started', 'failed', 'uncertain']).meta({ id: 'StartAckStatus' });
export const Message = z.object({ id, role: Role, order: counter, created_at: counter, updated_at: counter, text: z.string().max(1_000_000) }).strict().meta({ id: 'Message' });
export const Session = z.object({ title: z.string().max(1000), archived: z.boolean(), visible_before: counter.nullable(), deleted: z.boolean() }).strict().meta({ id: 'Session' });
export const BatchShape = z.object({ version: z.literal(1), batch_id: id, session_id: id, kind: BatchKind, from: counter, through: counter,
    upload_id: id.optional(), chunk: counter.optional(), complete: z.boolean().optional(), session: Session, messages: z.array(Message).max(limits.batchMessages), delete_ids: z.array(id).max(limits.batchMessages),
}).strict().meta({ id: 'Batch' });
export const Batch = BatchShape.superRefine((b, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'invalid_batch' });
    if (b.kind === 'baseline' || b.kind === 'replace') {
        if (!b.upload_id || b.chunk === undefined || b.complete === undefined || b.from !== 0 || b.delete_ids.length)
            fail();
    }
    else {
        if (b.through <= b.from)
            fail();
        if ([b.upload_id, b.chunk, b.complete].some(v => v !== undefined) && (!b.upload_id || b.chunk === undefined || b.complete === undefined))
            fail();
    }
    const ids = b.messages.map(m => m.id);
    if (new Set(ids).size !== ids.length || new Set(b.delete_ids).size !== b.delete_ids.length || ids.some(i => b.delete_ids.includes(i)))
        fail();
    if (b.session.deleted && (b.messages.length || b.delete_ids.length))
        fail();
});
export const ReadContext = z.object({ version: z.literal(1), anchor_order: z.number().int().min(-1), anchor_bytes: counter.max(1_000_000), prefix_hash: z.string().regex(/^[a-f0-9]{64}$/), visible_before: counter.nullable() }).strict().meta({ id: 'ReadContext' });
export const CursorPointer = z.object({ session_id: id, cursor: counter }).strict().meta({ id: 'CursorPointer' });
export const CursorRequest = z.object({ sessions: z.array(CursorPointer).max(limits.cursorMax) }).strict().meta({ id: 'CursorRequest' });
export const CheckedRequest = z.object({ complete: z.boolean().optional(), skipped: counter.optional(), behind: counter.max(100_000).optional(), behind_since: counter.nullable().optional() }).strict().meta({ id: 'CheckedRequest' });
export const EmptyRequest = z.object({}).strict().meta({ id: 'EmptyRequest' });
export const AckRequest = z.object({ operation_id: id, message_id: id, status: AckStatus }).strict().meta({ id: 'AckRequest' });
export const StartAckRequest = z.object({ operation_id: id, status: StartAckStatus, session_id: id.nullable(), reason: z.string().regex(/^[a-z_]{1,40}$/).nullable() }).strict().meta({ id: 'StartAckRequest' });
export const VerifyRequest = z.object({ session_id: id, hash: z.string().regex(/^[a-f0-9]{32}$/), cursor: counter.optional(), count: counter.optional() }).strict().meta({ id: 'VerifyRequest' });
export const PairStart = z.object({ device_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), database_epoch: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), label: z.string().max(100) }).strict().meta({ id: 'PairStart' });
export const PairToken = z.object({ device_code: z.string() }).strict().meta({ id: 'PairToken' });
export const MimeType = z.enum(['text/html', 'text/plain', 'image/png', 'image/jpeg', 'application/pdf', 'application/zip']).meta({ id: 'MimeType' });
export const ArtifactUpload = z.object({ artifact_id: z.string().regex(/^[a-f0-9]{32}$/), session_id: id, title: z.string().trim().min(1).max(160),
    name: z.string().min(1).max(160).regex(/^[^/\\\x00-\x1f\x7f]+$/).refine(n => n !== '.' && n !== '..'), mime_type: MimeType,
    blob: z.string().min(4).max(Math.ceil(limits.artifactBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), confirmed: z.literal(true),
}).strict().meta({ id: 'ArtifactUpload' });
// MCP advertises these same schemas and parses them before a typed handler runs.
// Keep input defaults here, not in a second registration-site schema.
export const toolInputs = {
    list_visible_sessions: z.object({ directory: z.string().min(1).max(4100).optional(), include_scheduled_and_paused: z.boolean().default(false) }),
    list_artifacts: z.object({ session_id: id }),
    preview_artifact: z.object({ artifact_id: id }),
    mac_presence: z.object({}), new_since_last_check: z.object({}),
    list_sessions: z.object({ status: z.enum(['all', 'active', ...Status.options]).default('all'), view: z.enum(['recent', 'all']).default('recent'), query: z.string().max(100).default(''), after: z.string().max(200).default(''), limit: z.number().int().min(1).max(50).default(14), detail: z.boolean().default(false) }),
    session_health: z.object({ session_id: id }),
    session_brief: z.object({ session_id: id.optional(), query: z.string().min(1).max(100).optional() }),
    search_history: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(30).default(8), excerpt_chars: z.number().int().min(100).max(2000).default(400), offset: z.number().int().min(0).max(500).default(0) }),
    read_session: z.object({ session_id: id, after: z.number().int().min(-1).optional(), before: counter.optional(), limit: z.number().int().min(1).max(20).default(10) }),
    read_message: z.object({ session_id: id, message_id: id, offset: z.number().int().min(0).max(1_000_000).default(0) }),
    send_session_message: z.object({ operation_id: operation, session_id: id, text: z.string().min(1).max(50_000), base_cursor: counter, context: ReadContext.optional(), confirmed: z.literal(true) }),
    message_status: z.object({ operation_id: id }), cancel_message: z.object({ operation_id: id, confirmed: z.literal(true) }),
    start_session: z.object({ operation_id: operation, directory: z.string().min(2).max(1024), text: z.string().min(1).max(50_000), confirmed: z.literal(true) }),
    start_status: z.object({ operation_id: id }), cancel_start: z.object({ operation_id: id, confirmed: z.literal(true) }),
};
export const wireSchemas = { RuntimeSnapshot, Message, Session, Batch: BatchShape, ReadContext, CursorPointer, CursorRequest, CheckedRequest, EmptyRequest, AckRequest, StartAckRequest, VerifyRequest, PairStart, PairToken, ArtifactUpload };

// Generated. Edit the .mts source, not this file.
import { z } from 'zod';
import { ReadContext, SnapshotTrace, Status, Health, Reason, DashboardCategory, VisibilityAction, routes } from './contract.mjs';
const id = z.string().min(1).max(200), counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Consumers tolerate additive response fields, but known fields never change type.
const object = (shape) => z.object(shape);
export const OkResponse = object({ ok: z.literal(true) }).meta({ id: 'OkResponse' });
export const PairStartResponse = object({ device_code: z.string().min(1), verification_uri: z.string().url(), expires_in: counter, interval: counter }).meta({ id: 'PairStartResponse' });
export const PairTokenResponse = object({ access_token: z.string().min(1), token_type: z.literal('Bearer'), expires_at: counter, owner_id: z.string(), device_id: id, database_epoch: id }).meta({ id: 'PairTokenResponse' });
export const BatchResponse = object({ batch_id: id, session_id: id, committed: z.boolean(), through: counter.nullable(), next_chunk: counter.nullable() }).meta({ id: 'BatchResponse' });
export const CursorsResponse = object({ mismatch: z.array(id) }).meta({ id: 'CursorsResponse' });
export const VerifyResponse = object({ session_id: id, match: z.boolean(), reason: z.enum(['missing', 'match', 'differs']), cloud_cursor: counter.optional(), cloud_count: counter.optional() }).meta({ id: 'VerifyResponse' });
export const RuntimeAlert = object({ incident: counter, stale_for_ms: counter }).meta({ id: 'RuntimeAlert' });
export const PollResponse = object({ pending: z.boolean(), generation: counter, active_until: counter, runtime_alert: RuntimeAlert.nullable().optional(), probe: object({ probe_id: id, session_id: id }).nullable().optional() }).meta({ id: 'PollResponse' });
export const MessageLease = object({ operation_id: id, session_id: id, message_id: id, text: z.string().min(1).max(50_000), base_cursor: counter, expires_at: counter, context: ReadContext.nullable().optional() }).meta({ id: 'MessageLease' });
export const ConfirmationLease = object({ needs_confirmation: id }).meta({ id: 'ConfirmationLease' });
export const VisibilityLease = object({ operation_id: id, session_id: id, message_id: id, action: VisibilityAction, expires_at: counter }).meta({ id: 'VisibilityLease' });
export const LeaseResponse = object({ message: z.union([MessageLease, ConfirmationLease]).nullable(), visibility: VisibilityLease.optional() }).meta({ id: 'LeaseResponse' });
export const StartLease = object({ operation_id: id, directory: z.string(), text: z.string(), expires_at: counter }).meta({ id: 'StartLease' });
export const StartLeaseResponse = object({ start: StartLease.nullable() }).meta({ id: 'StartLeaseResponse' });
export const DeliveryStatus = z.enum(['queued', 'leased', 'accepted', 'needs_confirmation', 'failed', 'expired', 'uncertain', 'cancelled']).meta({ id: 'DeliveryStatus' });
export const StartStatus = z.enum(['queued', 'leased', 'started', 'created_not_started', 'failed', 'expired', 'uncertain', 'cancelled']).meta({ id: 'StartStatus' });
export const ReceiptResponse = object({ operation_id: id, session_id: id, status: DeliveryStatus, message_id: id, expires_at: counter, delivery_confirmed: z.boolean(), next_action: z.string().nullable() }).meta({ id: 'ReceiptResponse' });
export const StartReceiptResponse = object({ operation_id: id, status: StartStatus, directory: z.string(), session_id: id.nullable(), started: z.boolean(), prompt_accepted: z.boolean(), reason: z.string().nullable(), expires_at: counter, next_action: z.string().nullable() }).meta({ id: 'StartReceiptResponse' });
export const ArtifactResponse = object({ artifact_id: id, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: counter }).meta({ id: 'ArtifactResponse' });
const artifactMetadata = object({ artifact_id: id, session_id: id, title: z.string(), name: z.string(), mime_type: z.string(), byte_length: counter, sha256: z.string() }).passthrough();
export const nativeSchemas = { OkResponse, PairStartResponse, PairTokenResponse, BatchResponse, CursorsResponse, VerifyResponse, PollResponse, LeaseResponse, MessageLease, VisibilityLease, StartLeaseResponse, ReceiptResponse, StartReceiptResponse, ArtifactResponse };
export const responseByRoute = {
    [routes.checked]: OkResponse, [routes.runtime]: OkResponse, [routes.probe]: OkResponse, [routes.poll]: PollResponse, [routes.lease]: LeaseResponse, [routes.startLease]: StartLeaseResponse,
    [routes.ack]: ReceiptResponse, [routes.startAck]: StartReceiptResponse, [routes.cursors]: CursorsResponse, [routes.verify]: VerifyResponse,
    [routes.batches]: BatchResponse, [routes.artifact]: ArtifactResponse, [routes.pairStart]: PairStartResponse, [routes.pairToken]: PairTokenResponse,
};
// Extensions preserve existing rich read results. Each tool has a distinct typed
// envelope; schemas validate critical nested fields and do not discard metadata.
const extensible = (shape) => z.object(shape).passthrough();
const freshness = { source_checked_at: counter.nullable().optional(), mac_seen_recently: z.boolean().optional(), history_fresh: z.boolean().optional() };
const row = extensible({ session_id: id, title: z.string(), status: Status, health: Health.optional() });
const message = extensible({ message_id: id, role: z.enum(['user', 'assistant']), message_order: counter, text: z.string(), truncated: z.boolean().optional(), offset: counter.optional() });
const delivery = ReceiptResponse.extend({ delivery_state: z.string(), claim_ceiling: z.string(), say_to_owner: z.string(), report_rule: z.string(), ...freshness }).passthrough();
const start = StartReceiptResponse.extend({ delivery_state: z.string(), claim_ceiling: z.string(), say_to_owner: z.string(), report_rule: z.string(), ...freshness }).passthrough();
const visibility = object({ operation_id: id, session_id: id, action: VisibilityAction, status: z.enum(['queued', 'applied', 'failed', 'expired', 'uncertain']), say_to_owner: z.string() });
const categoryCounts = z.record(z.string(), counter);
const messageTruncation = object({ truncated: z.literal(true), message_id: id, offset: counter });
const voiceSession = z.object({ id, title: z.string(), status: DashboardCategory, user: z.string().nullable(), agent: z.string().nullable(), user_truncation: messageTruncation.optional(), agent_truncation: messageTruncation.optional(), review: z.literal(true).optional() }).strict();
const directoryGroup = z.object({ path: z.string(), label: z.string(), counts: categoryCounts, sessions: z.array(voiceSession), working: z.array(voiceSession) }).strict();
export const toolOutputs = {
    list_visible_sessions: z.object({ counts: categoryCounts.nullable(), directories: z.array(directoryGroup), warning: z.string().optional() }).strict(),
    snapshot_diagnostics: z.object({ state: z.enum(['fresh', 'stale', 'unavailable']), reasons: z.array(z.string()), checked_at: counter, runtime_stored_at: counter.nullable(), last_mac_seen_at: counter.nullable(), snapshot_captured_at: counter.nullable(), snapshot_stored_at: counter.nullable(), session_count: counter.nullable(), connector: SnapshotTrace.nullable() }).strict(),
    list_artifacts: extensible({ artifacts: z.array(artifactMetadata) }),
    mac_presence: extensible({ bridge: z.enum(['online', 'offline', 'unknown']), internet: z.enum(['reachable', 'unknown']), history_sync: z.enum(['fresh', 'stale', 'partial', 'unknown']), last_heartbeat_at: counter.nullable(), last_successful_sync_at: counter.nullable() }),
    new_since_last_check: extensible({ available: z.boolean(), changes: z.array(extensible({ session_id: id, change: z.enum(['needs_you', 'finished']), reason: Reason.nullable() })), note: z.string() }),
    list_sessions: z.union([extensible({ sessions: z.array(row).length(0), counts: z.null(), partial: z.literal(true), status_fresh: z.literal(false), note: z.string() }), extensible({ sessions: z.array(row), counts: extensible({ total: counter, working: counter, needs_you: counter, done: counter, scheduled: counter, unknown: counter }), status_fresh: z.boolean(), status_observed_at: counter.nullable(), next_after: z.string().nullable(), ...freshness })]),
    session_health: z.union([extensible({ found: z.literal(false), health: z.literal('unknown'), health_live: z.literal(false), note: z.string() }), extensible({ found: z.literal(true), session_id: id, status: Status, health: Health, health_live: z.boolean() })]),
    session_brief: z.union([extensible({ found: z.literal(false), note: z.string() }), extensible({ found: z.literal(true), session: row, transcript: z.array(message), data_age: extensible({ status_fresh: z.boolean(), context_fresh: z.boolean(), caveat: z.string().nullable() }), send_params: object({ session_id: id, base_cursor: counter, context: ReadContext }).nullable() })]),
    search_history: extensible({ matches: z.array(extensible({ session_id: id, message_id: id, role: z.enum(['user', 'assistant']), excerpt: z.string(), excerpt_offset: counter })), ...freshness }),
    read_session: extensible({ messages: z.array(message), cursor: counter, context: ReadContext, page_kind: z.enum(['older', 'newer', 'latest']), next_after: counter.nullable(), next_before: counter.nullable(), ...freshness }),
    read_message: extensible({ message_id: id, role: z.enum(['user', 'assistant']), text: z.string(), offset: counter, next_offset: counter.nullable(), ...freshness }),
    send_session_message: delivery, message_status: delivery, cancel_message: delivery,
    hide_session: visibility, unhide_session: visibility, session_visibility_status: visibility,
    start_session: start, start_status: start, cancel_start: start,
};

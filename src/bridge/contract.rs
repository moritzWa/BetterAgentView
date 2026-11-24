// Generated from bridge/contracts/contract.mts. Do not edit.
pub const CURSOR_BATCH: usize = 1000;
pub const CURSOR_MAX: usize = 4000;
pub const BATCH_CHUNK: usize = 400;
pub const BATCH_MESSAGES: usize = 500;
pub const SNAPSHOT_STATUSES: usize = 1000;
pub const ARTIFACT_BYTES: usize = 512000;
pub const ROUTE_RUNTIME: &str = "/v1/connector/runtime";
pub const ROUTE_CHECKED: &str = "/v1/connector/checked";
pub const ROUTE_POLL: &str = "/v1/connector/poll";
pub const ROUTE_LEASE: &str = "/v1/connector/lease";
pub const ROUTE_ACK: &str = "/v1/connector/ack";
pub const ROUTE_START_LEASE: &str = "/v1/connector/start-lease";
pub const ROUTE_START_ACK: &str = "/v1/connector/start-ack";
pub const ROUTE_CURSORS: &str = "/v1/sync/cursors";
pub const ROUTE_VERIFY: &str = "/v1/sync/verify";
pub const ROUTE_BATCHES: &str = "/v1/sync/batches";
pub const ROUTE_ARTIFACT: &str = "/v1/artifacts";
pub const ROUTE_PAIR_START: &str = "/pair/start";
pub const ROUTE_PAIR_TOKEN: &str = "/pair/token";
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct BridgeContracts {
    pub ack_request: AckRequest,

    pub artifact_response: ArtifactResponse,

    pub artifact_upload: ArtifactUpload,

    pub batch: Batch,

    pub batch_response: BatchResponse,

    pub checked_request: CheckedRequest,

    pub cursor_pointer: CursorPointer,

    pub cursor_request: CursorRequest,

    pub cursors_response: CursorsResponse,

    pub empty_request: EmptyRequest,

    pub lease_response: LeaseResponse,

    pub message: Message,

    pub message_lease: MessageLease,

    pub ok_response: OkResponse,

    pub pair_start: PairStart,

    pub pair_start_response: PairStartResponse,

    pub pair_token: PairToken,

    pub pair_token_response: PairTokenResponse,

    pub poll_response: PollResponse,

    pub read_context: ReadContext,

    pub receipt_response: ReceiptResponse,

    pub runtime_snapshot: RuntimeSnapshot,

    pub session: Session,

    pub start_ack_request: StartAckRequest,

    pub start_lease_response: StartLeaseResponse,

    pub start_receipt_response: StartReceiptResponse,

    pub verify_request: VerifyRequest,

    pub verify_response: VerifyResponse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AckRequest {
    pub message_id: String,

    pub operation_id: String,

    pub status: AckStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AckStatus {
    Accepted,

    Failed,

    #[serde(rename = "needs_confirmation")]
    NeedsConfirmation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactResponse {
    pub artifact_id: String,

    pub bytes: i64,

    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactUpload {
    pub artifact_id: String,

    pub blob: String,

    pub confirmed: bool,

    pub mime_type: MimeType,

    pub name: String,

    pub session_id: String,

    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MimeType {
    #[serde(rename = "application/pdf")]
    ApplicationPdf,

    #[serde(rename = "application/zip")]
    ApplicationZip,

    #[serde(rename = "image/jpeg")]
    ImageJpeg,

    #[serde(rename = "image/png")]
    ImagePng,

    #[serde(rename = "text/html")]
    TextHtml,

    #[serde(rename = "text/plain")]
    TextPlain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub batch_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,

    pub delete_ids: Vec<String>,

    pub from: i64,

    pub kind: BatchKind,

    pub messages: Vec<Message>,

    pub session: Session,

    pub session_id: String,

    pub through: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,

    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchKind {
    Baseline,

    Delta,

    Replace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub created_at: i64,

    pub id: String,

    pub order: i64,

    pub role: Role,

    pub text: String,

    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Assistant,

    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub archived: bool,

    pub deleted: bool,

    pub title: String,

    #[serde(deserialize_with = "required_nullable")]
    pub visible_before: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BatchResponse {
    pub batch_id: String,

    pub committed: bool,

    #[serde(deserialize_with = "required_nullable")]
    pub next_chunk: Option<i64>,

    pub session_id: String,

    #[serde(deserialize_with = "required_nullable")]
    pub through: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckedRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind_since: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CursorPointer {
    pub cursor: i64,

    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CursorRequest {
    pub sessions: Vec<CursorPointer>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorsResponse {
    pub mismatch: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeaseResponse {
    #[serde(deserialize_with = "required_nullable")]
    pub message: Option<Lease>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lease {
    pub base_cursor: Option<i64>,

    pub context: Option<ReadContext>,

    pub expires_at: Option<i64>,

    pub message_id: Option<String>,

    pub operation_id: Option<String>,

    pub session_id: Option<String>,

    pub text: Option<String>,

    pub needs_confirmation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadContext {
    pub anchor_bytes: i64,

    pub anchor_order: i64,

    pub prefix_hash: String,

    pub version: i64,

    #[serde(deserialize_with = "required_nullable")]
    pub visible_before: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageLease {
    pub base_cursor: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ReadContext>,

    pub expires_at: i64,

    pub message_id: String,

    pub operation_id: String,

    pub session_id: String,

    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairStart {
    pub database_epoch: String,

    pub device_id: String,

    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairStartResponse {
    pub device_code: String,

    pub expires_in: i64,

    pub interval: i64,

    pub verification_uri: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairToken {
    pub device_code: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairTokenResponse {
    pub access_token: String,

    pub database_epoch: String,

    pub device_id: String,

    pub expires_at: i64,

    pub owner_id: String,

    pub token_type: TokenType,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TokenType {
    Bearer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PollResponse {
    pub active_until: i64,

    pub generation: i64,

    pub pending: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_alert: Option<RuntimeAlert>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeAlert {
    pub incident: i64,

    pub stale_for_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptResponse {
    pub delivery_confirmed: bool,

    pub expires_at: i64,

    pub message_id: String,

    #[serde(deserialize_with = "required_nullable")]
    pub next_action: Option<String>,

    pub operation_id: String,

    pub session_id: String,

    pub status: DeliveryStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Accepted,

    Cancelled,

    Expired,

    Failed,

    Leased,

    #[serde(rename = "needs_confirmation")]
    NeedsConfirmation,

    Queued,

    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSnapshot {
    pub available: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard: Option<DashboardSnapshot>,

    pub partial: bool,

    pub statuses: Vec<RuntimeStatus>,

    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardSnapshot {
    pub captured_at: i64,

    pub dashboard_id: String,

    pub filter: String,

    pub groups: Vec<DashboardGroup>,

    pub partial: bool,

    pub sessions: Vec<DashboardSession>,

    pub terminal_title: String,

    pub view: View,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardGroup {
    pub key: String,

    pub label: String,

    pub listed: i64,

    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardSession {
    pub category: DashboardCategory,

    pub directory: String,

    pub group_key: String,

    pub id: String,

    pub listed: bool,

    pub provider: String,

    pub session_id: String,

    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DashboardCategory {
    Idle,

    #[serde(rename = "needs_input")]
    NeedsInput,

    Paused,

    #[serde(rename = "project_done")]
    ProjectDone,

    #[serde(rename = "ready_for_review")]
    ReadyForReview,

    Scheduled,

    #[serde(rename = "task_done")]
    TaskDone,

    Unknown,

    Working,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum View {
    Directory,

    Status,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStatus {
    pub attention_assessed: bool,

    pub can_message: bool,

    pub completion: Completion,

    #[serde(deserialize_with = "required_nullable")]
    pub directory: Option<String>,

    pub health: Health,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_flight: Option<InFlight>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress_at: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress_kind: Option<ProgressKind>,

    #[serde(deserialize_with = "required_nullable")]
    pub last_user_message_id: Option<String>,

    pub last_user_ms: i64,

    #[serde(deserialize_with = "required_nullable")]
    pub reason: Option<Reason>,

    pub session_id: String,

    pub status: Status,

    pub top_level: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_started_at: Option<i64>,

    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Completion {
    #[serde(rename = "project_done")]
    ProjectDone,

    #[serde(rename = "task_done")]
    TaskDone,

    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Failed,

    Idle,

    #[serde(rename = "potentially_stalled")]
    PotentiallyStalled,

    Running,

    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InFlight {
    Shell,

    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressKind {
    Shell,

    Text,

    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Approval,

    Failed,

    Question,

    Reply,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Done,

    #[serde(rename = "needs_you")]
    NeedsYou,

    Scheduled,

    Unknown,

    Working,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartAckRequest {
    pub operation_id: String,

    #[serde(deserialize_with = "required_nullable")]
    pub reason: Option<String>,

    #[serde(deserialize_with = "required_nullable")]
    pub session_id: Option<String>,

    pub status: StartAckStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartAckStatus {
    #[serde(rename = "created_not_started")]
    CreatedNotStarted,

    Failed,

    Started,

    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartLeaseResponse {
    #[serde(deserialize_with = "required_nullable")]
    pub start: Option<StartLease>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartLease {
    pub directory: String,

    pub expires_at: i64,

    pub operation_id: String,

    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartReceiptResponse {
    pub directory: String,

    pub expires_at: i64,

    #[serde(deserialize_with = "required_nullable")]
    pub next_action: Option<String>,

    pub operation_id: String,

    pub prompt_accepted: bool,

    #[serde(deserialize_with = "required_nullable")]
    pub reason: Option<String>,

    #[serde(deserialize_with = "required_nullable")]
    pub session_id: Option<String>,

    pub started: bool,

    pub status: StartStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartStatus {
    Cancelled,

    #[serde(rename = "created_not_started")]
    CreatedNotStarted,

    Expired,

    Failed,

    Leased,

    Queued,

    Started,

    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,

    pub hash: String,

    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerifyResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_count: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_cursor: Option<i64>,

    #[serde(rename = "match")]
    pub verify_response_match: bool,

    pub reason: ReasonEnum,

    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasonEnum {
    Differs,

    Match,

    Missing,
}

impl std::str::FromStr for Status {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for Completion {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for Reason {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for Health {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for ProgressKind {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for InFlight {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for DashboardCategory {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for Role {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for BatchKind {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for AckStatus {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for StartAckStatus {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for MimeType {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for DeliveryStatus {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

impl std::str::FromStr for StartStatus {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

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

    pub artifact_upload: ArtifactUpload,

    pub batch: Batch,

    pub checked_request: CheckedRequest,

    pub cursor_pointer: CursorPointer,

    pub cursor_request: CursorRequest,

    pub empty_request: EmptyRequest,

    pub message: Message,

    pub pair_start: PairStart,

    pub pair_token: PairToken,

    pub read_context: ReadContext,

    pub runtime_snapshot: RuntimeSnapshot,

    pub session: Session,

    pub start_ack_request: StartAckRequest,

    pub verify_request: VerifyRequest,
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

    pub visible_before: Option<i64>,
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
#[serde(deny_unknown_fields)]
pub struct EmptyRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairStart {
    pub database_epoch: String,

    pub device_id: String,

    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairToken {
    pub device_code: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadContext {
    pub anchor_bytes: i64,

    pub anchor_order: i64,

    pub prefix_hash: String,

    pub version: i64,

    pub visible_before: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSnapshot {
    pub available: bool,

    pub partial: bool,

    pub statuses: Vec<RuntimeStatus>,

    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStatus {
    pub attention_assessed: bool,

    pub can_message: bool,

    pub completion: Completion,

    pub directory: Option<String>,

    pub health: Health,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_flight: Option<InFlight>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress_at: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress_kind: Option<ProgressKind>,

    pub last_user_message_id: Option<String>,

    pub last_user_ms: i64,

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

    pub reason: Option<String>,

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
#[serde(deny_unknown_fields)]
pub struct VerifyRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,

    pub hash: String,

    pub session_id: String,
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

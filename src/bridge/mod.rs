//! Opt-in private mobile history bridge. The dashboard does not own its lifecycle.
mod artifacts;
mod context;
/// Generated shared bridge wire types.
///
/// ```
/// use agentview::bridge::contract::Status;
/// let _status = Status::Working;
/// ```
///
/// ```compile_fail
/// use agentview::bridge::contract::Status;
/// let _status = Status::InventedStatus;
/// ```
pub mod contract;
mod health;
mod http;
mod journal;
mod runtime;
mod source;
mod start;
#[cfg(test)]
mod tests;
pub use artifacts::publish as publish_artifact;

use anyhow::{bail, Context, Result};
use journal::Journal;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub endpoint: String,
    pub device_id: String,
    pub database_epoch: String,
    pub database: PathBuf,
    pub opencode_bin: String,
    pub keychain_service: String,
    pub inode: u64,
    #[serde(default)]
    pub supervisor_state: Option<PathBuf>,
}
pub fn state_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is missing")?;
    let root = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".local/state"));
    Ok(root.join("agentview/bridge"))
}
fn private_dir(path: &Path) -> Result<()> {
    if path.exists() && std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        bail!("bridge directory cannot be a symlink");
    }
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn random_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| anyhow::anyhow!("secure random source unavailable"))?;
    use std::fmt::Write;
    let mut encoded = String::with_capacity(32);
    for byte in bytes {
        write!(encoded, "{byte:02x}")?;
    }
    Ok(encoded)
}
pub fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn inode(path: &Path) -> Result<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(std::fs::metadata(path)?.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(0)
    }
}
fn load(dir: &Path) -> Result<Config> {
    let config: Config = serde_json::from_slice(&std::fs::read(dir.join("config.json"))?)?;
    if config.version != 1 || config.inode != inode(&config.database)? {
        bail!("source database replaced; re-pair required");
    }
    Ok(config)
}
fn save_token(service: &str, token: &str) -> Result<()> {
    crate::usage::save_bridge_credential(service, token)
        .context("could not save dedicated bridge Keychain item")
}
fn token(config: &Config) -> Result<String> {
    crate::usage::read_bridge_credential(&config.keychain_service)
        .context("bridge Keychain credential unavailable")
}

pub fn pair(
    dir: &Path,
    endpoint: &str,
    bin: &str,
    database: Option<&Path>,
    supervisor_state: Option<&Path>,
) -> Result<()> {
    private_dir(dir)?;
    if dir.join("config.json").exists() {
        bail!("bridge is already paired; disconnect it before replacing the source");
    }
    let db_path = if let Some(path) = database {
        path.canonicalize()?
    } else {
        // Reuse the dashboard's executable/profile-aware, read-only source resolver.
        let (db, v2) = crate::adapters::opencode_db::open_read_only(bin)?;
        if !v2 {
            bail!("OpenCode V2 is required");
        }
        PathBuf::from(db.path().context("OpenCode database path unavailable")?)
    };
    let source = source::open(&db_path)?;
    drop(source);
    let device_id = random_id()?;
    let epoch = random_id()?;
    let started = http::request::<contract::PairStartResponse>(
        endpoint,
        contract::ROUTE_PAIR_START,
        None,
        Some(&serde_json::to_value(contract::PairStart {
            device_id: device_id.clone(),
            database_epoch: epoch.clone(),
            label: std::env::var("USER").unwrap_or_else(|_| "Mac".into()) + " BetterAgentView",
        })?),
        30,
    )?;
    let code = &started.device_code;
    println!(
        "Approve this device in your browser:\n{}",
        started.verification_uri
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    loop {
        match http::request::<contract::PairTokenResponse>(
            endpoint,
            contract::ROUTE_PAIR_TOKEN,
            None,
            Some(&serde_json::to_value(contract::PairToken {
                device_code: code.to_owned(),
            })?),
            30,
        ) {
            Ok(response) => {
                let credential = &response.access_token;
                let service = format!("agentview-bridge-{device_id}");
                save_token(&service, credential)?;
                let config = Config {
                    version: 1,
                    endpoint: endpoint.to_owned(),
                    device_id,
                    database_epoch: epoch,
                    database: db_path.clone(),
                    opencode_bin: bin.to_owned(),
                    keychain_service: service,
                    inode: inode(&db_path)?,
                    supervisor_state: supervisor_state.map(Path::to_path_buf),
                };
                crate::fs_util::write_private_json(&dir.join("config.json"), &config)?;
                println!("Paired. Credential stored in a dedicated Keychain item; no history uploaded yet.");
                return Ok(());
            }
            Err(e)
                if e.to_string() == "bridge HTTP 428" && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_secs(5))
            }
            Err(_) => bail!("pairing failed or expired; retry pairing"),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Health {
    last_ok: u64,
    failing: Vec<Failure>,
    #[serde(default)]
    last_pass_at: u64,
    #[serde(default)]
    last_pass_ms: u64,
    #[serde(default)]
    scanned: usize,
    #[serde(default)]
    uploaded_batches: usize,
}

#[derive(Clone, Serialize, Deserialize)]
struct Failure {
    session_id: String,
    stage: String,
    reason: String,
    since: u64,
    last_try: u64,
    count: u32,
}

/// Seconds to wait before retrying a session that failed `count` times in a row.
/// Short at first so a transient blip on a session in active use heals within a
/// pass or two; long later so a permanently bad session costs almost nothing.
fn retry_after(count: u32) -> u64 {
    match count {
        0 | 1 => 5,
        2 => 15,
        3 => 30,
        4 => 60,
        5 => 120,
        _ => 300,
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn read_health(dir: &Path) -> Health {
    std::fs::read(dir.join("sync-health.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// What an upload failure tells us about whether the cloud applied the batch.
#[derive(Debug, PartialEq)]
enum Fault {
    /// The cloud refused the batch inside its transaction, so nothing was
    /// committed. Retrying the same bytes can never succeed.
    Definite,
    /// The cloud may have committed before it failed or before we saw the receipt.
    /// The same batch must be retried verbatim: the cloud replays its stored
    /// receipt, whereas a rebuilt batch would fail `cursor_gap` forever.
    Ambiguous,
}

fn http_status(message: &str) -> Option<u16> {
    message
        .strip_prefix("bridge HTTP ")?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// A refused delta or baseline means the pointers disagree. A full replace heals it.
fn needs_replace(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.contains("cursor_gap") || text.contains("baseline_already_committed")
}

fn classify(error: &anyhow::Error) -> Option<Fault> {
    let message = error.to_string();
    if let Some(status) = http_status(&message) {
        return match status {
            400 | 409 | 413 | 422 => Some(Fault::Definite),
            500..=599 => Some(Fault::Ambiguous),
            _ => None,
        };
    }
    if message == "invalid sync acknowledgement" {
        return Some(Fault::Ambiguous);
    }
    None
}

/// Short, content-free description for the log and health file.
fn safe_reason(error: &anyhow::Error) -> String {
    let text = format!("{error:#}");
    if text.contains('"') || text.contains('`') || text.contains('/') {
        return "unreadable source data".into();
    }
    text.chars().take(160).collect()
}

type Faults = Vec<(String, &'static str, anyhow::Error)>;

/// Uploads queued batches. A failure that belongs to one session is set aside
/// (held or dropped, per `classify`) so it cannot block other sessions. Anything
/// else (network, auth, rate limit, local disk) is a pass-level error.
fn flush_isolating(journal: &mut Journal, config: &Config, token: &str) -> Result<(usize, Faults)> {
    let mut count = 0;
    let mut faults: Faults = Vec::new();
    while let Some(body) = journal.pending()? {
        let session = body["session_id"].as_str().unwrap_or_default().to_owned();
        let sent = http::request::<contract::BatchResponse>(
            &config.endpoint,
            contract::ROUTE_BATCHES,
            Some(token),
            Some(&body),
            60,
        )
        .and_then(|receipt| journal.ack(&serde_json::to_value(receipt)?));
        match sent {
            Ok(()) => count += 1,
            Err(error) => match classify(&error) {
                Some(Fault::Definite) => {
                    journal.discard_pending(&session)?;
                    faults.push((session, "upload", error));
                }
                Some(Fault::Ambiguous) => {
                    journal.hold_pending(&session)?;
                    faults.push((session, "upload", error));
                }
                None => return Err(error),
            },
        }
    }
    Ok((count, faults))
}

/// Uploads the whole current projection beside the copy the cloud already serves.
/// Reads keep returning the old copy until the last chunk is confirmed.
fn replace_session(
    db: &mut rusqlite::Connection,
    journal: &mut Journal,
    config: &Config,
    credential: &str,
    id: &str,
) -> std::result::Result<usize, (&'static str, anyhow::Error)> {
    let native = source::native(db, id).map_err(|e| ("source", e))?;
    let Some(capture) = source::capture(db, id, None).map_err(|e| ("capture", e))? else {
        return Ok(0);
    };
    journal
        .stage_replace(id, capture, native)
        .map_err(|e| ("stage", e))?;
    let (n, faults) = flush_isolating(journal, config, credential).map_err(|e| ("transport", e))?;
    if let Some((_, stage, error)) = faults.into_iter().next() {
        return Err((stage, error));
    }
    Ok(n)
}

fn sync_session(
    db: &mut rusqlite::Connection,
    journal: &mut Journal,
    config: &Config,
    credential: &str,
    id: &str,
    uploads: &mut usize,
) -> std::result::Result<(), (&'static str, anyhow::Error)> {
    // A batch with an unknown outcome goes first, byte for byte.
    if journal.has_held(id).map_err(|e| ("checkpoint", e))? {
        journal.restore_held(id).map_err(|e| ("checkpoint", e))?;
        let (n, faults) =
            flush_isolating(journal, config, credential).map_err(|e| ("transport", e))?;
        *uploads += n;
        if let Some((_, stage, error)) = faults.into_iter().next() {
            if needs_replace(&error) {
                *uploads += replace_session(db, journal, config, credential, id)?;
                return Ok(());
            }
            return Err((stage, error));
        }
    }
    let old = journal.checkpoint(id).map_err(|e| ("checkpoint", e))?;
    let native = source::native(db, id).map_err(|e| ("source", e))?;
    if let Some(old) = &old {
        if old.native != native {
            return Err((
                "source",
                anyhow::anyhow!("source format changed; re-pair required"),
            ));
        }
        if source::watermark(db, id).map_err(|e| ("source", e))? == old.observed {
            return Ok(());
        }
    }
    let capture =
        source::capture(db, id, old.as_ref().map(|p| p.observed)).map_err(|e| ("capture", e))?;
    if let Some(capture) = capture {
        journal
            .stage(id, capture, native)
            .map_err(|e| ("stage", e))?;
        let (n, faults) =
            flush_isolating(journal, config, credential).map_err(|e| ("transport", e))?;
        *uploads += n;
        if let Some((_, stage, error)) = faults.into_iter().next() {
            if needs_replace(&error) {
                *uploads += replace_session(db, journal, config, credential, id)?;
                return Ok(());
            }
            return Err((stage, error));
        }
    }
    Ok(())
}

pub fn sync_once(dir: &Path) -> Result<usize> {
    sync_pass(dir, true)
}

/// One history pass. `reconcile` also compares every local pointer with the
/// cloud's. That costs one request per 1,000 sessions, which dominated a pass
/// that otherwise only compares local watermarks. The service reconciles on its
/// idle cadence rather than on every wake from the phone.
fn sync_pass(dir: &Path, reconcile: bool) -> Result<usize> {
    let _pass_span = crate::perf_log::span("bridge-sync-pass");
    let _sync_lock = local_lock(&dir.join("sync.lock"))?;
    let started = std::time::Instant::now();
    let config = load(dir)?;
    let credential = token(&config)?;
    let mut journal = Journal::open(&dir.join("journal.sqlite"))?;
    let previous = read_health(dir);
    let now = now_secs();
    let mut failing: Vec<Failure> = Vec::new();
    let note = |failing: &mut Vec<Failure>, id: &str, stage: &str, error: &anyhow::Error| {
        let before = previous.failing.iter().find(|f| f.session_id == id);
        let count = before.map_or(1, |f| f.count + 1);
        let reason = safe_reason(error);
        if count == 1 || count % 20 == 0 {
            eprintln!(
                "bridge session stuck session={id} stage={stage} attempts={count} reason={reason}"
            );
        }
        failing.retain(|f| f.session_id != id);
        failing.push(Failure {
            session_id: id.to_owned(),
            stage: stage.into(),
            reason,
            since: before.map_or(now, |f| f.since),
            last_try: now,
            count,
        });
    };
    let (mut uploads, queued_faults) = flush_isolating(&mut journal, &config, &credential)?;
    let mut db = source::open(&config.database)?;
    let ids = source::sessions(&db)?.into_iter().collect::<BTreeSet<_>>();
    for (id, stage, error) in queued_faults {
        if needs_replace(&error) && ids.contains(&id) {
            match replace_session(&mut db, &mut journal, &config, &credential, &id) {
                Ok(n) => uploads += n,
                Err(("transport", error)) => return Err(error),
                Err((stage, error)) => note(&mut failing, &id, stage, &error),
            }
        } else {
            note(&mut failing, &id, stage, &error);
        }
    }
    let scan_span = crate::perf_log::span("bridge-sync-scan");
    // Any failure here only means every session takes the per-session path.
    let unchanged = journal
        .observed_marks()
        .and_then(|marks| {
            let held = journal.held_sessions()?.into_iter().collect();
            source::unchanged_native(&db, &marks, &held)
        })
        .unwrap_or_default();
    let mut server_errors = 0;
    for id in &ids {
        if failing.iter().any(|f| &f.session_id == id) {
            continue;
        }
        let before = previous.failing.iter().find(|f| &f.session_id == id);
        if let Some(f) = before {
            if now.saturating_sub(f.last_try) < retry_after(f.count) {
                failing.push(f.clone());
                continue;
            }
        }
        if unchanged.contains(id) {
            continue;
        }
        match sync_session(
            &mut db,
            &mut journal,
            &config,
            &credential,
            id,
            &mut uploads,
        ) {
            Ok(()) => server_errors = 0,
            Err(("transport", error)) => return Err(error),
            Err((stage, error)) => {
                // One session's batch can make the cloud answer 5xx every time,
                // but three in a row across sessions looks like an outage.
                if classify(&error) == Some(Fault::Ambiguous) {
                    server_errors += 1;
                    if server_errors >= 3 {
                        return Err(error);
                    }
                }
                note(&mut failing, id, stage, &error);
            }
        }
    }
    drop(scan_span);
    // A restored journal can look caught up locally while the cloud pointer differs.
    // Compare pointers and replace those sessions. A network failure here is not a stall.
    let _cursor_span = crate::perf_log::span("bridge-sync-cursors");
    if let Ok(local) = if reconcile {
        journal.checkpoints()
    } else {
        Ok(Vec::new())
    } {
        if !local.is_empty() {
            for chunk in local.chunks(CURSOR_BATCH_SIZE) {
                let sessions: Vec<contract::CursorPointer> = chunk
                    .iter()
                    .map(|(id, cursor)| contract::CursorPointer {
                        session_id: id.clone(),
                        cursor: *cursor,
                    })
                    .collect();
                match http::request::<contract::CursorsResponse>(
                    &config.endpoint,
                    contract::ROUTE_CURSORS,
                    Some(&credential),
                    Some(&serde_json::to_value(contract::CursorRequest { sessions })?),
                    60,
                ) {
                    Ok(report) => {
                        for id in &report.mismatch {
                            if !ids.contains(id) || failing.iter().any(|f| f.session_id == *id) {
                                continue;
                            }
                            match replace_session(&mut db, &mut journal, &config, &credential, id) {
                                Ok(n) => uploads += n,
                                Err(("transport", error)) => return Err(error),
                                Err((stage, error)) => note(&mut failing, id, stage, &error),
                            }
                        }
                    }
                    Err(error) => log_unavailable("cursors", &error),
                }
            }
        }
    }
    drop(_cursor_span);
    for id in journal.known()? {
        if !ids.contains(&id) {
            if journal.has_held(&id)? {
                journal.restore_held(&id)?;
                flush_isolating(&mut journal, &config, &credential)?;
            }
            journal.tombstone(&id)?;
            let (n, faults) = flush_isolating(&mut journal, &config, &credential)?;
            uploads += n;
            for (id, stage, error) in &faults {
                note(&mut failing, id, stage, error);
            }
        }
    }
    let health = Health {
        last_ok: if failing.is_empty() {
            now
        } else {
            previous.last_ok
        },
        failing,
        last_pass_at: now,
        last_pass_ms: started.elapsed().as_millis() as u64,
        scanned: ids.len(),
        uploaded_batches: uploads,
    };
    let _ = crate::fs_util::write_private_json(&dir.join("sync-health.json"), &health);
    // A scan with stuck sessions must not stamp history as fresh.
    http::request::<contract::OkResponse>(
        &config.endpoint,
        contract::ROUTE_CHECKED,
        Some(&credential),
        Some(&serde_json::to_value(contract::CheckedRequest {
            complete: Some(health.failing.is_empty()),
            skipped: Some(health.failing.len() as i64),
            behind: Some(health.failing.len() as i64),
            behind_since: health
                .failing
                .iter()
                .map(|f| f.since)
                .min()
                .map(|s| (s * 1000) as i64),
        })?),
        30,
    )?;
    if let Err(error) = publish_runtime(dir, &config, &credential) {
        log_unavailable("runtime", &error);
    }
    Ok(uploads)
}

/// Reads one session's status and sends it back. Any failure answers `null`, so
/// the reader falls back to the snapshot at once instead of waiting out a timeout.
fn answer_probe(
    _dir: &Path,
    config: &Config,
    credential: &str,
    probe: &contract::Probe,
    read: bool,
) {
    let _span = crate::perf_log::span("bridge-probe-answer");
    let status = if !read {
        None
    } else {
        match runtime::session_status(config, &probe.session_id) {
            Ok(status) => status,
            Err(error) => {
                log_unavailable("probe", &error);
                None
            }
        }
    };
    let body = contract::ProbeResult {
        probe_id: probe.probe_id.clone(),
        status,
    };
    let sent = serde_json::to_value(body)
        .map_err(anyhow::Error::from)
        .and_then(|body| {
            http::request::<contract::OkResponse>(
                &config.endpoint,
                contract::ROUTE_PROBE,
                Some(credential),
                Some(&body),
                10,
            )
        });
    if let Err(error) = sent {
        log_unavailable("probe", &error);
    }
}

fn publish_runtime(dir: &Path, config: &Config, credential: &str) -> Result<()> {
    // The poll thread and the sync loop both publish. If the other one is mid-publish,
    // its result is the one the phone needs, so this call has nothing to add.
    let Some(_lock) = try_local_lock(&dir.join("runtime.lock"))? else {
        return Ok(());
    };
    let stamp = dir.join("runtime-checked.json");
    if std::fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < RUNTIME_MIN_INTERVAL)
    {
        return Ok(());
    }
    let started = std::time::Instant::now();
    // One quick retry: a native read can fail for a moment while OpenCode writes.
    let snapshot = match runtime::snapshot(config) {
        Ok(snapshot) => snapshot,
        Err(first) => {
            log_unavailable("runtime", &first);
            std::thread::sleep(Duration::from_secs(2));
            runtime::snapshot(config)?
        }
    };
    let mut payload = serde_json::to_value(snapshot)?;
    if crate::perf_log::enabled() {
        crate::perf_log::event(
            "bridge-runtime-payload",
            format_args!("bytes={}", payload.to_string().len()),
        );
    }
    let _upload_span = crate::perf_log::span("bridge-runtime-upload");
    let published = http::request::<contract::OkResponse>(
        &config.endpoint,
        contract::ROUTE_RUNTIME,
        Some(credential),
        Some(&payload),
        35,
    );
    match published {
        // A rolling upgrade may still reach the previous strict Worker. Keep
        // native status publishing intact; never substitute inventory for UI.
        Err(error)
            if error.to_string() == "bridge HTTP 400 invalid_runtime_snapshot"
                && payload.get("dashboard").is_some() =>
        {
            payload.as_object_mut().unwrap().remove("dashboard");
            http::request::<contract::OkResponse>(
                &config.endpoint,
                contract::ROUTE_RUNTIME,
                Some(credential),
                Some(&payload),
                35,
            )?;
        }
        other => {
            other?;
        }
    }
    crate::fs_util::write_private_json(&stamp, &json!({"checked":true}))?;
    log_recovered("runtime");
    if started.elapsed() > Duration::from_secs(3) {
        eprintln!(
            "bridge runtime slow ms={} time={}",
            started.elapsed().as_millis(),
            now_secs()
        );
    }
    Ok(())
}

fn already_admitted(
    db: &rusqlite::Connection,
    id: &str,
    session: &str,
    text: &str,
) -> Result<bool> {
    let known=db.query_row("SELECT type,json_extract(data,'$.text') FROM session_message WHERE id=?1 AND session_id=?2",rusqlite::params![id,session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional()?;
    if let Some((kind, body)) = known {
        if kind != "user" || body.as_deref() != Some(text) {
            bail!("local input ID payload conflict");
        }
        return Ok(true);
    }
    let inbox=db.query_row("SELECT type,json_extract(payload,'$.text') FROM session_inbox WHERE id=?1 AND session_id=?2",rusqlite::params![id,session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional()?;
    if let Some((kind, body)) = inbox {
        if kind != "user" || body.as_deref() != Some(text) {
            bail!("local input ID payload conflict");
        }
        return Ok(true);
    }
    Ok(false)
}

pub fn deliver_once(dir: &Path) -> Result<bool> {
    let _delivery_lock = local_lock(&dir.join("delivery.lock"))?;
    let config = load(dir)?;
    let credential = token(&config)?;
    let journal = Journal::open(&dir.join("journal.sqlite"))?;
    // A delivery interrupted after local admission must ACK the original lease,
    // not ask the cloud for a different operation and lose its durable ID.
    let pending = journal
        .db
        .query_row(
            "SELECT body FROM delivery ORDER BY rowid LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let message = if let Some(body) = pending {
        serde_json::from_str::<Value>(&body)?
    } else {
        let lease = http::request::<contract::LeaseResponse>(
            &config.endpoint,
            contract::ROUTE_LEASE,
            Some(&credential),
            Some(&serde_json::to_value(contract::EmptyRequest {})?),
            30,
        )?;
        let Some(lease) = lease.message else {
            return Ok(false);
        };
        if lease.needs_confirmation.is_some() {
            return Ok(false);
        }
        let typed: contract::MessageLease = serde_json::from_value(serde_json::to_value(lease)?)?;
        let message = serde_json::to_value(typed)?;
        journal.db.execute(
            "INSERT INTO delivery(operation_id,body) VALUES (?1,?2)",
            rusqlite::params![
                message["operation_id"].as_str().context("invalid lease")?,
                message.to_string()
            ],
        )?;
        message
    };
    let id = message["session_id"].as_str().context("invalid target")?;
    let mid = message["message_id"].as_str().context("invalid input ID")?;
    let text = message["text"].as_str().context("invalid input")?;
    let operation = message["operation_id"]
        .as_str()
        .context("invalid operation")?;
    let mut db = source::open(&config.database)?;
    let mut status = "accepted";
    if !already_admitted(&db, mid, id, text)? {
        if message["expires_at"].as_i64().unwrap_or(0)
            <= std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as i64
        {
            status = "failed";
        } else if let Some(capture) = source::capture(&mut db, id, None).unwrap_or_else(|error| {
            eprintln!(
                "bridge delivery cannot read session={id} reason={}",
                safe_reason(&error)
            );
            None
        }) {
            let consistent = if message["context"].is_object() {
                context::matches(&capture, &message["context"])
            } else {
                journal
                    .checkpoint(id)?
                    .is_some_and(|p| Some(p.cursor) == message["base_cursor"].as_i64())
                    && journal.source_matches(id, &capture)?
            };
            if !consistent {
                status = "needs_confirmation";
            } else {
                let supervisor = if let Some(state) = &config.supervisor_state {
                    crate::opencode_supervisor::OpenCodeSupervisor::with_state_dir(
                        config.opencode_bin.clone(),
                        state.clone(),
                    )?
                } else {
                    crate::opencode_supervisor::OpenCodeSupervisor::host(
                        config.opencode_bin.clone(),
                    )?
                };
                supervisor.queue_remote_reply(
                    id,
                    Path::new(&capture.cwd),
                    capture.state["title"].as_str().unwrap_or("Session"),
                    mid,
                    text,
                )?;
            }
        } else {
            status = "failed";
        }
    }
    http::request::<contract::ReceiptResponse>(
        &config.endpoint,
        contract::ROUTE_ACK,
        Some(&credential),
        Some(&serde_json::to_value(contract::AckRequest {
            operation_id: operation.to_owned(),
            message_id: mid.to_owned(),
            status: status.parse()?,
        })?),
        30,
    )?;
    journal
        .db
        .execute("DELETE FROM delivery WHERE operation_id=?1", [operation])?;
    Ok(true)
}

fn ack_start(
    endpoint: &str,
    credential: &str,
    operation: &str,
    status: &str,
    session_id: Option<&str>,
    reason: &str,
) -> Result<()> {
    http::request::<contract::StartReceiptResponse>(
        endpoint,
        contract::ROUTE_START_ACK,
        Some(credential),
        Some(&serde_json::to_value(contract::StartAckRequest {
            operation_id: operation.to_owned(),
            status: status.parse()?,
            session_id: session_id.map(str::to_owned),
            reason: (!reason.is_empty()).then(|| reason.to_owned()),
        })?),
        30,
    )?;
    Ok(())
}

/// Creates at most one queued session. A local claim without an id is never launched again.
pub fn start_once(dir: &Path) -> Result<bool> {
    let _lock = local_lock(&dir.join("start.lock"))?;
    let config = load(dir)?;
    let credential = token(&config)?;
    let journal = Journal::open(&dir.join("journal.sqlite"))?;
    let pending = journal
        .db
        .query_row(
            "SELECT operation_id, session_id, prompt_accepted FROM start_op LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((operation, session_id, accepted)) = pending {
        let (status, reason) = if let Some(session_id) = session_id.as_deref() {
            let status = if accepted == Some(1) {
                "started"
            } else {
                "created_not_started"
            };
            ack_start(
                &config.endpoint,
                &credential,
                &operation,
                status,
                Some(session_id),
                "",
            )?;
            start::finish(&journal.db, &operation)?;
            return Ok(true);
        } else {
            ("uncertain", "unknown")
        };
        ack_start(
            &config.endpoint,
            &credential,
            &operation,
            status,
            None,
            reason,
        )?;
        start::finish(&journal.db, &operation)?;
        return Ok(true);
    }
    let lease = http::request::<contract::StartLeaseResponse>(
        &config.endpoint,
        contract::ROUTE_START_LEASE,
        Some(&credential),
        Some(&serde_json::to_value(contract::EmptyRequest {})?),
        30,
    )?;
    let Some(start) = lease.start else {
        return Ok(false);
    };
    let start = serde_json::to_value(start)?;
    let operation = start["operation_id"].as_str().context("invalid start")?;
    let directory = start["directory"]
        .as_str()
        .context("invalid start directory")?;
    let text = start["text"].as_str().context("invalid start prompt")?;
    let allowed = std::env::var_os("HOME")
        .ok_or("server")
        .and_then(|home| start::allowed_directory(Path::new(directory), Path::new(&home)));
    if let Err(reason) = &allowed {
        ack_start(
            &config.endpoint,
            &credential,
            operation,
            "failed",
            None,
            reason,
        )?;
        return Ok(true);
    }
    let canonical = allowed.map_err(|reason| anyhow::anyhow!("start directory: {reason}"))?;
    match start::claim(&journal.db, operation, &start.to_string())? {
        start::Claim::Uncertain => {
            ack_start(
                &config.endpoint,
                &credential,
                operation,
                "uncertain",
                None,
                "unknown",
            )?;
            start::finish(&journal.db, operation)?;
            return Ok(true);
        }
        start::Claim::Resume {
            session_id,
            prompt_accepted,
        } => {
            let status = if prompt_accepted {
                "started"
            } else {
                "created_not_started"
            };
            ack_start(
                &config.endpoint,
                &credential,
                operation,
                status,
                Some(&session_id),
                "",
            )?;
            start::finish(&journal.db, operation)?;
            return Ok(true);
        }
        start::Claim::Launch => {}
    }
    let supervisor = if let Some(state) = &config.supervisor_state {
        crate::opencode_supervisor::OpenCodeSupervisor::with_state_dir(
            config.opencode_bin.clone(),
            state.clone(),
        )?
    } else {
        crate::opencode_supervisor::OpenCodeSupervisor::host(config.opencode_bin.clone())?
    };
    match supervisor.launch_reporting(text, &canonical, None) {
        Ok(report) => {
            start::record(
                &journal.db,
                operation,
                &report.session.id,
                report.prompt_accepted,
            )?;
            let status = if report.prompt_accepted {
                "started"
            } else {
                "created_not_started"
            };
            ack_start(
                &config.endpoint,
                &credential,
                operation,
                status,
                Some(&report.session.id),
                "",
            )?;
            start::finish(&journal.db, operation)?;
        }
        Err(error) => {
            eprintln!("bridge start failed reason={}", safe_reason(&error));
            ack_start(
                &config.endpoint,
                &credential,
                operation,
                "failed",
                None,
                "server",
            )?;
            start::finish(&journal.db, operation)?;
        }
    }
    Ok(true)
}

fn is_busy(error: &anyhow::Error) -> bool {
    error.to_string().contains("already running")
}

/// `None` when another thread or process holds the lock. That is the job being
/// done already, not a failure, so callers skip quietly instead of logging an
/// outage and backing off.
fn try_local_lock(path: &Path) -> Result<Option<std::fs::File>> {
    match local_lock(path) {
        Ok(lock) => Ok(Some(lock)),
        Err(error) if is_busy(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn deliver_unless_busy(dir: &Path) -> Result<bool> {
    match deliver_once(dir) {
        Err(error) if is_busy(&error) => Ok(false),
        other => other,
    }
}

fn start_unless_busy(dir: &Path) -> Result<bool> {
    match start_once(dir) {
        Err(error) if is_busy(&error) => Ok(false),
        other => other,
    }
}

fn local_lock(path: &Path) -> Result<std::fs::File> {
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("bridge operation already running");
        }
    }
    Ok(lock)
}

pub fn run(dir: &Path) -> Result<()> {
    // Stage timings for slow snapshots and passes go to the shared perf log.
    crate::perf_log::use_default_file();
    let _ = load(dir)?;
    let _lock = local_lock(&dir.join("daemon.lock"))?;
    let queue_dir = dir.to_owned();
    let active_until = Arc::new(AtomicU64::new(0));
    let activity = active_until.clone();
    let reconnect_sync = Arc::new(AtomicBool::new(false));
    let request_sync = reconnect_sync.clone();
    // The cloud wakes the poll thread the moment someone reads history. Waking
    // the sync loop from it saves up to a full tick on the first read after idle.
    let (wake, woken) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut retrying = false;
        // Fill the session-record cache and publish once at start, so the first
        // phone read after a restart does not pay for a full listing.
        if let Ok(config) = load(&queue_dir) {
            if let Ok(credential) = token(&config) {
                if let Err(error) = publish_runtime(&queue_dir, &config, &credential) {
                    log_unavailable("runtime", &error);
                }
            }
        }
        loop {
            let result = (|| -> Result<()> {
                let config = load(&queue_dir)?;
                let credential = token(&config)?;
                let poll = http::request::<contract::PollResponse>(
                    &config.endpoint,
                    contract::ROUTE_POLL,
                    Some(&credential),
                    Some(&serde_json::to_value(contract::EmptyRequest {})?),
                    35,
                )?;
                if runtime_alert_changed(&queue_dir, poll.runtime_alert.as_ref())? {
                    notify_runtime_stale();
                }
                // A recovered connection must catch history up even when the phone
                // is idle. A plain wake alone does not bypass the 15-minute timer.
                if retrying {
                    request_sync.store(true, Ordering::Relaxed);
                    retrying = false;
                }
                activity.store(poll.active_until.max(0) as u64, Ordering::Relaxed);
                // A phone read is waiting on one session's status. Answer from
                // its own thread so a publication in progress here does not delay it.
                if let Some(probe) = poll.probe.clone() {
                    let (dir, config, credential) =
                        (queue_dir.clone(), config.clone(), credential.clone());
                    // One at a time: a reader that gave up has already moved on, so
                    // piling a second read onto the first only slows both. A busy
                    // daemon says so at once and the reader uses the snapshot.
                    let take = !PROBE_BUSY.swap(true, Ordering::SeqCst);
                    std::thread::spawn(move || {
                        if take {
                            answer_probe(&dir, &config, &credential, &probe, true);
                            PROBE_BUSY.store(false, Ordering::SeqCst);
                        } else {
                            answer_probe(&dir, &config, &credential, &probe, false);
                        }
                    });
                }
                let _ = wake.send(());
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_millis() as u64;
                // Delivery and the session-state publish are independent. A failed
                // delivery must not leave the phone reading a stale state.
                let delivery = (|| -> Result<()> {
                    if poll.pending {
                        while deliver_unless_busy(&queue_dir)? {}
                        while start_unless_busy(&queue_dir)? {}
                    }
                    Ok(())
                })();
                if poll.active_until.max(0) as u64 > now {
                    if let Err(error) = publish_runtime(&queue_dir, &config, &credential) {
                        log_unavailable("runtime", &error);
                    }
                }
                delivery
            })();
            match result {
                Ok(()) => log_recovered("delivery"),
                Err(error) => {
                    retrying = true;
                    log_unavailable("delivery", &error);
                    std::thread::sleep(Duration::from_secs(10));
                }
            }
        }
    });
    let mut last_sync = std::time::Instant::now() - Duration::from_secs(900);
    let mut last_reconcile: Option<std::time::Instant> = None;
    let mut unhealthy_since: Option<std::time::Instant> = None;
    let mut last_alert: Option<std::time::Instant> = None;
    let mut force_sync = false;
    let mut previous_tick = (std::time::SystemTime::now(), std::time::Instant::now());
    loop {
        force_sync |= reconnect_sync.swap(false, Ordering::Relaxed);
        // The idle timer below stops counting while the Mac sleeps. A wall clock that
        // ran ahead of it means we just woke up: sync now instead of waiting out
        // the rest of the interval.
        let tick = (std::time::SystemTime::now(), std::time::Instant::now());
        let wall = tick.0.duration_since(previous_tick.0).unwrap_or_default();
        if slept_between(wall, tick.1.duration_since(previous_tick.1)) {
            eprintln!("bridge woke after {}s asleep; syncing", wall.as_secs());
            force_sync = true;
        }
        previous_tick = tick;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64;
        // Idle backfill every 15 minutes lets Neon's five-minute autosuspend
        // actually take effect. Active mobile use requests near-live checks.
        if !force_sync
            && active_until.load(Ordering::Relaxed) <= now
            && last_sync.elapsed() < IDLE_SYNC_INTERVAL
        {
            let _ = woken.recv_timeout(IDLE_SYNC_PAUSE);
            continue;
        }
        while woken.try_recv().is_ok() {}
        // Pointer reconciliation is the slow part of a pass. Phone activity only
        // needs to know the source has not changed, so run it on the idle cadence
        // and after a reconnect or wake from sleep. A phone that stays active
        // still reconciles, at the longer interval, instead of every tick.
        let phone_active = active_until.load(Ordering::Relaxed) > now;
        let reconcile = should_reconcile(
            force_sync,
            phone_active,
            last_reconcile.map(|at| at.elapsed()),
        );
        force_sync = false;
        let outcome = sync_pass(dir, reconcile);
        if reconcile && outcome.is_ok() {
            last_reconcile = Some(std::time::Instant::now());
        }
        let healthy = outcome.is_ok() && read_health(dir).failing.is_empty();
        let offline = outcome
            .as_ref()
            .err()
            .is_some_and(|e| matches!(error_kind(&e.to_string()), "network" | "busy"));
        if healthy || offline {
            unhealthy_since = None;
        } else {
            let since = *unhealthy_since.get_or_insert_with(std::time::Instant::now);
            if since.elapsed() >= STUCK_ALERT_AFTER
                && !last_alert.is_some_and(|t| t.elapsed() < STUCK_ALERT_EVERY)
            {
                last_alert = Some(std::time::Instant::now());
                notify_stuck();
            }
        }
        match outcome {
            Ok(n) => {
                last_sync = std::time::Instant::now();
                log_recovered("sync");
                if n > 0 {
                    eprintln!("bridge synced {n} history batches");
                }
                // Reconcile Postgres at the same cadence that already wakes it
                // for history. A crash between commit and wake signaling must
                // not strand a queued instruction indefinitely.
                if deliver_unless_busy(dir).is_err() {
                    eprintln!("bridge queue reconciliation deferred");
                }
                if start_unless_busy(dir).is_err() {
                    eprintln!("bridge start reconciliation deferred");
                }
            }
            Err(error) => log_unavailable("sync", &error),
        };
        // Sleep between passes, but not past a fresh wake from the cloud. While
        // the phone is active a pass is cheap, and history older than five
        // seconds makes the next read wait for one, so pass often enough that
        // a read finds a recent check.
        let active = active_until.load(Ordering::Relaxed)
            > std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as u64;
        let _ = woken.recv_timeout(if active {
            ACTIVE_SYNC_PAUSE
        } else {
            IDLE_SYNC_PAUSE
        });
    }
}

/// Pointer reconciliation asks the cloud about every session, so it is kept off
/// the path of a phone read: due on the idle cadence, or half-hourly while the
/// phone stays active, and always after a reconnect, a wake or a restart.
fn should_reconcile(forced: bool, phone_active: bool, since_last: Option<Duration>) -> bool {
    forced
        || since_last.map_or(true, |elapsed| {
            elapsed
                >= if phone_active {
                    ACTIVE_RECONCILE_INTERVAL
                } else {
                    IDLE_SYNC_INTERVAL
                }
        })
}

/// Shortest gap between two runtime publications. The Worker treats a snapshot
/// older than 20 s as stale and makes a status read wait for the next one, and a
/// pass now takes under a second, so publishing this often keeps reads from waiting.
const RUNTIME_MIN_INTERVAL: Duration = Duration::from_secs(10);
static PROBE_BUSY: AtomicBool = AtomicBool::new(false);
const IDLE_SYNC_INTERVAL: Duration = Duration::from_secs(900);
const IDLE_SYNC_PAUSE: Duration = Duration::from_secs(5);
const ACTIVE_SYNC_PAUSE: Duration = Duration::from_secs(2);
const ACTIVE_RECONCILE_INTERVAL: Duration = Duration::from_secs(1800);

/// Wall-clock age after which `status` calls the last pass stale. A Mac that
/// slept will read stale until it wakes and syncs.
const STALE_AFTER_SECS: u64 = 30 * 60;
// The Worker accepts at most 4,000 pointers and bounds request bytes. History
// includes legacy sessions too, so a whole-source inventory can exceed that.
const CURSOR_BATCH_SIZE: usize = contract::CURSOR_BATCH;
const STUCK_ALERT_AFTER: Duration = Duration::from_secs(30 * 60);
const STUCK_ALERT_EVERY: Duration = Duration::from_secs(6 * 3600);

// Durable deduplication: daemon restarts do not re-notify the same incident.
fn runtime_alert_changed(dir: &Path, alert: Option<&contract::RuntimeAlert>) -> Result<bool> {
    let path = dir.join("runtime-alert.json");
    let old: Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let incident = alert.map(|a| a.incident);
    if old.get("incident").and_then(Value::as_i64) == incident {
        return Ok(false);
    }
    crate::fs_util::write_private_json(&path, &json!({"incident":incident}))?;
    if let Some(alert) = alert {
        eprintln!(
            "bridge runtime publication stale for {} seconds; notifying",
            alert.stale_for_ms / 1000
        );
        Ok(true)
    } else {
        eprintln!("bridge runtime publication recovered");
        Ok(false)
    }
}

fn notify_runtime_stale() {
    #[cfg(target_os="macos")]
    let _=std::process::Command::new("osascript").args(["-e","display notification \"Your Mac is online, but phone session status has stopped updating. Run: agentview bridge status\" with title \"BetterAgentView bridge\""]).status();
}

fn notify_stuck() {
    eprintln!("bridge sync stuck for 30+ minutes; notifying");
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("osascript")
        .args([
            "-e",
            "display notification \"Phone sync has not completed for 30+ minutes. Run: agentview bridge status\" with title \"BetterAgentView bridge\"",
        ])
        .status();
}

fn error_kind(message: &str) -> &'static str {
    if message.contains("HTTP 401") {
        "authentication"
    } else if message.contains("HTTP 429") {
        "rate_limit"
    } else if message.contains("HTTP 5") {
        "cloud_service"
    } else if message.contains("HTTP 4") {
        "protocol"
    } else if message.contains("already running") {
        "busy"
    } else if message.contains("Keychain") {
        "credential"
    } else if message.contains("network") {
        "network"
    } else if message.contains("timed out") {
        "timeout"
    } else if message.contains("database is locked") || message.contains("table is locked") {
        "source_locked"
    } else if message.contains("unsupported OpenCode source schema") {
        "source_schema"
    } else {
        "local_or_native"
    }
}

/// Which step of the session-state snapshot failed. Only these fixed names are printed.
fn runtime_stage(chain: &str) -> Option<&'static str> {
    [
        "supervisor",
        "server_check",
        "discover",
        "registries",
        "source_open",
        "last_user",
    ]
    .into_iter()
    .find(|stage| chain.contains(&format!("runtime snapshot: {stage}")))
}

/// The curl exit code from a transport failure (6 DNS, 7 connect, 28 timeout, 35 TLS).
fn curl_code(chain: &str) -> Option<i32> {
    let rest = chain.split("(curl ").nth(1)?;
    rest.split(')').next()?.trim().parse().ok()
}

fn http_failure(chain: &str) -> Option<String> {
    let rest = chain.strip_prefix("bridge HTTP ")?;
    let mut parts = rest.split_whitespace();
    let status = parts.next()?.parse::<u16>().ok()?;
    if !(400..600).contains(&status) {
        return None;
    }
    // Only the transport's sanitized error token is safe to log. Never print
    // arbitrary response text or an anyhow context containing private data.
    let code = parts.next().filter(|code| {
        code.len() <= 80 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    });
    Some(format!(
        " http={status}{}",
        code.map_or(String::new(), |c| format!(" code={c}"))
    ))
}

struct Outage {
    kind: &'static str,
    since: u64,
    last_logged: u64,
    suppressed: u32,
}

const OUTAGE_REPEAT_SECS: u64 = 300;

static OUTAGES: std::sync::Mutex<std::collections::BTreeMap<String, Outage>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// True when this failure should be printed: the first one, a change of kind, or
/// a repeat after five minutes. The rest are counted, not printed.
fn outage_failed(
    outages: &mut std::collections::BTreeMap<String, Outage>,
    channel: &str,
    kind: &'static str,
    now: u64,
) -> Option<(u64, u32)> {
    match outages.get_mut(channel) {
        None => {
            outages.insert(
                channel.to_owned(),
                Outage {
                    kind,
                    since: now,
                    last_logged: now,
                    suppressed: 0,
                },
            );
            Some((0, 0))
        }
        Some(o) if o.kind != kind || now.saturating_sub(o.last_logged) >= OUTAGE_REPEAT_SECS => {
            let suppressed = std::mem::take(&mut o.suppressed);
            o.kind = kind;
            o.last_logged = now;
            Some((now.saturating_sub(o.since), suppressed))
        }
        Some(o) => {
            o.suppressed += 1;
            None
        }
    }
}

/// How long the channel was failing, if it was.
fn outage_recovered(
    outages: &mut std::collections::BTreeMap<String, Outage>,
    channel: &str,
    now: u64,
) -> Option<u64> {
    outages.remove(channel).map(|o| now.saturating_sub(o.since))
}

fn log_recovered(channel: &str) {
    let now = now_secs();
    let lasted = OUTAGES
        .lock()
        .ok()
        .and_then(|mut outages| outage_recovered(&mut outages, channel, now));
    if let Some(secs) = lasted.filter(|secs| *secs >= 10) {
        eprintln!("bridge {channel} recovered after {secs}s time={now}");
    }
}

/// True when the machine slept or stalled: the wall clock moved on while the
/// monotonic clock, which stops during sleep, did not.
fn slept_between(wall: Duration, monotonic: Duration) -> bool {
    wall > monotonic + Duration::from_secs(30)
}

fn log_unavailable(channel: &str, error: &anyhow::Error) {
    // The whole cause chain decides the kind. Only the kind, a fixed stage name and
    // a curl exit code are printed: the text can contain paths, SQL, headers or
    // prompt content.
    let chain = format!("{error:#}");
    let kind = error_kind(&chain);
    let now = now_secs();
    let print = OUTAGES
        .lock()
        .ok()
        .and_then(|mut outages| outage_failed(&mut outages, channel, kind, now));
    let Some((failing_for, repeats)) = print else {
        return;
    };
    let stage = runtime_stage(&chain).map_or(String::new(), |stage| format!(" stage={stage}"));
    let curl = curl_code(&chain).map_or(String::new(), |code| format!(" curl={code}"));
    let http = http_failure(&error.to_string()).unwrap_or_default();
    let since = if failing_for > 0 {
        format!(" failing_for={failing_for}s repeats={repeats}")
    } else {
        String::new()
    };
    eprintln!(
        "bridge {channel} unavailable kind={kind}{stage}{curl}{http}{since} time={now}; retrying"
    );
}

/// Compares each local projection with the cloud copy. Prints no message text.
pub fn verify(dir: &Path) -> Result<Value> {
    let config = load(dir)?;
    let credential = token(&config)?;
    let journal = Journal::open(&dir.join("journal.sqlite"))?;
    let mut db = source::open(&config.database)?;
    let ids = source::sessions(&db)?;
    let mut checked = 0;
    let mut matched = 0;
    let mut moved = 0;
    let mut mismatches = Vec::new();
    let mut failed = Vec::new();
    for id in &ids {
        let Some(capture) = source::capture(&mut db, id, None)? else {
            continue;
        };
        let checkpoint = journal.checkpoint(id)?;
        // A session that changed after the last sync pass is waiting for the next
        // pass. It is not a mismatch, and comparing it would only add noise.
        if checkpoint
            .as_ref()
            .is_some_and(|p| p.observed != capture.through)
        {
            moved += 1;
            continue;
        }
        let text = source::projection_text(&capture.state, &capture.messages);
        let local_hash = format!("{:x}", md5::Md5::digest(text.as_bytes()));
        let report = match http::request::<contract::VerifyResponse>(
            &config.endpoint,
            contract::ROUTE_VERIFY,
            Some(&credential),
            Some(&serde_json::to_value(contract::VerifyRequest {
                session_id: id.to_owned(),
                hash: local_hash,
                cursor: Some(capture.through),
                count: Some(capture.messages.len() as i64),
            })?),
            60,
        ) {
            Ok(report) => report,
            Err(error) => {
                failed.push(json!({"session_id": id, "reason": safe_reason(&error)}));
                continue;
            }
        };
        checked += 1;
        // Same text but a different pointer is still a problem: the next delta would
        // be refused. A moved watermark with no upload is not.
        let pointer_differs = checkpoint
            .as_ref()
            .is_some_and(|p| report.cloud_cursor != Some(p.cursor));
        if report.verify_response_match && !pointer_differs {
            matched += 1;
        } else {
            mismatches.push(json!({
                "session_id": id,
                "reason": if report.verify_response_match { json!("pointer") } else { json!(report.reason) },
                "local_checkpoint": checkpoint.as_ref().map(|p| p.cursor),
                "cloud_cursor": report.cloud_cursor,
                "local_count": capture.messages.len(),
                "cloud_count": report.cloud_count,
            }));
        }
        if checked % 200 == 0 {
            eprintln!("bridge verify checked {checked}");
        }
    }
    Ok(json!({
        "checked": checked,
        "matched": matched,
        "moved_since_last_sync": moved,
        "mismatches": mismatches,
        "failed": failed,
    }))
}

pub fn status(dir: &Path) -> Result<Value> {
    let config = load(dir)?;
    let journal = Journal::open(&dir.join("journal.sqlite"))?;
    let health = read_health(dir);
    let (sessions, messages, pending): (i64, i64, i64) = (
        journal
            .db
            .query_row("SELECT count(*) FROM checkpoint", [], |r| r.get(0))?,
        journal
            .db
            .query_row("SELECT count(*) FROM cache", [], |r| r.get(0))?,
        journal
            .db
            .query_row("SELECT count(*) FROM pending", [], |r| r.get(0))?,
    );
    let age = (health.last_pass_at > 0).then(|| now_secs().saturating_sub(health.last_pass_at));
    // A successful history scan/heartbeat does not imply that the separately
    // published native-state snapshot was accepted by the Worker.
    let runtime_age = std::fs::metadata(dir.join("runtime-checked.json"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age.as_secs());
    Ok(
        json!({"paired":true,"endpoint":config.endpoint,"sessions":sessions,"messages":messages,"pending_batches":pending,"device_id":config.device_id,"database_epoch":config.database_epoch,"last_fully_synced":health.last_ok,"last_pass_at":health.last_pass_at,"last_pass_age_seconds":age,"stale":age.map_or(true, |age| age > STALE_AFTER_SECS),"runtime_age_seconds":runtime_age,"runtime_stale":runtime_age.map_or(true, |age| age >= 30),"last_pass_ms":health.last_pass_ms,"scanned_sessions":health.scanned,"stuck_sessions":health.failing,"held_batches_for":journal.held_sessions()?}),
    )
}

#[cfg(any(target_os = "macos", test))]
fn login_environment(
    isolated: bool,
    service_file: Option<&Path>,
    xdg_state: Option<&Path>,
) -> std::collections::BTreeMap<String, String> {
    let mut values =
        std::collections::BTreeMap::from([("AGENTVIEW_OPENCODE_API".into(), "v2".into())]);
    if !isolated {
        for (key, path) in [
            ("AGENTVIEW_OPENCODE_SERVICE_FILE", service_file),
            ("XDG_STATE_HOME", xdg_state),
        ] {
            if let Some(path) = path.filter(|p| p.is_absolute()) {
                values.insert(key.into(), path.to_string_lossy().into_owned());
            }
        }
    }
    values
}

pub fn install(dir: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let config = load(dir)?;
        let home = PathBuf::from(std::env::var_os("HOME").context("HOME missing")?);
        let label = format!("com.agentview.bridge.{}", config.device_id);
        let plist = home
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"));
        let xml_escape = |s: &str| {
            s.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
        };
        let args = [
            std::env::current_exe()?.to_string_lossy().to_string(),
            "bridge".into(),
            "--state-dir".into(),
            dir.to_string_lossy().to_string(),
            "run".into(),
        ];
        use std::fmt::Write;
        let mut strings = String::new();
        for arg in args {
            write!(strings, "<string>{}</string>", xml_escape(&arg))?;
        }
        let service_file = std::env::var_os("AGENTVIEW_OPENCODE_SERVICE_FILE").map(PathBuf::from);
        let xdg_state = crate::fs_util::xdg_home("XDG_STATE_HOME").map(PathBuf::from);
        let mut environment = String::new();
        for (key, value) in login_environment(
            config.supervisor_state.is_some(),
            service_file.as_deref(),
            xdg_state.as_deref(),
        ) {
            write!(
                environment,
                "<key>{}</key><string>{}</string>",
                xml_escape(&key),
                xml_escape(&value)
            )?;
        }
        let contents=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array>{strings}</array><key>EnvironmentVariables</key><dict>{environment}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardErrorPath</key><string>{}</string></dict></plist>",xml_escape(&dir.join("daemon.log").to_string_lossy()));
        std::fs::create_dir_all(plist.parent().unwrap())?;
        crate::fs_util::write_private_bytes(&plist, contents.as_bytes())?;
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let _ = std::process::Command::new("launchctl")
            .args(["enable", &format!("{domain}/{label}")])
            .output();
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", &format!("{domain}/{label}")])
            .output();
        if !std::process::Command::new("launchctl")
            .arg("bootstrap")
            .arg(&domain)
            .arg(&plist)
            .status()?
            .success()
        {
            bail!("could not install bridge login item");
        }
        println!(
            "Installed bridge login item. Runs while logged in and awake; does not wake the Mac."
        );
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = dir;
        bail!("login-item installation currently requires macOS")
    }
}

pub fn stop(dir: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let config = load(dir)?;
        let target = format!(
            "gui/{}/com.agentview.bridge.{}",
            unsafe { libc::getuid() },
            config.device_id
        );
        if !std::process::Command::new("launchctl")
            .args(["disable", &target])
            .status()?
            .success()
        {
            bail!("could not disable bridge login item");
        }
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", &target])
            .output();
        println!("Bridge stopped and disabled at login. Pairing and cloud history are retained.");
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = dir;
        bail!("login-item control currently requires macOS")
    }
}

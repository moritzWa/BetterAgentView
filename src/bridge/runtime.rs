use super::contract::{Completion, Health, Reason, Status};
pub(super) use super::contract::{RuntimeSnapshot as Snapshot, RuntimeStatus};
use super::Config;
use crate::adapters::{DiscoveryRequest, OpenCodeController, OpenCodeSource, SessionSource};
use crate::control::ProviderController;
use crate::domain::{AgentSession, SessionSnapshot, SessionState};
use crate::opencode_supervisor::OpenCodeSupervisor;
use anyhow::{Context, Result};
use rusqlite::OptionalExtension;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

pub(super) fn project(session: &AgentSession) -> RuntimeStatus {
    let status = match session.state {
        SessionState::Working => Status::Working,
        SessionState::NeedsInput => Status::NeedsYou,
        SessionState::Scheduled => Status::Scheduled,
        SessionState::ReadyForReview => Status::NeedsYou,
        SessionState::Completed | SessionState::TaskDone | SessionState::ProjectDone => {
            Status::Done
        }
        SessionState::Unknown => Status::Unknown,
    };
    let reason = if session.state == SessionState::NeedsInput {
        Some(match session.raw_state.as_deref() {
            Some("permission requested") => Reason::Approval,
            Some("question asked") => Reason::Question,
            Some("turn failed") => Reason::Failed,
            _ => Reason::Reply,
        })
    } else {
        None
    };
    let can_message = session.state != SessionState::Unknown
        && !matches!(
            session.raw_state.as_deref(),
            Some("permission requested" | "question asked")
        );
    RuntimeStatus {
        session_id: session.provider_session_id.clone(),
        status: status.clone(),
        completion: match session.state {
            SessionState::TaskDone => Completion::TaskDone,
            SessionState::ProjectDone => Completion::ProjectDone,
            _ => Completion::Unconfirmed,
        },
        reason: reason.clone(),
        updated_at: session
            .updated_at
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64),
        can_message,
        last_user_message_id: None,
        last_user_ms: crate::last_message::facts_for(&session.id)
            .map_or(0, |facts| facts.last_user_ms as i64),
        top_level: true,
        attention_assessed: session.state == SessionState::NeedsInput,
        directory: (!session.cwd.as_os_str().is_empty())
            .then(|| session.cwd.to_string_lossy().into_owned()),
        // Working stays unknown until the source read. A missing read is not a stall.
        health: if reason == Some(Reason::Failed) {
            Health::Failed
        } else if status == Status::Working || status == Status::Unknown {
            Health::Unknown
        } else {
            Health::Idle
        },
        turn_started_at: None,
        last_progress_at: None,
        last_progress_kind: None,
        in_flight: None,
    }
}

pub(super) fn snapshot(config: &Config) -> Result<Snapshot> {
    let mut snapshot = build(config, None)?;
    use super::contract::{ReadResult, ReadSource};
    if config.supervisor_state.is_some() {
        return Ok(snapshot);
    }
    let (mut dashboard, mut read_result) = crate::dashboard_snapshot::read_latest();
    let mut read_source = ReadSource::Desktop;
    if dashboard.is_none() {
        match crate::dashboard_snapshot::refresh_in_background() {
            Ok(fresh) => {
                dashboard = Some(fresh);
                read_source = ReadSource::Connector;
                read_result = ReadResult::Accepted;
            }
            Err(ReadResult::Missing) => {} // A dashboard from before this upgrade has no saved settings.
            Err(error) => {
                read_source = ReadSource::Connector;
                read_result = error;
            }
        }
    }
    let read_at = crate::dashboard_snapshot::now_ms();
    let desktop = crate::dashboard_snapshot::last_desktop_publish();
    let trace = super::contract::SnapshotTrace {
        read_at,
        read_result,
        read_source,
        desktop_generated_at: desktop.as_ref().map(|v| v.0),
        desktop_session_count: desktop.as_ref().map(|v| v.1),
        desktop_publish_result: desktop.map(|v| v.2),
        previous_upload_at: None,
        previous_upload_result: None,
    };
    crate::perf_log::event(
        "bridge-dashboard-read",
        format_args!(
            "read_at={} source={:?} result={:?} captured_at={:?} session_count={:?}",
            read_at,
            trace.read_source,
            trace.read_result,
            dashboard.as_ref().map(|s| s.captured_at),
            dashboard.as_ref().map(|s| s.sessions.len())
        ),
    );
    snapshot.dashboard = dashboard;
    snapshot.snapshot_trace = Some(trace);
    Ok(snapshot)
}

/// The status of one session, from the same pipeline as the snapshot. `None` when
/// the session is not in the snapshot's inventory (hidden, paused, or gone).
pub(super) fn session_status(config: &Config, id: &str) -> Result<Option<RuntimeStatus>> {
    Ok(build(config, Some(id))?
        .statuses
        .into_iter()
        .find(|status| status.session_id == id))
}

fn build(config: &Config, only: Option<&str>) -> Result<Snapshot> {
    let _total = crate::perf_log::span(if only.is_some() {
        "bridge-runtime-probe"
    } else {
        "bridge-runtime-snapshot"
    });
    let supervisor = Arc::new(if let Some(state) = &config.supervisor_state {
        OpenCodeSupervisor::with_state_dir(config.opencode_bin.clone(), state.clone())
            .context("runtime snapshot: supervisor")?
    } else {
        OpenCodeSupervisor::host(config.opencode_bin.clone())
            .context("runtime snapshot: supervisor")?
    });
    if supervisor
        .live_server_pid()
        .context("runtime snapshot: server_check")?
        .is_none()
    {
        return Ok(Snapshot {
            dashboard: None,
            snapshot_trace: None,
            available: false,
            partial: false,
            truncated: false,
            statuses: Vec::new(),
        });
    }
    // Exactly the dashboard's source/classifier, including native permission,
    // question, failed-turn, child-agent and background-work states. Do not ask
    // ChatGPT to infer these from the conversation copy.
    let source = OpenCodeSource::managed(config.opencode_bin.clone(), supervisor.clone());
    let discover_span = crate::perf_log::span("bridge-runtime-discover");
    let request = DiscoveryRequest {
        include_completed: true,
        include_interactive: true,
        include_external: true,
        history_limit: 5000,
        ..DiscoveryRequest::default()
    };
    let discovery = match only {
        Some(id) => source.discover_one(&request, id),
        None => source.discover_with_warnings(&request),
    }
    .context("runtime snapshot: discover")?;
    drop(discover_span);
    let mut discovery = SessionSnapshot {
        sessions: discovery.sessions,
        warnings: discovery.warnings,
    };
    // Discovery alone omits the dashboard's holds/native-shell overlay and its
    // persisted judgement that a finished assistant turn is asking the user.
    let enrich_span = crate::perf_log::span("bridge-runtime-enrich");
    OpenCodeController::managed(config.opencode_bin.clone(), supervisor).enrich(&mut discovery);
    drop(enrich_span);
    let classify_span = crate::perf_log::span("bridge-runtime-classify-registries");
    let assessed = if config.supervisor_state.is_none() {
        crate::turn_classifier::apply_saved(&mut discovery)
    } else {
        Default::default()
    };
    let parents = if config.supervisor_state.is_none() {
        Some(
            crate::session_tree::ParentLinks::load_default()
                .context("runtime snapshot: registries")?,
        )
    } else {
        None
    };
    let paused = if config.supervisor_state.is_none() {
        Some(
            crate::paused::PausedSessions::load_default()
                .context("runtime snapshot: registries")?
                .paused(),
        )
    } else {
        None
    };
    let hidden = if config.supervisor_state.is_none() {
        Some(
            crate::hidden::HiddenSessions::load_default()
                .context("runtime snapshot: registries")?,
        )
    } else {
        None
    };
    drop(classify_span);
    let mut statuses = discovery
        .sessions
        .iter()
        .filter(|session| {
            !paused
                .as_ref()
                .is_some_and(|ids| ids.contains_key(&session.id))
        })
        .filter(|session| !hidden.as_ref().is_some_and(|ids| ids.contains(&session.id)))
        .map(|session| {
            let mut status = project(session);
            status.attention_assessed |= assessed.contains(&session.id);
            status.top_level = !parents
                .as_ref()
                .is_some_and(|p| p.links().contains_key(&session.provider_session_id));
            status
        })
        .collect::<Vec<_>>();
    statuses.sort_by_key(|s| {
        (
            if s.status == Status::NeedsYou {
                0
            } else if s.status == Status::Working {
                1
            } else {
                2
            },
            std::cmp::Reverse(s.updated_at),
        )
    });
    let count_truncated = statuses.len() > super::contract::SNAPSHOT_STATUSES;
    let mut partial = !discovery.warnings.is_empty()
        || statuses
            .iter()
            .skip(super::contract::SNAPSHOT_STATUSES)
            .any(|s| s.status != Status::Done);
    // Keep the durable wake snapshot small; never drop attention states merely
    // to make room for old completed history. Search still covers all history.
    statuses.truncate(super::contract::SNAPSHOT_STATUSES);
    let _source_span = crate::perf_log::span("bridge-runtime-source-reads");
    let db = super::source::open(&config.database).context("runtime snapshot: source_open")?;
    let mut latest=db.prepare("SELECT m.id FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE s.id=?1 AND m.type='user' AND m.seq<COALESCE((SELECT b.seq FROM session_message b WHERE b.session_id=s.id AND b.id=json_extract(s.revert,'$.messageID')),9007199254740991) ORDER BY m.seq DESC LIMIT 1").context("runtime snapshot: last_user")?;
    for status in &mut statuses {
        status.last_user_message_id = latest
            .query_row([&status.session_id], |row| row.get(0))
            .optional()
            .context("runtime snapshot: last_user")?;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let working = statuses
        .iter()
        .filter(|status| status.status == Status::Working)
        .map(|status| status.session_id.clone())
        .collect::<Vec<_>>();
    let _progress_span = crate::perf_log::span("bridge-runtime-progress");
    match super::health::progress(&db, &working, now_ms) {
        Ok(found) => {
            for status in &mut statuses {
                if let Some(progress) = found.get(&status.session_id) {
                    status.health = progress.health.parse().unwrap_or(Health::Unknown);
                    status.turn_started_at = progress.turn_started_at.map(|v| v as i64);
                    status.last_progress_at = progress.last_progress_at.map(|v| v as i64);
                    status.last_progress_kind =
                        progress.last_progress_kind.and_then(|v| v.parse().ok());
                    status.in_flight = progress.in_flight.and_then(|v| v.parse().ok());
                }
            }
        }
        Err(_) => {
            // Leave working sessions unknown. Do not publish a stall from a failed read.
        }
    }
    drop(_source_span);
    // Full directory metadata can make a count-bounded snapshot too large.
    // Keep its serialized body safely inside the existing 850 KB transport cap.
    // Reserve the dashboard's 100 KB and envelope up front. Its read is only
    // needed by the full publish path, not by per-session probes.
    let mut bytes = 101_024;
    let mut keep = 0;
    for status in &statuses {
        let size = serde_json::to_vec(status)?.len() + 1;
        if bytes + size > 750_000 {
            break;
        }
        bytes += size;
        keep += 1;
    }
    let truncated = count_truncated || keep < statuses.len();
    partial |= statuses.iter().skip(keep).any(|s| s.status != Status::Done);
    statuses.truncate(keep);
    Ok(Snapshot {
        dashboard: None,
        snapshot_trace: None,
        available: true,
        partial,
        truncated,
        statuses,
    })
}

//! The actual dashboard model, not a second discovery of provider history.
use crate::app::{App, SelectionKey, ViewMode};
use crate::bridge::contract::{
    DashboardCategory as Category, DashboardGroup, DashboardSession, DashboardSnapshot,
    DesktopPublishResult, ReadResult, View,
};
use crate::domain::SessionState;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_BYTES: usize = 100_000;

#[derive(serde::Deserialize, serde::Serialize)]
struct DiscoverySettings {
    args: Vec<String>,
    cwd: PathBuf,
}

/// Remember the user's actual discovery flags. Never widen their providers,
/// directory or external-history scope just because no terminal is running.
pub fn remember_discovery_args() -> anyhow::Result<()> {
    let root = directory().ok_or_else(|| anyhow::anyhow!("no state directory"))?;
    crate::fs_util::write_private_json(
        &root.join("discovery-settings"),
        &DiscoverySettings {
            args: std::env::args().skip(1).collect(),
            cwd: std::env::current_dir()?,
        },
    )
}

pub fn last_list_preferences() -> Option<(String, bool)> {
    let bytes = std::fs::read(directory()?.join("list-preferences")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(crate) fn last_desktop_publish() -> Option<(i64, i64, DesktopPublishResult)> {
    let bytes = std::fs::read(directory()?.join("publish-trace")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(crate) fn refresh_in_background() -> Result<DashboardSnapshot, ReadResult> {
    use crate::process::{CommandRequest, CommandRunner, ProcessRunner};
    let root = directory().ok_or(ReadResult::Missing)?;
    let settings: DiscoverySettings = match std::fs::read(root.join("discovery-settings")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| ReadResult::Invalid)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReadResult::Missing),
        Err(_) => return Err(ReadResult::ReadError),
    };
    let program = std::env::current_exe().map_err(|_| ReadResult::ReadError)?;
    let mut args = vec!["--bridge-dashboard-json".to_owned(), "--json".to_owned()];
    args.extend(settings.args);
    let mut request = CommandRequest::new(program.to_string_lossy(), args);
    request.current_dir = Some(settings.cwd);
    request.timeout = Duration::from_secs(12);
    let output = ProcessRunner
        .run(&request)
        .map_err(|_| ReadResult::RefreshFailed)?;
    if output.status != 0 {
        return Err(ReadResult::RefreshFailed);
    }
    if output.stdout.len() > MAX_BYTES {
        return Err(ReadResult::Oversized);
    }
    serde_json::from_slice(&output.stdout).map_err(|_| ReadResult::Invalid)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn capture(app: &App) -> DashboardSnapshot {
    let keys = app.selectable_keys();
    // Equivalent slash spellings on Windows share the representative UI key.
    let directory_groups = app.directory_groups();
    let directories = directory_groups
        .iter()
        .filter_map(|group| group.key.strip_prefix("cwd:").map(|path| (group, path)))
        .flat_map(|(group, path)| {
            group.sessions.iter().map(move |index| {
                (
                    *index,
                    (group.key.clone(), path.to_owned(), group.label.clone()),
                )
            })
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut sessions = Vec::new();
    let mut groups = Vec::new();
    for group in app.groups() {
        let mut listed = 0;
        for index in &group.sessions {
            let s = &app.snapshot.sessions[*index];
            let visible = keys.contains(&SelectionKey::Session(s.id.clone()));
            listed += i64::from(visible);
            let category = if app.paused.contains_key(&s.id) {
                Category::Paused
            } else if s.is_scheduled() && group.key == "scheduled" {
                Category::Scheduled
            } else {
                match s.state {
                    SessionState::NeedsInput => Category::NeedsInput,
                    SessionState::Working => Category::Working,
                    SessionState::TaskDone => Category::TaskDone,
                    SessionState::ProjectDone => Category::ProjectDone,
                    SessionState::Completed => Category::Idle,
                    SessionState::ReadyForReview => Category::ReadyForReview,
                    SessionState::Scheduled => Category::Scheduled,
                    SessionState::Unknown => Category::Unknown,
                }
            };
            let (directory_id, directory_path, directory_label) =
                directories.get(index).cloned().unwrap_or_else(|| {
                    let path = crate::app::project_group_path(&s.cwd);
                    (
                        format!("cwd:{}", path.display()),
                        path.to_string_lossy().into_owned(),
                        crate::app::abbreviate_home(&path),
                    )
                });
            sessions.push(DashboardSession {
                directory_id,
                directory_path,
                directory_label,
                id: s.id.clone(),
                session_id: s.provider_session_id.clone(),
                title: s.name.clone(),
                provider: s.provider.label().into(),
                directory: s.cwd.to_string_lossy().into_owned(),
                category,
                group_key: group.key.clone(),
                listed: visible,
            });
        }
        groups.push(DashboardGroup {
            key: group.key.clone(),
            label: group.label.clone(),
            total: group.sessions.len() as i64,
            listed,
        });
    }
    // Provider warnings do not make this copy of the UI inexact. In particular,
    // a history-window warning is expected: that window IS the displayed set.
    let partial = sessions.len() > 1000 || groups.len() > 1000;
    sessions.truncate(1000);
    groups.truncate(1000);
    DashboardSnapshot {
        dashboard_id: format!("dashboard:{}", std::process::id()),
        terminal_title: crate::ui::terminal_title(app),
        captured_at: now_ms(),
        filter: app.filter.clone(),
        view: if app.view_mode == ViewMode::Status {
            View::Status
        } else {
            View::Directory
        },
        partial,
        sessions,
        groups,
    }
}

fn directory() -> Option<PathBuf> {
    let root = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/state")))?;
    Some(root.join("agentview/dashboard-snapshots"))
}

/// A short lease expires even if the UI crashes. Each process owns only its file.
pub struct Publisher {
    last: Option<Instant>,
    path: Option<PathBuf>,
    preferences: Option<(String, bool)>,
}
impl Default for Publisher {
    fn default() -> Self {
        Self::new()
    }
}
impl Publisher {
    pub fn new() -> Self {
        Self {
            last: None,
            path: directory().map(|d| d.join(format!("{}.json", std::process::id()))),
            preferences: None,
        }
    }
    pub fn publish(&mut self, app: &App) {
        if self
            .last
            .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
        {
            return;
        }
        self.last = Some(Instant::now());
        if !self
            .preferences
            .as_ref()
            .is_some_and(|(filter, completed)| {
                filter == &app.filter && *completed == app.includes_completed
            })
        {
            if let Some(root) = self.path.as_ref().and_then(|p| p.parent()) {
                let preferences = (app.filter.clone(), app.includes_completed);
                match crate::fs_util::write_private_json(
                    &root.join("list-preferences"),
                    &preferences,
                ) {
                    Ok(()) => self.preferences = Some(preferences),
                    Err(_) => crate::perf_log::event(
                        "bridge-dashboard-settings",
                        format_args!("result=preferences_write_failed"),
                    ),
                }
            }
        }
        let snapshot = capture(app);
        crate::perf_log::event(
            "bridge-dashboard-generated",
            format_args!(
                "captured_at={} session_count={}",
                snapshot.captured_at,
                snapshot.sessions.len()
            ),
        );
        let result = self.write(&snapshot);
        let label = result.as_ref().err().copied().unwrap_or("ok");
        if let Some(root) = self.path.as_ref().and_then(|p| p.parent()) {
            let temp = root.join(format!("publish-trace.{}.tmp", std::process::id()));
            if let Ok(bytes) =
                serde_json::to_vec(&(snapshot.captured_at, snapshot.sessions.len(), label))
            {
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true).truncate(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                use std::io::Write;
                if options
                    .open(&temp)
                    .and_then(|mut f| f.write_all(&bytes))
                    .is_ok()
                {
                    let _ = crate::fs_util::replace_file(&temp, &root.join("publish-trace"));
                }
            }
        }
        crate::perf_log::event(
            "bridge-dashboard-publish",
            format_args!(
                "captured_at={} session_count={} result={}",
                snapshot.captured_at,
                snapshot.sessions.len(),
                result.as_ref().err().copied().unwrap_or("ok")
            ),
        );
    }
    fn write(&self, snapshot: &DashboardSnapshot) -> Result<(), &'static str> {
        use std::io::Write;
        let path = self.path.as_ref().ok_or("no_state_directory")?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "mkdir_failed")?;
        let temp = path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let bytes = serde_json::to_vec(snapshot).map_err(|_| "serialize_failed")?;
        // WakeGate metadata has a per-value limit. Never silently cut rows.
        if bytes.len() > MAX_BYTES {
            return Err("oversized");
        }
        options
            .open(&temp)
            .and_then(|mut f| f.write_all(&bytes))
            .map_err(|_| "write_failed")?;
        crate::fs_util::replace_file(&temp, path).map_err(|_| "rename_failed")?;
        Ok(())
    }
}
impl Drop for Publisher {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub fn latest() -> Option<DashboardSnapshot> {
    read_latest().0
}

pub(crate) fn read_latest() -> (Option<DashboardSnapshot>, ReadResult) {
    let Some(path) = directory() else {
        return (None, ReadResult::Missing);
    };
    latest_in(&path, now_ms())
}

fn latest_in(path: &std::path::Path, now: i64) -> (Option<DashboardSnapshot>, ReadResult) {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (None, ReadResult::Missing),
        Err(_) => return (None, ReadResult::ReadError),
    };
    let mut best: Option<DashboardSnapshot> = None;
    let mut failure = (None, ReadResult::Missing);
    for entry in entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
    {
        let modified = entry.metadata().and_then(|m| m.modified()).ok();
        let rejected = match std::fs::read(entry.path()) {
            Ok(bytes) if bytes.len() > MAX_BYTES => ReadResult::Oversized,
            Ok(bytes) => match serde_json::from_slice::<DashboardSnapshot>(&bytes) {
                Ok(snapshot) if snapshot.captured_at > now => ReadResult::ClockAhead,
                Ok(snapshot) if now.saturating_sub(snapshot.captured_at) >= 15_000 => {
                    ReadResult::Expired
                }
                Ok(snapshot) => {
                    if best
                        .as_ref()
                        .map_or(true, |other| other.captured_at < snapshot.captured_at)
                    {
                        best = Some(snapshot);
                    }
                    continue;
                }
                Err(_) => ReadResult::Invalid,
            },
            Err(_) => ReadResult::ReadError,
        };
        if modified >= failure.0 {
            failure = (modified, rejected);
        }
    }
    if best.is_some() {
        (best, ReadResult::Accepted)
    } else {
        (None, failure.1)
    }
}

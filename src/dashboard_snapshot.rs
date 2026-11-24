//! The actual dashboard model, not a second discovery of provider history.
use crate::app::{App, SelectionKey, ViewMode};
use crate::bridge::contract::{
    DashboardCategory as Category, DashboardGroup, DashboardSession, DashboardSnapshot, View,
};
use crate::domain::SessionState;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn capture(app: &App) -> DashboardSnapshot {
    let keys = app.selectable_keys();
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
            sessions.push(DashboardSession {
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
        captured_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
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
        let _ = self.write(app);
    }
    fn write(&self, app: &App) -> anyhow::Result<()> {
        use std::io::Write;
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no state directory"))?;
        std::fs::create_dir_all(path.parent().unwrap())?;
        let temp = path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let bytes = serde_json::to_vec(&capture(app))?;
        // WakeGate metadata has a per-value limit. Never silently cut rows.
        if bytes.len() > 100_000 {
            anyhow::bail!("dashboard snapshot exceeds transport budget");
        }
        options.open(&temp)?.write_all(&bytes)?;
        std::fs::rename(temp, path)?;
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
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    std::fs::read_dir(directory()?)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            if entry.path().extension()?.to_str()? != "json" {
                return None;
            }
            let bytes = std::fs::read(entry.path()).ok()?;
            if bytes.len() > 100_000 {
                return None;
            }
            let snapshot: DashboardSnapshot = serde_json::from_slice(&bytes).ok()?;
            (snapshot.captured_at <= now && now - snapshot.captured_at < 15_000).then_some(snapshot)
        })
        .max_by_key(|s| s.captured_at)
}

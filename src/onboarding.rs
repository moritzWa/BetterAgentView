//! The same setup instructions ship in the binary and on GitHub.
pub const PROMPT: &str = include_str!("../docs/SETUP-PROMPT.md");

pub const FORK_URL: &str = "https://github.com/moritzWa/opencode/tree/v2-parity";
pub const GUIDE_URL: &str =
    "https://github.com/moritzWa/betteragentview/blob/main/docs/onboarding.md";

fn state_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(crate::last_harness::default_last_harness_path()?.with_file_name("onboarding.json"))
}

/// Existing dashboard users keep their preferences and are not forced through setup.
pub fn first_launch() -> anyhow::Result<bool> {
    let path = state_path()?;
    Ok(needs_setup(&path))
}

fn needs_setup(path: &std::path::Path) -> bool {
    if let Ok(bytes) = std::fs::read(path) {
        return serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|state| state["guided_setup_seen"].as_bool())
            == Some(false);
    }
    !path.exists()
        && !path.with_file_name("last-harness.json").exists()
        && !path.with_file_name("last-view.json").exists()
}

pub fn begin() -> anyhow::Result<()> {
    crate::fs_util::write_private_json(
        &state_path()?,
        &serde_json::json!({"version": 1, "guided_setup_seen": false}),
    )
}

pub fn finish(first_task_pending: bool) -> anyhow::Result<()> {
    crate::fs_util::write_private_json(
        &state_path()?,
        &serde_json::json!({"version": 1, "guided_setup_seen": true, "first_task_pending": first_task_pending}),
    )
}

pub fn take_first_task() -> anyhow::Result<bool> {
    let path = state_path()?;
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(false);
    };
    let mut state: serde_json::Value = serde_json::from_slice(&bytes)?;
    if state["first_task_pending"] != true {
        return Ok(false);
    }
    state["first_task_pending"] = serde_json::json!(false);
    crate::fs_util::write_private_json(&path, &state)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_preserves_existing_users_and_respects_skip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("onboarding.json");
        assert!(needs_setup(&path));
        for file in ["onboarding.json", "last-harness.json", "last-view.json"] {
            std::fs::write(dir.path().join(file), "{}").unwrap();
            assert!(!needs_setup(&path));
            std::fs::remove_file(dir.path().join(file)).unwrap();
        }
        std::fs::write(&path, r#"{"version":1,"guided_setup_seen":false}"#).unwrap();
        std::fs::write(dir.path().join("last-harness.json"), "{}").unwrap();
        assert!(
            needs_setup(&path),
            "an interrupted setup must resume even after choosing a harness"
        );
    }

    #[test]
    fn setup_covers_optional_features_without_bundling_private_credentials() {
        for expected in [
            "doctor",
            "setup opencode",
            "Grok",
            "Groq",
            "shortcuts",
            "SELF-HOSTING.md",
            "without asking first",
        ] {
            assert!(PROMPT.contains(expected), "missing {expected}");
        }
        assert!(!PROMPT.contains("moritzw.workers.dev"));
        assert!(!PROMPT.contains("wallawitsch@gmail.com"));
    }
}

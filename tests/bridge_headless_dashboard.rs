use std::{fs, path::Path, process::Command};

#[test]
fn connector_can_build_dashboard_without_a_running_terminal_or_snapshot_file() {
    let home = tempfile::tempdir().unwrap();
    let state = home.path().join("state");
    let root = state.join("agentview/dashboard-snapshots");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("list-preferences"), r#"["reviewer",true]"#).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/populated-sessions.json");
    let read = || {
        let out = Command::new(env!("CARGO_BIN_EXE_agentview"))
            .env("HOME", home.path())
            .env("XDG_STATE_HOME", &state)
            .args([
                "--bridge-dashboard-json",
                "--json",
                "--no-host-providers",
                "--fixture",
            ])
            .arg(&fixture)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let first = read();
    assert_eq!(first["filter"], "reviewer");
    assert!(first["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "claude:docker:reviewer"));
    fs::write(
        root.join("list-preferences"),
        r#"["no-such-match-fd213",true]"#,
    )
    .unwrap();
    let second = read();
    assert_eq!(second["sessions"], serde_json::json!([]));
    assert!(second["captured_at"].as_i64().unwrap() >= first["captured_at"].as_i64().unwrap());
    assert_eq!(fs::read_dir(root).unwrap().count(), 1);
}

use std::process::Command;

#[test]
fn onboarding_prints_the_shipped_markdown_without_provider_access() {
    for binary in [
        env!("CARGO_BIN_EXE_betteragentview"),
        env!("CARGO_BIN_EXE_agentview"),
    ] {
        let home = tempfile::tempdir().unwrap();
        let output = Command::new(binary)
            .arg("onboarding")
            .env("HOME", home.path())
            .env("XDG_STATE_HOME", home.path().join("state"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            agentview::onboarding::PROMPT
        );
        assert!(!home
            .path()
            .join("state/agentview/bridge/config.json")
            .exists());
    }
}

#[test]
fn public_command_reports_the_new_name() {
    let output = Command::new(env!("CARGO_BIN_EXE_betteragentview"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("betteragentview {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn legacy_command_keeps_its_machine_readable_version() {
    let output = Command::new(env!("CARGO_BIN_EXE_agentview"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("agentview {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn public_help_uses_the_new_command() {
    let output = Command::new(env!("CARGO_BIN_EXE_betteragentview"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("Usage: betteragentview"));
}

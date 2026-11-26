use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

pub fn request<T: serde::de::DeserializeOwned>(
    endpoint: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
    timeout: u64,
) -> Result<T> {
    let base = url::Url::parse(endpoint)?;
    if base.scheme() != "https"
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        bail!("bridge endpoint must be HTTPS without credentials");
    }
    if !path.starts_with('/') || path.starts_with("//") {
        bail!("invalid bridge route");
    }
    let url = base.join(path)?;
    let mut config=format!("url = {}\nsilent\nshow-error\nmax-time = {timeout}\nconnect-timeout = 10\nproto = \"=https\"\nwrite-out = \"\\n%{{http_code}}\"\n",serde_json::to_string(url.as_str())?);
    if let Some(token) = token {
        if token.len() != 43
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            bail!("invalid bridge credential");
        }
        config.push_str(&format!("header = \"Authorization: Bearer {token}\"\n"));
    }
    if let Some(body) = body {
        config.push_str("request = \"POST\"\nheader = \"Content-Type: application/json\"\n");
        config.push_str(&format!(
            "data-binary = {}\n",
            serde_json::to_string(&body.to_string())?
        ));
    }
    let mut child = Command::new("curl")
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("could not launch bridge HTTPS transport")?;
    let mut stdout = child.stdout.take().unwrap();
    let output = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    // Curl has its own request and connect limits. The parent also owns a
    // deadline, including handing the request to curl over stdin, so a wedged
    // helper cannot strand the poll, delivery or sync loop.
    let mut stdin = child.stdin.take().unwrap();
    let input = std::thread::spawn(move || stdin.write_all(config.as_bytes()));
    let status = wait_for_transport(&mut child, Duration::from_secs(timeout.saturating_add(2)));
    let written = input
        .join()
        .map_err(|_| anyhow::anyhow!("bridge request writer failed"))?;
    let bytes = output
        .join()
        .map_err(|_| anyhow::anyhow!("bridge response reader failed"))??;
    let status = status?;
    if !status.success() {
        bail!(
            "bridge network request failed (curl {})",
            status.code().unwrap_or(-1)
        );
    }
    written.context("could not write bridge HTTPS request")?;
    let text = String::from_utf8(bytes).context("invalid bridge response encoding")?;
    let (json, status) = text
        .rsplit_once('\n')
        .context("missing bridge response status")?;
    let status: u16 = status.parse()?;
    if !(200..300).contains(&status) {
        // The code is a short token such as cursor_gap. Anything else stays out of the error.
        let code = serde_json::from_str::<Value>(json).ok().and_then(|v| {
            v.get("error").and_then(|e| e.as_str()).and_then(|c| {
                (c.len() <= 80 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_'))
                    .then(|| c.to_owned())
            })
        });
        if let Some(code) = code {
            bail!("bridge HTTP {status} {code}");
        }
        bail!("bridge HTTP {status}");
    }
    serde_json::from_str(json).context("invalid bridge JSON response")
}

fn wait_for_transport(child: &mut Child, timeout: Duration) -> Result<ExitStatus> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(10));
            }
            result => {
                // Reap the child before joining pipe readers/writers.
                let _ = child.kill();
                child
                    .wait()
                    .context("could not reap bridge HTTPS transport")?;
                result?;
                bail!("bridge network request exceeded transport watchdog deadline");
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn transport_watchdog_kills_and_reaps_a_hung_child() {
        let mut child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let started = Instant::now();
        let error = wait_for_transport(&mut child, Duration::from_millis(40)).unwrap_err();
        assert!(error.to_string().contains("watchdog deadline"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn transport_watchdog_preserves_the_childs_exit_status() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 6"])
            .spawn()
            .unwrap();
        assert_eq!(
            wait_for_transport(&mut child, Duration::from_secs(5))
                .unwrap()
                .code(),
            Some(6)
        );
    }
}

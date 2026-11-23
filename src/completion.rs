//! Message-only, bounded evidence for the session completion decision.
//! Never pass an inspection transcript: it can contain reasoning and tool logs.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::adapters::opencode_db::SessionTurn;
use crate::turn_classifier::Verdict;

pub const DEFAULT_MODEL: &str = "typesafe/jev-1.14";
pub const ENDPOINT: &str = "https://openrouter.ai/api/alpha/decisions";

pub fn evidence(scope: &str, turns: &[SessionTurn]) -> String {
    let exchange = |turn: &SessionTurn, latest: bool| {
        json!([
            {"role": "user", "text": excerpt(&turn.you, if latest { 600 } else { 300 })},
            {"role": "assistant", "text": excerpt(&turn.it, if latest { 1800 } else { 500 })},
        ])
    };
    let latest = turns.last().map(|turn| exchange(turn, true));
    let previous = turns
        .len()
        .checked_sub(2)
        .and_then(|i| turns.get(i))
        .map(|turn| exchange(turn, false));
    json!({
        "context": {"initial_request": excerpt(scope, 600), "previous_exchange": previous},
        "latest_exchange": latest,
    })
    .to_string()
}

fn excerpt(text: &str, budget: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= budget {
        return text;
    }
    // Preserve both the scope at the start and unresolved work at the end.
    let start: String = text.chars().take(budget / 3).collect();
    let end: String = text
        .chars()
        .rev()
        .take(budget * 2 / 3)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{start} [middle omitted] {end}")
}

pub fn request(model: &str, messages: &str, held: bool) -> Result<Value> {
    let messages: Value = serde_json::from_str(messages).context("invalid message evidence")?;
    Ok(json!({
        "model": model,
        "state": {"messages": messages, "automatic_followup_pending": held},
        "questions": serde_json::from_str::<Value>(include_str!("completion-questions.json"))?
    }))
}

pub fn parse(response: &[u8]) -> Result<Verdict> {
    let response: Value = serde_json::from_slice(response)?;
    if let Some(error) = response.pointer("/error/message").and_then(Value::as_str) {
        bail!("Decisions: {error}");
    }
    let attention = response
        .pointer("/answers/attention")
        .context("missing attention decision")?;
    let completion = response
        .pointer("/answers/completion")
        .context("missing completion decision")?;
    if attention["type"] != "choice" || completion["type"] != "choice" {
        bail!("decision is not a choice");
    }
    let verdict = match completion["choice"].as_str() {
        Some("task_done") => Verdict::Done,
        Some("project_done") => Verdict::ProjectDone,
        Some("unclear") => Verdict::Unclear,
        _ => bail!("unknown completion decision"),
    };
    match attention["choice"].as_str() {
        Some("needs_input") => Ok(Verdict::NeedsInput),
        Some("no_input") => Ok(verdict),
        _ => bail!("unknown attention decision"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_is_bounded_and_contains_only_final_replies() {
        let turn = SessionTurn {
            you: "x".repeat(10_000),
            it: "y".repeat(10_000),
            replies: vec!["private progress narration".into()],
        };
        let evidence = evidence(&"z".repeat(10_000), &[turn.clone(), turn.clone(), turn]);
        assert!(evidence.len() < 4100);
        assert!(!evidence.contains("private progress"));
        assert_eq!(
            serde_json::from_str::<Value>(&evidence).unwrap()["latest_exchange"][1]["text"],
            excerpt(&"y".repeat(10_000), 1800)
        );
    }

    #[test]
    fn latest_exchange_is_separate_from_superseded_requests_and_previous_replies() {
        let turns = [
            SessionTurn {
                you: "discarded".into(),
                it: "discarded answer".into(),
                ..Default::default()
            },
            SessionTurn {
                you: "propose only".into(),
                it: "no implementation yet".into(),
                ..Default::default()
            },
            SessionTurn {
                you: "implement now".into(),
                it: "deployed and verified".into(),
                ..Default::default()
            },
        ];
        let value: Value =
            serde_json::from_str(&evidence("original planning scope", &turns)).unwrap();
        assert_eq!(value["latest_exchange"][0]["role"], "user");
        assert_eq!(value["latest_exchange"][0]["text"], "implement now");
        assert_eq!(value["latest_exchange"][1]["text"], "deployed and verified");
        assert_eq!(
            value["context"]["previous_exchange"][0]["text"],
            "propose only"
        );
        assert!(!value.to_string().contains("discarded"));
        let wire = value.to_string();
        assert!(wire.find("implement now").unwrap() < wire.find("deployed and verified").unwrap());
    }

    #[test]
    fn strict_typed_choices_and_errors() {
        for (choice, expected) in [
            ("task_done", Verdict::Done),
            ("project_done", Verdict::ProjectDone),
            ("unclear", Verdict::Unclear),
        ] {
            assert_eq!(
                parse(
                    json!({"answers":{"attention":{"type":"choice","choice":"no_input"},"completion":{"type":"choice","choice":choice}}})
                        .to_string()
                        .as_bytes()
                )
                .unwrap(),
                expected
            );
        }
        assert_eq!(parse(json!({"answers":{"attention":{"type":"choice","choice":"needs_input"},"completion":{"type":"choice","choice":"project_done"}}}).to_string().as_bytes()).unwrap(), Verdict::NeedsInput);
        for invalid in [
            json!({}),
            json!({"error":{"message":"no credits"}}),
            json!({"answers":{"status":{"type":"choice","choice":"done"}}}),
        ] {
            assert!(parse(invalid.to_string().as_bytes()).is_err());
        }
    }
}

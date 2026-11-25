//! The harness the new-session composer starts on.
//!
//! The dashboard records the provider of every launch it dispatches, and the
//! next start opens the composer on it unless `--harness` says otherwise. A
//! missing or unreadable record falls back to the built-in default.
//!
//! It also keeps the model last chosen for each harness, so a choice such as
//! `anthropic/claude-opus-5-5` outlives a restart. No entry means the
//! harness's own default.
//!
//! Some models are exceptional: picking one applies to a single new session and
//! is never remembered. The list is `do_not_remember` in
//! `~/.config/agentview/model-memory.json`, and defaults to Abliteration.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::domain::Provider;

const DOCUMENT_VERSION: u32 = 1;

#[derive(Debug, Default, Deserialize, Serialize)]
struct LastHarnessDocument {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<Provider>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    models: Vec<RememberedModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RememberedModel {
    provider: Provider,
    model: String,
}

/// Models used once and never remembered. Each entry names either a whole
/// model provider (`abliteration-ai` covers `abliteration-ai/anything`) or one
/// exact model (`openrouter/vendor/model`, or a bare name such as `opus`).
/// Matching ignores case.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelMemoryPolicy {
    do_not_remember: Vec<String>,
}

#[derive(Deserialize)]
struct ModelMemoryConfig {
    #[serde(default)]
    do_not_remember: Vec<String>,
}

const DEFAULT_DO_NOT_REMEMBER: [&str; 1] = ["abliteration-ai"];

impl Default for ModelMemoryPolicy {
    fn default() -> Self {
        Self::new(
            DEFAULT_DO_NOT_REMEMBER
                .iter()
                .map(|entry| entry.to_string()),
        )
    }
}

impl ModelMemoryPolicy {
    pub fn new(entries: impl IntoIterator<Item = String>) -> Self {
        Self {
            do_not_remember: entries
                .into_iter()
                .map(|entry| entry.trim().trim_end_matches('/').to_ascii_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect(),
        }
    }

    /// The built-in list when the file is missing or unreadable, so a broken
    /// config can never start remembering an exceptional model. A file that
    /// reads replaces the built-in list, so `[]` turns the feature off.
    pub fn load_default() -> Self {
        let Some(config) = crate::fs_util::xdg_home("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        else {
            return Self::default();
        };
        Self::load(&config.join("agentview/model-memory.json"))
    }

    pub fn load(path: &std::path::Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ModelMemoryConfig>(&bytes).ok())
            .map(|config| Self::new(config.do_not_remember))
            .unwrap_or_default()
    }

    pub fn is_exceptional(&self, model: &str) -> bool {
        let model = model.trim().to_ascii_lowercase();
        self.do_not_remember.iter().any(|entry| {
            model == *entry
                || model
                    .strip_prefix(entry.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }
}

#[derive(Clone, Debug)]
pub struct LastHarness {
    path: PathBuf,
    policy: ModelMemoryPolicy,
}

impl LastHarness {
    pub fn load_default() -> Result<Self> {
        Ok(Self::at(default_last_harness_path()?).with_policy(ModelMemoryPolicy::load_default()))
    }

    pub fn at(path: PathBuf) -> Self {
        Self {
            path,
            policy: ModelMemoryPolicy::default(),
        }
    }

    pub fn with_policy(mut self, policy: ModelMemoryPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn policy(&self) -> &ModelMemoryPolicy {
        &self.policy
    }

    fn document(&self) -> Option<LastHarnessDocument> {
        let input = fs::read_to_string(&self.path).ok()?;
        let document: LastHarnessDocument = serde_json::from_str(&input).ok()?;
        (document.version == DOCUMENT_VERSION).then_some(document)
    }

    pub fn provider(&self) -> Option<Provider> {
        self.document()?.provider
    }

    /// Every remembered model, by harness. An exceptional model saved by an
    /// older version reads as the harness's default.
    pub fn models(&self) -> Vec<(Provider, String)> {
        self.document()
            .map(|document| {
                document
                    .models
                    .into_iter()
                    .filter(|entry| !self.policy.is_exceptional(&entry.model))
                    .map(|entry| (entry.provider, entry.model))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The model last chosen for `provider`, or `None` for its default.
    pub fn model(&self, provider: &Provider) -> Option<String> {
        self.models()
            .into_iter()
            .find(|(candidate, _)| candidate == provider)
            .map(|(_, model)| model)
    }

    /// Drop exceptional models an older version saved, so the file itself no
    /// longer names them.
    pub fn forget_exceptional(&self) -> Result<()> {
        let Some(mut document) = self.document() else {
            return Ok(());
        };
        let before = document.models.len();
        document
            .models
            .retain(|entry| !self.policy.is_exceptional(&entry.model));
        if document.models.len() == before {
            return Ok(());
        }
        crate::fs_util::write_private_json(&self.path, &document)
    }

    pub fn save(&self, provider: &Provider) -> Result<()> {
        let mut document = self.document().unwrap_or_default();
        if document.provider.as_ref() == Some(provider) {
            return Ok(());
        }
        document.version = DOCUMENT_VERSION;
        document.provider = Some(provider.clone());
        crate::fs_util::write_private_json(&self.path, &document)
    }

    /// Remember `model` for `provider`; `None` goes back to its default. An
    /// exceptional model is ignored and the earlier choice stays.
    pub fn save_model(&self, provider: &Provider, model: Option<&str>) -> Result<()> {
        if model.is_some_and(|model| self.policy.is_exceptional(model)) {
            return Ok(());
        }
        if self.model(provider).as_deref() == model {
            return Ok(());
        }
        let mut document = self.document().unwrap_or_default();
        document.version = DOCUMENT_VERSION;
        document.models.retain(|entry| &entry.provider != provider);
        if let Some(model) = model {
            document.models.push(RememberedModel {
                provider: provider.clone(),
                model: model.to_owned(),
            });
        }
        crate::fs_util::write_private_json(&self.path, &document)
    }
}

pub fn default_last_harness_path() -> Result<PathBuf> {
    if let Some(state_home) = crate::fs_util::xdg_home("XDG_STATE_HOME") {
        return Ok(PathBuf::from(state_home)
            .join("agentview")
            .join("last-harness.json"));
    }
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".local/state/agentview/last-harness.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_harness_survives_a_restart() {
        let directory = crate::test_support::tempfile::tempdir().unwrap();
        let path = directory.path().join("state").join("last-harness.json");
        assert_eq!(LastHarness::at(path.clone()).provider(), None);
        LastHarness::at(path.clone())
            .save(&Provider::OpenCode)
            .unwrap();
        assert_eq!(
            LastHarness::at(path.clone()).provider(),
            Some(Provider::OpenCode)
        );
        LastHarness::at(path.clone())
            .save(&Provider::Codex)
            .unwrap();
        assert_eq!(LastHarness::at(path).provider(), Some(Provider::Codex));
    }

    #[test]
    fn chosen_models_survive_a_restart_per_harness_and_keep_the_harness() {
        let directory = crate::test_support::tempfile::tempdir().unwrap();
        let path = directory.path().join("last-harness.json");
        // A record written before models were kept still reads.
        fs::write(&path, r#"{"version":1,"provider":"opencode"}"#).unwrap();
        let record = LastHarness::at(path.clone());
        assert_eq!(record.model(&Provider::OpenCode), None);
        record
            .save_model(&Provider::OpenCode, Some("cursor/claude-opus-5-5"))
            .unwrap();
        record.save_model(&Provider::Claude, Some("opus")).unwrap();
        record
            .save_model(&Provider::OpenCode, Some("anthropic/claude-opus-5-5"))
            .unwrap();
        let reloaded = LastHarness::at(path.clone());
        assert_eq!(reloaded.provider(), Some(Provider::OpenCode));
        assert_eq!(
            reloaded.model(&Provider::OpenCode).as_deref(),
            Some("anthropic/claude-opus-5-5")
        );
        assert_eq!(reloaded.model(&Provider::Claude).as_deref(), Some("opus"));
        reloaded.save(&Provider::Codex).unwrap();
        reloaded.save_model(&Provider::Claude, None).unwrap();
        let reloaded = LastHarness::at(path);
        assert_eq!(reloaded.provider(), Some(Provider::Codex));
        assert_eq!(reloaded.model(&Provider::Claude), None);
        assert!(reloaded.model(&Provider::OpenCode).is_some());
    }

    #[test]
    fn unreadable_record_falls_back_to_the_default() {
        let directory = crate::test_support::tempfile::tempdir().unwrap();
        let path = directory.path().join("last-harness.json");
        fs::write(&path, "not json").unwrap();
        assert_eq!(LastHarness::at(path).provider(), None);
    }

    #[test]
    fn exceptional_models_are_never_saved_and_keep_the_earlier_choice() {
        let directory = crate::test_support::tempfile::tempdir().unwrap();
        let path = directory.path().join("last-harness.json");
        let record = LastHarness::at(path.clone());
        record
            .save_model(&Provider::OpenCode, Some("anthropic/claude-opus-5-5"))
            .unwrap();
        record
            .save_model(
                &Provider::OpenCode,
                Some("abliteration-ai/abliterated-model-large-flash"),
            )
            .unwrap();
        assert_eq!(
            LastHarness::at(path).model(&Provider::OpenCode).as_deref(),
            Some("anthropic/claude-opus-5-5")
        );
    }

    #[test]
    fn a_legacy_saved_exceptional_model_falls_back_to_the_default() {
        let directory = crate::test_support::tempfile::tempdir().unwrap();
        let path = directory.path().join("last-harness.json");
        fs::write(
            &path,
            r#"{"version":1,"provider":"opencode","models":[
                {"provider":"opencode","model":"abliteration-ai/abliterated-model-large-flash"},
                {"provider":"claude","model":"opus"}]}"#,
        )
        .unwrap();
        let record = LastHarness::at(path);
        assert_eq!(record.model(&Provider::OpenCode), None);
        assert_eq!(record.model(&Provider::Claude).as_deref(), Some("opus"));
        assert_eq!(record.provider(), Some(Provider::OpenCode));
        record.forget_exceptional().unwrap();
        let saved = fs::read_to_string(record.path.clone()).unwrap();
        assert!(!saved.contains("abliteration"), "{saved}");
        assert_eq!(record.model(&Provider::Claude).as_deref(), Some("opus"));
        assert_eq!(record.provider(), Some(Provider::OpenCode));
    }

    #[test]
    fn policy_matches_a_provider_or_one_exact_model() {
        let policy = ModelMemoryPolicy::new(
            ["Abliteration-AI/", "openrouter/vendor/model", " "].map(String::from),
        );
        assert!(policy.is_exceptional("abliteration-ai/anything"));
        assert!(policy.is_exceptional("abliteration-ai"));
        assert!(policy.is_exceptional("openrouter/vendor/model"));
        assert!(!policy.is_exceptional("openrouter/vendor/other"));
        assert!(!policy.is_exceptional("abliteration-ai-two/model"));
        assert!(!policy.is_exceptional("anthropic/claude-opus-5-5"));
    }

    #[test]
    fn config_replaces_the_default_list_and_a_broken_file_keeps_it() {
        let directory = crate::test_support::tempfile::tempdir().unwrap();
        let path = directory.path().join("model-memory.json");
        assert!(ModelMemoryPolicy::load(&path).is_exceptional("abliteration-ai/x"));
        fs::write(&path, r#"{"do_not_remember":["groq"]}"#).unwrap();
        let policy = ModelMemoryPolicy::load(&path);
        assert!(policy.is_exceptional("groq/openai/gpt-oss-120b"));
        assert!(!policy.is_exceptional("abliteration-ai/x"));
        fs::write(&path, r#"{"do_not_remember":[]}"#).unwrap();
        assert!(!ModelMemoryPolicy::load(&path).is_exceptional("abliteration-ai/x"));
        fs::write(&path, "not json").unwrap();
        assert!(ModelMemoryPolicy::load(&path).is_exceptional("abliteration-ai/x"));
    }
}

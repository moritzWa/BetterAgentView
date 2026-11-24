//! The same setup instructions ship in the binary and on GitHub.
pub const PROMPT: &str = include_str!("../docs/SETUP-PROMPT.md");

#[cfg(test)]
mod tests {
    use super::*;

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

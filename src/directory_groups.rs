//! Local, display-only directory grouping. Never use these paths to open or launch sessions.
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DirectoryGroups {
    groups: Vec<Group>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    path: PathBuf,
    label: String,
    #[serde(default)]
    aliases: Vec<PathBuf>,
}

impl DirectoryGroups {
    pub(crate) fn load_default() -> Result<Self> {
        let Some(root) = crate::fs_util::xdg_home("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        else {
            return Ok(Self::default());
        };
        let path = root.join("agentview/directory-groups.json");
        match std::fs::read(&path) {
            Ok(bytes) => Self::parse(&bytes).with_context(|| format!("reading {}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        let config: Self = serde_json::from_slice(bytes)?;
        for group in &config.groups {
            if group.label.trim().is_empty() || group.label.chars().any(char::is_control) {
                bail!("directory group label must be nonempty and on one line");
            }
            if std::iter::once(&group.path)
                .chain(&group.aliases)
                .any(|p| !p.is_absolute())
            {
                bail!("directory group paths must be absolute");
            }
        }
        Ok(config)
    }

    pub(crate) fn path<'a>(&'a self, cwd: &Path) -> Option<&'a Path> {
        self.groups.iter().find_map(|group| {
            std::iter::once(&group.path)
                .chain(&group.aliases)
                .any(|root| cwd.starts_with(root))
                .then_some(group.path.as_path())
        })
    }

    pub(crate) fn label(&self, path: &Path) -> Option<&str> {
        self.groups
            .iter()
            .find(|group| group.path == path)
            .map(|group| group.label.as_str())
    }
}

//! What polypore remembers about sessions on top of the agents' own files:
//! names you gave them and which ones you archived. Kept in the state dir;
//! the agents' transcripts are never rewritten.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::model::RunKey;

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct SessionMeta {
    pub names: BTreeMap<String, String>,
    pub archived: BTreeSet<String>,
}

pub fn key(k: &RunKey) -> String {
    format!("{}:{}", k.kind.label(), k.id)
}

fn path() -> std::path::PathBuf {
    crate::config::state_dir().join("sessions.json")
}

impl SessionMeta {
    pub fn load() -> SessionMeta {
        std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self) {
        if let Ok(t) = serde_json::to_string_pretty(self) {
            let tmp = path().with_extension("tmp");
            if std::fs::write(&tmp, t).is_ok() {
                let _ = std::fs::rename(tmp, path());
            }
        }
    }

    pub fn name(&self, k: &RunKey) -> Option<&str> {
        self.names.get(&key(k)).map(|s| s.as_str())
    }

    /// An empty name removes it, going back to the agent's own title.
    pub fn rename(&mut self, k: &RunKey, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            self.names.remove(&key(k));
        } else {
            self.names.insert(key(k), name.to_string());
        }
        self.save();
    }

    pub fn is_archived(&self, k: &RunKey) -> bool {
        self.archived.contains(&key(k))
    }

    /// Flips archived; returns the new value.
    pub fn toggle_archived(&mut self, k: &RunKey) -> bool {
        let key = key(k);
        let now = if self.archived.remove(&key) {
            false
        } else {
            self.archived.insert(key);
            true
        };
        self.save();
        now
    }
}

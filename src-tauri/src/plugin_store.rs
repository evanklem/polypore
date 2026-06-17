//! On-disk registry of installed third-party plugins.
//!
//! Each installed plugin lives at `<project>/.polypore/plugins/<id>/`, holding
//! its bundle, a `polypore.json` manifest, and an `install.json` record written
//! by the installer (the polypore-ide MCP sidecar). These directories are the
//! source of truth: the desktop host rehydrates from them at boot so installed
//! panels render on every launch, independent of any sidecar state file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::project_context;

/// The install record persisted next to a plugin bundle.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRecord {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    installed_at: Option<u64>,
    #[serde(default)]
    source: Option<String>,
}

/// A single installed plugin as seen by the renderer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub scope: String,
    pub installed_at: u64,
    pub source: String,
    pub entry_url: String,
    pub permissions: Vec<String>,
    pub manifest: Value,
}

fn plugins_root() -> Result<PathBuf, String> {
    Ok(project_context::active_project_root()?
        .join(".polypore")
        .join("plugins"))
}

fn is_safe_plugin_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn plugin_dir(id: &str) -> Result<PathBuf, String> {
    if !is_safe_plugin_id(id) {
        return Err("invalid plugin id".to_string());
    }
    Ok(plugins_root()?.join(id))
}

fn read_manifest(dir: &Path) -> Option<Value> {
    let raw = fs::read_to_string(dir.join("polypore.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn read_install_record(dir: &Path) -> InstallRecord {
    fs::read_to_string(dir.join("install.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn manifest_string<'a>(manifest: &'a Value, key: &str) -> Option<&'a str> {
    manifest.get(key).and_then(Value::as_str)
}

fn build_record(id: &str, dir: &Path) -> Option<InstalledPlugin> {
    let manifest = read_manifest(dir)?;
    // an id mismatch between dir name and manifest is a tampering/corruption
    // signal; the protocol serves by dir name, so trust the dir name as the id.
    let record = read_install_record(dir);
    let entry = manifest_string(&manifest, "entry").unwrap_or("index.html");
    let entry_url = format!("plugin://{id}/{entry}");
    let permissions = manifest
        .get("permissions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(InstalledPlugin {
        id: id.to_string(),
        version: manifest_string(&manifest, "version")
            .unwrap_or("0.0.0")
            .to_string(),
        enabled: record.enabled.unwrap_or(true),
        scope: record.scope.unwrap_or_else(|| "project".to_string()),
        installed_at: record.installed_at.unwrap_or(0),
        source: record.source.unwrap_or_else(|| dir.display().to_string()),
        entry_url,
        permissions,
        manifest,
    })
}

/// List every installed plugin found under `.polypore/plugins/`. A missing
/// directory means nothing is installed, which is not an error.
#[tauri::command]
pub fn plugins_list_installed() -> Result<Vec<InstalledPlugin>, String> {
    let root = plugins_root()?;
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("failed to read plugins dir: {err}")),
    };
    let mut installed = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_safe_plugin_id(&id) {
            continue;
        }
        if let Some(record) = build_record(&id, &entry.path()) {
            installed.push(record);
        }
    }
    installed.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(installed)
}

/// Flip the enabled flag in a plugin's install.json so the toggle survives a
/// restart.
#[tauri::command]
pub fn plugins_set_installed_enabled(id: String, enabled: bool) -> Result<(), String> {
    let dir = plugin_dir(&id)?;
    let record_path = dir.join("install.json");
    if !dir.is_dir() {
        return Err(format!("plugin not installed: {id}"));
    }
    let mut value = fs::read_to_string(&record_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    value.insert("enabled".to_string(), Value::Bool(enabled));
    let body = serde_json::to_string_pretty(&Value::Object(value))
        .map_err(|err| format!("failed to encode install.json: {err}"))?;
    fs::write(&record_path, format!("{body}\n"))
        .map_err(|err| format!("failed to write install.json: {err}"))
}

/// Remove an installed plugin's directory from disk.
#[tauri::command]
pub fn plugins_remove_installed(id: String) -> Result<(), String> {
    let dir = plugin_dir(&id)?;
    if !dir.is_dir() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|err| format!("failed to remove plugin: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // active_project_root reads a process-global env var; serialize the tests
    // that mutate it so they do not race.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_project_root<T>(root: &Path, body: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = std::env::var(project_context::PROJECT_ROOT_ENV).ok();
        project_context::set_active_project_root(root);
        let result = body();
        match previous {
            Some(value) => std::env::set_var(project_context::PROJECT_ROOT_ENV, value),
            None => std::env::remove_var(project_context::PROJECT_ROOT_ENV),
        }
        result
    }

    fn install_fixture(root: &Path, id: &str, manifest: &str, install: Option<&str>) {
        let dir = root.join(".polypore").join("plugins").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("polypore.json"), manifest).unwrap();
        if let Some(install) = install {
            fs::write(dir.join("install.json"), install).unwrap();
        }
    }

    #[test]
    fn lists_installed_with_computed_entry_url() {
        let tmp = std::env::temp_dir().join(format!("polypore-plugin-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        install_fixture(
            &tmp,
            "acme.widget",
            r#"{"schemaVersion":1,"id":"acme.widget","title":"Widget","icon":"w","version":"1.2.3","entry":"main.html","permissions":["ui.notify"],"capabilities":[],"category":"other"}"#,
            Some(r#"{"enabled":false,"scope":"user","installedAt":42,"source":"/staged"}"#),
        );

        let installed = with_project_root(&tmp, plugins_list_installed).unwrap();

        assert_eq!(installed.len(), 1);
        let plugin = &installed[0];
        assert_eq!(plugin.id, "acme.widget");
        assert_eq!(plugin.version, "1.2.3");
        assert_eq!(plugin.entry_url, "plugin://acme.widget/main.html");
        assert!(!plugin.enabled);
        assert_eq!(plugin.scope, "user");
        assert_eq!(plugin.installed_at, 42);
        assert_eq!(plugin.permissions, vec!["ui.notify".to_string()]);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn defaults_enabled_when_install_record_missing() {
        let tmp =
            std::env::temp_dir().join(format!("polypore-plugin-test-def-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        install_fixture(
            &tmp,
            "acme.plain",
            r#"{"schemaVersion":1,"id":"acme.plain","title":"Plain","icon":"p","version":"0.1.0","entry":"index.html","permissions":[],"capabilities":[],"category":"other"}"#,
            None,
        );

        let installed = with_project_root(&tmp, plugins_list_installed).unwrap();

        assert_eq!(installed.len(), 1);
        assert!(installed[0].enabled);
        assert_eq!(installed[0].entry_url, "plugin://acme.plain/index.html");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn toggle_then_remove_round_trips() {
        let tmp =
            std::env::temp_dir().join(format!("polypore-plugin-test-rm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        install_fixture(
            &tmp,
            "acme.toggle",
            r#"{"schemaVersion":1,"id":"acme.toggle","title":"T","icon":"t","version":"0.1.0","entry":"index.html","permissions":[],"capabilities":[],"category":"other"}"#,
            Some(r#"{"enabled":true,"scope":"project","installedAt":1,"source":"/s"}"#),
        );

        with_project_root(&tmp, || {
            plugins_set_installed_enabled("acme.toggle".to_string(), false).unwrap();
            let installed = plugins_list_installed().unwrap();
            assert!(!installed[0].enabled);
            // unrelated fields survive the merge.
            assert_eq!(installed[0].installed_at, 1);

            plugins_remove_installed("acme.toggle".to_string()).unwrap();
            assert!(plugins_list_installed().unwrap().is_empty());
        });
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(plugins_set_installed_enabled("../escape".to_string(), true).is_err());
        assert!(plugins_remove_installed("../escape".to_string()).is_err());
    }

    #[test]
    fn missing_plugins_dir_is_empty_not_error() {
        let tmp =
            std::env::temp_dir().join(format!("polypore-plugin-test-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let installed = with_project_root(&tmp, plugins_list_installed).unwrap();
        assert!(installed.is_empty());
    }
}

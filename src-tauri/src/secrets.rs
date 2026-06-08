use keyring::Entry;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub id: String,
    pub scope: String,
    pub service: Option<String>,
    pub hint: String,
    pub configured: bool,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretUseRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    pub body: Option<serde_json::Value>,
    pub timeout_ms: Option<u64>,
    pub allow_insecure: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretUseResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn substitute_secret_text(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        return value.to_string();
    }
    value.replace("${secret}", secret)
}

fn scrub_secret_text(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        return value.to_string();
    }
    value.replace(secret, "[secret]")
}

fn substitute_secret_json(value: serde_json::Value, secret: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => {
            serde_json::Value::String(substitute_secret_text(&text, secret))
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|item| substitute_secret_json(item, secret))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, substitute_secret_json(value, secret)))
                .collect(),
        ),
        other => other,
    }
}

fn project_fingerprint(project_path: Option<&str>) -> String {
    let mut hasher = DefaultHasher::new();
    project_path.unwrap_or(".").hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn keyring_user(scope: &str, project_path: Option<&str>, id: &str) -> String {
    if scope == "project" {
        format!(
            "polypore.{scope}.{}.{}",
            project_fingerprint(project_path),
            id
        )
    } else {
        format!("polypore.{scope}.{id}")
    }
}

fn entry(scope: &str, project_path: Option<&str>, id: &str) -> Result<Entry, String> {
    Entry::new("polypore", &keyring_user(scope, project_path, id))
        .map_err(|err| format!("keyring unavailable: {err}"))
}

fn mask(_value: &str) -> String {
    "********".to_string()
}

fn config_dir() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("POLYPORE_CONFIG_DIR") {
        return Ok(PathBuf::from(path));
    }
    if cfg!(windows) {
        std::env::var("APPDATA")
            .map(|base| PathBuf::from(base).join("polypore"))
            .map_err(|_| "APPDATA is not set".to_string())
    } else {
        std::env::var("HOME")
            .map(|base| PathBuf::from(base).join(".config").join("polypore"))
            .map_err(|_| "HOME is not set".to_string())
    }
}

fn metadata_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("secret-refs.json"))
}

fn read_metadata() -> Result<Vec<SecretRef>, String> {
    let path = metadata_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("invalid secret metadata: {err}"))
}

fn write_metadata(items: &[SecretRef]) -> Result<(), String> {
    let path = metadata_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(items)
        .map_err(|err| format!("failed to encode secret metadata: {err}"))?;
    fs::write(&path, format!("{raw}\n"))
        .map_err(|err| format!("failed to write {}: {err}", path.display()))
}

fn upsert_metadata(next: SecretRef) -> Result<SecretRef, String> {
    let mut refs = read_metadata()?;
    refs.retain(|item| !(item.id == next.id && item.scope == next.scope));
    refs.push(next.clone());
    write_metadata(&refs)?;
    Ok(next)
}

fn secret_value(id: &str, scope: &str, project_path: Option<&str>) -> Result<String, String> {
    entry(scope, project_path, id)?
        .get_password()
        .map_err(|err| format!("secret not available: {err}"))
}

/// Resolve a secret handle to its raw value for trusted in-shell injection
/// (e.g. typing into a login field via the web driver). The value flows
/// shell→driver→page over a trusted stdio channel and never reaches the agent,
/// preserving the POLYPORE_AGENT_SCRUBBED trust model. Tries the requested
/// scope, else falls back project→user.
pub fn resolve_secret_for_injection(id: &str, scope: Option<&str>) -> Result<String, String> {
    let project = crate::project_context::active_project_root()
        .ok()
        .map(|path| path.display().to_string());
    let scopes: Vec<&str> = match scope {
        Some(scope) => vec![scope],
        None => vec!["project", "user"],
    };
    for scope in scopes {
        if let Ok(value) = secret_value(id, scope, project.as_deref()) {
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }
    Err(format!("secret handle not configured: {id}"))
}

#[tauri::command]
pub fn secrets_set(
    id: String,
    value: String,
    scope: Option<String>,
    service: Option<String>,
    project_path: Option<String>,
) -> Result<SecretRef, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    if scope != "user" && scope != "project" {
        return Err("scope must be user or project".to_string());
    }
    if id.trim().is_empty() || value.is_empty() {
        return Err("secret id and value are required".to_string());
    }
    entry(&scope, project_path.as_deref(), &id)?
        .set_password(&value)
        .map_err(|err| format!("failed to store secret in keyring: {err}"))?;

    upsert_metadata(SecretRef {
        id,
        scope,
        service,
        hint: mask(&value),
        configured: true,
        created_at: now_ms(),
        last_used_at: None,
    })
}

#[tauri::command]
pub fn secrets_list(
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<Vec<SecretRef>, String> {
    let mut refs = read_metadata()?;
    refs.retain(|item| scope.as_ref().is_none_or(|wanted| &item.scope == wanted));
    for item in &mut refs {
        item.configured = entry(&item.scope, project_path.as_deref(), &item.id)
            .and_then(|entry| {
                entry
                    .get_password()
                    .map(|_| ())
                    .map_err(|err| err.to_string())
            })
            .is_ok();
    }
    Ok(refs)
}

#[tauri::command]
pub fn secrets_has(
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<bool, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    Ok(secret_value(&id, &scope, project_path.as_deref()).is_ok())
}

#[tauri::command]
pub fn secrets_delete(
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<bool, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    let deleted = entry(&scope, project_path.as_deref(), &id)?
        .delete_credential()
        .is_ok();
    let mut refs = read_metadata()?;
    let before = refs.len();
    refs.retain(|item| !(item.id == id && item.scope == scope));
    if refs.len() != before {
        write_metadata(&refs)?;
    }
    Ok(deleted || refs.len() != before)
}

#[tauri::command]
pub fn secrets_scrub(text: String, project_path: Option<String>) -> Result<String, String> {
    let mut scrubbed = text;
    for item in read_metadata()? {
        if let Ok(secret) = secret_value(&item.id, &item.scope, project_path.as_deref()) {
            if !secret.is_empty() {
                scrubbed = scrubbed.replace(&secret, "[secret]");
            }
        }
    }
    Ok(scrubbed)
}

#[tauri::command]
pub fn secrets_use(
    id: String,
    request: SecretUseRequest,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<SecretUseResponse, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    let secret = secret_value(&id, &scope, project_path.as_deref())?;
    let url = substitute_secret_text(&request.url, &secret);
    if !url.starts_with("https://") && request.allow_insecure != Some(true) {
        return Err("url must be https unless allow_insecure is true".to_string());
    }

    let timeout_ms = request.timeout_ms.unwrap_or(30_000).min(120_000);
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|err| format!("failed to build http client: {err}"))?;

    let method = request.method.unwrap_or_else(|| "GET".to_string());
    let mut headers = HeaderMap::new();
    for (key, value) in request.headers.unwrap_or_default() {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|err| format!("invalid header name: {err}"))?;
        let value = HeaderValue::from_str(&substitute_secret_text(&value, &secret))
            .map_err(|err| format!("invalid header value: {err}"))?;
        headers.insert(name, value);
    }

    let mut builder = client
        .request(
            method
                .parse()
                .map_err(|err| format!("invalid http method: {err}"))?,
            &url,
        )
        .headers(headers);
    if let Some(body) = request.body {
        builder = builder.json(&substitute_secret_json(body, &secret));
    }

    let response = builder
        .send()
        .map_err(|err| format!("secret request failed: {err}"))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(key, value)| {
            (
                key.to_string(),
                scrub_secret_text(value.to_str().unwrap_or(""), &secret),
            )
        })
        .collect();
    let body_text = response
        .text()
        .map_err(|err| format!("failed to read response body: {err}"))?;
    let body = scrub_secret_text(&body_text, &secret);

    let mut refs = read_metadata()?;
    for item in &mut refs {
        if item.id == id && item.scope == scope {
            item.last_used_at = Some(now_ms());
        }
    }
    let _ = write_metadata(&refs);

    Ok(SecretUseResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command]
pub fn secrets_reveal(
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<Option<String>, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    match entry(&scope, project_path.as_deref(), &id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_err) => Ok(None), // treat any retrieval failure as "not found"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn mask_is_fixed_width_for_ascii_and_unicode_values() {
        assert_eq!(mask("sk-ant-secret"), "********");
        assert_eq!(mask("🔐🔐🔐🔐🔐"), "********");
        assert_eq!(mask("短い秘密"), "********");
    }

    #[test]
    fn project_keyring_user_includes_project_fingerprint() {
        let one = keyring_user("project", Some("/tmp/one"), "api-key");
        let two = keyring_user("project", Some("/tmp/two"), "api-key");
        let user = keyring_user("user", Some("/tmp/one"), "api-key");

        assert_ne!(one, two);
        assert!(one.starts_with("polypore.project."));
        assert_eq!(user, "polypore.user.api-key");
    }

    #[test]
    fn secret_substitution_and_scrubbing_cover_url_headers_and_body() {
        let secret = "sk-test-secret";
        assert_eq!(
            substitute_secret_text("https://api.example.test?token=${secret}", secret),
            "https://api.example.test?token=sk-test-secret"
        );
        assert_eq!(
            scrub_secret_text("x-secret: sk-test-secret", secret),
            "x-secret: [secret]"
        );
        let body = serde_json::json!({
            "token": "${secret}",
            "nested": ["Bearer ${secret}", { "raw": "${secret}" }],
            "count": 1
        });
        assert_eq!(
            substitute_secret_json(body, secret),
            serde_json::json!({
                "token": "sk-test-secret",
                "nested": ["Bearer sk-test-secret", { "raw": "sk-test-secret" }],
                "count": 1
            })
        );
    }

    /// C1 — secrets_reveal_returns_value_after_set
    /// Use project scope with a stable test path so the keyring key is
    /// deterministic and isolated from user secrets.  A tempdir for
    /// POLYPORE_CONFIG_DIR keeps the metadata JSON off the real filesystem.
    #[test]
    fn secrets_reveal_returns_value_after_set() {
        let tmp_config = tempfile::tempdir().expect("tempdir");
        env::set_var("POLYPORE_CONFIG_DIR", tmp_config.path().to_str().unwrap());
        let project_path = Some("/tmp/polypore-test-c1-reveal".to_string());

        // Set the secret.
        let set_result = secrets_set(
            "c1-key".to_string(),
            "c1-value".to_string(),
            Some("project".to_string()),
            None,
            project_path.clone(),
        );
        assert!(set_result.is_ok(), "secrets_set failed: {:?}", set_result);

        // Reveal the secret — stub returns None, so this should fail.
        let reveal_result = secrets_reveal(
            "c1-key".to_string(),
            Some("project".to_string()),
            project_path.clone(),
        );

        // Clean up keyring entry so we don't litter the OS keyring.
        let _ = secrets_delete(
            "c1-key".to_string(),
            Some("project".to_string()),
            project_path,
        );
        env::remove_var("POLYPORE_CONFIG_DIR");

        assert_eq!(reveal_result, Ok(Some("c1-value".to_string())));
    }

    /// C2 — secrets_reveal_returns_none_when_missing
    /// A secret that was never set → Ok(None), NOT Err.
    #[test]
    fn secrets_reveal_returns_none_when_missing() {
        let reveal_result = secrets_reveal(
            "c2-never-set-key-xzy987".to_string(),
            Some("project".to_string()),
            Some("/tmp/polypore-test-c2-missing".to_string()),
        );
        assert_eq!(reveal_result, Ok(None));
    }

    /// C3 — secrets_reveal_respects_project_scope
    /// Set with scope=project + project_path="X".
    /// Reveal without project_path → Ok(None) (different keyring user).
    /// Reveal with matching project_path → Ok(Some(value)).
    #[test]
    fn secrets_reveal_respects_project_scope() {
        let tmp_config = tempfile::tempdir().expect("tempdir");
        std::env::set_var("POLYPORE_CONFIG_DIR", tmp_config.path().to_str().unwrap());
        let project_path_x = Some("/tmp/polypore-test-c3-scope-x".to_string());

        // Set the secret with project scope and a specific project path.
        let set_result = secrets_set(
            "c3-scoped-key".to_string(),
            "c3-scoped-value".to_string(),
            Some("project".to_string()),
            None,
            project_path_x.clone(),
        );
        assert!(set_result.is_ok(), "secrets_set failed: {:?}", set_result);

        // Reveal WITHOUT the project_path → should not find it
        // (project scope includes path fingerprint, so no path → different key).
        let reveal_no_path = secrets_reveal(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            None,
        );
        // Reveal WITH a DIFFERENT project_path → also should not find it.
        let reveal_wrong_path = secrets_reveal(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            Some("/tmp/polypore-test-c3-scope-y".to_string()),
        );
        // Reveal WITH the matching project_path → should return the value.
        let reveal_correct_path = secrets_reveal(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            project_path_x.clone(),
        );

        // Clean up keyring entry.
        let _ = secrets_delete(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            project_path_x,
        );
        std::env::remove_var("POLYPORE_CONFIG_DIR");

        assert_eq!(
            reveal_no_path,
            Ok(None),
            "reveal without project_path should return None"
        );
        assert_eq!(
            reveal_wrong_path,
            Ok(None),
            "reveal with wrong project_path should return None"
        );
        assert_eq!(
            reveal_correct_path,
            Ok(Some("c3-scoped-value".to_string())),
            "reveal with correct project_path should return value"
        );
    }
}

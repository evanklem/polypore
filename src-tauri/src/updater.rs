use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatus {
    pub configured: bool,
    pub endpoint: Option<String>,
    pub available_version: Option<String>,
    pub current_version: String,
    pub status: String,
}

/* the plugin is registered unconditionally in main.rs so the IPC surface
exists in every build. without endpoints + a pubkey the check call
returns an error, which we surface as `unconfigured`; a production
build supplies both via tauri.conf.json (or `tauri signer sign` at
bundle time). */
#[tauri::command]
pub async fn updater_status(app: tauri::AppHandle) -> Result<UpdaterStatus, String> {
    let current_version = app.package_info().version.to_string();
    let endpoint = std::env::var("POLYPORE_UPDATE_ENDPOINT").ok();

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(err) => {
            return Ok(UpdaterStatus {
                configured: false,
                endpoint,
                available_version: None,
                current_version,
                status: format!("updater unavailable: {err}"),
            });
        }
    };

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdaterStatus {
            configured: true,
            endpoint,
            available_version: Some(update.version.clone()),
            current_version,
            status: format!("update {} available", update.version),
        }),
        Ok(None) => Ok(UpdaterStatus {
            configured: true,
            endpoint,
            available_version: None,
            current_version,
            status: "up to date".to_string(),
        }),
        Err(err) => Ok(UpdaterStatus {
            configured: false,
            endpoint,
            available_version: None,
            current_version,
            status: format!("update check failed: {err}"),
        }),
    }
}

#[tauri::command]
pub fn updater_current_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn updater_relaunch(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
pub async fn updater_install(app: tauri::AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "no update available".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|err| err.to_string())?;
    Ok(format!("update {} installed", update.version))
}

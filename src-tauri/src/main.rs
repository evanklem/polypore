#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod askpass_broker;
mod broker_security;
mod dap;
mod debug_capture;
mod diagnostics;
mod external;
mod fs_watch;
mod host_broker;
mod iterate;
mod lsp;
mod mcp_discover;
mod mcp_probe;
mod mcp_super;
mod notifications;
mod persistence;
mod plugin_protocol;
mod preview_native;
mod project;
mod project_context;
mod pty;
mod secret_broker;
mod secrets;
mod snapshotter;
mod updater;
mod webdriver;

fn main() {
    // git/ssh re-exec this binary as their askpass helper (GIT_ASKPASS /
    // SSH_ASKPASS point at it, flagged by an env var). Handle that and exit
    // before any GUI initialisation so a credential prompt stays cheap.
    if askpass_broker::running_as_helper() {
        askpass_broker::run_helper_and_exit();
    }

    // GTK3 + WebKitGTK on Wayland allocates a new Cairo surface every frame
    // during panel resize, making sash drag laggy. X11/XWayland avoids that
    // per-frame alloc (4x fewer cycles in perf traces). Force X11 unless the
    // user has already set GDK_BACKEND, so they can override if needed.
    // Remove when Tauri gains GTK4/webkitgtk-6.0 support.
    #[cfg(target_os = "linux")]
    if std::env::var("GDK_BACKEND").is_err() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("plugin", plugin_protocol::handle)
        .manage(mcp_super::McpSupervisor::default())
        .manage(secret_broker::SecretBroker::default())
        .manage(host_broker::HostBroker::default())
        .manage(askpass_broker::AskpassBroker::default())
        .manage(fs_watch::FsWatcher::default())
        .manage(pty::PtyRegistry::default())
        .manage(snapshotter::SnapshotterRegistry::default())
        .manage(dap::DebugRegistry::default())
        .manage(webdriver::WebDriverRegistry::default())
        .invoke_handler(tauri::generate_handler![
            agent::agent_probe,
            agent::agent_slash_catalog,
            agent::agent_send,
            agent::agent_interrupt,
            diagnostics::diagnostics_collect,
            diagnostics::diagnostics_deep_scan,
            external::open_external_url,
            fs_watch::fs_watch_status,
            fs_watch::fs_list_tree,
            fs_watch::fs_search,
            fs_watch::fs_read_text,
            fs_watch::fs_write_text,
            fs_watch::fs_mkdir,
            fs_watch::fs_delete,
            fs_watch::skill_publish,
            fs_watch::skill_unpublish,
            fs_watch::skill_delete,
            fs_watch::skill_list,
            fs_watch::knowledge_bases_list,
            fs_watch::knowledge_pick_base_folder,
            fs_watch::knowledge_pick_base_location,
            fs_watch::knowledge_base_suggest_location,
            fs_watch::knowledge_base_create,
            fs_watch::knowledge_base_set_scope,
            fs_watch::knowledge_base_rename,
            fs_watch::knowledge_base_delete,
            fs_watch::knowledge_folder_create,
            fs_watch::knowledge_folder_rename,
            fs_watch::knowledge_folder_delete,
            fs_watch::knowledge_delete_doc,
            fs_watch::knowledge_list,
            fs_watch::knowledge_read,
            fs_watch::knowledge_write,
            host_broker::mcp_host_rpc_respond,
            askpass_broker::askpass_respond,
            askpass_broker::askpass_cancel,
            iterate::iterate_run,
            iterate::iterate_status,
            lsp::lsp_diagnostics_collect,
            lsp::lsp_diagnostics_document,
            lsp::lsp_status,
            mcp_probe::mcp_server_probe,
            mcp_super::mcp_server_start,
            mcp_super::mcp_server_status,
            mcp_super::mcp_server_stop,
            notifications::os_notify,
            persistence::persistence_status,
            persistence::persistence_record_chat_message,
            persistence::persistence_record_verify_run,
            persistence::persistence_record_snapshot,
            persistence::tasks_list,
            persistence::tasks_add,
            persistence::tasks_update,
            persistence::verify_runs_list,
            persistence::verify_run_command,
            project::git_diff,
            project::git_fork,
            project::git_revert_files,
            project::git_restore_from_snapshot,
            project::worktree_create,
            project::worktrees_list,
            persistence::history_event_record,
            persistence::history_events_list,
            persistence::snapshot_log_list,
            snapshotter::snapshot_take,
            snapshotter::snapshot_signal_write,
            snapshotter::snapshot_signal_turn_end,
            snapshotter::snapshot_bootstrap,
            snapshotter::snapshot_suppress,
            project::git_run,
            project::project_status,
            project::project_templates,
            project::project_pick_folder,
            project::project_recent_list,
            project::project_open,
            project::project_forget,
            project::project_create,
            project::project_agent_status,
            preview_native::preview_capture_frame,
            preview_native::preview_focus_window,
            preview_native::preview_send_input,
            dap::debug_adapter_probe,
            dap::debug_start,
            dap::debug_set_breakpoints,
            dap::debug_continue,
            dap::debug_step_over,
            dap::debug_step_in,
            dap::debug_step_out,
            dap::debug_pause,
            dap::debug_stack_trace,
            dap::debug_scopes,
            dap::debug_variables,
            dap::debug_evaluate,
            dap::debug_console,
            dap::debug_stop,
            debug_capture::debug_capture_screenshot,
            debug_capture::debug_capture_console,
            webdriver::debug_web_capabilities,
            webdriver::debug_web_start,
            webdriver::debug_web_navigate,
            webdriver::debug_web_click,
            webdriver::debug_web_fill,
            webdriver::debug_web_login,
            webdriver::debug_web_stop,
            pty::pty_spawn,
            pty::pty_stop,
            pty::pty_write,
            pty::pty_resize,
            updater::updater_status,
            updater::updater_install,
            updater::updater_current_version,
            updater::updater_relaunch,
            secrets::secrets_set,
            secrets::secrets_set_allowed_hosts,
            secrets::secrets_list,
            secrets::secrets_has,
            secrets::secrets_delete,
            secrets::secrets_scrub,
            secrets::secrets_use,
            secrets::secrets_reveal,
            mcp_discover::mcp_discover_external,
            mcp_discover::mcp_config_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running polypore");
}

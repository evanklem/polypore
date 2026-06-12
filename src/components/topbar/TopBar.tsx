import { useEffect, useRef, useState } from 'react';
import type { LaunchTarget } from '../../Launcher';
import type { PanelType, UserWorkspacePreset, WorkspaceName } from '../../core/types';
import { GitMenu } from './GitMenu';
import { ProjectMenu } from './ProjectMenu';
import { WorkspaceMenu } from './WorkspaceMenu';
import type { ProjectStatusResult, TauriInvoke } from './types';

export interface TopBarProps {
  workspace: WorkspaceName;
  defaultWorkspace: WorkspaceName;
  defaultBranch: string;
  panelLabel: (slot: PanelType) => string;
  onWorkspaceChange: (workspace: WorkspaceName) => void;
  onResetWorkspace?: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  projectVersion: number;
  onProjectOpened: (target: LaunchTarget) => void;
  onOpenProjectLauncher: (mode: 'recent' | 'new') => void;
  tauriInvoke: TauriInvoke;
  userPresets: UserWorkspacePreset[];
  onSaveAsPreset: (name: string) => string | null;
  onDeletePreset: (name: string) => string | null;
}

type OpenMenu = 'project' | 'git' | 'workspace' | null;

export function TopBar({
  workspace,
  defaultWorkspace,
  defaultBranch,
  panelLabel,
  onWorkspaceChange,
  onResetWorkspace,
  onOpenSettings,
  onOpenHelp,
  projectVersion,
  onProjectOpened,
  onOpenProjectLauncher,
  tauriInvoke,
  userPresets,
  onSaveAsPreset,
  onDeletePreset,
}: TopBarProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<ProjectStatusResult>({
    path: '',
    name: 'polypore',
    branch: defaultBranch,
    dirty: false,
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      tauriInvoke<ProjectStatusResult>('project_status')?.then((next) => {
        if (!cancelled) setStatus(next);
      }).catch(() => {});
    };
    refresh();
    /* the repo changes from outside this UI too — a terminal `git checkout`,
       an agent running git in an embedded pty, an external editor dirtying
       files. refresh whenever the window regains focus and on a slow poll
       while visible so the branch/dirty segment tracks reality. */
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 10_000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(poll);
    };
  }, [projectVersion, tauriInvoke]);

  const toggle = (menu: Exclude<OpenMenu, null>) => () => {
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  useEffect(() => {
    if (!openMenu) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  return (
    <header className="topbar" ref={headerRef}>
      <ProjectMenu
        status={status}
        onStatusChange={setStatus}
        projectVersion={projectVersion}
        isOpen={openMenu === 'project'}
        onToggle={toggle('project')}
        onProjectOpened={onProjectOpened}
        onOpenProjectLauncher={onOpenProjectLauncher}
        tauriInvoke={tauriInvoke}
      />
      <GitMenu
        status={status}
        onStatusChange={setStatus}
        isOpen={openMenu === 'git'}
        onToggle={toggle('git')}
        tauriInvoke={tauriInvoke}
      />
      <WorkspaceMenu
        workspace={workspace}
        defaultWorkspace={defaultWorkspace}
        panelLabel={panelLabel}
        isOpen={openMenu === 'workspace'}
        onToggle={toggle('workspace')}
        onWorkspaceChange={onWorkspaceChange}
        onResetWorkspace={onResetWorkspace}
        userPresets={userPresets}
        onSaveAsPreset={onSaveAsPreset}
        onDeletePreset={onDeletePreset}
      />
      {/* Global chrome keeps to project / git / workspace /
          settings / help / brand. Agent workflow controls live in the
          codex / claude windows; status indicators for lsp/updater/mcp
          render elsewhere when they're real. */}
      <button className="segment settings-button" title="settings" aria-label="settings" onClick={onOpenSettings}>settings</button>
      <button className="segment help-button" title="help" aria-label="help" onClick={onOpenHelp}>help</button>
      <div className="segment segment--brand">polypore v{__APP_VERSION__}</div>
    </header>
  );
}

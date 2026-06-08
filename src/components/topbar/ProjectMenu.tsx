import { useEffect, useState } from 'react';
import type { LaunchTarget } from '../../Launcher';
import type { ProjectStatusResult, RecentProject, TauriInvoke } from './types';

export interface ProjectMenuProps {
  status: ProjectStatusResult;
  onStatusChange: (status: ProjectStatusResult) => void;
  projectVersion: number;
  isOpen: boolean;
  onToggle: () => void;
  onProjectOpened: (target: LaunchTarget) => void;
  onOpenProjectLauncher: (mode: 'recent' | 'new') => void;
  tauriInvoke: TauriInvoke;
}

export function ProjectMenu({
  status,
  onStatusChange,
  projectVersion,
  isOpen,
  onToggle,
  onProjectOpened,
  onOpenProjectLauncher,
  tauriInvoke,
}: ProjectMenuProps) {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    tauriInvoke<RecentProject[]>('project_recent_list')?.then((rows) => {
      if (!cancelled) setRecents(rows);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [isOpen, projectVersion, tauriInvoke]);

  const openProjectPath = async (path: string) => {
    setError('');
    try {
      const meta = await tauriInvoke<LaunchTarget>('project_open', { path });
      if (!meta) throw new Error('desktop shell is not available');
      const next = await tauriInvoke<ProjectStatusResult>('project_status');
      if (next) onStatusChange(next);
      onToggle();
      onProjectOpened(meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickFolder = async () => {
    setError('');
    try {
      const result = await tauriInvoke<string | null>('project_pick_folder');
      if (!result) return;
      await openProjectPath(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="project-menu">
      <button
        className="segment segment--project project-menu__button"
        title={status.path || 'current project'}
        aria-label={`project ${status.name}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="project-menu__name">{status.name}</span>
        <span className="project-menu__chevron" aria-hidden="true">v</span>
      </button>
      {isOpen && (
        <div className="topbar-menu topbar-menu--project" role="menu" aria-label="project actions">
          <header>
            <span>project</span>
            <strong>{status.name}</strong>
          </header>
          <div className="project-menu__path" title={status.path || 'browser preview'}>
            {status.path || 'browser preview'}
          </div>
          <div className="project-menu__actions">
            <button role="menuitem" onClick={() => { onToggle(); onOpenProjectLauncher('new'); }}>
              <span>new project</span>
              <small>create from a scaffold</small>
            </button>
            <button role="menuitem" onClick={pickFolder}>
              <span>open folder...</span>
              <small>choose a workspace on disk</small>
            </button>
            <button role="menuitem" onClick={() => { onToggle(); onOpenProjectLauncher('recent'); }}>
              <span>project launcher</span>
              <small>browse recents and templates</small>
            </button>
          </div>
          <div className="project-menu__recents" aria-label="recent projects">
            <span>recent</span>
            {recents.length === 0 && <small>no recent projects</small>}
            {recents.slice(0, 6).map((recent) => (
              <button
                key={recent.path}
                role="menuitem"
                disabled={!recent.exists}
                onClick={() => openProjectPath(recent.path)}
              >
                <span>{recent.name || recent.path}</span>
                <small>{recent.exists ? recent.path : 'missing on disk'}</small>
              </button>
            ))}
          </div>
          {error && <div className="project-menu__error">{error}</div>}
        </div>
      )}
    </div>
  );
}

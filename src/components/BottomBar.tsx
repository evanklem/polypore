import { useEffect, useState } from 'react';
import type { ProjectStatusResult, TauriInvoke } from './topbar/types';

export interface BottomBarProps {
  projectVersion: number;
  defaultBranch: string;
  tauriInvoke: TauriInvoke;
}

export function BottomBar({ projectVersion, defaultBranch, tauriInvoke }: BottomBarProps) {
  const [status, setStatus] = useState<ProjectStatusResult>({
    path: '',
    name: 'polypore',
    branch: defaultBranch,
    dirty: false,
  });
  useEffect(() => {
    let cancelled = false;
    tauriInvoke<ProjectStatusResult>('project_status')?.then((next) => {
      if (!cancelled) setStatus(next);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectVersion, tauriInvoke]);

  return (
    <footer className="bottombar">
      <span>branch:{status.branch || 'none'}</span>
      <span>{status.name}</span>
      <span>{status.dirty ? 'working tree modified' : 'working tree clean'}</span>
      <span>{status.path || 'browser preview'}</span>
    </footer>
  );
}

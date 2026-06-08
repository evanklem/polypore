import { useState } from 'react';
import type { GitRunResult, ProjectStatusResult, TauriInvoke } from './types';

const GIT_ACTIONS: ReadonlyArray<{ label: string; desc: string; action: string }> = [
  { label: 'status', desc: 'show working tree state', action: 'status' },
  { label: 'fetch', desc: 'download remote changes', action: 'fetch' },
  { label: 'pull --ff-only', desc: 'fast-forward from upstream', action: 'pull' },
  { label: 'push', desc: 'upload local commits', action: 'push' },
  { label: 'show log', desc: 'recent commit history', action: 'log' },
];

export interface GitMenuProps {
  status: ProjectStatusResult;
  onStatusChange: (status: ProjectStatusResult) => void;
  isOpen: boolean;
  onToggle: () => void;
  tauriInvoke: TauriInvoke;
}

export function GitMenu({ status, onStatusChange, isOpen, onToggle, tauriInvoke }: GitMenuProps) {
  const branch = status.branch || 'no branch';
  const upstream = status.upstream || '';
  const [busy, setBusy] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  const runGitAction = async (action: string) => {
    setBusy(action);
    setOutput('');
    setError('');
    try {
      const result = await tauriInvoke<GitRunResult>('git_run', { action });
      if (!result) throw new Error('desktop shell is not available');
      const next = await tauriInvoke<ProjectStatusResult>('project_status');
      if (next) onStatusChange(next);
      const text = result.output.trim() || `git ${result.command.join(' ')} exited ${result.exit_code ?? 0}`;
      setOutput(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="git-branch-menu">
      <button
        className="segment branch-button"
        title={`git branch: ${branch}`}
        aria-label={`git branch ${branch}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="branch-button__label" aria-hidden="true">git</span>
        <span className="branch-button__name">{branch}</span>
        {status.dirty && <span className="branch-button__dot" aria-label="modified" />}
        <span className="branch-button__chevron" aria-hidden="true">v</span>
      </button>
      {isOpen && (
        <div className="topbar-menu topbar-menu--git" role="menu" aria-label="git actions">
          <header>
            <div className="git-menu__branch-info">
              <strong>{branch}</strong>
              {upstream && upstream !== branch && <small>{upstream}</small>}
            </div>
            <span className={`git-menu__status-badge${status.dirty ? ' git-menu__status-badge--dirty' : ''}`}>
              {status.dirty ? 'modified' : 'clean'}
            </span>
          </header>
          <div className="git-menu__actions">
            {GIT_ACTIONS.map((item) => (
              <button
                key={item.action}
                className="topbar-menu__item"
                role="menuitem"
                disabled={!!busy}
                onClick={() => runGitAction(item.action)}
              >
                <span>{busy === item.action ? `${item.label}…` : item.label}</span>
                <small>{item.desc}</small>
              </button>
            ))}
          </div>
          {output && <pre className="git-menu__output">{output}</pre>}
          {error && <div className="git-menu__error">{error}</div>}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { PanelType, WorkspaceName } from '../../core/types';
import { workspacePresets } from '../../workspaces/presets';

export interface WorkspaceMenuProps {
  workspace: WorkspaceName;
  defaultWorkspace: WorkspaceName;
  panelLabel: (slot: PanelType) => string;
  isOpen: boolean;
  onToggle: () => void;
  onWorkspaceChange: (workspace: WorkspaceName) => void;
  onResetWorkspace?: () => void;
}

export function WorkspaceMenu({
  workspace,
  defaultWorkspace,
  panelLabel,
  isOpen,
  onToggle,
  onWorkspaceChange,
  onResetWorkspace,
}: WorkspaceMenuProps) {
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!isOpen) setNotice('');
  }, [isOpen]);

  return (
    <div className="topbar-select">
      <button
        className="segment topbar-select__button"
        aria-label={`workspace ${workspace.toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="topbar-select__label">workspace</span>
        <strong>{workspace.toLowerCase()}</strong>
        <span className="topbar-select__chevron" aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <div className="topbar-menu topbar-menu--workspace workspace-preset-menu" role="menu" aria-label="workspace presets">
          <header>
            <span>workspace preset</span>
            <strong>{workspace.toLowerCase()}</strong>
          </header>
          <div className="workspace-preset-menu__section" aria-label="workspace preset list">
            {workspacePresets.map((preset) => (
              <button
                key={preset.name}
                className={preset.name === workspace ? 'topbar-menu__item topbar-menu__item--active' : 'topbar-menu__item'}
                role="menuitemradio"
                aria-checked={preset.name === workspace}
                aria-label={`${preset.name.toLowerCase()} ${preset.panels.length} panels ${preset.emphasis.map(panelLabel).join(', ')}`}
                onClick={() => {
                  onWorkspaceChange(preset.name);
                  onToggle();
                }}
              >
                <span>{preset.name.toLowerCase()}</span>
                <small>{preset.panels.length} panels · {preset.emphasis.map(panelLabel).join(', ')}</small>
              </button>
            ))}
          </div>
          <div className="workspace-preset-menu__section workspace-preset-menu__section--actions">
            <button
              role="menuitem"
              onClick={() => {
                window.localStorage.setItem('polypore.workspace.savedPreset', workspace);
                setNotice(`saved ${workspace.toLowerCase()} as default`);
              }}
            >
              save as default
            </button>
            <button
              role="menuitem"
              onClick={() => {
                onResetWorkspace?.();
                onToggle();
              }}
            >
              reset workspace
            </button>
          </div>
          {notice && <div className="workspace-preset-menu__notice">{notice}</div>}
        </div>
      )}
    </div>
  );
}

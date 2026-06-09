import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PanelType, UserWorkspacePreset, WorkspaceName } from '../../core/types';
import { workspacePresets } from '../../workspaces/presets';

export interface WorkspaceMenuProps {
  workspace: WorkspaceName;
  defaultWorkspace: WorkspaceName;
  panelLabel: (slot: PanelType) => string;
  isOpen: boolean;
  onToggle: () => void;
  onWorkspaceChange: (workspace: WorkspaceName) => void;
  onResetWorkspace?: () => void;
  userPresets: UserWorkspacePreset[];
  onSaveAsPreset: (name: string) => string | null;
  onDeletePreset: (name: string) => string | null;
}

export function WorkspaceMenu({
  workspace,
  defaultWorkspace,
  panelLabel,
  isOpen,
  onToggle,
  onWorkspaceChange,
  onResetWorkspace,
  userPresets,
  onSaveAsPreset,
  onDeletePreset,
}: WorkspaceMenuProps) {
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [deletePresetName, setDeletePresetName] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!saveDialogOpen) return;
    nameInputRef.current?.focus();
  }, [saveDialogOpen]);

  useEffect(() => {
    if (!deletePresetName) return;
    deleteButtonRef.current?.focus();
  }, [deletePresetName]);

  const nameExists = (name: string) => {
    const normalized = name.toLowerCase();
    return workspacePresets.some((preset) => preset.name.toLowerCase() === normalized)
      || userPresets.some((preset) => preset.name.toLowerCase() === normalized);
  };

  const closeSaveDialog = () => {
    setSaveDialogOpen(false);
    setPresetName('');
    setSaveError('');
  };

  const handleSave = () => {
    const name = presetName.trim();
    if (!name) return;
    if (nameExists(name)) {
      setSaveError('a workspace with that name already exists');
      return;
    }
    const error = onSaveAsPreset(name);
    if (error) {
      setSaveError(error);
      return;
    }
    closeSaveDialog();
  };

  const handleSaveKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') closeSaveDialog();
  };

  const closeDeleteDialog = () => {
    setDeletePresetName(null);
    setDeleteError('');
  };

  const handleDelete = () => {
    if (!deletePresetName) return;
    const error = onDeletePreset(deletePresetName);
    if (error) {
      setDeleteError(error);
      return;
    }
    if (deletePresetName === workspace) {
      onWorkspaceChange(defaultWorkspace);
    }
    closeDeleteDialog();
  };

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

          <div className="workspace-preset-menu__section" aria-label="built-in presets">
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

          {userPresets.length > 0 && (
            <div className="workspace-preset-menu__section workspace-preset-menu__section--user" aria-label="saved presets">
              {userPresets.map((preset) => (
                <div
                  key={preset.name}
                  className="workspace-preset-menu__user-row"
                >
                  <button
                    className={`topbar-menu__item${preset.name === workspace ? ' topbar-menu__item--active' : ''}`}
                    role="menuitemradio"
                    aria-checked={preset.name === workspace}
                    aria-label={preset.name.toLowerCase()}
                    onClick={() => {
                      onWorkspaceChange(preset.name);
                      onToggle();
                    }}
                  >
                    <span>{preset.name.toLowerCase()}</span>
                    <small>saved preset</small>
                  </button>
                  <button
                    type="button"
                    className="topbar-menu__item-delete"
                    aria-label={`delete ${preset.name.toLowerCase()} preset`}
                    onClick={() => {
                      setDeletePresetName(preset.name);
                      setDeleteError('');
                      onToggle();
                    }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="workspace-preset-menu__section workspace-preset-menu__section--actions">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setPresetName('');
                setSaveError('');
                setSaveDialogOpen(true);
                onToggle();
              }}
            >
              save current layout
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
        </div>
      )}
      {saveDialogOpen && createPortal(
        <div
          className="panel-settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSaveDialog();
          }}
        >
          <div
            className="panel-settings-overlay host-input-overlay workspace-preset-dialog"
            role="dialog"
            aria-label="save current layout"
            aria-modal="true"
          >
            <header>
              <strong>save current layout</strong>
            </header>
            <input
              ref={nameInputRef}
              type="text"
              maxLength={48}
              value={presetName}
              placeholder="workspace name"
              aria-label="workspace name"
              onChange={(event) => {
                setPresetName(event.target.value);
                setSaveError('');
              }}
              onKeyDown={handleSaveKeyDown}
            />
            {saveError && <p className="workspace-preset-dialog__error" role="alert">{saveError}</p>}
            <div className="host-confirm-overlay__actions">
              <button type="button" onClick={closeSaveDialog}>cancel</button>
              <button type="button" disabled={!presetName.trim()} onClick={handleSave}>save</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {deletePresetName && createPortal(
        <div
          className="panel-settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDeleteDialog();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeDeleteDialog();
          }}
        >
          <div
            className="panel-settings-overlay host-confirm-overlay workspace-preset-dialog"
            role="dialog"
            aria-label={`delete ${deletePresetName.toLowerCase()} preset`}
            aria-modal="true"
          >
            <header>
              <strong>delete workspace preset</strong>
            </header>
            <section className="host-confirm-overlay__body">
              <strong>{deletePresetName}</strong>
              <span>this preset and its saved layout will be permanently deleted</span>
            </section>
            {deleteError && <p className="workspace-preset-dialog__error" role="alert">{deleteError}</p>}
            <div className="host-confirm-overlay__actions">
              <button type="button" onClick={closeDeleteDialog}>cancel</button>
              <button
                ref={deleteButtonRef}
                type="button"
                className="workspace-preset-dialog__delete"
                onClick={handleDelete}
              >
                delete
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

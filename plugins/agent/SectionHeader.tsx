import React from 'react';

export type SectionHeaderProps = {
  title: string;
  count?: number;
  addLabel?: string;
  onAdd?: () => void;
  children?: React.ReactNode;
};

export function SectionHeader({ title, count, addLabel, onAdd, children }: SectionHeaderProps) {
  return (
    <header className="section-header agent-side__section-head">
      <div className="section-header__title">
        <h3>{title}</h3>
        {count !== undefined && (
          <span className="section-header__count agent-side__section-meta">{count}</span>
        )}
      </div>
      {(children || (addLabel && onAdd)) && (
        <div className="section-header__actions">
          {children}
          {addLabel && onAdd && (
            <button className="section-header__add agent-side__inline-btn" onClick={onAdd}>
              {addLabel}
            </button>
          )}
        </div>
      )}
    </header>
  );
}

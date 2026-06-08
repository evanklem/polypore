import React from 'react';

export type EmptyStateProps = {
  message: string;
  ctaLabel: string;
  onAction: () => void;
};

export function EmptyState({ message, ctaLabel, onAction }: EmptyStateProps) {
  return (
    <div className="empty-state empty-state--rail">
      <p className="empty-state__message">{message}</p>
      <button className="empty-state__cta agent-side__inline-btn" onClick={onAction}>
        {ctaLabel}
      </button>
    </div>
  );
}

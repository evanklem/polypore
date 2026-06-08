import { useEffect, useRef, useState } from 'react';

export interface HostInputBoxOverlayProps {
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

export function HostInputBoxOverlay({ prompt, placeholder, initialValue, onCancel, onSubmit }: HostInputBoxOverlayProps) {
  const [value, setValue] = useState(initialValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div className="panel-settings-backdrop" role="presentation">
      <div className="panel-settings-overlay host-input-overlay" role="dialog" aria-label={prompt}>
        <header>
          <strong>{prompt}</strong>
        </header>
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') onCancel();
          }}
          aria-label={prompt}
        />
        <div className="host-confirm-overlay__actions">
          <button type="button" onClick={onCancel}>cancel</button>
          <button type="button" onClick={submit}>ok</button>
        </div>
      </div>
    </div>
  );
}

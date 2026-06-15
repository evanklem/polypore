import { useState } from 'react';
import {
  ACCENT_PRESETS,
  DEFAULT_INTERFACE_SETTINGS,
  type InterfaceGlass,
  type InterfaceMotion,
  type InterfaceSettings,
  loadInterfaceSettings,
  normalizeAccent,
  normalizeZoom,
  resetInterfaceSettings,
  saveInterfaceSettings,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from '../settingsStorage';

export interface InterfaceTabProps {
  setNotice: (value: string) => void;
}

const MOTION_OPTIONS: Array<{ value: InterfaceMotion; label: string }> = [
  { value: 'full', label: 'full' },
  { value: 'reduced', label: 'reduced' },
];

const GLASS_OPTIONS: Array<{ value: InterfaceGlass; label: string }> = [
  { value: 'frosted', label: 'frosted' },
  { value: 'solid', label: 'solid' },
];

export function InterfaceTab({ setNotice }: InterfaceTabProps) {
  const [settings, setSettings] = useState<InterfaceSettings>(() => loadInterfaceSettings());

  const update = <K extends keyof InterfaceSettings>(key: K, value: InterfaceSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(saveInterfaceSettings(next));
    setNotice('interface settings saved');
  };

  const reset = () => {
    setSettings(resetInterfaceSettings());
    setNotice('interface settings reset');
  };

  return (
    <section className="surface-page" aria-label="appearance">
      <section className="surface-section" role="group" aria-label="accent">
        <div className="surface-section__head">
          <h2>accent</h2>
          <span className="surface-section__head-row">
            <small>retints the whole theme · applies immediately</small>
            <span className="appearance-preview" style={{ background: settings.accent }} aria-label="current accent" />
          </span>
        </div>
        <div className="appearance-swatches">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.hex}
              type="button"
              className="appearance-swatch"
              aria-pressed={settings.accent === preset.hex}
              onClick={() => update('accent', preset.hex)}
            >
              <span className="appearance-swatch__dot" style={{ background: preset.hex }} aria-hidden="true" />
              <span>{preset.name}</span>
            </button>
          ))}
        </div>
        <div className="appearance-color">
          <label className="appearance-color__well" title="pick any colour">
            <input
              type="color"
              value={settings.accent}
              aria-label="custom accent colour"
              onChange={(event) => update('accent', event.target.value)}
            />
            <span className="appearance-swatch__dot" style={{ background: settings.accent }} aria-hidden="true" />
            <span>custom</span>
          </label>
          <input
            className="surface-input appearance-color__hex"
            value={settings.accent}
            aria-label="accent hex"
            spellCheck={false}
            onChange={(event) => setSettings((current) => ({ ...current, accent: event.target.value }))}
            onBlur={(event) => update('accent', normalizeAccent(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update('accent', normalizeAccent((event.target as HTMLInputElement).value));
            }}
          />
        </div>
      </section>

      <section className="surface-section" aria-label="interface behavior">
        <div className="surface-section__head">
          <h2>behaviour</h2>
          <small>motion and surface</small>
        </div>
        <div className="appearance-choices">
          <SettingPicker label="motion" value={settings.motion} options={MOTION_OPTIONS} onChange={(value) => update('motion', value)} />
          <SettingPicker label="surface" value={settings.glass} options={GLASS_OPTIONS} onChange={(value) => update('glass', value)} />
        </div>
      </section>

      <section className="surface-section" aria-label="scale">
        <div className="surface-section__head">
          <h2>scale</h2>
          <small>sizes the whole ui · independent of system scaling</small>
        </div>
        <div className="appearance-zoom">
          <button
            type="button"
            className="appearance-zoom__step"
            aria-label="decrease scale"
            onClick={() => update('zoom', normalizeZoom(settings.zoom - ZOOM_STEP))}
            disabled={settings.zoom <= ZOOM_MIN}
          >
            −
          </button>
          <input
            type="range"
            className="appearance-zoom__slider"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={settings.zoom}
            aria-label="ui scale"
            onChange={(event) => update('zoom', normalizeZoom(Number(event.target.value)))}
          />
          <button
            type="button"
            className="appearance-zoom__step"
            aria-label="increase scale"
            onClick={() => update('zoom', normalizeZoom(settings.zoom + ZOOM_STEP))}
            disabled={settings.zoom >= ZOOM_MAX}
          >
            +
          </button>
          <span className="appearance-zoom__value">{Math.round(settings.zoom * 100)}%</span>
        </div>
      </section>

      <div className="surface-action-row">
        <button
          type="button"
          className="surface-btn"
          onClick={reset}
          disabled={JSON.stringify(settings) === JSON.stringify(DEFAULT_INTERFACE_SETTINGS)}
        >
          reset to defaults
        </button>
      </div>
    </section>
  );
}

function SettingPicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="appearance-choice" role="group" aria-label={label}>
      <span className="appearance-choice__label">{label}</span>
      <div className="appearance-segmented">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

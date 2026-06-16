import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App, { AppHostProvider, createAppHost } from './App';
import { applyInterfaceSettings, loadInterfaceSettings, registerZoomHotkeys } from './settings/settingsStorage';

/* Apply the saved theme BEFORE the first React commit so the initial paint uses
   the user's accent, not the honey defaults baked into tokens.css. Doing this in
   a component effect (the old home of this call) fires after first paint, which
   is what produced the one-frame honey flash on load. */
applyInterfaceSettings(loadInterfaceSettings());

/* global Ctrl/Cmd +/-/0 scale hotkeys, bound to the same persisted setting as
   the Settings slider. registered once for the app's lifetime. */
registerZoomHotkeys();

/* host construction is explicit: importing App performs no construction,
   the entry point decides when the host comes to life. */
const appHostBundle = createAppHost();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <AppHostProvider value={appHostBundle}>
      <App />
    </AppHostProvider>
  </React.StrictMode>
);

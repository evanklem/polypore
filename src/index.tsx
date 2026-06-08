import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { applyInterfaceSettings, loadInterfaceSettings } from './settings/settingsStorage';

/* Apply the saved theme BEFORE the first React commit so the initial paint uses
   the user's accent, not the honey defaults baked into tokens.css. Doing this in
   a component effect (the old home of this call) fires after first paint, which
   is what produced the one-frame honey flash on load. */
applyInterfaceSettings(loadInterfaceSettings());

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();

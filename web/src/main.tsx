/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register service worker in production only.
// Module worker so sw-routing.js can be tested as a plain ES module.
// Decision recorded in README: requires Chrome/Edge/Safari/Firefox with
// module worker support; no offline on plain-HTTP LAN addresses.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { type: 'module' })
      .catch((err) => console.error('[sw] registration failed:', err));
  });
}

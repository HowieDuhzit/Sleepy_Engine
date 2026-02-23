import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { AppShell } from './react/AppShell';
import { SolanaWalletProvider } from './react/SolanaWalletProvider';
import { applyGlobalSettings, loadGlobalSettings } from './settings/global-settings';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app');
}

applyGlobalSettings(loadGlobalSettings());

createRoot(container).render(
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(SolanaWalletProvider, null, React.createElement(AppShell, null)),
  ),
);

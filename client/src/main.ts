import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { AppShell } from './react/AppShell';
import { SolanaWalletProvider } from './react/SolanaWalletProvider';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app');
}

createRoot(container).render(
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(SolanaWalletProvider, null, React.createElement(AppShell, null)),
  ),
);

import React, { useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { NameRegistryState } from '@bonfida/spl-name-service';
import { uploadGameAvatar } from '../services/game-api';

const nameRegistry = NameRegistryState as unknown as {
  retrieve: (connection: Connection, owner: PublicKey, type?: PublicKey) => Promise<{ registryData?: { name?: string } } | null>;
};

async function resolveSnsName(connection: Connection, owner: PublicKey): Promise<string | null> {
  try {
    const registry = await nameRegistry.retrieve(connection, owner, undefined);
    return registry?.registryData?.name ?? null;
  } catch (err) {
    console.warn('SNS lookup failed', err);
    return null;
  }
}

type PlayerProfileCardProps = {
  gameId: string;
  scene: string;
  gameName: string;
};

export function PlayerProfileCard({ gameId, scene, gameName }: PlayerProfileCardProps) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [snsName, setSnsName] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  useEffect(() => {
    if (!connected || !publicKey) {
      setBalance(null);
      setSnsName(null);
      return;
    }
    let canceled = false;
    setBalance(null);
    connection
      .getBalance(publicKey)
      .then((lamports: number) => {
        if (canceled) return;
        setBalance(lamports / LAMPORTS_PER_SOL);
      })
      .catch(() => {
        if (canceled) return;
        setBalance(null);
      });
    resolveSnsName(connection, publicKey)
      .then((name) => {
        if (canceled) return;
        setSnsName(name);
      })
      .catch(() => {
        if (canceled) return;
        setSnsName(null);
      });
    return () => {
      canceled = true;
    };
  }, [connection, connected, publicKey]);

  const handleUpload = async () => {
    if (!selectedFile) {
      setStatus('Select a VRM file first');
      return;
    }
    if (!gameId) {
      setStatus('Pick a game before saving');
      return;
    }
    setUploading(true);
    setStatus('Uploading...');
    try {
      await uploadGameAvatar(gameId, 'default.vrm', selectedFile);
      setStatus('Default VRM saved');
    } catch (err) {
      setStatus(`Upload failed: ${String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const walletText = publicKey ? `${publicKey.toBase58().slice(0, 6)}…${publicKey.toBase58().slice(-4)}` : 'Not connected';
  const snsDisplay = snsName ?? 'No SNS record';
  const balanceDisplay = balance === null ? '—' : `${balance.toFixed(4)} SOL`;

  return (
    <section className="nxe-profile-card">
      <div className="nxe-profile-title">Solana Profile</div>
      <div className="nxe-profile-row">Game: <strong>{gameName || 'none'}</strong></div>
      <div className="nxe-profile-row">Scene: <strong>{scene}</strong></div>
      <WalletMultiButton className="nxe-wallet-button" />
      <div className="nxe-profile-meta">
        <div><span>Wallet</span><strong>{walletText}</strong></div>
        <div><span>SNS</span><strong>{snsDisplay}</strong></div>
        <div><span>Balance</span><strong>{balanceDisplay}</strong></div>
      </div>
      <label className="nxe-profile-upload">
        <span>Default VRM</span>
        <input
          type="file"
          accept=".vrm,.glb,.gltf"
          onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <button className="nxe-profile-save" onClick={handleUpload} disabled={uploading || !selectedFile}>
        {uploading ? 'Saving…' : 'Save Default VRM'}
      </button>
      {status && <div className="nxe-profile-status">{status}</div>}
    </section>
  );
}

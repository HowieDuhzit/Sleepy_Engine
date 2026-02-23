import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { ConsoleSettingsCard } from './ConsoleSettingsCard';
import { buildAnimationClipFromData, parseClipPayload, type ClipData } from '../game/clip';
import { menuAudio } from '../audio/menu-audio';
import {
  applyGlobalSettings,
  type GlobalSettings,
  loadGlobalSettings,
  resetGlobalSettings,
  saveGlobalSettings,
} from '../settings/global-settings';
import {
  addSocialFriend,
  getSocialState,
  saveSocialProfile,
  sendSocialMessage,
  type SocialFriendRecord,
  type SocialMessageRecord,
} from '../services/game-api';

type MainMenuScene3DProps = {
  showForeground?: boolean;
  gameId: string;
  gameName: string;
  startScene: string;
  gamesCount: number;
  notificationsCount: number;
  friendsOnline: number;
  clock: string;
  games: Array<{ id: string; name: string }>;
  onGameChange: (gameId: string) => void;
  onPlay: () => void;
  onEditor: () => void;
};

type MenuCardKind = 'project' | 'editor' | 'social' | 'settings';

type MenuCard = {
  id: string;
  kind: MenuCardKind;
  title: string;
  color: string;
  gameId?: string;
};

type CardRuntime = {
  cardId: string;
  group: THREE.Group;
  body: THREE.Mesh;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  materials: {
    surface: THREE.MeshBasicMaterial;
  };
};

type CardStats = {
  gameName: string;
  gameId: string;
  startScene: string;
  gamesCount: number;
  notificationsCount: number;
  friendsOnline: number;
  clock: string;
};

type SocialFriend = {
  id: string;
  name: string;
  status: string;
  online: boolean;
};

type SocialMessage = {
  id: string;
  from: 'me' | 'friend';
  text: string;
  at: string;
};

const h = React.createElement;

const PROJECT_CARD_COLORS = ['#6eb66c', '#5ca8c8', '#6f8ed8', '#8d73ce', '#6fa7a0', '#86b258'];
const STATIC_CARD_COLORS: Record<Exclude<MenuCardKind, 'project'>, string> = {
  editor: '#67b67a',
  social: '#4f97be',
  settings: '#5f7fa8',
};

const socialClientStorageKey = 'nxe_social_client_id';

const getOrCreateSocialClientId = () => {
  if (typeof window === 'undefined') return 'guest_local';
  const existing = window.localStorage.getItem(socialClientStorageKey);
  if (existing && /^[a-z0-9_-]{3,64}$/i.test(existing)) return existing;
  const raw =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const clientId = raw.replace(/[^a-z0-9_-]/gi, '_').toLowerCase().slice(0, 48);
  window.localStorage.setItem(socialClientStorageKey, clientId);
  return clientId;
};

const toUiMessage = (message: SocialMessageRecord, clientId: string): SocialMessage => ({
  id: message.id,
  from: message.from === clientId ? 'me' : 'friend',
  text: message.text,
  at: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
});

const mapSocialFriends = (friends: SocialFriendRecord[]): SocialFriend[] =>
  friends.map((friend) => ({
    id: friend.id,
    name: friend.name,
    status: friend.status,
    online: friend.online,
  }));

const mapSocialChats = (
  chats: Record<string, SocialMessageRecord[]>,
  clientId: string,
): Record<string, SocialMessage[]> => {
  const mapped: Record<string, SocialMessage[]> = {};
  for (const [friendId, messages] of Object.entries(chats)) {
    mapped[friendId] = messages.map((message) => toUiMessage(message, clientId));
  }
  return mapped;
};

const getMenuQualityProfile = (settings: GlobalSettings) => {
  const reducedMotion = settings.accessibility.reducedMotion;
  const qualityPreset = settings.video.qualityPreset;
  const base =
    qualityPreset === 'performance'
      ? { particles: 1200, motion: 0.55, size: 0.04 }
      : qualityPreset === 'balanced'
        ? { particles: 2200, motion: 0.78, size: 0.046 }
        : qualityPreset === 'cinematic'
          ? { particles: 4800, motion: 1.2, size: 0.056 }
          : { particles: 3200, motion: 1, size: 0.048 };
  if (reducedMotion) {
    return {
      particles: Math.round(base.particles * 0.65),
      motion: base.motion * 0.34,
      size: base.size,
    };
  }
  return base;
};

function buildMenuCards(games: Array<{ id: string; name: string }>): MenuCard[] {
  const projectCards: MenuCard[] = games.map((game, index) => ({
    id: `project:${game.id}`,
    kind: 'project',
    title: game.name || game.id,
    color: PROJECT_CARD_COLORS[index % PROJECT_CARD_COLORS.length] ?? '#6a9bcf',
    gameId: game.id,
  }));

  return [
    ...projectCards,
    { id: 'editor', kind: 'editor', title: 'Editor', color: STATIC_CARD_COLORS.editor },
    { id: 'social', kind: 'social', title: 'Social', color: STATIC_CARD_COLORS.social },
    { id: 'settings', kind: 'settings', title: 'Settings', color: STATIC_CARD_COLORS.settings },
  ];
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawCardUi(
  card: MenuCard,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  stats: CardStats,
  isFocused: boolean,
) {
  const accent = new THREE.Color(card.color);
  const accentRgb = `${Math.round(accent.r * 255)}, ${Math.round(accent.g * 255)}, ${Math.round(accent.b * 255)}`;
  const panelX = 18;
  const panelY = 16;
  const panelW = canvas.width - 36;
  const panelH = canvas.height - 32;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const bgGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  bgGradient.addColorStop(0, isFocused ? 'rgba(9, 17, 28, 0.98)' : 'rgba(9, 17, 28, 0.82)');
  bgGradient.addColorStop(1, isFocused ? 'rgba(4, 9, 16, 0.98)' : 'rgba(4, 9, 16, 0.8)');
  ctx.fillStyle = bgGradient;
  roundedRectPath(ctx, panelX, panelY, panelW, panelH, 18);
  ctx.fill();

  const glossGradient = ctx.createLinearGradient(panelX, panelY, panelX, panelY + panelH * 0.5);
  glossGradient.addColorStop(0, isFocused ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)');
  glossGradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glossGradient;
  roundedRectPath(ctx, panelX, panelY, panelW, panelH, 18);
  ctx.fill();

  const borderGradient = ctx.createLinearGradient(panelX, panelY, panelX + panelW, panelY + panelH);
  borderGradient.addColorStop(0, `rgba(${accentRgb}, ${isFocused ? 0.9 : 0.55})`);
  borderGradient.addColorStop(1, 'rgba(210,230,255,0.28)');
  ctx.strokeStyle = borderGradient;
  ctx.lineWidth = isFocused ? 3 : 2;
  roundedRectPath(ctx, panelX, panelY, panelW, panelH, 18);
  ctx.stroke();

  ctx.fillStyle = `rgba(${accentRgb}, ${isFocused ? 0.8 : 0.45})`;
  roundedRectPath(ctx, panelX + 8, panelY + 10, 8, panelH - 20, 4);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.font = '700 20px "Space Grotesk", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(card.kind.toUpperCase(), panelX + 30, panelY + 27);

  const chipText = isFocused ? 'SELECTED' : 'READY';
  const chipW = ctx.measureText(chipText).width + 24;
  const chipH = 28;
  const chipX = panelX + panelW - chipW - 20;
  const chipY = panelY + 14;
  ctx.fillStyle = isFocused ? `rgba(${accentRgb}, 0.26)` : 'rgba(172,198,238,0.15)';
  roundedRectPath(ctx, chipX, chipY, chipW, chipH, 14);
  ctx.fill();
  ctx.strokeStyle = isFocused ? `rgba(${accentRgb}, 0.8)` : 'rgba(198,219,255,0.28)';
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, chipX, chipY, chipW, chipH, 14);
  ctx.stroke();
  ctx.fillStyle = 'rgba(241,248,255,0.95)';
  ctx.font = '700 14px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(chipText, chipX + chipW / 2, chipY + chipH / 2 + 0.5);
  ctx.textAlign = 'start';

  ctx.fillStyle = 'rgba(248,252,255,0.98)';
  ctx.font = '700 54px "Space Grotesk", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(card.title, panelX + 30, panelY + 52);

  const subtitle =
    card.kind === 'project'
      ? `${card.gameId ?? 'none'} | scene ${stats.startScene}`
      : card.kind === 'editor'
        ? `${stats.gameName} | ${stats.startScene}`
        : card.kind === 'social'
          ? `${stats.friendsOnline} online | ${stats.notificationsCount} alerts`
          : `global console settings | ${stats.gameName}`;
  ctx.fillStyle = 'rgba(190,216,248,0.92)';
  ctx.font = '600 17px "Space Grotesk", sans-serif';
  ctx.fillText(subtitle, panelX + 30, panelY + 114);

  const dividerY = panelY + 145;
  ctx.strokeStyle = 'rgba(178,208,248,0.24)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(panelX + 30, dividerY);
  ctx.lineTo(panelX + panelW - 24, dividerY);
  ctx.stroke();

  ctx.fillStyle = 'rgba(230,242,255,0.93)';
  ctx.font = '600 22px "Space Grotesk", sans-serif';

  const lines: string[] = [];
  if (card.kind === 'project') {
    lines.push(`Project: ${card.title}`);
    lines.push(`Project ID: ${card.gameId ?? 'none'}`);
    lines.push(stats.gameId === card.gameId ? 'Press Enter / A to launch project' : 'Press Enter / A to select');
  } else if (card.kind === 'editor') {
    lines.push(`Current project: ${stats.gameName}`);
    lines.push(`Scene: ${stats.startScene}`);
    lines.push('Press Enter / A to open editor');
  } else if (card.kind === 'social') {
    lines.push(`Friends online: ${stats.friendsOnline}`);
    lines.push(`Notifications: ${stats.notificationsCount}`);
    lines.push(`Local clock: ${stats.clock}`);
  } else {
    lines.push('Global settings across all games');
    lines.push(`Current project: ${stats.gameName}`);
    lines.push('Press Enter / A for profile, audio, video, network');
  }

  lines.forEach((line, index) => {
    ctx.fillText(line, panelX + 30, panelY + 164 + index * 30);
  });

  const footerY = panelY + panelH - 38;
  ctx.fillStyle = 'rgba(170,198,236,0.44)';
  ctx.font = '600 15px "Space Grotesk", sans-serif';
  ctx.fillText('Navigate: Arrow Keys / Left Stick', panelX + 30, footerY);
  ctx.textAlign = 'right';
  ctx.fillStyle = isFocused ? `rgba(${accentRgb}, 0.95)` : 'rgba(198,219,255,0.64)';
  ctx.fillText(isFocused ? 'ACTIVE CARD' : 'IN STACK', panelX + panelW - 24, footerY);
  ctx.textAlign = 'start';
}

export function MainMenuScene3D({
  showForeground = true,
  gameId,
  gameName,
  startScene,
  gamesCount,
  notificationsCount,
  friendsOnline,
  clock,
  games,
  onGameChange,
  onPlay,
  onEditor,
}: MainMenuScene3DProps) {
  const menuCards = useMemo(() => buildMenuCards(games), [games]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [activeCardId, setActiveCardId] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [socialOpen, setSocialOpen] = useState(false);
  const [globalSettings, setGlobalSettings] = useState(() => loadGlobalSettings());
  const [fpsText, setFpsText] = useState('');
  const [socialClientId] = useState<string>(() => getOrCreateSocialClientId());
  const [friends, setFriends] = useState<SocialFriend[]>([]);
  const [profile, setProfile] = useState({
    displayName: 'Player One',
    status: 'Ready to play',
    bio: 'Building worlds and testing every frame.',
  });
  const [profileDraft, setProfileDraft] = useState(profile);
  const [editingProfile, setEditingProfile] = useState(false);
  const [selectedFriendId, setSelectedFriendId] = useState('');
  const [chatByFriend, setChatByFriend] = useState<Record<string, SocialMessage[]>>({});
  const [chatDraft, setChatDraft] = useState('');
  const [addFriendDraft, setAddFriendDraft] = useState('');

  useEffect(() => {
    saveGlobalSettings(globalSettings);
    applyGlobalSettings(globalSettings);
  }, [globalSettings]);

  const activeCardIdRef = useRef(activeCardId);
  const settingsOpenRef = useRef(settingsOpen);
  const socialOpenRef = useRef(socialOpen);
  const showForegroundRef = useRef(showForeground);
  const gameIdRef = useRef(gameId);
  const menuCardsRef = useRef<MenuCard[]>(menuCards);
  const statsRef = useRef<CardStats>({
    gameName,
    gameId,
    startScene,
    gamesCount,
    notificationsCount,
    friendsOnline,
    clock,
  });
  const onGameChangeRef = useRef(onGameChange);
  const onPlayRef = useRef(onPlay);
  const onEditorRef = useRef(onEditor);
  const globalSettingsRef = useRef(globalSettings);

  useEffect(() => {
    if (menuCards.length === 0) {
      setActiveCardId('');
      return;
    }
    const stillExists = menuCards.some((card) => card.id === activeCardId);
    if (!stillExists) {
      setActiveCardId(menuCards[0]?.id ?? '');
    }
  }, [menuCards, activeCardId]);

  activeCardIdRef.current = activeCardId;
  settingsOpenRef.current = settingsOpen;
  socialOpenRef.current = socialOpen;
  showForegroundRef.current = showForeground;
  gameIdRef.current = gameId;
  menuCardsRef.current = menuCards;
  statsRef.current = {
    gameName,
    gameId,
    startScene,
    gamesCount,
    notificationsCount,
    friendsOnline,
    clock,
  };
  onGameChangeRef.current = onGameChange;
  onPlayRef.current = onPlay;
  onEditorRef.current = onEditor;
  globalSettingsRef.current = globalSettings;

  const cycleCard = (delta: number) => {
    if (!showForegroundRef.current) return;
    const cards = menuCardsRef.current;
    if (cards.length === 0) return;
    const currentIndex = cards.findIndex((card) => card.id === activeCardIdRef.current);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + delta + cards.length) % cards.length;
    const next = cards[nextIndex];
    if (next) {
      if (next.id !== activeCardIdRef.current) {
        menuAudio.playNavigate();
      }
      setActiveCardId(next.id);
    }
  };

  const activateCard = (cardId?: string) => {
    if (!showForegroundRef.current) return;
    const selectedCardId = cardId ?? activeCardIdRef.current;
    if (!selectedCardId) return;

    const card = menuCardsRef.current.find((entry) => entry.id === selectedCardId);
    if (!card) return;
    menuAudio.playConfirm();

    if (card.kind === 'settings') {
      setSocialOpen(false);
      setSettingsOpen(true);
      return;
    }

    if (card.kind === 'social') {
      setSettingsOpen(false);
      setProfileDraft(profile);
      setEditingProfile(false);
      setSocialOpen(true);
      return;
    }

    if (card.kind === 'project') {
      if (!card.gameId) return;
      if (card.gameId !== gameIdRef.current) {
        onGameChangeRef.current(card.gameId);
        setActiveCardId(card.id);
        window.setTimeout(() => {
          onPlayRef.current();
        }, 120);
        return;
      }
      onPlayRef.current();
      return;
    }

    if (card.kind === 'editor') {
      onEditorRef.current();
    }
  };

  useEffect(() => {
    if (!showForeground) {
      setSettingsOpen(false);
      setSocialOpen(false);
    }
  }, [showForeground]);

  useEffect(() => {
    if (!settingsOpen && !socialOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
        setSocialOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen, socialOpen]);

  useEffect(() => {
    if (!socialOpen) return;
    let mounted = true;

    const sync = async () => {
      try {
        const state = await getSocialState(socialClientId);
        if (!mounted) return;
        setProfile({
          displayName: state.profile.displayName,
          status: state.profile.status,
          bio: state.profile.bio,
        });
        if (!editingProfile) {
          setProfileDraft({
            displayName: state.profile.displayName,
            status: state.profile.status,
            bio: state.profile.bio,
          });
        }
        const nextFriends = mapSocialFriends(state.friends);
        setFriends(nextFriends);
        setSelectedFriendId((prev) => {
          if (prev && nextFriends.some((friend) => friend.id === prev)) return prev;
          return nextFriends[0]?.id ?? '';
        });
        setChatByFriend(mapSocialChats(state.chats, socialClientId));
      } catch (error) {
        console.error('Social sync failed:', error);
      }
    };

    void sync();
    const poll = window.setInterval(() => {
      void sync();
    }, 2000);

    return () => {
      mounted = false;
      window.clearInterval(poll);
    };
  }, [socialOpen, socialClientId, editingProfile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;

      if (settingsOpenRef.current || socialOpenRef.current) {
        if (key === 'Escape' || key === 'Backspace') {
          event.preventDefault();
          setSettingsOpen(false);
          setSocialOpen(false);
        }
        return;
      }

      if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'a' || key === 'A') {
        event.preventDefault();
        cycleCard(-1);
        return;
      }
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'd' || key === 'D') {
        event.preventDefault();
        cycleCard(1);
        return;
      }
      if (key === 'Tab') {
        event.preventDefault();
        cycleCard(event.shiftKey ? -1 : 1);
        return;
      }
      if (key === 'Home') {
        event.preventDefault();
        const first = menuCardsRef.current[0];
        if (first) setActiveCardId(first.id);
        return;
      }
      if (key === 'End') {
        event.preventDefault();
        const last = menuCardsRef.current[menuCardsRef.current.length - 1];
        if (last) setActiveCardId(last.id);
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        activateCard();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const layoutRef = {
      current: {
        cardBaseX: 1.3,
        cardBaseY: 0.62,
        cardSpacing: 1.08,
        cardLift: 0.025,
        cardBaseZ: -1.85,
        cardDepthStep: 0.28,
        activeScale: 1.22,
        inactiveScale: 0.95,
        cardRootScale: 1,
        avatarScale: 1.36,
        avatarX: -1.95,
        avatarY: -1.24,
        avatarZ: 2.25,
      },
    };
    const cameraBase = { x: 0.2, y: 1.72, z: 7.6 };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050913);

    const camera = new THREE.PerspectiveCamera(
      42,
      host.clientWidth / Math.max(host.clientHeight, 1),
      0.1,
      100,
    );
    camera.position.set(0.2, 1.72, 7.6);
    camera.lookAt(0.25, 0.7, -0.9);

    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x122034, 0.95);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xf4f8ff, 1.0);
    key.position.set(4, 8, 6);
    scene.add(key);

    const fill = new THREE.PointLight(0x74c3ff, 0.9, 24);
    fill.position.set(-4, 3, 4);
    scene.add(fill);

    const rim = new THREE.PointLight(0x86d5ff, 0.5, 18);
    rim.position.set(5.5, 2.7, 4.2);
    scene.add(rim);

    const backdropUniforms = {
      uTime: { value: 0 },
    };
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 96, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: backdropUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec2 vUv;
          uniform float uTime;

          float hash21(vec2 p) {
            p = fract(p * vec2(123.34, 345.45));
            p += dot(p, p + 34.345);
            return fract(p.x * p.y);
          }

          vec3 palette(float t) {
            vec3 a = vec3(0.05, 0.16, 0.32);
            vec3 b = vec3(0.18, 0.42, 0.56);
            vec3 c = vec3(0.18, 0.28, 0.55);
            vec3 d = vec3(0.1, 0.65, 0.82);
            return a + b * cos(6.28318 * (c * t + d));
          }

          void main() {
            vec2 uv = vUv * 2.0 - 1.0;
            uv.x *= 1.35;
            float t = uTime * 0.16;

            float waveA = sin(uv.x * 2.8 + t * 2.1 + sin(uv.y * 2.0 + t) * 1.6);
            float waveB = cos(uv.x * 4.2 - t * 1.4 + cos(uv.y * 2.8 - t * 0.8) * 1.4);
            float wave = waveA * 0.55 + waveB * 0.45;
            float ribbon = smoothstep(0.72, 0.02, abs(uv.y + wave * 0.22));

            float pulse = 0.5 + 0.5 * sin(t * 3.2 + uv.x * 3.5);
            vec3 col = palette(uv.x * 0.18 + uv.y * 0.12 + t * 0.7);
            col *= ribbon * (0.34 + pulse * 0.32);

            vec2 gridUv = vUv * vec2(34.0, 18.0);
            vec2 gv = abs(fract(gridUv) - 0.5);
            float line = smoothstep(0.12, 0.0, min(gv.x, gv.y));
            float mask = smoothstep(1.05, -0.1, abs(uv.y)) * smoothstep(1.15, 0.0, abs(uv.x));
            col += vec3(0.06, 0.16, 0.24) * line * mask * 0.35;

            float stars = step(0.9966, hash21(floor(vUv * vec2(540.0, 280.0) + t * 8.0)));
            col += vec3(0.62, 0.9, 1.0) * stars * 0.45 * (0.3 + ribbon * 0.7);

            float vignette = smoothstep(1.35, 0.18, length(uv * vec2(0.92, 0.78)));
            float alpha = vignette * (0.58 + ribbon * 0.26);

            gl_FragColor = vec4(col, alpha);
          }
        `,
      }),
    );
    backdrop.position.set(0, 1.2, -30);
    scene.add(backdrop);

    const PARTICLE_COUNT = 4800;
    const PARTICLE_MIN_X = -34;
    const PARTICLE_MAX_X = 34;
    const PARTICLE_MIN_Y = -18;
    const PARTICLE_MAX_Y = 18;
    const PARTICLE_MIN_Z = -62;
    const PARTICLE_MAX_Z = -6;
    const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    const particleBasePositions = new Float32Array(PARTICLE_COUNT * 3);
    const particleColors = new Float32Array(PARTICLE_COUNT * 3);
    const particlePhase = new Float32Array(PARTICLE_COUNT);
    const particleGeometry = new THREE.BufferGeometry();
    const particleMaterial = new THREE.PointsMaterial({
      size: 0.048,
      transparent: true,
      opacity: 0.66,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    const cold = new THREE.Color('#6ebeff');
    const warm = new THREE.Color('#83ffe4');
    const frost = new THREE.Color('#d8edff');

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      const x = THREE.MathUtils.randFloat(PARTICLE_MIN_X, PARTICLE_MAX_X);
      const y = THREE.MathUtils.randFloat(PARTICLE_MIN_Y, PARTICLE_MAX_Y);
      const z = THREE.MathUtils.randFloat(PARTICLE_MIN_Z, PARTICLE_MAX_Z);
      const colorMixA = THREE.MathUtils.randFloat(0, 1);
      const colorMixB = THREE.MathUtils.randFloat(0, 1);
      const color = cold.clone().lerp(warm, colorMixA).lerp(frost, colorMixB * 0.35);
      const index3 = i * 3;
      particlePositions[index3] = x;
      particlePositions[index3 + 1] = y;
      particlePositions[index3 + 2] = z;
      particleBasePositions[index3] = x;
      particleBasePositions[index3 + 1] = y;
      particleBasePositions[index3 + 2] = z;
      particleColors[index3] = color.r;
      particleColors[index3 + 1] = color.g;
      particleColors[index3 + 2] = color.b;
      particlePhase[i] = THREE.MathUtils.randFloat(0, Math.PI * 2);
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    const particlePositionAttribute = particleGeometry.getAttribute('position') as THREE.BufferAttribute;
    const particleField = new THREE.Points(particleGeometry, particleMaterial);
    particleField.frustumCulled = false;
    particleField.position.set(0, 0.7, 0);
    scene.add(particleField);

    const cardRoot = new THREE.Group();
    scene.add(cardRoot);

    const cards: CardRuntime[] = menuCards.map((card) => {
      const color = new THREE.Color(card.color);
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 384;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('menu_card_context_failed');

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;

      const surfaceMaterial = new THREE.MeshBasicMaterial({
        map: texture,
        color: 0xffffff,
        transparent: true,
        opacity: 0.84,
        alphaTest: 0.08,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const body = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.6), surfaceMaterial);

      const group = new THREE.Group();
      group.add(body);
      cardRoot.add(group);

      drawCardUi(card, ctx, canvas, statsRef.current, card.id === activeCardIdRef.current);
      texture.needsUpdate = true;

      return {
        cardId: card.id,
        group,
        body,
        texture,
        canvas,
        ctx,
        materials: {
          surface: surfaceMaterial,
        },
      };
    });

    let vrm: VRM | null = null;
    let menuMixer: THREE.AnimationMixer | null = null;
    const gltfLoader = new GLTFLoader();
    gltfLoader.register((parser) => new VRMLoaderPlugin(parser));

    const loadIdleClip = async (): Promise<ClipData | null> => {
      try {
        const response = await fetch('/animations/idle.json', { cache: 'no-store' });
        if (!response.ok) return null;
        const payload = (await response.json()) as unknown;
        return parseClipPayload(payload);
      } catch (error) {
        console.warn('Menu idle animation load failed:', error);
        return null;
      }
    };
    const idleClipPromise = loadIdleClip();

    const loadVrm = async () => {
      const urls = ['/avatars/default.vrm', '/api/games/prototype/avatars/default.vrm'];
      try {
        let loaded: VRM | undefined;
        let gltfScene: THREE.Group | null = null;
        for (const url of urls) {
          try {
            const gltf = await gltfLoader.loadAsync(url);
            loaded = gltf.userData.vrm as VRM | undefined;
            if (loaded) {
              gltfScene = gltf.scene;
              break;
            }
          } catch {
            // Try next URL.
          }
        }
        if (!loaded || !gltfScene) return;

        if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
          VRMUtils.removeUnnecessaryVertices(gltfScene);
        }
        if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
          VRMUtils.removeUnnecessaryJoints(gltfScene);
        }

        loaded.scene.traverse((obj) => {
          obj.frustumCulled = false;
        });

        const bones = (loaded.humanoid.normalizedHumanBones ?? {}) as Record<
          string,
          { node?: THREE.Object3D }
        >;
        for (const [key, bone] of Object.entries(bones)) {
          if (bone?.node) {
            bone.node.name = `menu_${key}`;
          }
        }

        const layout = layoutRef.current;
        loaded.scene.scale.setScalar(layout.avatarScale);
        loaded.scene.position.set(layout.avatarX, layout.avatarY, layout.avatarZ);
        loaded.scene.rotation.y = Math.PI * 1.1;

        vrm = loaded;
        const idleClipData = await idleClipPromise;
        if (idleClipData) {
          const clip = buildAnimationClipFromData('menu_idle', idleClipData, {
            prefix: 'menu_',
            rootKey: 'hips',
          });
          menuMixer = new THREE.AnimationMixer(loaded.scene);
          const idleAction = menuMixer.clipAction(clip);
          idleAction.enabled = true;
          idleAction.setLoop(THREE.LoopRepeat, Infinity);
          idleAction.clampWhenFinished = false;
          idleAction.play();
        }

        scene.add(loaded.scene);
      } catch (error) {
        console.warn('Menu VRM load failed:', error);
      }
    };

    void loadVrm();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const cardBodies = cards.map((card) => card.body);

    const handleClick = (event: MouseEvent) => {
      if (!showForegroundRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const hits = raycaster.intersectObjects(cardBodies, false);
      const firstHit = hits.at(0);
      if (!firstHit) return;
      const body = firstHit.object as THREE.Mesh;
      const hit = cards.find((card) => card.body === body);
      if (!hit) return;

      if (hit.cardId === activeCardIdRef.current) {
        activateCard(hit.cardId);
      } else {
        menuAudio.playNavigate();
        setActiveCardId(hit.cardId);
        const targetCard = menuCardsRef.current.find((entry) => entry.id === hit.cardId);
        if (targetCard?.kind === 'project') {
          window.setTimeout(() => activateCard(hit.cardId), 0);
        }
      }
    };

    renderer.domElement.addEventListener('click', handleClick);

    let raf = 0;
    let gamepadRaf = 0;
    const clock3d = new THREE.Clock();
    let lastStatKey = '';
    let lastFocusedCardId = '';
    let lastFpsReadAt = performance.now();
    let fpsFrames = 0;
    let lastFov = 0;
    let lastParticleBudget = -1;

    const setCardTargets = (selectedCardId: string) => {
      const selectedIndex = menuCards.findIndex((card) => card.id === selectedCardId);
      const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
      const layout = layoutRef.current;
      cards.forEach((card, idx) => {
        const delta = idx - activeIndex;
        const distance = Math.abs(delta);
        const sign = delta === 0 ? 0 : Math.sign(delta);
        const lateral = Math.pow(distance, 1.08) * layout.cardSpacing * 1.22;
        const arcLift = Math.min(distance * 0.055, 0.24);
        const zStack = distance === 0 ? layout.cardDepthStep * 2.45 : -distance * layout.cardDepthStep * 1.48 - 0.14;
        const scaleFalloff = Math.min(distance, 5) * 0.17;
        const targetScale = Math.max(layout.inactiveScale * 0.72, layout.activeScale - scaleFalloff);

        card.group.userData.tx = layout.cardBaseX + sign * lateral;
        card.group.userData.ty = layout.cardBaseY + distance * layout.cardLift + arcLift;
        card.group.userData.tz = layout.cardBaseZ + zStack;
        card.group.userData.tr = sign === 0 ? 0 : -sign * Math.min(0.44, 0.1 + distance * 0.1);
        card.group.userData.ts = idx === activeIndex ? layout.activeScale * 1.28 : targetScale;
        card.group.userData.ro = idx === activeIndex ? 2200 : 1400 - distance * 20 - (delta < 0 ? 1 : 0);
      });
    };

    const applyResponsiveLayout = () => {
      const w = Math.max(host.clientWidth, 1);
      const h2 = Math.max(host.clientHeight, 1);
      const shortSide = Math.max(1, Math.min(w, h2));
      const mobile = w < 900;
      const portraitMobile = mobile && h2 > w;
      const spread = THREE.MathUtils.clamp(w / 1280, 0.62, 1.14);
      const depth = THREE.MathUtils.clamp(w / 1440, 0.86, 1.12);
      const prominence = THREE.MathUtils.clamp(980 / shortSide, 0.92, 1.36);
      const cardRootScale = THREE.MathUtils.clamp(
        prominence * (portraitMobile ? 0.74 : mobile ? 1.04 : 1),
        portraitMobile ? 0.74 : 0.95,
        portraitMobile ? 0.94 : 1.42,
      );

      layoutRef.current = {
        cardBaseX: portraitMobile ? 0.08 : mobile ? 0.72 : 1.3,
        cardBaseY: portraitMobile ? 0.58 : mobile ? 0.42 : 0.62,
        cardSpacing: (portraitMobile ? 1.24 : 1.08) * spread * (1 / cardRootScale),
        cardLift: portraitMobile ? 0.026 : mobile ? 0.018 : 0.025,
        cardBaseZ: portraitMobile ? -2.72 : mobile ? -2.2 : -1.85,
        cardDepthStep: (portraitMobile ? 0.34 : 0.28) * depth,
        activeScale: (portraitMobile ? 0.8 : mobile ? 1.1 : 1.23) * cardRootScale,
        inactiveScale: (portraitMobile ? 0.7 : mobile ? 0.92 : 0.96) * cardRootScale,
        cardRootScale,
        avatarScale: portraitMobile ? 0.78 : mobile ? 1.14 : 1.36,
        avatarX: portraitMobile ? -1.34 : mobile ? -1.36 : -1.95,
        avatarY: portraitMobile ? -1.26 : mobile ? -1.2 : -1.24,
        avatarZ: portraitMobile ? 1.45 : mobile ? 2.02 : 2.25,
      };

      camera.aspect = w / h2;
      camera.fov = THREE.MathUtils.clamp(globalSettingsRef.current.video.fieldOfView, 70, 120);
      cameraBase.x = portraitMobile ? 0.02 : mobile ? 0.14 : 0.24;
      cameraBase.y = portraitMobile ? 1.96 : mobile ? 1.6 : 1.74;
      cameraBase.z = portraitMobile
        ? 10.6
        : mobile
          ? 8.2
          : THREE.MathUtils.lerp(7.2, 8.0, THREE.MathUtils.clamp((w - 900) / 700, 0, 1));
      camera.position.set(cameraBase.x, cameraBase.y, cameraBase.z);
      camera.lookAt(
        portraitMobile ? 0.12 : mobile ? 0.48 : 0.92,
        portraitMobile ? 0.72 : mobile ? 0.56 : 0.72,
        portraitMobile ? -1.56 : mobile ? -1.2 : -1.04,
      );
      camera.updateProjectionMatrix();
      cardRoot.scale.setScalar(cardRootScale);

      if (vrm) {
        const layout = layoutRef.current;
        vrm.scene.scale.setScalar(layout.avatarScale);
        vrm.scene.position.set(layout.avatarX, layout.avatarY, layout.avatarZ);
      }
    };

    const getPrimaryGamepad = (): Gamepad | null => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      if (!pads || pads.length === 0) return null;
      for (const pad of pads) {
        if (pad) return pad;
      }
      return null;
    };

    const NAV_INITIAL_DELAY = 260;
    const NAV_REPEAT_DELAY = 140;
    let heldDirection = 0;
    let lastNavTime = 0;
    let prevConfirm = false;
    let prevBack = false;

    const pollGamepad = () => {
      const now = performance.now();
      const pad = getPrimaryGamepad();
      if (!showForegroundRef.current) {
        heldDirection = 0;
        prevConfirm = false;
        prevBack = false;
        gamepadRaf = window.requestAnimationFrame(pollGamepad);
        return;
      }
      if (pad) {
        const left = !!pad.buttons[14]?.pressed || (pad.axes[0] ?? 0) < -0.55;
        const right = !!pad.buttons[15]?.pressed || (pad.axes[0] ?? 0) > 0.55;
        const up = !!pad.buttons[12]?.pressed || (pad.axes[1] ?? 0) < -0.55;
        const down = !!pad.buttons[13]?.pressed || (pad.axes[1] ?? 0) > 0.55;
        const confirm = !!pad.buttons[0]?.pressed || !!pad.buttons[9]?.pressed;
        const back = !!pad.buttons[1]?.pressed || !!pad.buttons[8]?.pressed;

        let direction = 0;
        if (left || up) direction = -1;
        else if (right || down) direction = 1;

        if (direction === 0) {
          heldDirection = 0;
        } else {
          const delay = heldDirection === direction ? NAV_REPEAT_DELAY : NAV_INITIAL_DELAY;
          if (heldDirection !== direction || now - lastNavTime > delay) {
            if (!settingsOpenRef.current) cycleCard(direction);
            lastNavTime = now;
            heldDirection = direction;
          }
        }

        if (confirm && !prevConfirm && !settingsOpenRef.current) {
          activateCard();
        }
        if (back && !prevBack) {
          if (settingsOpenRef.current) setSettingsOpen(false);
          else {
            const first = menuCardsRef.current[0];
            if (first) setActiveCardId(first.id);
          }
        }

        prevConfirm = confirm;
        prevBack = back;
      } else {
        heldDirection = 0;
        prevConfirm = false;
        prevBack = false;
      }

      gamepadRaf = window.requestAnimationFrame(pollGamepad);
    };

    const animate = () => {
      const delta = Math.min(clock3d.getDelta(), 1 / 20);
      const elapsed = clock3d.getElapsedTime();
      const settings = globalSettingsRef.current;
      const profile = getMenuQualityProfile(settings);
      const motionScale = profile.motion;
      const shakeScale = settings.gameplay.cameraShake / 100;
      const motionBlurStrength = settings.video.motionBlur / 100;

      setCardTargets(activeCardIdRef.current);
      cardRoot.visible = showForegroundRef.current;

      const targetFov = THREE.MathUtils.clamp(settings.video.fieldOfView, 70, 120);
      if (Math.abs(lastFov - targetFov) > 0.01) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
        lastFov = targetFov;
      }

      if (lastParticleBudget !== profile.particles) {
        particleGeometry.setDrawRange(0, profile.particles);
        lastParticleBudget = profile.particles;
      }
      particleMaterial.size = profile.size;
      particleMaterial.opacity = 0.5 + motionBlurStrength * 0.28;

      // Ambient background motion: volumetric drift with parallax depth.
      for (let i = 0; i < profile.particles; i += 1) {
        const index3 = i * 3;
        const bx = particleBasePositions[index3] ?? 0;
        const by = particleBasePositions[index3 + 1] ?? 0;
        const bz = particleBasePositions[index3 + 2] ?? 0;
        const phase = particlePhase[i] ?? 0;
        const t = elapsed * 0.33 * motionScale + phase;

        const x =
          bx +
          Math.sin(t * 1.8 + bz * 0.05) * (0.95 * motionScale) +
          Math.cos(t * 0.7 + by * 0.18) * (0.34 * motionScale);
        const y =
          by +
          Math.cos(t * 1.2 + bx * 0.04) * (0.62 * motionScale) +
          Math.sin(t * 0.9 + bz * 0.03) * (0.22 * motionScale);
        const z = bz + Math.sin(t * 0.58 + bx * 0.03 + by * 0.05) * (0.82 * motionScale);

        particlePositions[index3] = x;
        particlePositions[index3 + 1] = y;
        particlePositions[index3 + 2] = z;
      }
      particlePositionAttribute.needsUpdate = true;
      particleField.rotation.y = Math.sin(elapsed * 0.08 * motionScale) * 0.038;
      backdropUniforms.uTime.value = elapsed;

      const stats = statsRef.current;
      const focusedCardId = activeCardIdRef.current;
      const statKey = `${stats.gameName}|${stats.gameId}|${stats.startScene}|${stats.gamesCount}|${stats.notificationsCount}|${stats.friendsOnline}|${stats.clock}`;
      if (statKey !== lastStatKey || focusedCardId !== lastFocusedCardId) {
        for (let i = 0; i < cards.length; i += 1) {
          const runtime = cards[i];
          const card = menuCards[i];
          if (!runtime || !card) continue;
          drawCardUi(card, runtime.ctx, runtime.canvas, stats, card.id === focusedCardId);
          runtime.texture.needsUpdate = true;
        }
        lastStatKey = statKey;
        lastFocusedCardId = focusedCardId;
      }

      cards.forEach((card) => {
        const group = card.group;
        group.position.x += (((group.userData.tx as number) ?? 0) - group.position.x) * 0.09;
        group.position.y += (((group.userData.ty as number) ?? 0) - group.position.y) * 0.09;
        group.position.z += (((group.userData.tz as number) ?? 0) - group.position.z) * 0.09;
        group.rotation.y += (((group.userData.tr as number) ?? 0) - group.rotation.y) * 0.09;
        const targetScale = (group.userData.ts as number) ?? 1;
        const s = group.scale.x + (targetScale - group.scale.x) * 0.09;
        group.scale.setScalar(s);
        card.body.renderOrder = (group.userData.ro as number) ?? 1000;

        const isActive = card.cardId === activeCardIdRef.current;
        if (isActive) {
          card.materials.surface.opacity = 1;
        } else {
          card.materials.surface.opacity += (0.84 - card.materials.surface.opacity) * 0.12;
        }
      });

      if (vrm) {
        vrm.scene.visible = showForegroundRef.current;
        if (menuMixer) {
          menuMixer.update(delta);
        }
        vrm.scene.position.y = layoutRef.current.avatarY + Math.sin(elapsed * 1.2 * motionScale) * 0.025;
        vrm.update(delta);
      }

      const shake =
        shakeScale > 0.01 && !settings.accessibility.reducedMotion
          ? Math.sin(elapsed * 2.4) * 0.006 * shakeScale
          : 0;
      camera.position.set(cameraBase.x + shake, cameraBase.y, cameraBase.z);

      fpsFrames += 1;
      const now = performance.now();
      if (now - lastFpsReadAt >= 500) {
        if (settings.video.showFps) {
          const fps = Math.round((fpsFrames * 1000) / Math.max(now - lastFpsReadAt, 1));
          setFpsText(`${fps} FPS`);
        } else {
          setFpsText('');
        }
        fpsFrames = 0;
        lastFpsReadAt = now;
      }

      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };

    applyResponsiveLayout();
    animate();
    gamepadRaf = window.requestAnimationFrame(pollGamepad);

    const onResize = () => {
      const w = host.clientWidth;
      const h2 = Math.max(host.clientHeight, 1);
      renderer.setSize(w, h2);
      applyResponsiveLayout();
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(gamepadRaf);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('click', handleClick);
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((mat) => mat.dispose());
          else obj.material.dispose();
        }
      });
      cards.forEach((card) => card.texture.dispose());
      particleGeometry.dispose();
      particleMaterial.dispose();
      backdrop.geometry.dispose();
      (backdrop.material as THREE.Material).dispose();
      if (vrm) scene.remove(vrm.scene);
      if (menuMixer) {
        menuMixer.stopAllAction();
        menuMixer = null;
      }
      host.removeChild(renderer.domElement);
    };
  }, [gameId, menuCards]);

  const selectedFriend = friends.find((friend) => friend.id === selectedFriendId) ?? friends[0];
  const selectedMessages = chatByFriend[selectedFriend?.id ?? ''] ?? [];

  const saveProfile = async () => {
    const next = {
      displayName: profileDraft.displayName.trim() || 'Player One',
      status: profileDraft.status.trim() || 'Ready to play',
      bio: profileDraft.bio.trim() || 'Building worlds and testing every frame.',
    };
    try {
      await saveSocialProfile({
        clientId: socialClientId,
        displayName: next.displayName,
        status: next.status,
        bio: next.bio,
      });
      setProfile(next);
      setProfileDraft(next);
      setEditingProfile(false);
      menuAudio.playConfirm();
    } catch (error) {
      console.error('Save social profile failed:', error);
    }
  };

  const cancelProfileEdit = () => {
    setProfileDraft(profile);
    setEditingProfile(false);
    menuAudio.playNavigate();
  };

  const sendChatMessage = async () => {
    const friendId = selectedFriend?.id;
    const text = chatDraft.trim();
    if (!friendId || !text) return;
    try {
      await sendSocialMessage({
        clientId: socialClientId,
        friendId,
        text,
      });
      setChatDraft('');
      menuAudio.playConfirm();
      const state = await getSocialState(socialClientId);
      setChatByFriend(mapSocialChats(state.chats, socialClientId));
    } catch (error) {
      console.error('Send social message failed:', error);
    }
  };

  const submitAddFriend = async () => {
    const friendId = addFriendDraft.trim().toLowerCase();
    if (!friendId) return;
    try {
      await addSocialFriend({
        clientId: socialClientId,
        friendId,
      });
      setAddFriendDraft('');
      menuAudio.playConfirm();
      const state = await getSocialState(socialClientId);
      const nextFriends = mapSocialFriends(state.friends);
      setFriends(nextFriends);
      if (nextFriends.some((friend) => friend.id === friendId)) {
        setSelectedFriendId(friendId);
      }
    } catch (error) {
      console.error('Add friend failed:', error);
    }
  };

  return h(
    'div',
    { className: 'nxe-menu-viewport' },
    h('div', { className: 'nxe-stage-canvas', ref: containerRef }),
    showForeground && fpsText
      ? h('div', { className: 'nxe-menu-fps', 'aria-live': 'polite' }, fpsText)
      : null,
    showForeground && settingsOpen
      ? h(
          'div',
          {
            className: 'nxe-settings-modal-backdrop',
            onClick: () => setSettingsOpen(false),
          },
          h(ConsoleSettingsCard, {
            gameId,
            gameName,
            startScene,
            settings: globalSettings,
            onChange: setGlobalSettings,
            onReset: () => {
              setGlobalSettings(resetGlobalSettings());
              menuAudio.playConfirm();
            },
            onClose: () => setSettingsOpen(false),
          }),
        )
      : null,
    showForeground && socialOpen
      ? h(
          'div',
          {
            className: 'nxe-settings-modal-backdrop',
            onClick: () => {
              setSocialOpen(false);
              setEditingProfile(false);
            },
          },
          h(
            'section',
            {
              className: 'nxe-social-modal',
              onClick: (event: React.MouseEvent) => event.stopPropagation(),
            },
            h(
              'header',
              { className: 'nxe-settings-modal-header nxe-social-modal-header' },
                h(
                  'div',
                  null,
                  h('h3', null, 'Social Hub'),
                  h('p', null, `${profile.displayName} • ${friends.filter((f) => f.online).length} friends online`),
                ),
              h(
                'button',
                {
                  className: 'nxe-settings-modal-close',
                  onClick: () => {
                    setSocialOpen(false);
                    setEditingProfile(false);
                  },
                  'aria-label': 'Close social menu',
                },
                'Close',
              ),
            ),
            h(
              'div',
              { className: 'nxe-social-grid' },
              h(
                'section',
                { className: 'nxe-social-panel' },
                h(
                  'div',
                  { className: 'nxe-social-section-head' },
                  h('h4', null, 'Player Profile'),
                  editingProfile
                    ? null
                    : h(
                        'button',
                        {
                          className: 'nxe-social-action',
                          onClick: () => {
                            setProfileDraft(profile);
                            setEditingProfile(true);
                            menuAudio.playNavigate();
                          },
                        },
                        'Edit',
                      ),
                ),
                editingProfile
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'label',
                        { className: 'nxe-social-field' },
                        h('span', null, 'Display Name'),
                        h('input', {
                          value: profileDraft.displayName,
                          maxLength: 24,
                          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                            setProfileDraft((prev) => ({ ...prev, displayName: event.target.value })),
                        }),
                      ),
                      h(
                        'label',
                        { className: 'nxe-social-field' },
                        h('span', null, 'Status'),
                        h('input', {
                          value: profileDraft.status,
                          maxLength: 40,
                          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                            setProfileDraft((prev) => ({ ...prev, status: event.target.value })),
                        }),
                      ),
                      h(
                        'label',
                        { className: 'nxe-social-field' },
                        h('span', null, 'Bio'),
                        h('textarea', {
                          value: profileDraft.bio,
                          rows: 4,
                          maxLength: 140,
                          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
                            setProfileDraft((prev) => ({ ...prev, bio: event.target.value })),
                        }),
                      ),
                      h(
                        'div',
                        { className: 'nxe-social-profile-actions' },
                        h(
                          'button',
                          { className: 'nxe-social-action', onClick: cancelProfileEdit },
                          'Cancel',
                        ),
                        h(
                          'button',
                          { className: 'nxe-social-action nxe-social-action-primary', onClick: saveProfile },
                          'Save',
                        ),
                      ),
                    )
                  : h(
                      'div',
                      { className: 'nxe-social-profile-readonly' },
                      h('strong', null, profile.displayName),
                      h('p', { className: 'nxe-social-status' }, profile.status),
                      h('p', null, profile.bio),
                    ),
              ),
              h(
                'section',
                { className: 'nxe-social-panel' },
                h('h4', null, 'Friends'),
                h('p', { className: 'nxe-social-code' }, `Your code: ${socialClientId}`),
                h(
                  'form',
                  {
                    className: 'nxe-social-add-friend',
                    onSubmit: (event: React.FormEvent) => {
                      event.preventDefault();
                      void submitAddFriend();
                    },
                  },
                  h('input', {
                    value: addFriendDraft,
                    placeholder: 'Enter friend code',
                    maxLength: 64,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setAddFriendDraft(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'submit',
                      className: 'nxe-social-action',
                      disabled: addFriendDraft.trim().length < 3,
                    },
                    'Add Friend',
                  ),
                ),
                h(
                  'div',
                  { className: 'nxe-social-friends' },
                  ...(friends.length === 0
                    ? [
                        h(
                          'p',
                          { key: 'no-friends', className: 'nxe-social-empty' },
                          'No other players online yet. Open this menu in another client to connect.',
                        ),
                      ]
                    : friends.map((friend) =>
                    h(
                      'button',
                      {
                        key: friend.id,
                        className: `nxe-social-friend ${friend.id === selectedFriend?.id ? 'active' : ''}`,
                        onClick: () => {
                          setSelectedFriendId(friend.id);
                          menuAudio.playNavigate();
                        },
                      },
                      h('span', { className: `nxe-social-dot ${friend.online ? 'online' : 'offline'}` }),
                      h('strong', null, friend.name),
                      h('small', null, friend.status),
                    ),
                  )),
                ),
              ),
              h(
                'section',
                { className: 'nxe-social-panel nxe-social-chat' },
                h('h4', null, `Chat • ${selectedFriend?.name ?? 'Friend'}`),
                h(
                  'div',
                  { className: 'nxe-social-chat-log' },
                  ...selectedMessages.map((message) =>
                    h(
                      'div',
                      {
                        key: message.id,
                        className: `nxe-social-bubble ${message.from === 'me' ? 'out' : 'in'}`,
                      },
                      h('p', null, message.text),
                      h('time', null, message.at),
                    ),
                  ),
                ),
                h(
                  'form',
                  {
                    className: 'nxe-social-chat-form',
                    onSubmit: (event: React.FormEvent) => {
                      event.preventDefault();
                      void sendChatMessage();
                    },
                  },
                  h('input', {
                    placeholder: selectedFriend ? `Message ${selectedFriend.name}...` : 'No friend selected',
                    value: chatDraft,
                    maxLength: 220,
                    disabled: !selectedFriend,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setChatDraft(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'submit',
                      className: 'nxe-social-action nxe-social-action-primary',
                      disabled: !selectedFriend || chatDraft.trim().length === 0,
                    },
                    'Send',
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

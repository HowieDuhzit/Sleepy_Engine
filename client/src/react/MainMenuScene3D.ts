import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

type MenuTab = 'home' | 'games' | 'media' | 'social' | 'store' | 'settings';

type MainMenuScene3DProps = {
  activeTab: MenuTab;
  gameId: string;
  gameName: string;
  startScene: string;
  gamesCount: number;
  notificationsCount: number;
  friendsOnline: number;
  onSelectTab: (tab: MenuTab) => void;
  onPlay: () => void;
  onEditor: () => void;
};

const TAB_ORDER: MenuTab[] = ['home', 'games', 'media', 'social', 'store', 'settings'];
const TAB_LABELS: Record<MenuTab, string> = {
  home: 'Home',
  games: 'Games',
  media: 'Media',
  social: 'Social',
  store: 'Store',
  settings: 'Settings',
};
const TAB_COLORS: Record<MenuTab, string> = {
  home: '#8ecf3d',
  games: '#69bc2e',
  media: '#57af7d',
  social: '#3e9ab3',
  store: '#6aa7df',
  settings: '#5f7fa8',
};

const h = React.createElement;

type CardRuntime = {
  tab: MenuTab;
  group: THREE.Group;
  body: THREE.Mesh;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
};

type CardStats = {
  gameName: string;
  gameId: string;
  startScene: string;
  gamesCount: number;
  notificationsCount: number;
  friendsOnline: number;
};

function drawCardUi(
  tab: MenuTab,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  stats: CardStats,
) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(12,20,26,0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, 'rgba(255,255,255,0.16)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);

  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.font = '700 50px "Arial Black", Arial, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(TAB_LABELS[tab], 30, 26);

  ctx.fillStyle = 'rgba(240,248,255,0.92)';
  ctx.font = '700 22px Arial, sans-serif';

  const lines: string[] = [];
  if (tab === 'home') {
    lines.push(`Game: ${stats.gameName}`);
    lines.push(`Scene: ${stats.startScene}`);
    lines.push('A: Play    X: Editor');
  } else if (tab === 'games') {
    lines.push(`Installed: ${stats.gamesCount}`);
    lines.push(`Selected: ${stats.gameId || 'none'}`);
    lines.push('Select card + Enter to launch');
  } else if (tab === 'media') {
    lines.push('Watch  Listen  Library');
    lines.push('Trending playlists ready');
    lines.push('Local files indexed');
  } else if (tab === 'social') {
    lines.push(`Friends online: ${stats.friendsOnline}`);
    lines.push(`Notifications: ${stats.notificationsCount}`);
    lines.push('Party and invite hub');
  } else if (tab === 'store') {
    lines.push('Featured packs available');
    lines.push('Animation + NPC bundles');
    lines.push('Marketplace highlights');
  } else {
    lines.push('Graphics and profile tools');
    lines.push('Cloud sync and storage');
    lines.push('System preferences');
  }

  lines.forEach((line, index) => {
    ctx.fillText(line, 30, 108 + index * 28);
  });

  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  const y = canvas.height - 48;
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(30 + i * 56, y, 44, 20);
  }
}

export function MainMenuScene3D({
  activeTab,
  gameId,
  gameName,
  startScene,
  gamesCount,
  notificationsCount,
  friendsOnline,
  onSelectTab,
  onPlay,
  onEditor,
}: MainMenuScene3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<MenuTab>(activeTab);
  const gameIdRef = useRef(gameId);
  const statsRef = useRef<CardStats>({
    gameName,
    gameId,
    startScene,
    gamesCount,
    notificationsCount,
    friendsOnline,
  });
  const onSelectTabRef = useRef(onSelectTab);
  const onPlayRef = useRef(onPlay);
  const onEditorRef = useRef(onEditor);

  activeTabRef.current = activeTab;
  gameIdRef.current = gameId;
  statsRef.current = {
    gameName,
    gameId,
    startScene,
    gamesCount,
    notificationsCount,
    friendsOnline,
  };
  onSelectTabRef.current = onSelectTab;
  onPlayRef.current = onPlay;
  onEditorRef.current = onEditor;

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b1019, 10, 24);

    const camera = new THREE.PerspectiveCamera(
      42,
      host.clientWidth / Math.max(host.clientHeight, 1),
      0.1,
      100,
    );
    camera.position.set(0.2, 1.72, 7.6);
    camera.lookAt(0.25, 0.7, 0);

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

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 90),
      new THREE.MeshPhongMaterial({
        color: 0x0f1624,
        transparent: true,
        opacity: 0.92,
        shininess: 72,
        specular: 0x1f3659,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.55;
    scene.add(floor);

    const cardRoot = new THREE.Group();
    scene.add(cardRoot);

    const cards: CardRuntime[] = TAB_ORDER.map((tab) => {
      const color = new THREE.Color(TAB_COLORS[tab]);
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 384;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('menu_card_context_failed');
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;

      const frontMaterial = new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff });
      const backMaterial = new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff });
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.6, 0.14), [
        new THREE.MeshStandardMaterial({
          color: color.clone().multiplyScalar(0.85),
          roughness: 0.36,
          metalness: 0.08,
        }),
        new THREE.MeshStandardMaterial({
          color: color.clone().multiplyScalar(0.95),
          roughness: 0.34,
          metalness: 0.08,
        }),
        new THREE.MeshStandardMaterial({
          color: color.clone().multiplyScalar(1.04),
          roughness: 0.33,
          metalness: 0.1,
        }),
        new THREE.MeshStandardMaterial({
          color: color.clone().multiplyScalar(0.73),
          roughness: 0.4,
          metalness: 0.08,
        }),
        frontMaterial,
        backMaterial,
      ]);
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(2.8, 1.52),
        new THREE.MeshBasicMaterial({
          color: color.clone().multiplyScalar(1.25),
          transparent: true,
          opacity: 0.18,
          blending: THREE.AdditiveBlending,
        }),
      );
      glow.position.z = 0.08;
      const group = new THREE.Group();
      group.add(body);
      group.add(glow);
      cardRoot.add(group);

      drawCardUi(tab, ctx, canvas, statsRef.current);
      texture.needsUpdate = true;

      return { tab, group, body, texture, canvas, ctx };
    });

    const fallbackAvatar = new THREE.Group();
    fallbackAvatar.position.set(-3.05, -0.25, 0.45);
    scene.add(fallbackAvatar);

    const skin = new THREE.MeshStandardMaterial({
      color: 0xd6ab86,
      roughness: 0.7,
      metalness: 0.05,
    });
    const suit = new THREE.MeshStandardMaterial({
      color: 0x28354d,
      roughness: 0.62,
      metalness: 0.1,
    });

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 28, 28), skin);
    head.position.y = 1.63;
    fallbackAvatar.add(head);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.82, 8, 16), suit);
    torso.position.y = 0.95;
    fallbackAvatar.add(torso);

    const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.52, 6, 10), suit);
    leftArm.position.set(-0.39, 1.02, 0);
    leftArm.rotation.z = 0.4;
    fallbackAvatar.add(leftArm);

    const rightArm = leftArm.clone();
    rightArm.position.x = 0.39;
    rightArm.rotation.z = -0.4;
    fallbackAvatar.add(rightArm);

    const leftLeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.78, 6, 10), suit);
    leftLeg.position.set(-0.15, -0.28, 0);
    fallbackAvatar.add(leftLeg);

    const rightLeg = leftLeg.clone();
    rightLeg.position.x = 0.15;
    fallbackAvatar.add(rightLeg);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.95, 36),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(-3.05, -1.5, 0.45);
    scene.add(shadow);

    let vrm: VRM | null = null;
    const gltfLoader = new GLTFLoader();
    gltfLoader.register((parser) => new VRMLoaderPlugin(parser));

    const loadVrm = async () => {
      const selectedGameId = gameIdRef.current;
      if (!selectedGameId) return;
      const url = `/api/games/${encodeURIComponent(selectedGameId)}/avatars/default.vrm`;
      try {
        const gltf = await gltfLoader.loadAsync(url);
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (!loaded) return;

        if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
          VRMUtils.removeUnnecessaryVertices(gltf.scene);
        }
        if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
          VRMUtils.removeUnnecessaryJoints(gltf.scene);
        }

        loaded.scene.traverse((obj) => {
          obj.frustumCulled = false;
        });
        loaded.scene.scale.setScalar(1.45);
        loaded.scene.position.set(-3.05, -1.46, 0.45);
        loaded.scene.rotation.y = Math.PI * 1.1;
        const leftUpperArm = loaded.humanoid?.getNormalizedBoneNode('leftUpperArm');
        const rightUpperArm = loaded.humanoid?.getNormalizedBoneNode('rightUpperArm');
        const leftLowerArm = loaded.humanoid?.getNormalizedBoneNode('leftLowerArm');
        const rightLowerArm = loaded.humanoid?.getNormalizedBoneNode('rightLowerArm');
        if (leftUpperArm) leftUpperArm.rotation.z = 0.35;
        if (rightUpperArm) rightUpperArm.rotation.z = -0.35;
        if (leftLowerArm) leftLowerArm.rotation.z = -0.2;
        if (rightLowerArm) rightLowerArm.rotation.z = 0.2;

        vrm = loaded;
        scene.add(loaded.scene);
        fallbackAvatar.visible = false;
      } catch (error) {
        console.warn('Menu VRM load failed, using fallback avatar:', error);
        fallbackAvatar.visible = true;
      }
    };

    void loadVrm();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const cardBodies = cards.map((card) => card.body);

    const handleClick = (event: MouseEvent) => {
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

      const selectedTab = hit.tab;
      if (selectedTab === activeTabRef.current) {
        if (selectedTab === 'home') onPlayRef.current();
        if (selectedTab === 'games') onEditorRef.current();
      } else {
        onSelectTabRef.current(selectedTab);
      }
    };

    renderer.domElement.addEventListener('click', handleClick);

    let raf = 0;
    const clock = new THREE.Clock();
    let lastStatKey = '';

    const setCardTargets = (selectedTab: MenuTab) => {
      const activeIndex = TAB_ORDER.indexOf(selectedTab);
      cards.forEach((card, idx) => {
        const delta = idx - activeIndex;
        card.group.userData.tx = 0.95 + delta * 1.65;
        card.group.userData.ty = 0.62 + Math.abs(delta) * 0.035;
        card.group.userData.tz = Math.min(3.2, Math.abs(delta) * 0.92);
        card.group.userData.tr = delta * -0.23;
        card.group.userData.ts = idx === activeIndex ? 1.18 : 0.94;
      });
    };

    const animate = () => {
      const delta = Math.min(clock.getDelta(), 1 / 20);
      const elapsed = clock.getElapsedTime();

      setCardTargets(activeTabRef.current);

      const stats = statsRef.current;
      const statKey = `${stats.gameName}|${stats.gameId}|${stats.startScene}|${stats.gamesCount}|${stats.notificationsCount}|${stats.friendsOnline}`;
      if (statKey !== lastStatKey) {
        for (const card of cards) {
          drawCardUi(card.tab, card.ctx, card.canvas, stats);
          card.texture.needsUpdate = true;
        }
        lastStatKey = statKey;
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
      });

      fallbackAvatar.position.y = -0.25 + Math.sin(elapsed * 1.5) * 0.05;
      fallbackAvatar.rotation.y = Math.sin(elapsed * 0.6) * 0.16;
      leftArm.rotation.z = 0.35 + Math.sin(elapsed * 1.8) * 0.08;
      rightArm.rotation.z = -0.35 - Math.sin(elapsed * 1.8) * 0.08;

      if (vrm) {
        vrm.scene.position.y = -1.46 + Math.sin(elapsed * 1.2) * 0.025;
        vrm.update(delta);
      }

      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      const w = host.clientWidth;
      const h2 = Math.max(host.clientHeight, 1);
      camera.aspect = w / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h2);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.cancelAnimationFrame(raf);
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
      if (vrm) scene.remove(vrm.scene);
      host.removeChild(renderer.domElement);
    };
  }, [gameId]);

  return h('div', { className: 'nxe-stage-canvas', ref: containerRef });
}

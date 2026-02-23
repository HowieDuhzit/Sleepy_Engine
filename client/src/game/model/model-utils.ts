import * as THREE from 'three';
import type { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

export type ModelOriginOffset = {
  x?: number;
  y?: number;
  z?: number;
};

export const loadFbxObject = (fbxLoader: FBXLoader, url: string) =>
  new Promise<THREE.Object3D>((resolve, reject) => {
    fbxLoader.load(
      url,
      (obj) => resolve(obj),
      undefined,
      (error) => reject(error),
    );
  });

export const loadTexture = (url: string, colorSpace: THREE.ColorSpace) =>
  new Promise<THREE.Texture>((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (texture) => {
        texture.colorSpace = colorSpace;
        resolve(texture);
      },
      undefined,
      (error) => reject(error),
    );
  });

export const normalizeModelRootPivot = (root: THREE.Object3D) => {
  root.updateMatrixWorld(true);
  let hasSkinnedMesh = false;
  const staticMeshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) {
      hasSkinnedMesh = true;
      return;
    }
    if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.BufferGeometry) {
      staticMeshes.push(obj);
    }
  });

  let workingRoot = root;
  if (!hasSkinnedMesh && staticMeshes.length > 0) {
    const flattened = new THREE.Group();
    flattened.name = root.name || 'flattened-model-root';
    const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
    for (const mesh of staticMeshes) {
      const bakedGeometry = mesh.geometry.clone();
      const relativeMatrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld);
      bakedGeometry.applyMatrix4(relativeMatrix);
      bakedGeometry.computeBoundingBox();
      bakedGeometry.computeBoundingSphere();
      const bakedMesh = new THREE.Mesh(bakedGeometry, mesh.material);
      bakedMesh.name = mesh.name;
      bakedMesh.userData = { ...mesh.userData };
      bakedMesh.castShadow = true;
      bakedMesh.receiveShadow = true;
      flattened.add(bakedMesh);
    }
    if (flattened.children.length > 0) {
      workingRoot = flattened;
    }
  }

  const bounds = new THREE.Box3().setFromObject(workingRoot);
  if (bounds.isEmpty()) return workingRoot;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.0001);
  const offset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z);
  const uniformScale = 1 / maxDimension;

  if (
    workingRoot instanceof THREE.Group &&
    workingRoot.children.length > 0 &&
    workingRoot.children.every((child) => child instanceof THREE.Mesh)
  ) {
    for (const child of workingRoot.children) {
      const mesh = child as THREE.Mesh;
      if (!(mesh.geometry instanceof THREE.BufferGeometry)) continue;
      mesh.geometry.translate(offset.x, offset.y, offset.z);
      mesh.geometry.scale(uniformScale, uniformScale, uniformScale);
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
    }
    workingRoot.updateMatrixWorld(true);
    return workingRoot;
  }

  if (workingRoot instanceof THREE.Mesh && workingRoot.geometry instanceof THREE.BufferGeometry) {
    workingRoot.geometry.translate(offset.x, offset.y, offset.z);
    workingRoot.geometry.scale(uniformScale, uniformScale, uniformScale);
    workingRoot.geometry.computeBoundingBox();
    workingRoot.geometry.computeBoundingSphere();
    workingRoot.updateMatrixWorld(true);
    return workingRoot;
  }

  for (const child of workingRoot.children) {
    child.position.add(offset).multiplyScalar(uniformScale);
    child.scale.multiplyScalar(uniformScale);
  }
  workingRoot.updateMatrixWorld(true);
  return workingRoot;
};

export const applyModelOriginOffset = (root: THREE.Object3D, originOffset?: ModelOriginOffset) => {
  const x = Number(originOffset?.x ?? 0);
  const y = Number(originOffset?.y ?? 0);
  const z = Number(originOffset?.z ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (Math.abs(x) < 0.00001 && Math.abs(y) < 0.00001 && Math.abs(z) < 0.00001) return;
  const offset = new THREE.Vector3(x, y, z);
  if (root instanceof THREE.Mesh && root.geometry instanceof THREE.BufferGeometry) {
    root.geometry.translate(offset.x, offset.y, offset.z);
    root.geometry.computeBoundingBox();
    root.geometry.computeBoundingSphere();
    root.updateMatrixWorld(true);
    return;
  }
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!(obj.geometry instanceof THREE.BufferGeometry)) return;
    obj.geometry.translate(offset.x, offset.y, offset.z);
    obj.geometry.computeBoundingBox();
    obj.geometry.computeBoundingSphere();
  });
  root.updateMatrixWorld(true);
};

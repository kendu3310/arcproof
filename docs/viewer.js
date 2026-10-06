/**
 * Side-by-side 3D preview of a model before and after optimisation.
 *
 * The page already says "9,216 triangles in, 9,216 triangles out". That is a
 * number a visitor has to take on faith. Seeing both models turn together,
 * identical, while one is a seventh of the size, is the same claim in a form
 * that needs no faith at all.
 *
 * Triangles are counted from the geometry this module actually loaded, not
 * read from the header the service sent. The point of the project is not
 * trusting the provider's word; a viewer that simply reprinted it would miss
 * that entirely.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const loader = new GLTFLoader();

export async function renderPair(container, before, after, labels = {}) {
  container.stopPreview?.();
  container.innerHTML = "";
  container.className = "viewers";

  const left = createPane(container, labels.before ?? "Original");
  const right = createPane(container, labels.after ?? "Optimised");

  const [a, b] = await Promise.all([parse(before), parse(after)]);

  mount(left, a);
  mount(right, b);

  /**
   * One camera drives both panes.
   *
   * An earlier version linked them through each other's `change` events, in
   * both directions, while both auto-rotated. Each pane then overwrote the
   * other every frame and the distance to the target drifted: the models
   * slowly shrank, disappeared, and came back. Only one set of controls is
   * live at a time now, and the other is a copy of it.
   */
  let leader = left;
  let follower = right;
  let idle = true;

  for (const [pane, other] of [
    [left, right],
    [right, left],
  ]) {
    pane.controls.addEventListener("start", () => {
      leader = pane;
      follower = other;
      idle = false;
    });
  }

  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);

    leader.controls.autoRotate = idle;
    leader.controls.update();

    follower.camera.position.copy(leader.camera.position);
    follower.camera.quaternion.copy(leader.camera.quaternion);
    follower.controls.target.copy(leader.controls.target);

    left.renderer.render(left.scene, left.camera);
    right.renderer.render(right.scene, right.camera);
  };
  tick();

  // Dropping a second file replaces these panes. Without this the old loop
  // keeps running against detached canvases, and WebGL contexts are a limited
  // resource — a browser silently drops the oldest once enough pile up.
  container.stopPreview = () => {
    cancelAnimationFrame(frame);
    for (const pane of [left, right]) {
      pane.controls.dispose();
      pane.observer.disconnect();
      pane.renderer.dispose();
    }
  };

  const counts = { before: count(a.scene), after: count(b.scene) };
  left.caption.textContent = describe(counts.before);
  right.caption.textContent = describe(counts.after);

  return counts;
}

function parse(bytes) {
  return new Promise((resolve, reject) => {
    // The buffer must be its own copy: GLTFLoader keeps references into it,
    // and a view onto a shared buffer can be read back as another file's data.
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    loader.parse(copy, "", resolve, reject);
  });
}

function createPane(container, title) {
  const pane = document.createElement("div");
  pane.className = "viewer";
  pane.innerHTML = `<div class="viewer-title">${title}</div>`;
  container.appendChild(pane);

  const canvas = document.createElement("canvas");
  pane.appendChild(canvas);

  const caption = document.createElement("div");
  caption.className = "viewer-caption";
  pane.appendChild(caption);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();

  // Flat ambient light makes a rounded object look like a cut-out: every face
  // receives the same amount and only the silhouette survives. Most of the
  // light here is directional and off-axis, so curvature reads as curvature.
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30302e, 0.8));

  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(4, 6, 3);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.55);
  fill.position.set(-5, 0.5, 2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(-2, 3, -5);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotateSpeed = 1.1;

  const resize = () => {
    const width = pane.clientWidth;
    const height = Math.max(240, Math.round(width * 0.85));
    renderer.setSize(width, height, false);
    // setSize with updateStyle=false leaves the CSS height unset, so the
    // element collapses to its intrinsic ratio rather than the size we asked
    // the renderer for.
    canvas.style.height = `${height}px`;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(pane);
  resize();

  return { pane, canvas, caption, renderer, scene, camera, controls, observer };
}

function mount(pane, gltf) {
  // Render both faces. A preview exists to show the visitor their model, and
  // plenty of real assets have inverted winding or single-sided planes that
  // would otherwise come back as an empty panel — indistinguishable from a
  // broken page. Whether the winding is correct is the asset's business.
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material) material.side = THREE.DoubleSide;
    }
  });

  pane.scene.add(gltf.scene);

  // Frame whatever arrived. Models come in at wildly different scales, and a
  // fixed camera shows most of them as either a speck or nothing at all.
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z) || 1;

  // The distance at which the largest dimension fills the view, plus a small
  // margin so the model does not clip the edges as it turns.
  const radius = (extent / 2 / Math.tan((pane.camera.fov * Math.PI) / 360)) * 1.3;

  pane.controls.target.copy(centre);
  pane.camera.position.set(
    centre.x + radius * 0.45,
    centre.y + radius * 0.35,
    centre.z + radius * 0.82,
  );
  pane.camera.near = extent / 1000;
  pane.camera.far = extent * 1000;
  pane.camera.updateProjectionMatrix();

  // Bound the zoom. Without this the wheel pushes the camera inside the model
  // or far enough out that it vanishes, and someone who does that by accident
  // has no obvious way back.
  pane.controls.minDistance = radius * 0.35;
  pane.controls.maxDistance = radius * 4;
  pane.controls.update();
}

/** Count triangles and vertices from loaded geometry, not from any header. */
function count(root) {
  let triangles = 0;
  let vertices = 0;

  root.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const position = node.geometry.getAttribute("position");
    const index = node.geometry.getIndex();
    if (!position) return;
    vertices += position.count;
    triangles += Math.floor((index ? index.count : position.count) / 3);
  });

  return { triangles, vertices };
}

function describe({ triangles, vertices }) {
  return `${triangles.toLocaleString()} triangles · ${vertices.toLocaleString()} vertices`;
}

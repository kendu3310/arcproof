/**
 * Side-by-side 3D preview of a model before and after optimisation.
 *
 * The page already says "12 triangles in, 12 triangles out". That is a number
 * a visitor has to take on faith. Seeing both models turn together, identical,
 * while one of them is a twentieth of the size, is the same claim in a form
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
  container.innerHTML = "";
  container.className = "viewers";

  const left = createPane(container, labels.before ?? "Original");
  const right = createPane(container, labels.after ?? "Optimised");

  const [a, b] = await Promise.all([parse(before), parse(after)]);

  mount(left, a);
  mount(right, b);

  // Drag either model and both turn. Comparing two shapes is only possible
  // from the same angle, and asking someone to line up two cameras by hand is
  // asking them not to bother.
  link(left, right);
  link(right, left);

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
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-4, -1, -3);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;

  const pane_ = { pane, canvas, caption, renderer, scene, camera, controls };

  const resize = () => {
    const width = pane.clientWidth;
    const height = Math.max(200, Math.round(width * 0.8));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(pane);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return pane_;
}

function mount(pane, gltf) {
  pane.scene.add(gltf.scene);

  // Frame whatever arrived. Models come in at wildly different scales, and a
  // fixed camera shows most of them as either a speck or nothing at all.
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z) || 1;
  const distance = (extent / 2) / Math.tan((pane.camera.fov * Math.PI) / 360);

  pane.controls.target.copy(centre);
  pane.camera.position.set(centre.x + extent * 0.6, centre.y + extent * 0.4, centre.z + distance * 1.5);
  pane.camera.near = extent / 100;
  pane.camera.far = extent * 100;
  pane.camera.updateProjectionMatrix();
  pane.controls.update();
}

function link(source, target) {
  source.controls.addEventListener("change", () => {
    target.camera.position.copy(source.camera.position);
    target.camera.quaternion.copy(source.camera.quaternion);
    target.controls.target.copy(source.controls.target);
  });
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

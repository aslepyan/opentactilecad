// Client-side STL viewer, planar-face selection, and multi-face unfolding.
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  buildSurfaceModel,
  selectSmoothTrianglePatch,
  unfoldSelectedRegions,
  unfoldSelectedTriangles,
} from "./face-select.js";

const container = document.getElementById("stl-container");
const infoEl = document.getElementById("stl-info");
const fileInput = document.getElementById("stl-input");
const uploadBtn = document.getElementById("upload-stl");
const resetBtn = document.getElementById("reset-view");
const clearFaceBtn = document.getElementById("clear-face");
const singleBtn = document.getElementById("select-single");
const multipleBtn = document.getElementById("select-multiple");
const curvedBtn = document.getElementById("select-curved");
const curvatureTolInput = document.getElementById("curvature-tolerance");
const maxGrowthInput = document.getElementById("curved-max-radius");
const autoSeamInput = document.getElementById("auto-seam");
const setSeamBtn = document.getElementById("set-seam");
const selectAllBtn = document.getElementById("select-all-faces");
const unfoldBtn = document.getElementById("unfold-faces");

let scene, camera, renderer, controls, mesh, highlightMesh;
let raycaster, downPt, surfaceModel;
let selectionMode = "single";
let selectedRegions = new Set();
let selectedTriangles = new Set();
let rootRegionId = null;
let rootTriangleId = null;
let curvedSelectionMeta = null;
let seamPickMode = false;
let manualSeamTriangles = [];
let loadedName = "";
let homeTarget = new THREE.Vector3();
let homePos = new THREE.Vector3();
let initialized = false;
let resizeObserver = null;
let modelRadius = 1;

function init() {
  if (initialized) return;
  initialized = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1116);
  const w = container.clientWidth || 400;
  const h = container.clientHeight || 300;

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
  camera.position.set(60, 60, 60);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enableZoom = false;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = 0.18;
  controls.panSpeed = 0.85;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = 0.01;
  controls.maxDistance = 10000;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  keyLight.position.set(1, 1, 1);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
  fillLight.position.set(-1, -0.5, -1);
  scene.add(fillLight);
  scene.add(new THREE.GridHelper(200, 40, 0x33414f, 0x1b2530));
  scene.add(new THREE.AxesHelper(20));

  // A click selects; pointer movement is left to OrbitControls.
  raycaster = new THREE.Raycaster();
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (event) => {
    downPt = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!downPt) return;
    const moved = Math.hypot(event.clientX - downPt.x, event.clientY - downPt.y);
    downPt = null;
    if (moved <= 5) selectFaceAt(event.clientX, event.clientY);
  });
  canvas.addEventListener("wheel", handleWheelZoom, { passive: false });

  window.addEventListener("resize", onResize);
  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);
  }
  animate();
}

function onResize() {
  if (!renderer) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function normalizedWheelDelta(event) {
  let delta = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= container.clientHeight || 240;
  return Math.max(-80, Math.min(80, delta));
}

function handleWheelZoom(event) {
  if (!camera || !controls) return;
  event.preventDefault();
  event.stopPropagation();

  const delta = normalizedWheelDelta(event);
  if (!delta) return;

  const target = controls.target;
  const offset = camera.position.clone().sub(target);
  const currentDistance = offset.length();
  if (currentDistance < 1e-9) return;

  const zoomFactor = Math.exp(delta * 0.0022);
  const nextDistance = Math.max(
    controls.minDistance,
    Math.min(controls.maxDistance, currentDistance * zoomFactor),
  );
  offset.setLength(nextDistance);
  camera.position.copy(target).add(offset);
  camera.updateMatrixWorld();
  controls.update();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function frameObject(geometry) {
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.computeBoundingBox();

  const radius = size.length() / 2 || 1;
  modelRadius = radius;
  const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.3;
  homePos.set(distance, distance * 0.8, distance);
  homeTarget.set(0, 0, 0);
  camera.position.copy(homePos);
  camera.near = Math.max(radius / 100, 0.001);
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(homeTarget);
  controls.minDistance = Math.max(radius * 0.015, 0.01);
  controls.maxDistance = Math.max(distance * 8, radius * 6, 10);
  controls.saveState();
  controls.update();
  return size;
}

function loadArrayBuffer(buffer, filename) {
  init();
  let geometry;
  try {
    geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
  } catch (error) {
    showError(`Failed to parse STL: ${error.message}`);
    return;
  }

  clearSelection(false);
  surfaceModel = null;
  loadedName = "";
  setSelectionControlsEnabled(false);
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh = null;
  }

  const size = frameObject(geometry);
  try {
    surfaceModel = buildSurfaceModel(geometry);
  } catch (error) {
    geometry.dispose();
    showError(`Could not analyze STL surfaces: ${error.message}`);
    return;
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0x9fb4c8,
    metalness: 0.1,
    roughness: 0.75,
    flatShading: true,
  });
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  loadedName = filename;

  setSelectionControlsEnabled(true);
  const triCount = geometry.attributes.position.count / 3;
  const warning = surfaceModel.nonManifoldEdges
    ? ` · ${surfaceModel.nonManifoldEdges} non-manifold edges`
    : "";
  infoEl.textContent =
    `${filename} · ${triCount.toLocaleString()} triangles · ` +
    `${surfaceModel.regions.length} planar faces · ` +
    `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm${warning}`;
}

function selectFaceAt(clientX, clientY) {
  if (!mesh || !surfaceModel) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(mesh, false);
  if (!hits.length) return;

  const regionId = surfaceModel.triRegion[hits[0].faceIndex];
  if (regionId < 0) {
    showError("That triangle is degenerate and cannot be selected.");
    return;
  }

  if (seamPickMode) {
    pickSeamTriangle(hits[0].faceIndex);
    return;
  }

  if (selectionMode === "curved") {
    try {
      const tolerance = Number.parseFloat(curvatureTolInput?.value) || 18;
      const maxRadius = Number.parseFloat(maxGrowthInput?.value);
      const patch = selectSmoothTrianglePatch(surfaceModel, hits[0].faceIndex, {
        curvatureToleranceDeg: tolerance,
        maxRadiusMm: Number.isFinite(maxRadius) && maxRadius > 0 ? maxRadius : undefined,
      });
      const alreadySelected = [...patch.triangles].every((triangleId) => selectedTriangles.has(triangleId));
      if (alreadySelected) {
        for (const triangleId of patch.triangles) selectedTriangles.delete(triangleId);
        if (!selectedTriangles.has(rootTriangleId)) rootTriangleId = selectedTriangles.values().next().value ?? null;
      } else {
        for (const triangleId of patch.triangles) selectedTriangles.add(triangleId);
        if (rootTriangleId === null) rootTriangleId = patch.rootTriangleId;
      }
      curvedSelectionMeta = patch;
      manualSeamTriangles = [];
      refreshHighlight();
      showCombinedSelectionStatus("Click Unfold selection when ready.");
    } catch (error) {
      showError(error.message);
    }
    return;
  }

  if (selectionMode === "single") {
    selectedRegions = new Set([regionId]);
    selectedTriangles = new Set();
    rootTriangleId = null;
    curvedSelectionMeta = null;
    manualSeamTriangles = [];
    rootRegionId = regionId;
    refreshHighlight();
    unfoldCurrentSelection();
    return;
  }

  if (selectedRegions.has(regionId)) {
    selectedRegions.delete(regionId);
    if (rootRegionId === regionId) rootRegionId = selectedRegions.values().next().value ?? null;
  } else {
    selectedRegions.add(regionId);
    if (rootRegionId === null) rootRegionId = regionId;
  }
  manualSeamTriangles = [];
  refreshHighlight();
  showCombinedSelectionStatus("Click Unfold selection when ready.");
}

function unfoldCurrentSelection() {
  if (!surfaceModel || (!selectedRegions.size && !selectedTriangles.size)) return;
  let result;
  try {
    const combinedTriangles = combinedSelectedTriangles();
    result = selectedTriangles.size
      ? unfoldSelectedTriangles(surfaceModel, combinedTriangles, rootTriangleId ?? combinedTriangles.values().next().value, {
          autoSeam: autoSeamInput?.checked !== false,
          seamTriangleIds: manualSeamTriangles,
        })
      : unfoldSelectedRegions(surfaceModel, selectedRegions, rootRegionId);
  } catch (error) {
    showError(error.message);
    return;
  }

  if (selectedTriangles.size) {
    rootTriangleId = result.rootTriangleId;
  } else {
    rootRegionId = result.rootRegionId;
  }
  const unit = selectedTriangles.size ? "triangle" : "face";
  const warning = result.warnings?.length ? ` · ${result.warnings[0]}` : "";
  const seam = result.seam?.message ? ` · ${result.seam.message}` : "";
  infoEl.textContent =
    `${loadedName} · unfolded ${result.faceCount} ${unit}${result.faceCount === 1 ? "" : "s"} · ` +
    `${result.w.toFixed(1)} × ${result.h.toFixed(1)} mm · ` +
    `${result.foldLines.length} fold line${result.foldLines.length === 1 ? "" : "s"}${seam}${warning}`;
  window.dispatchEvent(new CustomEvent("otc:face-outline", {
    detail: {
      outline: result.outline,
      foldLines: result.foldLines,
      w: result.w,
      h: result.h,
      faceCount: result.faceCount,
      warnings: result.warnings || [],
    },
  }));
}

function refreshHighlight() {
  clearHighlight();
  if (!surfaceModel || (!selectedRegions.size && !selectedTriangles.size)) {
    clearFaceBtn.disabled = true;
    unfoldBtn.disabled = true;
    return;
  }

  const positions = [];
  if (selectedTriangles.size || selectedRegions.size) {
    const highlightedTriangles = selectedTriangles.size
      ? combinedSelectedTriangles()
      : null;
    if (highlightedTriangles) {
      for (const triangleId of highlightedTriangles) {
        const base = triangleId * 3;
        for (const j of [base, base + 1, base + 2]) {
          positions.push(
            surfaceModel.positions.getX(j),
            surfaceModel.positions.getY(j),
            surfaceModel.positions.getZ(j),
          );
        }
      }
    } else {
      for (const regionId of selectedRegions) {
        positions.push(...surfaceModel.regions[regionId].highlightPositions);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({
    color: 0xffa023,
    transparent: true,
    opacity: 0.58,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  highlightMesh = new THREE.Mesh(geometry, material);
  scene.add(highlightMesh);
  clearFaceBtn.disabled = false;
  unfoldBtn.disabled = false;
}

function combinedSelectedTriangles() {
  const triangles = new Set(selectedTriangles);
  for (const regionId of selectedRegions) {
    const region = surfaceModel?.regions?.[regionId];
    if (!region) continue;
    for (const triangleId of region.triangles) triangles.add(triangleId);
  }
  return triangles;
}

function pickSeamTriangle(triangleId) {
  const combined = combinedSelectedTriangles();
  if (!combined.has(triangleId)) {
    showError("Click seam points on the selected surface.");
    return;
  }
  manualSeamTriangles.push(triangleId);
  if (manualSeamTriangles.length === 1) {
    showCombinedSelectionStatus("click the second seam point");
    return;
  }
  manualSeamTriangles = manualSeamTriangles.slice(0, 2);
  seamPickMode = false;
  setSeamBtn?.classList.remove("active");
  showCombinedSelectionStatus("manual seam set; click Unfold selection");
}

function clearHighlight() {
  if (!highlightMesh) return;
  scene.remove(highlightMesh);
  highlightMesh.geometry.dispose();
  highlightMesh.material.dispose();
  highlightMesh = null;
}

function clearSelection(notify = true) {
  selectedRegions = new Set();
  selectedTriangles = new Set();
  rootRegionId = null;
  rootTriangleId = null;
  curvedSelectionMeta = null;
  seamPickMode = false;
  manualSeamTriangles = [];
  setSeamBtn?.classList.remove("active");
  clearHighlight();
  clearFaceBtn.disabled = true;
  unfoldBtn.disabled = true;
  if (notify) {
    window.dispatchEvent(new CustomEvent("otc:face-clear"));
    if (surfaceModel) showSelectionStatus("Selection cleared.");
  }
}

function showSelectionStatus(suffix = "") {
  const count = selectedRegions.size;
  infoEl.textContent =
    `${loadedName} · ${count} of ${surfaceModel.regions.length} planar faces selected` +
    (suffix ? ` · ${suffix}` : "");
}

function showCombinedSelectionStatus(suffix = "") {
  const faceCount = selectedRegions.size;
  const triangleCount = selectedTriangles.size;
  const area = curvedSelectionMeta?.area ? ` · ${curvedSelectionMeta.area.toFixed(1)} mm²` : "";
  const tolerance = curvedSelectionMeta?.toleranceDeg ?? (Number.parseFloat(curvatureTolInput?.value) || 18);
  const nonManifold = curvedSelectionMeta?.nonManifoldEdges
    ? ` · ${curvedSelectionMeta.nonManifoldEdges} non-manifold edges`
    : "";
  const parts = [];
  if (faceCount) parts.push(`${faceCount} planar face${faceCount === 1 ? "" : "s"}`);
  if (triangleCount) parts.push(`${triangleCount.toLocaleString()} curved triangle${triangleCount === 1 ? "" : "s"}`);
  infoEl.textContent =
    `${loadedName} · ${parts.join(" + ") || "no surfaces selected"} · ` +
    `${tolerance}° normal angle${triangleCount ? area : ""}${nonManifold}` +
    (manualSeamTriangles.length ? ` · manual seam ${manualSeamTriangles.length}/2` : "") +
    (suffix ? ` · ${suffix}` : "");
}

function showError(message) {
  infoEl.textContent = `Error: ${message}`;
  infoEl.classList.add("error");
  window.setTimeout(() => infoEl.classList.remove("error"), 2500);
}

function setMode(mode) {
  seamPickMode = false;
  setSeamBtn?.classList.remove("active");
  selectionMode = mode;
  singleBtn.classList.toggle("active", mode === "single");
  multipleBtn.classList.toggle("active", mode === "multiple");
  curvedBtn.classList.toggle("active", mode === "curved");
  singleBtn.setAttribute("aria-pressed", String(mode === "single"));
  multipleBtn.setAttribute("aria-pressed", String(mode === "multiple"));
  curvedBtn.setAttribute("aria-pressed", String(mode === "curved"));
  if (surfaceModel) {
    if (mode === "curved") {
      showCombinedSelectionStatus("click one triangle on a curved surface");
    } else if (selectedRegions.size || selectedTriangles.size) {
      showCombinedSelectionStatus(mode === "single" ? "click one face to replace selection" : "click faces to toggle selection");
    } else {
      showSelectionStatus(mode === "single" ? "click one face" : "click faces to toggle selection");
    }
  }
}

function setSelectionControlsEnabled(enabled) {
  resetBtn.disabled = !enabled;
  singleBtn.disabled = !enabled;
  multipleBtn.disabled = !enabled;
  curvedBtn.disabled = !enabled;
  selectAllBtn.disabled = !enabled;
  if (curvatureTolInput) curvatureTolInput.disabled = !enabled;
  if (maxGrowthInput) maxGrowthInput.disabled = !enabled;
  if (autoSeamInput) autoSeamInput.disabled = !enabled;
  if (setSeamBtn) setSeamBtn.disabled = !enabled;
  if (!enabled) {
    clearFaceBtn.disabled = true;
    unfoldBtn.disabled = true;
  }
}

// ---- UI wiring ----
uploadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  infoEl.textContent = `Loading and analyzing ${file.name}…`;
  const reader = new FileReader();
  reader.onload = (loadEvent) => loadArrayBuffer(loadEvent.target.result, file.name);
  reader.onerror = () => showError("Could not read the selected file.");
  reader.readAsArrayBuffer(file);
  fileInput.value = "";
});

singleBtn.addEventListener("click", () => setMode("single"));
multipleBtn.addEventListener("click", () => setMode("multiple"));
curvedBtn.addEventListener("click", () => setMode("curved"));

setSeamBtn?.addEventListener("click", () => {
  if (!surfaceModel) return;
  if (!selectedTriangles.size && !selectedRegions.size) {
    showError("Select a curved or connected surface before setting a seam.");
    return;
  }
  seamPickMode = !seamPickMode;
  manualSeamTriangles = [];
  setSeamBtn.classList.toggle("active", seamPickMode);
  showCombinedSelectionStatus(seamPickMode ? "click the first seam point" : "manual seam cancelled");
});

selectAllBtn.addEventListener("click", () => {
  if (!surfaceModel) return;
  selectedRegions = new Set(surfaceModel.regions.map((region) => region.id));
  selectedTriangles = new Set();
  rootTriangleId = null;
  curvedSelectionMeta = null;
  manualSeamTriangles = [];
  seamPickMode = false;
  setSeamBtn?.classList.remove("active");
  if (rootRegionId === null) {
    rootRegionId = surfaceModel.regions
      .reduce((largest, region) => region.area > largest.area ? region : largest).id;
  }
  refreshHighlight();
  showSelectionStatus("all faces selected; unfolding…");
  unfoldCurrentSelection();
});

unfoldBtn.addEventListener("click", unfoldCurrentSelection);
clearFaceBtn.addEventListener("click", () => clearSelection(true));

resetBtn.addEventListener("click", () => {
  if (!mesh) return;
  camera.position.copy(homePos);
  camera.near = Math.max(modelRadius / 100, 0.001);
  camera.far = modelRadius * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(homeTarget);
  controls.minDistance = Math.max(modelRadius * 0.015, 0.01);
  controls.update();
});

setMode("single");
setSelectionControlsEnabled(false);

// The STL panel can be hidden (mode switch, view switch) while its Three.js
// renderer exists — resize against a hidden/zero-size container is a no-op,
// so re-run it once the panel becomes visible again.
window.addEventListener("otc:view-shown", () => {
  if (initialized) onResize();
});

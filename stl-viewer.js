// Client-side STL viewer, planar-face selection, and multi-face unfolding.
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  buildSurfaceModel,
  finalizeChainOutline,
  selectSmoothTrianglePatch,
  unfoldSelectedRegions,
  unfoldSelectedTriangles,
} from "./face-select.js";
import { API_BASE } from "./config.js";

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
const connectionsEl = document.getElementById("stl-connections");

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

// Disconnected selections are joined server-side by /unroll-mesh-chain
// (straight-strut cuts between surfaces that don't share mesh edges). The
// backend needs the raw STL bytes (its face indices match three.js's — see
// NOTES.md's real-face-index fix), the selections in click order, and any
// manually-picked corner pairs per connection.
let stlBuffer = null;
// frameObject() recenters the displayed geometry; backend coordinates stay
// in the file's original frame, so 3D points it returns (corner-picker
// markers) must be shifted by -meshOffset before rendering.
const meshOffset = new THREE.Vector3();
let clickOrder = [];        // [{faceIndex, regionId|null, triangles:Set}] in click order
let chainOverrides = {};    // {connectionIndex: [[vA1,vB1],[vA2,vB2]]}
let chainData = null;       // last /unroll-mesh-chain response
let chainBusy = false;
let cornerPick = null;      // {connIndex, pairs, pendingA, markerGroup, previewGroup}

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
    if (moved > 5) return;
    if (cornerPick) {
      pickCornerAt(event.clientX, event.clientY);
      return;
    }
    selectFaceAt(event.clientX, event.clientY);
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
  meshOffset.copy(center);
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
  stlBuffer = buffer;
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
        for (const entry of clickOrder) {
          for (const triangleId of patch.triangles) entry.triangles.delete(triangleId);
        }
        clickOrder = clickOrder.filter((entry) => entry.triangles.size);
      } else {
        for (const triangleId of patch.triangles) selectedTriangles.add(triangleId);
        if (rootTriangleId === null) rootTriangleId = patch.rootTriangleId;
        clickOrder.push({ faceIndex: hits[0].faceIndex, regionId: null, triangles: new Set(patch.triangles) });
      }
      invalidateChain();
      curvedSelectionMeta = patch;
      manualSeamTriangles = [];
      refreshHighlight();
      showCombinedSelectionStatus(unfoldHint());
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
    clickOrder = [{
      faceIndex: hits[0].faceIndex,
      regionId,
      triangles: new Set(surfaceModel.regions[regionId].triangles),
    }];
    invalidateChain();
    refreshHighlight();
    unfoldCurrentSelection();
    return;
  }

  if (selectedRegions.has(regionId)) {
    selectedRegions.delete(regionId);
    if (rootRegionId === regionId) rootRegionId = selectedRegions.values().next().value ?? null;
    clickOrder = clickOrder.filter((entry) => entry.regionId !== regionId);
  } else {
    selectedRegions.add(regionId);
    if (rootRegionId === null) rootRegionId = regionId;
    clickOrder.push({
      faceIndex: hits[0].faceIndex,
      regionId,
      triangles: new Set(surfaceModel.regions[regionId].triangles),
    });
  }
  invalidateChain();
  manualSeamTriangles = [];
  refreshHighlight();
  showCombinedSelectionStatus(unfoldHint());
}

function unfoldCurrentSelection() {
  if (!surfaceModel || (!selectedRegions.size && !selectedTriangles.size)) return;
  const combinedTriangles = combinedSelectedTriangles();

  // Selections that don't share mesh edges can't unfold as one client-side
  // patch; the backend joins them with straight-strut cuts instead.
  if (selectionComponentCount(combinedTriangles) > 1) {
    unfoldViaBackendChain();
    return;
  }

  let result;
  try {
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

// ---- Backend strut-chain for disconnected selections ----

function selectionComponentCount(triangles) {
  const remaining = new Set(triangles);
  let components = 0;
  while (remaining.size) {
    components++;
    const seed = remaining.values().next().value;
    const stack = [seed];
    remaining.delete(seed);
    while (stack.length) {
      const current = stack.pop();
      for (const edge of surfaceModel.triAdjacency[current] || []) {
        if (remaining.has(edge.triangle)) {
          remaining.delete(edge.triangle);
          stack.push(edge.triangle);
        }
      }
    }
  }
  return components;
}

// The click history, trimmed to what's still selected. Later clicks own any
// triangle two entries both grabbed, so every region is sent exactly once
// and each entry's click face stays inside its own region.
function orderedClickEntries() {
  const selected = combinedSelectedTriangles();
  const claimed = new Set();
  const entries = [];
  for (let i = clickOrder.length - 1; i >= 0; i--) {
    const source = clickOrder[i];
    const triangles = new Set();
    for (const t of source.triangles) {
      if (selected.has(t) && !claimed.has(t)) {
        triangles.add(t);
        claimed.add(t);
      }
    }
    if (!triangles.size) continue;
    const faceIndex = triangles.has(source.faceIndex)
      ? source.faceIndex
      : triangles.values().next().value;
    entries.push({ faceIndex, triangles });
  }
  return entries.reverse();
}

// Guided flow for disconnected selections: corner picking is a REQUIRED
// step, not a fix-up. "Join surfaces" walks the chain cut by cut — the
// backend (corners_first) stops at the first cut without user-picked
// corners and returns its marker loops; the automatic corner heuristic
// never runs. Only when every cut has picked corners does the outline
// exist, and only "Use this shape" hands it to the board editor.
async function unfoldViaBackendChain() {
  if (chainBusy) return;
  if (!stlBuffer) {
    showError("The original STL bytes are unavailable — reload the file.");
    return;
  }
  const entries = orderedClickEntries();
  if (entries.length < 2) {
    showError("Disconnected surfaces need separate clicks so their join order is known.");
    return;
  }

  chainBusy = true;
  unfoldBtn.disabled = true;
  infoEl.textContent = `${loadedName} · analyzing how ${entries.length} surfaces connect…`;
  try {
    const form = new FormData();
    form.append("file", new Blob([stlBuffer]), loadedName || "model.stl");
    form.append("click_face_indices", entries.map((e) => e.faceIndex).join(","));
    form.append("click_regions", JSON.stringify(entries.map((e) => [...e.triangles])));
    form.append("connection_overrides", JSON.stringify(chainOverrides));
    form.append("corners_first", "true");

    const response = await fetch(`${API_BASE}/unroll-mesh-chain`, { method: "POST", body: form });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        detail = (await response.json()).detail || detail;
      } catch {}
      throw new Error(detail);
    }
    chainData = await response.json();
    chainData.entryCount = entries.length;
    renderChainPanel();
    const pending = chainData.pending_connection;
    if (pending !== null && pending !== undefined) {
      startCornerPick(pending, chainData.connections[pending]);
    } else {
      infoEl.textContent =
        `${loadedName} · all cuts joined with your corners · ` +
        `check the preview, then "Use this shape".`;
    }
  } catch (error) {
    showError(error.message);
  } finally {
    chainBusy = false;
    unfoldBtn.disabled = false;
  }
}

function useChainShape() {
  if (!chainData) return;
  let finalized;
  try {
    finalized = finalizeChainOutline(chainData.outline);
  } catch (error) {
    showError(error.message);
    return;
  }
  window.dispatchEvent(new CustomEvent("otc:face-outline", {
    detail: {
      outline: finalized.outline,
      foldLines: [],
      w: finalized.w,
      h: finalized.h,
      faceCount: chainData.entryCount || 2,
      warnings: chainData.warnings || [],
    },
  }));
  infoEl.textContent =
    `${loadedName} · outline loaded into the editor · ` +
    `${finalized.w.toFixed(1)} × ${finalized.h.toFixed(1)} mm`;
}

function drawChainPreview(canvas, points) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!points || points.length < 3) return;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 10;
  const scale = Math.min((w - 2 * pad) / Math.max(maxX - minX, 1e-6),
                         (h - 2 * pad) / Math.max(maxY - minY, 1e-6));
  const ox = (w - (maxX - minX) * scale) / 2;
  const oy = (h - (maxY - minY) * scale) / 2;
  // y flipped: outline is y-up, canvas is y-down
  const px = (p) => [ox + (p[0] - minX) * scale, h - oy - (p[1] - minY) * scale];
  ctx.beginPath();
  const [x0, y0] = px(points[0]);
  ctx.moveTo(x0, y0);
  for (const p of points.slice(1)) ctx.lineTo(...px(p));
  ctx.closePath();
  ctx.fillStyle = "rgba(60, 130, 90, 0.35)";
  ctx.strokeStyle = "#7fe0a8";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  // Mark the cable edge (0->1 after finalization) so the exit side is visible.
  ctx.beginPath();
  ctx.moveTo(...px(points[0]));
  ctx.lineTo(...px(points[1]));
  ctx.strokeStyle = "#ffd23e";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function renderChainPanel() {
  if (!connectionsEl) return;
  connectionsEl.innerHTML = "";
  if (!chainData) {
    connectionsEl.hidden = true;
    return;
  }

  const pending = chainData.pending_connection ?? null;
  let finalized = null;
  if (pending === null && (chainData.outline || []).length >= 3) {
    try {
      finalized = finalizeChainOutline(chainData.outline);
    } catch {}
  }

  if (finalized) {
    const canvas = document.createElement("canvas");
    canvas.className = "chain-preview";
    canvas.width = 260;
    canvas.height = 150;
    connectionsEl.appendChild(canvas);
    drawChainPreview(canvas, finalized.outline);
  }

  const dims = document.createElement("div");
  dims.className = "chain-dims";
  const strutCount = chainData.connections.filter((c) => c.needs_strut).length;
  const worstDev = Math.max(0, ...(chainData.region_developability_mm || []));
  dims.textContent = (finalized
    ? `${finalized.w.toFixed(1)} × ${finalized.h.toFixed(1)} mm · yellow = cable edge`
    : "Pick the matching corners for each cut — the unfolded shape appears once every cut is joined.")
    + ` · ${strutCount} straight cut${strutCount === 1 ? "" : "s"} so far`
    + (worstDev > 1.0 ? ` · distortion up to ${worstDev.toFixed(1)}mm` : "");
  connectionsEl.appendChild(dims);

  for (const [index, connection] of chainData.connections.entries()) {
    if (!connection.needs_strut) continue;
    const isPending = index === pending;
    const row = document.createElement("div");
    row.className = isPending ? "conn-row pending" : "conn-row warn";
    const label = document.createElement("span");
    const kind = isPending ? "corners needed" : (chainOverrides[index] ? "your corners" : "auto corners");
    label.innerHTML =
      `Cut ${index + 1}&harr;${index + 2}: <span class="conn-kind">${kind}</span>`;
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "secondary";
    pick.disabled = chainBusy;
    pick.textContent = cornerPick?.connIndex === index
      ? "Cancel"
      : (isPending ? "Pick corners" : "Repick");
    pick.addEventListener("click", () => {
      if (cornerPick?.connIndex === index) {
        endCornerPick("corner picking cancelled — the cut still needs corners");
      } else {
        startCornerPick(index, connection);
      }
    });
    row.appendChild(label);
    row.appendChild(pick);
    connectionsEl.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "chain-actions";
  const use = document.createElement("button");
  use.type = "button";
  use.className = "primary";
  use.textContent = "Use this shape";
  use.disabled = chainBusy || !finalized;
  use.title = finalized ? "" : "Pick corners for every cut first.";
  use.addEventListener("click", useChainShape);
  actions.appendChild(use);
  connectionsEl.appendChild(actions);

  connectionsEl.hidden = false;
}

const CORNER_GROUP_COLORS = [0xffd23e, 0x39c6d6, 0x9dff57, 0xff9d3e];

function startCornerPick(connIndex, connection) {
  endCornerPick();
  const markerGroup = new THREE.Group();
  const radius = Math.max(modelRadius * 0.018, 0.05);
  const addMarker = (point, side) => {
    const [vertexIndex, x, y, z, groupId] = point;
    const color = side === "a"
      ? CORNER_GROUP_COLORS[Math.trunc(groupId) % CORNER_GROUP_COLORS.length]
      : 0xff5ea8;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 12, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    marker.position.set(x - meshOffset.x, y - meshOffset.y, z - meshOffset.z);
    marker.renderOrder = 10;
    marker.userData = { side, vertexIndex: Math.trunc(vertexIndex) };
    markerGroup.add(marker);
  };
  for (const point of connection.loop_a || []) addMarker(point, "a");
  for (const point of connection.loop_b || []) addMarker(point, "b");
  const previewGroup = new THREE.Group();
  scene.add(markerGroup);
  scene.add(previewGroup);
  cornerPick = { connIndex, pairs: [], pendingA: null, markerGroup, previewGroup };
  renderChainPanel();
  infoEl.textContent =
    `Cut ${connIndex + 1}↔${connIndex + 2} · corner pair 1 of 2: click a colored marker ` +
    "on the joined part, then its matching pink marker on the new surface.";
}

function endCornerPick(message = "") {
  if (cornerPick) {
    scene.remove(cornerPick.markerGroup);
    scene.remove(cornerPick.previewGroup);
    for (const group of [cornerPick.markerGroup, cornerPick.previewGroup]) {
      group.traverse((obj) => {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
      });
    }
    cornerPick = null;
    renderChainPanel();
  }
  if (message) infoEl.textContent = `${loadedName} · ${message}`;
}

function pickCornerAt(clientX, clientY) {
  if (!cornerPick) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const expectSide = cornerPick.pendingA === null ? "a" : "b";
  const hits = raycaster.intersectObjects(cornerPick.markerGroup.children, false)
    .filter((hit) => hit.object.userData.side === expectSide);
  if (!hits.length) {
    infoEl.textContent = expectSide === "a"
      ? "Click one of the colored markers on the existing chain first."
      : "Now click a pink marker on the new surface.";
    return;
  }
  const marker = hits[0].object;
  marker.material.color.setHex(0xffffff);
  if (expectSide === "a") {
    cornerPick.pendingA = marker;
    infoEl.textContent = "Now click its partner corner on the new surface (pink).";
    return;
  }

  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      cornerPick.pendingA.position.clone(),
      marker.position.clone(),
    ]),
    new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
  );
  line.renderOrder = 11;
  cornerPick.previewGroup.add(line);
  cornerPick.pairs.push([cornerPick.pendingA.userData.vertexIndex, marker.userData.vertexIndex]);
  cornerPick.pendingA = null;

  if (cornerPick.pairs.length < 2) {
    infoEl.textContent =
      `Cut ${cornerPick.connIndex + 1}↔${cornerPick.connIndex + 2} · corner pair 2 of 2: ` +
      "colored marker first, then its pink partner.";
    return;
  }
  // Later cuts attach to the chain this cut just reshaped, so their picked
  // corners no longer describe the same boundary — clear them and let the
  // guided walk re-request each one in order.
  for (const key of Object.keys(chainOverrides)) {
    if (Number(key) > cornerPick.connIndex) delete chainOverrides[key];
  }
  chainOverrides[cornerPick.connIndex] = cornerPick.pairs;
  endCornerPick();
  unfoldViaBackendChain();
}

// A selection edit makes the last chain result and its per-connection
// overrides stale (connection indices shift with the click list).
function invalidateChain() {
  chainOverrides = {};
  chainData = null;
  endCornerPick();
  if (connectionsEl) {
    connectionsEl.hidden = true;
    connectionsEl.innerHTML = "";
  }
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
  // Make the required next step visible: a disconnected selection is not
  // unfolded directly — the button starts the join-and-pick-corners walk.
  unfoldBtn.textContent = selectionIsDisconnected() ? "Join surfaces…" : "Unfold selection";
}

function selectionIsDisconnected() {
  if (!surfaceModel) return false;
  const combined = combinedSelectedTriangles();
  return combined.size > 0 && selectionComponentCount(combined) > 1;
}

function unfoldHint() {
  return selectionIsDisconnected()
    ? 'surfaces don’t touch — click "Join surfaces…" to pick the connecting corners'
    : "Click Unfold selection when ready.";
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
  clickOrder = [];
  invalidateChain();
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
  // Largest-area first, so a disconnected model chains its biggest shell
  // outward instead of starting from a sliver.
  clickOrder = [...surfaceModel.regions]
    .sort((a, b) => b.area - a.area)
    .map((region) => ({
      faceIndex: region.triangles[0],
      regionId: region.id,
      triangles: new Set(region.triangles),
    }));
  invalidateChain();
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

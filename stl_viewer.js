// STL 3D face-selection viewer. Loaded as an ES module (modern three.js is
// modules-only) alongside the classic-script app.js. Talks to app.js only
// through a small window-level interface:
//   - calls window.__stlHandoff(outline) when the user confirms an unroll
//   - reuses window.ensureServerAwake() / window.setStatus() / window.API_URL,
//     which app.js exposes (function declarations attach to window
//     automatically; API_URL is explicitly assigned since `const` doesn't).
//
// Standard flow (see NOTES.md's "STL/3D unroll" section for the full
// history/rationale): (1) select surfaces — click through *all* the faces
// wanted first, each gets its own color, no connection math happens yet;
// (2) set connections — "Set Connections" computes the whole chain in one
// backend request (POST /unroll-mesh-chain); any connection that needed a
// straight-strut approximation gets its own row, where corners can be
// picked explicitly instead of leaving it automatic — picking corners for
// any connection just resubmits the *entire* click list plus an updated
// sparse map of manual corner overrides, so there's no incremental replay
// state to keep consistent on this side, the backend recomputes everything
// fresh; (3) unwrap — hand the resulting flat outline off to the 2D canvas.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas2d = document.getElementById('canvas');
const canvas3d = document.getElementById('canvas3d');
const stlPanel = document.getElementById('stl-panel');
const stlStatsEl = document.getElementById('stl-stats');
const btnImportStl = document.getElementById('btn-import-stl');
const stlFileInput = document.getElementById('stl-file-input');
const btnPreviewStl = document.getElementById('btn-preview-stl');
const btnUnrollStl = document.getElementById('btn-unroll-stl');
const btnCancelStl = document.getElementById('btn-cancel-stl');
const btnCancelConnect = document.getElementById('btn-cancel-connect');
const connectInstructions = document.getElementById('connect-instructions');
const connectionsListEl = document.getElementById('connections-list');

// Other left-panel controls that would otherwise stay clickable (and
// confusing to leave live) while the 2D canvas is hidden behind the 3D view.
const otherControls = ['btn-draw', 'btn-import-dxf', 'btn-draw-fill', 'btn-clear', 'preset-select']
    .map(id => document.getElementById(id));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf5f5f7);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
dirLight.position.set(1, 1, 1);
scene.add(dirLight);

// Cycled by click index (selection phase) or group_id (connection markers)
// so distinct original faces always render as visually distinct colors.
const PALETTE = [0xff5533, 0x33aa55, 0x3388ff, 0xffaa00, 0xaa33ff, 0x00b3b3, 0xdd3377, 0x77cc00];
function paletteColor(i) {
    return new THREE.Color(PALETTE[i % PALETTE.length]);
}

let mesh = null;
let currentFile = null;
let active = false;
let meshSize = 1;
let meshCenterOffset = new THREE.Vector3(); // subtracted from displayed geometry by loadSTL();
                                             // backend 3D points need the same offset applied

// clickedFaces[i] = { faceIndex, regionFaceIndices } in click order.
let clickedFaces = [];
// Sparse map: connectionIndex (0-based gap between clickedFaces[k]/[k+1]) ->
// [[v_a1, v_b1], [v_a2, v_b2]] of manually-picked original mesh vertex indices.
let connectionOverrides = {};
let lastChainResponse = null; // last /unroll-mesh-chain response, or null
let lastOutline = null;

// Manual "connect corners" flow.
let connectModeActive = false;
let activeConnectionIndex = -1;
let connectPicks = [];        // [{side: 1|2, vertexIndex, pos}, ...]
let connectMarkerGroup = null;
let connectLineGroup = null;

function resizeViewer() {
    const container = canvas3d.parentElement;
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeViewer);

function animate() {
    requestAnimationFrame(animate);
    if (active) {
        controls.update();
        renderer.render(scene, camera);
    }
}
animate();

btnImportStl.addEventListener('click', () => stlFileInput.click());
stlFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    stlFileInput.value = '';
    if (!file) return;
    currentFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => enterSTLMode(ev.target.result);
    reader.readAsArrayBuffer(file);
});

function enterSTLMode(arrayBuffer) {
    canvas2d.classList.add('hidden');
    canvas3d.classList.remove('hidden');
    stlPanel.classList.remove('hidden');
    otherControls.forEach(el => { if (el) el.disabled = true; });
    btnImportStl.disabled = true;
    active = true;
    resizeViewer();
    loadSTL(arrayBuffer);
    window.setStatus('Double-click a flat surface to select it.');
}

function exitSTLMode() {
    canvas3d.classList.add('hidden');
    canvas2d.classList.remove('hidden');
    stlPanel.classList.add('hidden');
    otherControls.forEach(el => { if (el) el.disabled = false; });
    btnImportStl.disabled = false;
    active = false;
    if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh = null;
    }
    currentFile = null;
    resetSelectionState();
    exitConnectMode();
    stlStatsEl.innerHTML = '';
    // btnDrawFill's correct disabled state depends on outline.length/drawMode
    // (app.js state this module doesn't track) — let app.js recompute it
    // rather than assume "enabled" is always right.
    window.updateUI();
}

function resetSelectionState() {
    clickedFaces = [];
    connectionOverrides = {};
    lastChainResponse = null;
    lastOutline = null;
    btnPreviewStl.disabled = true;
    btnUnrollStl.disabled = true;
    connectionsListEl.innerHTML = '';
}

btnCancelStl.addEventListener('click', () => {
    exitSTLMode();
    window.setStatus('');
});

btnUnrollStl.addEventListener('click', () => {
    if (!lastOutline) return;
    const outline = lastOutline;
    exitSTLMode();
    window.__stlHandoff(outline);
});

function loadSTL(arrayBuffer) {
    if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
    }
    const loader = new STLLoader();
    const geometry = loader.parse(arrayBuffer);
    geometry.computeVertexNormals();

    // Selection is sent to the backend as face indices, not 3D points, so
    // centering the view doesn't need to preserve an offset back to the
    // STL's original coordinate frame for *that* — but the manual "connect
    // corners" flow's marker positions come back from the backend in the
    // STL's original (uncentered) frame, so the offset is captured here
    // (equivalent to geometry.center(), just not discarded) for
    // toSceneVec() to re-apply to those points later.
    geometry.computeBoundingBox();
    geometry.boundingBox.getCenter(meshCenterOffset);
    geometry.translate(-meshCenterOffset.x, -meshCenterOffset.y, -meshCenterOffset.z);

    const baseColors = new Float32Array(geometry.attributes.position.count * 3);
    baseColors.fill(0.75);
    geometry.setAttribute('color', new THREE.BufferAttribute(baseColors, 3));

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3()).length();
    meshSize = size;
    const center = box.getCenter(new THREE.Vector3());
    camera.position.copy(center).add(new THREE.Vector3(size, size * 0.6, size));
    camera.near = size / 100;
    camera.far = size * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();

    resetSelectionState();
    exitConnectMode();
    stlStatsEl.innerHTML = '';
}

function recolorFaces(faceIndices, color) {
    const colorAttr = mesh.geometry.attributes.color;
    for (const fi of faceIndices) {
        for (let k = 0; k < 3; k++) {
            colorAttr.setXYZ(fi * 3 + k, color.r, color.g, color.b);
        }
    }
    colorAttr.needsUpdate = true;
}

function resetColors() {
    const colorAttr = mesh.geometry.attributes.color;
    for (let i = 0; i < colorAttr.count; i++) colorAttr.setXYZ(i, 0.75, 0.75, 0.75);
    colorAttr.needsUpdate = true;
}

// Repaint every clicked region in its own click-indexed color — the live
// feedback during the selection phase, before any connection math runs.
function repaintClickedFaces() {
    resetColors();
    clickedFaces.forEach((c, i) => recolorFaces(c.regionFaceIndices, paletteColor(i)));
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas3d.addEventListener('dblclick', async (e) => {
    if (!mesh || !currentFile || connectModeActive) return;
    const rect = canvas3d.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(mesh);
    if (hits.length === 0) return;

    const hit = hits[0];
    const extending = e.shiftKey && clickedFaces.length > 0;
    if (!extending) {
        resetSelectionState();
    }

    window.setStatus('Adding surface...', true);
    await window.ensureServerAwake();
    window.setStatus('Adding surface...', true);

    try {
        const formData = new FormData();
        formData.append('file', currentFile);
        formData.append('click_face_index', hit.faceIndex);
        const resp = await fetch(`${window.API_URL}/grow-region`, { method: 'POST', body: formData });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        clickedFaces.push({ faceIndex: hit.faceIndex, regionFaceIndices: data.region_face_indices });
        repaintClickedFaces();

        // Any change to the face list invalidates the last preview/outline
        // until the user re-previews.
        lastChainResponse = null;
        lastOutline = null;
        btnUnrollStl.disabled = true;
        connectionsListEl.innerHTML = '';
        btnPreviewStl.disabled = false;

        window.setStatus(`${clickedFaces.length} surface${clickedFaces.length > 1 ? 's' : ''} selected. `
            + 'Shift+double-click to add another, or click "Set Connections" when ready.');
    } catch (err) {
        window.setStatus(`Error: ${err.message}`);
        console.error(err);
    }
});

btnPreviewStl.addEventListener('click', () => computeChain());

async function computeChain() {
    window.setStatus('Computing unrolled shape...', true);
    await window.ensureServerAwake();
    window.setStatus('Computing unrolled shape...', true);
    try {
        const formData = new FormData();
        formData.append('file', currentFile);
        formData.append('click_face_indices', clickedFaces.map(c => c.faceIndex).join(','));
        formData.append('connection_overrides', JSON.stringify(connectionOverrides));

        const resp = await fetch(`${window.API_URL}/unroll-mesh-chain`, { method: 'POST', body: formData });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        lastChainResponse = data;
        lastOutline = data.outline;

        resetColors();
        recolorFaces(data.region_face_indices, new THREE.Color(0.2, 0.8, 1));
        btnUnrollStl.disabled = false;

        const warningsHtml = data.warnings.length
            ? `<div class="warn">${data.warnings.join('<br>')}</div>` : '';
        stlStatsEl.innerHTML = `
            <div>Selected: <b>${data.region_face_count}</b> triangles</div>
            ${warningsHtml}
        `;
        renderConnectionsList(data.connections);

        const needsAttention = data.connections.some(c => c.needs_strut);
        window.setStatus(needsAttention
            ? 'Preview ready. Surfaces that aren\'t directly touching are connected automatically — '
              + 'set specific corners below if you want, or click "Unwrap" to continue.'
            : 'Preview ready. Click "Unwrap" when ready.');
    } catch (err) {
        window.setStatus(`Error: ${err.message}`);
        console.error(err);
    }
}

function renderConnectionsList(connections) {
    connectionsListEl.innerHTML = '';
    connections.forEach((c, i) => {
        if (!c.needs_strut) return; // a real touching connection needs no configuration
        const row = document.createElement('div');
        row.className = 'connection-row needs-attention';
        const manual = Object.prototype.hasOwnProperty.call(connectionOverrides, String(i));
        row.innerHTML = `<span>Connection ${i + 1}↔${i + 2}: `
            + `${manual ? 'corners set manually' : 'connected automatically'}</span>`;
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-fix';
        btn.textContent = manual ? 'Change Corners' : 'Set Corners';
        btn.addEventListener('click', () => enterConnectModeForConnection(i, c));
        row.appendChild(btn);
        connectionsListEl.appendChild(row);
    });
}

// --- Corner connection picking ---

function toSceneVec(pt) {
    // pt = [vertexIndex, x, y, z, ...] in the STL's original (uncentered)
    // coordinate frame — offset it the same way loadSTL() centered the
    // displayed mesh geometry, or markers won't line up with the mesh.
    return new THREE.Vector3(pt[1], pt[2], pt[3]).sub(meshCenterOffset);
}

function clearConnectMarkers() {
    if (connectMarkerGroup) {
        scene.remove(connectMarkerGroup);
        connectMarkerGroup.traverse(o => { if (o.material) o.material.dispose(); });
        if (connectMarkerGroup.children.length > 0) {
            connectMarkerGroup.children[0].geometry.dispose();
        }
        connectMarkerGroup = null;
    }
    if (connectLineGroup) {
        scene.remove(connectLineGroup);
        connectLineGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        connectLineGroup = null;
    }
    connectPicks = [];
}

function buildConnectMarkers(loopA, loopB) {
    connectMarkerGroup = new THREE.Group();
    const geo = new THREE.SphereGeometry(meshSize * 0.006, 12, 12);
    const addSide = (loopData, side) => {
        for (const pt of loopData) {
            const groupId = pt[4];
            const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: paletteColor(groupId) }));
            m.position.copy(toSceneVec(pt));
            m.userData = { side, vertexIndex: pt[0] };
            connectMarkerGroup.add(m);
        }
    };
    addSide(loopA, 1);
    addSide(loopB, 2);
    scene.add(connectMarkerGroup);
    connectLineGroup = new THREE.Group();
    scene.add(connectLineGroup);
}

function exitConnectMode() {
    connectModeActive = false;
    activeConnectionIndex = -1;
    clearConnectMarkers();
    btnCancelConnect.classList.add('hidden');
    connectInstructions.classList.add('hidden');
    btnPreviewStl.disabled = clickedFaces.length === 0;
    btnUnrollStl.disabled = !lastOutline;
}

function enterConnectModeForConnection(i, connectionData) {
    connectModeActive = true;
    activeConnectionIndex = i;
    connectPicks = [];
    buildConnectMarkers(connectionData.loop_a, connectionData.loop_b);
    btnCancelConnect.classList.remove('hidden');
    connectInstructions.classList.remove('hidden');
    btnPreviewStl.disabled = true;
    btnUnrollStl.disabled = true;
    window.setStatus(`Setting corners for connection ${i + 1}↔${i + 2} — pick your first pair of matching corners (see instructions above).`);
}

btnCancelConnect.addEventListener('click', () => {
    exitConnectMode();
    window.setStatus('Click "Unwrap" when ready, or set another connection\'s corners above.');
});

canvas3d.addEventListener('click', (e) => {
    if (!connectModeActive || !connectMarkerGroup) return;
    const rect = canvas3d.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(connectMarkerGroup.children);
    if (hits.length === 0) return;

    const marker = hits[0].object;
    const side = marker.userData.side;
    const expectedSide = connectPicks.length % 2 === 0 ? 1 : 2;
    if (side !== expectedSide) {
        window.setStatus(`Click a corner on the ${expectedSide === 1 ? 'left' : 'right'} surface next.`);
        return;
    }

    marker.material.color.set(0x33ff33);
    connectPicks.push({ side, vertexIndex: marker.userData.vertexIndex, pos: marker.position.clone() });

    if (connectPicks.length % 2 === 0) {
        const a = connectPicks[connectPicks.length - 2].pos;
        const b = connectPicks[connectPicks.length - 1].pos;
        const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b]);
        const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x33ff33 }));
        connectLineGroup.add(line);
    }

    if (connectPicks.length === 4) {
        submitManualConnect();
    } else if (connectPicks.length % 2 === 1) {
        window.setStatus(`Now click the matching corner on the ${side === 1 ? 'right' : 'left'} surface.`);
    } else {
        window.setStatus('First connection point set. Click a corner on the left surface for the second connection point.');
    }
});

async function submitManualConnect() {
    const bySide = { 1: [], 2: [] };
    for (const p of connectPicks) bySide[p.side].push(p.vertexIndex);
    connectionOverrides[String(activeConnectionIndex)] = [
        [bySide[1][0], bySide[2][0]],
        [bySide[1][1], bySide[2][1]],
    ];
    exitConnectMode();
    await computeChain();
}

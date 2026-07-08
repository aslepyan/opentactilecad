// STL 3D face-selection viewer. Loaded as an ES module (modern three.js is
// modules-only) alongside the classic-script app.js. Talks to app.js only
// through a small window-level interface:
//   - calls window.__stlHandoff(outline) when the user confirms an unroll
//   - reuses window.ensureServerAwake() / window.setStatus() / window.API_URL,
//     which app.js exposes (function declarations attach to window
//     automatically; API_URL is explicitly assigned since `const` doesn't).
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas2d = document.getElementById('canvas');
const canvas3d = document.getElementById('canvas3d');
const stlPanel = document.getElementById('stl-panel');
const stlStatsEl = document.getElementById('stl-stats');
const btnImportStl = document.getElementById('btn-import-stl');
const stlFileInput = document.getElementById('stl-file-input');
const btnUnrollStl = document.getElementById('btn-unroll-stl');
const btnCancelStl = document.getElementById('btn-cancel-stl');

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

let mesh = null;
let currentFile = null;
let selectedFaces = new Set();
let lastOutline = null;
let active = false;

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
    selectedFaces = new Set();
    lastOutline = null;
    btnUnrollStl.disabled = true;
    stlStatsEl.innerHTML = '';
    // btnDrawFill's correct disabled state depends on outline.length/drawMode
    // (app.js state this module doesn't track) — let app.js recompute it
    // rather than assume "enabled" is always right.
    window.updateUI();
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

    // geometry.center() translates in place without remembering the offset —
    // capture it ourselves so click points can be converted back to the
    // STL's own original coordinate frame (what the backend expects, since
    // it independently re-loads the raw uploaded file).
    geometry.computeBoundingBox();
    const centerOffset = geometry.boundingBox.getCenter(new THREE.Vector3());
    geometry.translate(-centerOffset.x, -centerOffset.y, -centerOffset.z);
    geometry.userData.centerOffset = centerOffset;

    const baseColors = new Float32Array(geometry.attributes.position.count * 3);
    baseColors.fill(0.75);
    geometry.setAttribute('color', new THREE.BufferAttribute(baseColors, 3));

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    camera.position.copy(center).add(new THREE.Vector3(size, size * 0.6, size));
    camera.near = size / 100;
    camera.far = size * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();

    selectedFaces = new Set();
    lastOutline = null;
    btnUnrollStl.disabled = true;
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

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas3d.addEventListener('dblclick', async (e) => {
    if (!mesh || !currentFile) return;
    const rect = canvas3d.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(mesh);
    if (hits.length === 0) return;

    const hit = hits[0];
    const offset = mesh.geometry.userData.centerOffset || new THREE.Vector3();
    const p = hit.point.clone().add(offset);

    const extending = e.shiftKey && selectedFaces.size > 0;
    if (!extending) {
        selectedFaces = new Set();
        resetColors();
    }
    recolorFaces([hit.faceIndex], new THREE.Color(1, 0.3, 0.2));

    window.setStatus(extending ? 'Extending selection across fold...' : 'Unrolling selection...', true);
    await window.ensureServerAwake();
    window.setStatus(extending ? 'Extending selection across fold...' : 'Unrolling selection...', true);

    try {
        const formData = new FormData();
        formData.append('file', currentFile);
        formData.append('click_x', p.x);
        formData.append('click_y', p.y);
        formData.append('click_z', p.z);
        formData.append('existing_faces', extending ? Array.from(selectedFaces).join(',') : '');

        const resp = await fetch(`${window.API_URL}/unroll-mesh`, { method: 'POST', body: formData });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();

        selectedFaces = new Set(data.region_face_indices);
        resetColors();
        recolorFaces(data.region_face_indices, new THREE.Color(0.2, 0.8, 1));
        lastOutline = data.outline;
        btnUnrollStl.disabled = false;

        const disagreementClass = data.developability_disagreement_mm < 0.5 ? 'ok' : 'warn';
        const warningsHtml = data.warnings.length
            ? `<div class="warn">${data.warnings.join('<br>')}</div>` : '';
        stlStatsEl.innerHTML = `
            <div>Selected: <b>${data.region_face_count}</b> triangles</div>
            <div>Disagreement: <span class="${disagreementClass}"><b>${data.developability_disagreement_mm.toFixed(3)} mm</b></span></div>
            ${warningsHtml}
        `;
        window.setStatus('Shift+double-click to fold across an edge, or click "Unroll Selection" when ready.');
    } catch (err) {
        // The clicked triangle was already painted red for instant feedback
        // before this request was sent — on failure, restore whatever was
        // actually selected before this click (nothing, if this was the
        // first click) instead of leaving that single triangle stuck red,
        // which looks like a real (but wrong) selection rather than a
        // failed request.
        resetColors();
        if (selectedFaces.size > 0) {
            recolorFaces(Array.from(selectedFaces), new THREE.Color(0.2, 0.8, 1));
        }
        window.setStatus(`Error: ${err.message}`);
        console.error(err);
    }
});

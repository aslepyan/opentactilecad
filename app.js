// ============================================================
// Configuration
// ============================================================
const API_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:8000"
    : "https://custom-pcb-dev.onrender.com";

// ============================================================
// Geometry helpers
// ============================================================
function signedArea(pts) {
    // Shoelace formula — positive = CCW, negative = CW
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    return area / 2;
}

function ensureCCW(pts) {
    if (signedArea(pts) < 0) {
        // CW — reverse but keep first vertex in place
        // Reverse all, then rotate so vertex 0 stays vertex 0
        const reversed = [pts[0], ...pts.slice(1).reverse()];
        return reversed;
    }
    return pts;
}

function rotateForCable(pts) {
    // Rotate outline so edge 1→2 is horizontal at the bottom.
    // Matches MATLAB rotateForCable() and Python rotate_for_cable().
    const p1 = pts[0], p2 = pts[1];
    const ex = p2[0] - p1[0], ey = p2[1] - p1[1];
    const ang = Math.atan2(ey, ex);
    const c = Math.cos(-ang), s = Math.sin(-ang);

    const midx = (p1[0] + p2[0]) / 2;
    const midy = (p1[1] + p2[1]) / 2;

    let rotated = pts.map(([x, y]) => {
        const dx = x - midx, dy = y - midy;
        return [c * dx - s * dy, s * dx + c * dy];
    });

    // Centroid should be above edge (Y > 0)
    const cx = rotated.reduce((s, p) => s + p[0], 0) / rotated.length;
    const cy = rotated.reduce((s, p) => s + p[1], 0) / rotated.length;
    if (cy < 0) {
        rotated = rotated.map(([x, y]) => [-x, -y]);
    }

    // Ensure p1 is left of p2
    if (rotated[0][0] > rotated[1][0]) {
        [rotated[0], rotated[1]] = [rotated[1], rotated[0]];
    }

    return rotated;
}

// ============================================================
// State
// ============================================================
let outline = [];          // Array of [x, y] in mm
let isDrawing = false;
let draggingIdx = -1;
let lastResult = null;     // Store ZIP for download

// Canvas state
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;

// ============================================================
// UI References
// ============================================================
const presetSelect = document.getElementById("preset-select");
const btnDraw = document.getElementById("btn-draw");
const btnClear = document.getElementById("btn-clear");
const btnGenerate = document.getElementById("btn-generate");
const btnDownload = document.getElementById("btn-download");
const statusText = document.getElementById("status-text");
const coordDisplay = document.getElementById("coord-display");
const vertexCount = document.getElementById("vertex-count");
const previewPanel = document.getElementById("preview-panel");
const svgContainer = document.getElementById("svg-container");
const statsGrid = document.getElementById("stats-grid");
const drcStatus = document.getElementById("drc-status");

// ============================================================
// Init
// ============================================================
function init() {
    // Populate presets
    for (const name in PRESETS) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        presetSelect.appendChild(opt);
    }

    presetSelect.addEventListener("change", loadPreset);
    btnDraw.addEventListener("click", toggleDraw);
    btnClear.addEventListener("click", clearOutline);
    btnGenerate.addEventListener("click", generate);
    btnDownload.addEventListener("click", downloadZip);

    canvas.addEventListener("click", onCanvasClick);
    canvas.addEventListener("mousemove", onCanvasMove);
    canvas.addEventListener("mousedown", onCanvasDown);
    canvas.addEventListener("mouseup", onCanvasUp);
    canvas.addEventListener("dblclick", onCanvasDblClick);

    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
}

function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    fitView();
    render();
}

// ============================================================
// View transform: mm -> canvas pixels
// ============================================================
function fitView() {
    if (outline.length < 2) {
        // Default view: -50 to 50 mm
        const span = 100;
        viewScale = Math.min(canvas.width, canvas.height) / span * 0.8;
        viewOffsetX = canvas.width / 2;
        viewOffsetY = canvas.height / 2;
        return;
    }
    const xs = outline.map(p => p[0]);
    const ys = outline.map(p => p[1]);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const w = xmax - xmin || 40;
    const h = ymax - ymin || 40;
    const margin = 1.3;
    viewScale = Math.min(canvas.width / (w * margin), canvas.height / (h * margin));
    viewOffsetX = canvas.width / 2 - ((xmin + xmax) / 2) * viewScale;
    viewOffsetY = canvas.height / 2 + ((ymin + ymax) / 2) * viewScale;  // Y-flip
}

function mmToCanvas(x, y) {
    return [x * viewScale + viewOffsetX, -y * viewScale + viewOffsetY];
}

function canvasToMm(cx, cy) {
    return [(cx - viewOffsetX) / viewScale, -(cy - viewOffsetY) / viewScale];
}

// ============================================================
// Rendering
// ============================================================
function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Grid
    drawGrid();

    // Outline polygon
    if (outline.length > 0) {
        ctx.beginPath();
        const [sx, sy] = mmToCanvas(outline[0][0], outline[0][1]);
        ctx.moveTo(sx, sy);
        for (let i = 1; i < outline.length; i++) {
            const [px, py] = mmToCanvas(outline[i][0], outline[i][1]);
            ctx.lineTo(px, py);
        }
        if (!isDrawing && outline.length > 2) {
            ctx.closePath();
            ctx.fillStyle = "rgba(0, 113, 227, 0.06)";
            ctx.fill();
        }
        ctx.strokeStyle = "#0071e3";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Vertices
        for (let i = 0; i < outline.length; i++) {
            const [vx, vy] = mmToCanvas(outline[i][0], outline[i][1]);
            ctx.beginPath();
            ctx.arc(vx, vy, 5, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 ? "#ff3b30" : "#0071e3";
            ctx.fill();
            ctx.strokeStyle = "white";
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // Edge 1 indicator (cable attach edge)
        if (outline.length >= 2 && !isDrawing) {
            const [ax, ay] = mmToCanvas(outline[0][0], outline[0][1]);
            const [bx, by] = mmToCanvas(outline[1][0], outline[1][1]);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.strokeStyle = "#ff9500";
            ctx.lineWidth = 3;
            ctx.stroke();
            // Label
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            ctx.font = "11px sans-serif";
            ctx.fillStyle = "#ff9500";
            ctx.fillText("cable edge", mx + 5, my - 5);
        }
    }

    // Instructions
    if (outline.length === 0 && !isDrawing) {
        ctx.font = "16px sans-serif";
        ctx.fillStyle = "#86868b";
        ctx.textAlign = "center";
        ctx.fillText("Select a preset or click 'Draw Outline' to start", canvas.width / 2, canvas.height / 2);
        ctx.textAlign = "start";
    }

    if (isDrawing) {
        ctx.font = "12px sans-serif";
        ctx.fillStyle = "#ff3b30";
        ctx.fillText("Click to place vertices. Double-click or click near first vertex to close.", 12, 20);
    }

    updateUI();
}

function drawGrid() {
    // Determine grid spacing in mm
    const pixelPerMm = viewScale;
    let gridMm = 1;
    if (pixelPerMm < 3) gridMm = 20;
    else if (pixelPerMm < 8) gridMm = 10;
    else if (pixelPerMm < 20) gridMm = 5;
    else if (pixelPerMm < 40) gridMm = 2;

    const [xminMm, yminMm] = canvasToMm(0, canvas.height);
    const [xmaxMm, ymaxMm] = canvasToMm(canvas.width, 0);

    ctx.beginPath();
    ctx.strokeStyle = "#e8e8ed";
    ctx.lineWidth = 0.5;

    const startX = Math.floor(xminMm / gridMm) * gridMm;
    const startY = Math.floor(yminMm / gridMm) * gridMm;

    for (let x = startX; x <= xmaxMm; x += gridMm) {
        const [cx] = mmToCanvas(x, 0);
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, canvas.height);
    }
    for (let y = startY; y <= ymaxMm; y += gridMm) {
        const [, cy] = mmToCanvas(0, y);
        ctx.moveTo(0, cy);
        ctx.lineTo(canvas.width, cy);
    }
    ctx.stroke();

    // Axes
    ctx.beginPath();
    ctx.strokeStyle = "#d2d2d7";
    ctx.lineWidth = 1;
    const [ox, oy] = mmToCanvas(0, 0);
    ctx.moveTo(ox, 0); ctx.lineTo(ox, canvas.height);
    ctx.moveTo(0, oy); ctx.lineTo(canvas.width, oy);
    ctx.stroke();
}

// ============================================================
// Drawing mode
// ============================================================
function toggleDraw() {
    isDrawing = !isDrawing;
    if (isDrawing) {
        outline = [];
        btnDraw.textContent = "Stop Drawing";
        btnDraw.classList.add("active");
        canvas.style.cursor = "crosshair";
        previewPanel.classList.add("hidden");
        lastResult = null;
    } else {
        if (outline.length >= 3) {
            finishDrawing();
            return;
        }
        btnDraw.textContent = "Draw Outline";
        btnDraw.classList.remove("active");
        canvas.style.cursor = "default";
    }
    render();
}

function onCanvasClick(e) {
    if (!isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [mx, my] = canvasToMm(cx, cy);

    // Snap to grid (1mm)
    const sx = Math.round(mx);
    const sy = Math.round(my);

    // Close polygon if clicking near first vertex
    if (outline.length >= 3) {
        const [fx, fy] = mmToCanvas(outline[0][0], outline[0][1]);
        if (Math.hypot(cx - fx, cy - fy) < 15) {
            finishDrawing();
            return;
        }
    }

    outline.push([sx, sy]);
    render();
}

function onCanvasDblClick(e) {
    if (!isDrawing) return;
    if (outline.length >= 3) {
        // Remove the extra vertex added by the click event
        // (dblclick fires two click events first)
        if (outline.length > 3) {
            outline.pop();
        }
        finishDrawing();
    }
}

function finishDrawing() {
    isDrawing = false;
    btnDraw.textContent = "Draw Outline";
    btnDraw.classList.remove("active");
    canvas.style.cursor = "default";
    // Ensure CCW winding, then rotate so cable edge is horizontal at bottom
    outline = ensureCCW(outline);
    outline = rotateForCable(outline);
    fitView();
    render();
}

function onCanvasMove(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [mx, my] = canvasToMm(cx, cy);
    coordDisplay.textContent = `${mx.toFixed(1)}, ${my.toFixed(1)} mm`;

    if (draggingIdx >= 0) {
        outline[draggingIdx] = [Math.round(mx), Math.round(my)];
        render();
    }
}

function onCanvasDown(e) {
    if (isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    for (let i = 0; i < outline.length; i++) {
        const [vx, vy] = mmToCanvas(outline[i][0], outline[i][1]);
        if (Math.hypot(cx - vx, cy - vy) < 10) {
            draggingIdx = i;
            canvas.style.cursor = "grabbing";
            e.preventDefault();
            return;
        }
    }
}

function onCanvasUp() {
    if (draggingIdx >= 0) {
        draggingIdx = -1;
        canvas.style.cursor = "default";
    }
}

// ============================================================
// Presets
// ============================================================
function loadPreset() {
    const name = presetSelect.value;
    if (!name || !PRESETS[name]) return;

    const preset = PRESETS[name];
    outline = preset.outline.map(p => [...p]);

    // Set default params first
    setParam("pixel_w_mm", 4.0);
    setParam("pixel_h_mm", 4.0);
    setParam("pitch_x_mm", 4.2);
    setParam("pitch_y_mm", 4.2);
    setParam("trace_w_mm", 0.2);
    setParam("gap_mm", 0.2);
    setParam("clearance_mm", 0.2);
    setParam("center_clear_mm", 0.2);
    setParam("edge_clear_mm", 0.1);
    setParam("edge_keepout_mm", 0.5);
    setParam("board_edge_clear_mm", 0.4);
    setParam("cable_length_mm", 4.0);
    setParam("via_drill_mm", 0.15);
    setParam("via_dia_mm", 0.35);
    setParam("pad_pitch_mm", 0.5);

    // Override with preset params
    for (const [key, val] of Object.entries(preset.params)) {
        setParam(key, val);
    }

    isDrawing = false;
    btnDraw.textContent = "Draw Outline";
    btnDraw.classList.remove("active");
    previewPanel.classList.add("hidden");
    lastResult = null;

    // Resize canvas first (preview panel was just hidden, giving more space)
    requestAnimationFrame(resizeCanvas);
}

function setParam(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function getParam(id) {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) : 0;
}

// Auto-link pixel size → pitch (maintain gap when pixel size changes)
// Snapshot the gap when user focuses the input, then apply it on each change.
(function() {
    let gapX = 0.2, gapY = 0.2;
    const wEl = document.getElementById("pixel_w_mm");
    const hEl = document.getElementById("pixel_h_mm");
    wEl.addEventListener("focus", () => { gapX = Math.max(getParam("pitch_x_mm") - getParam("pixel_w_mm"), 0.1); });
    wEl.addEventListener("input", () => { setParam("pitch_x_mm", +(getParam("pixel_w_mm") + gapX).toFixed(2)); });
    hEl.addEventListener("focus", () => { gapY = Math.max(getParam("pitch_y_mm") - getParam("pixel_h_mm"), 0.1); });
    hEl.addEventListener("input", () => { setParam("pitch_y_mm", +(getParam("pixel_h_mm") + gapY).toFixed(2));
    });
})();

function clearOutline() {
    outline = [];
    isDrawing = false;
    btnDraw.textContent = "Draw Outline";
    btnDraw.classList.remove("active");
    previewPanel.classList.add("hidden");
    lastResult = null;
    presetSelect.value = "";
    // Resize canvas first (preview panel was just hidden, giving more space)
    requestAnimationFrame(resizeCanvas);
}

// ============================================================
// UI state
// ============================================================
function updateUI() {
    vertexCount.textContent = `${outline.length} vertices`;
    btnGenerate.disabled = outline.length < 3 || isDrawing;
    btnDownload.classList.toggle("hidden", !lastResult);
}

function setStatus(msg, loading = false) {
    if (loading) {
        statusText.innerHTML = `<span class="spinner"></span>${msg}`;
    } else {
        statusText.textContent = msg;
    }
}

// ============================================================
// Generate
// ============================================================
async function generate() {
    if (outline.length < 3) return;

    const body = {
        outline: outline,
        pixel_w_mm: getParam("pixel_w_mm"),
        pixel_h_mm: getParam("pixel_h_mm"),
        pitch_x_mm: getParam("pitch_x_mm"),
        pitch_y_mm: getParam("pitch_y_mm"),
        edge_keepout_mm: getParam("edge_keepout_mm"),
        trace_w_mm: getParam("trace_w_mm"),
        gap_mm: getParam("gap_mm"),
        clearance_mm: getParam("clearance_mm"),
        center_clear_mm: getParam("center_clear_mm"),
        edge_clear_mm: getParam("edge_clear_mm"),
        via_drill_mm: getParam("via_drill_mm"),
        via_dia_mm: getParam("via_dia_mm"),
        pad_pitch_mm: getParam("pad_pitch_mm"),
        cable_length_mm: getParam("cable_length_mm"),
        board_edge_clear_mm: getParam("board_edge_clear_mm"),
    };

    btnGenerate.disabled = true;
    setStatus("Generating PCB...", true);
    previewPanel.classList.add("hidden");
    lastResult = null;

    // Wake up the server first (Render free tier spins down after 15min idle)
    try {
        await fetch(`${API_URL}/health`);
    } catch (e) {
        setStatus("Server is waking up — this may take up to 60s on first use...", true);
        // Keep trying health endpoint until server is ready
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
                const h = await fetch(`${API_URL}/health`);
                if (h.ok) break;
            } catch (e2) {}
        }
        setStatus("Generating PCB...", true);
    }

    try {
        const resp = await fetch(`${API_URL}/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }

        const data = await resp.json();
        lastResult = data.zip_b64;

        // Show preview
        svgContainer.innerHTML = data.svg;
        previewPanel.classList.remove("hidden");
        // Resize canvas to fit the reduced space
        requestAnimationFrame(resizeCanvas);

        // Stats
        const s = data.stats;
        statsGrid.innerHTML = `
            <dt>Active Pixels</dt><dd>${s.active_pixels}</dd>
            <dt>Removed</dt><dd>${s.removed_pixels}</dd>
            <dt>Col Routes</dt><dd>${s.col_routes}</dd>
            <dt>Row Routes</dt><dd>${s.row_routes}</dd>
            <dt>Connector</dt><dd>${s.connector_pos}-pos</dd>
            <dt>Total Pixels</dt><dd>${s.total_pixels}</dd>
        `;

        // DRC
        const d = data.drc;
        if (d.violations === 0) {
            drcStatus.className = "drc-status drc-pass";
            drcStatus.textContent = "DRC: PASS (0 violations)";
        } else {
            drcStatus.className = "drc-status drc-fail";
            drcStatus.textContent = `DRC: FAIL (${d.violations} violations)`;
        }

        setStatus(`Done! ${s.active_pixels} pixels, ${s.col_routes + s.row_routes} routes`);
    } catch (err) {
        setStatus(`Error: ${err.message}`);
        console.error(err);
    }

    btnGenerate.disabled = outline.length < 3;
    updateUI();
}

// ============================================================
// Download
// ============================================================
function downloadZip() {
    if (!lastResult) return;
    const bytes = atob(lastResult);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);

    const blob = new Blob([arr], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tactile_pcb.zip";
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================
// Pixel Preview
// ============================================================
function renderPixelPreview() {
    const container = document.getElementById("pixel-preview");
    const w = getParam("pixel_w_mm");
    const h = getParam("pixel_h_mm");
    const tw = getParam("trace_w_mm");
    const gp = getParam("gap_mm");
    const cc = getParam("center_clear_mm");
    const ec = getParam("edge_clear_mm");
    const vDrill = getParam("via_drill_mm");
    const vDia = getParam("via_dia_mm");

    // Boundaries
    const x1 = -w / 2, y1 = -h / 2, x2 = w / 2, y2 = h / 2;
    const ix1 = x1 + ec, iy1 = y1 + ec;
    const ix2 = x2 - ec, iy2 = y2 - ec;
    const innerW = ix2 - ix1;
    const innerH = iy2 - iy1;

    if (innerW <= tw || innerH <= tw) {
        container.innerHTML = '<div class="pixel-info">Invalid: edge clearance too large</div>';
        return;
    }

    const xL = ix1 + tw / 2;
    const xR = ix2 - tw / 2;
    const ymid = (iy1 + iy2) / 2;
    const pitch = tw + gp;
    const totalSlots = Math.max(1, Math.floor((innerH + gp) / pitch));
    const span = totalSlots * tw + (totalSlots - 1) * gp;
    const y0 = (iy1 + iy2 - span) / 2 + tw / 2;
    const spineYlo = iy1 + tw / 2;
    const spineYhi = iy2 - tw / 2;
    const xEndLeftMax = xR - (cc + tw);
    const xEndRightMin = xL + (cc + tw);
    const viaX = ix1 + vDia / 2;
    const viaY = ymid;

    // SVG setup — Y-flip: SVG y = svgTop + (y2 + labelSpace) - worldY
    const pad = Math.max(w, h) * 0.12;
    const labelSpace = 0.5;
    const svgX1 = x1 - pad;
    const svgY1 = 0;
    const svgW = w + 2 * pad;
    const svgH = h + 2 * pad + labelSpace;
    const fy = (v) => (pad + labelSpace) + (y2 - v);  // flip: world y2 → pad+labelSpace, world y1 → pad+labelSpace+h

    const col1 = "#2673d9";  // blue (pad 1)
    const col2 = "#d94026";  // red (pad 2)
    const strokeW = tw;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${svgX1.toFixed(3)} 0 ${svgW.toFixed(3)} ${svgH.toFixed(3)}">`;

    // Outer boundary
    svg += `<rect x="${x1}" y="${fy(y2)}" width="${w}" height="${h}" fill="none" stroke="#666" stroke-width="0.06"/>`;

    // Inner boundary
    svg += `<rect x="${ix1}" y="${fy(iy2)}" width="${innerW}" height="${innerH}" fill="none" stroke="#aaa" stroke-width="0.03" stroke-dasharray="0.1"/>`;

    // Left spine (pad 1)
    svg += `<line x1="${xL}" y1="${fy(spineYlo)}" x2="${xL}" y2="${fy(spineYhi)}" stroke="${col1}" stroke-width="${strokeW}" stroke-linecap="butt"/>`;

    // Right spine (pad 2)
    svg += `<line x1="${xR}" y1="${fy(spineYlo)}" x2="${xR}" y2="${fy(spineYhi)}" stroke="${col2}" stroke-width="${strokeW}" stroke-linecap="butt"/>`;

    // Fingers
    for (let i = 0; i < totalSlots; i++) {
        const yy = y0 + i * pitch;
        if (i % 2 === 0) {
            svg += `<line x1="${xL}" y1="${fy(yy)}" x2="${xEndLeftMax}" y2="${fy(yy)}" stroke="${col1}" stroke-width="${strokeW}" stroke-linecap="butt"/>`;
        } else {
            svg += `<line x1="${xR}" y1="${fy(yy)}" x2="${xEndRightMin}" y2="${fy(yy)}" stroke="${col2}" stroke-width="${strokeW}" stroke-linecap="butt"/>`;
        }
    }

    // Via annular ring
    svg += `<circle cx="${viaX}" cy="${fy(viaY)}" r="${vDia / 2}" fill="${col1}" fill-opacity="0.3" stroke="${col1}" stroke-width="0.02"/>`;
    // Drill hole
    svg += `<circle cx="${viaX}" cy="${fy(viaY)}" r="${vDrill / 2}" fill="white" stroke="#555" stroke-width="0.02"/>`;

    // Labels
    const labelY = fy(y2) - 0.15;
    svg += `<text x="${xL}" y="${labelY}" text-anchor="middle" font-size="0.35" fill="${col1}" font-weight="bold">Pad 1</text>`;
    svg += `<text x="${xR}" y="${labelY}" text-anchor="middle" font-size="0.35" fill="${col2}" font-weight="bold">Pad 2</text>`;

    svg += '</svg>';
    svg += `<div class="pixel-info">${w.toFixed(1)} x ${h.toFixed(1)} mm | ${totalSlots} fingers | t=${tw} g=${gp}</div>`;

    container.innerHTML = svg;
}

// Attach live update to all parameter inputs
document.querySelectorAll('.panel input[type="number"]').forEach(input => {
    input.addEventListener("input", renderPixelPreview);
});

// ============================================================
// Start
// ============================================================
init();
renderPixelPreview();

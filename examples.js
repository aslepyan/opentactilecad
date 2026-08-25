// Example design gallery: finished, ready-to-download designs a first-time
// visitor can open with one click. Each entry stores an (outline, params)
// config and regenerates through the normal /generate path on load — the same
// code path as a hand-drawn design — so examples never go stale against the
// pipeline and stay fully editable (taxel size, spacing, cable edge, edge
// cuts, connector) after loading.
//
// The two gripper outlines are real parts, unfolded at true scale with the
// STL import flow and captured here as plain 2D outlines: the soft-fingertip
// wrap comes from finger_tip_soft.stl (flat side + curved contact face + flat
// side, joined in the corner-picking flow) and the Yubi finger pad from the
// Yubi gripper's curved pad surface (screw holes ignored). The "facts" lines
// quote a verified local generate of the stored config (all DRC-clean).
import { showView } from "./views.js";
import { applyModeVisibility } from "./landing.js";

// Parameter values every example starts from (the app's own defaults), so a
// card always reproduces its advertised result no matter what was typed into
// the form earlier. Individual examples override just their grid size.
const BASELINE_PARAMS = {
  pixel_w_mm: 4.0, pixel_h_mm: 4.0, pitch_x_mm: 4.2, pitch_y_mm: 4.2,
  edge_keepout_mm: 0.5, trace_w_mm: 0.2, gap_mm: 0.2, clearance_mm: 0.2,
  board_edge_clear_mm: 0.2, edge_clear_mm: 0.1, center_clear_mm: 0.2,
  via_drill_mm: 0.15, via_dia_mm: 0.35, routing_margin_mm: 3.0,
  follow_main_padding_mm: 2.0, cable_length_mm: 12.0, tail_width_mm: null,
  tail_side_padding_mm: 0.0, connector_shoulder_fillet_mm: 1.0,
  board_mode: "expand", router: "hug",
};

const GRID_3MM = { pixel_w_mm: 3.0, pixel_h_mm: 3.0, pitch_x_mm: 3.2, pitch_y_mm: 3.2 };

export const EXAMPLES = [
  {
    id: "square",
    title: "Square patch",
    blurb: "The simplest sensor: a 40 × 40 mm square that senses pressure at 81 spots. The best first look at what this tool makes.",
    facts: "81 sensing spots · 4 mm grid",
    outline: [[-20, -20], [20, -20], [20, 20], [-20, 20]],
    params: {},
  },
  {
    id: "rect",
    title: "Rectangle patch",
    blurb: "A 50 × 30 mm rectangle — a drop-in pressure pad for any flat surface, like a gripper's palm plate.",
    facts: "66 sensing spots · 4 mm grid",
    outline: [[-25, -15], [25, -15], [25, 15], [-25, 15]],
    params: {},
  },
  {
    id: "tee",
    title: "T-shape",
    blurb: "A narrow stem opening into a wide top. Shows how the wiring automatically squeezes through a tight section of the shape.",
    facts: "182 sensing spots · 3 mm grid",
    outline: [[-12, 0], [12, 0], [12, 34], [34, 34], [34, 52], [-34, 52], [-34, 34], [-12, 34]],
    params: GRID_3MM,
  },
  {
    id: "arch",
    title: "Arch",
    blurb: "An upside-down U that leaves a rectangular window open — for sensing around a bolt, a strap slot, or a display cutout.",
    facts: "144 sensing spots · 3 mm grid",
    outline: [[0, 0], [18, 0], [18, 25], [42, 25], [42, 0], [60, 0], [60, 40], [0, 40]],
    params: GRID_3MM,
  },
  {
    id: "fingertip-wrap",
    title: "Soft fingertip wrap",
    blurb: "A real robot part: the front face and both sides of a soft gripper fingertip, unfolded flat from its 3D model. Printed flexible, it wraps back around the fingertip so the robot can feel what it's holding.",
    facts: "64 sensing spots · 3 mm grid · from an STL",
    outline: [
      [-24.193, -11.859], [-16.470, -11.935], [-16.076, -11.499],
      [16.156, -8.934], [16.604, -9.315], [24.193, -8.317],
      [21.507, 11.935], [6.329, 10.264], [-7.515, 9.141], [-24.091, 8.501],
    ],
    params: GRID_3MM,
  },
  {
    id: "yubi-pad",
    title: "Yubi finger pad",
    blurb: "The curved fingertip pad of a Yubi robot gripper, unfolded flat from its 3D model at true scale — sensors cover the whole pad, ignoring its screw holes.",
    facts: "122 sensing spots · 3 mm grid · from an STL",
    outline: [
      [-3.247, -34.645], [13.979, -34.439], [14.854, -30.847],
      [14.636, -15.087], [14.060, 34.645], [-7.099, 34.403],
      [-12.381, 28.098], [-14.849, 25.675], [-14.605, 4.225],
    ],
    params: GRID_3MM,
  },
];

// Small SVG preview of an outline: same colors as the drawing canvas (blue
// shape, orange cable edge) so the gallery teaches the color language before
// the user ever reaches the tool.
function outlineThumbnail(outline) {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const w = maxx - minx, h = maxy - miny;
  const pad = Math.max(w, h) * 0.08;
  // mm is y-up, SVG is y-down: flip by mapping y -> maxy - y.
  const pts = outline.map(([x, y]) => `${(x - minx + pad).toFixed(2)},${(maxy - y + pad).toFixed(2)}`);
  const [a, b] = [outline[0], outline[1]];
  const strokeW = Math.max(w, h) / 90;
  return (
    `<svg viewBox="0 0 ${(w + 2 * pad).toFixed(2)} ${(h + 2 * pad).toFixed(2)}" ` +
    `preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
    `<polygon points="${pts.join(" ")}" fill="rgba(79,157,255,0.16)" ` +
    `stroke="#4f9dff" stroke-width="${strokeW}" stroke-linejoin="round"/>` +
    `<line x1="${(a[0] - minx + pad).toFixed(2)}" y1="${(maxy - a[1] + pad).toFixed(2)}" ` +
    `x2="${(b[0] - minx + pad).toFixed(2)}" y2="${(maxy - b[1] + pad).toFixed(2)}" ` +
    `stroke="#ffb84d" stroke-width="${strokeW * 2.4}" stroke-linecap="round"/>` +
    `</svg>`
  );
}

function loadExample(example) {
  applyModeVisibility("draw");
  showView("tool");
  window.dispatchEvent(new CustomEvent("otc:load-example", {
    detail: {
      label: example.title,
      outline: example.outline,
      params: { ...BASELINE_PARAMS, ...example.params },
    },
  }));
}

const galleryEl = document.getElementById("landing-examples");
if (galleryEl) {
  for (const example of EXAMPLES) {
    const card = document.createElement("article");
    card.className = "panel example-card";
    card.innerHTML =
      `<div class="example-card__thumb">${outlineThumbnail(example.outline)}</div>` +
      `<h2>${example.title}</h2>` +
      `<p>${example.blurb}</p>` +
      `<div class="example-card__foot">` +
      `<span class="example-card__facts">${example.facts}</span>` +
      `<button type="button" class="primary">Open this design</button>` +
      `</div>`;
    card.querySelector("button").addEventListener("click", () => loadExample(example));
    galleryEl.appendChild(card);
  }
}

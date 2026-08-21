// API base URL. Empty string = same-origin (the FastAPI backend serves this page,
// so /generate and /health are reachable at the same host). To point the UI at a
// remote backend (e.g. the Render deployment), set this to that origin, e.g.
//   export const API_BASE = "https://your-backend.onrender.com";
// GitHub Pages serves this frontend as static files, so there is no backend at
// the same origin — point it at the Render deployment. Set this back to "" to
// run against a local FastAPI instance (which serves this page itself).
export const API_BASE = "https://custom-pcb-dev.onrender.com";

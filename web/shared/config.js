/**
 * Where the API lives.
 *
 * The portal is served from two places and must work identically in both:
 *
 *   · GitHub Pages   https://joaocreste.github.io/enter-wealth-management/
 *                    static only — the API is the Worker on another origin
 *   · the Worker     wrangler dev, or the deployed Worker serving its own assets
 *                    same origin, so the API base is empty
 *
 * Resolved at runtime from the hostname rather than injected at build time, so
 * the committed file is the same file that runs in both places and nobody has to
 * remember to rebuild before deploying.
 */

/** Set by `npm run deploy:worker`; the placeholder is replaced with the real URL. */
const WORKER_API = 'https://enter-wealth-advisor.WORKERS_SUBDOMAIN.workers.dev';

const isStaticHost = /\.github\.io$/.test(location.hostname) || /\.pages\.dev$/.test(location.hostname);

export const API_BASE = isStaticHost ? WORKER_API : '';

/**
 * The site root, so links work whether the portal sits at `/` (the Worker) or at
 * `/enter-wealth-management/` (a GitHub Pages project site).
 */
export const SITE_BASE = (() => {
  const path = location.pathname;
  const marker = path.indexOf('/advisor/');
  const clientMarker = path.indexOf('/client/');
  if (marker >= 0) return path.slice(0, marker + 1);
  if (clientMarker >= 0) return path.slice(0, clientMarker + 1);
  return path.replace(/[^/]*$/, '');
})();

export const advisorUrl = () => `${SITE_BASE}advisor/`;
export const clientUrl = () => `${SITE_BASE}client/`;
export const loginUrl = () => SITE_BASE;

/** Absolute URL for an API artefact the browser opens directly (a PDF, an email). */
export const apiUrl = (path) => `${API_BASE}${path}`;

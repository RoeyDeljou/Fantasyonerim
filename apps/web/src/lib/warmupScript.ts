/**
 * The inline <head> half of the API warm-up (lib/warmup.ts): runs before any JS bundle has loaded. Not a client
 * module, so the root layout can inline it. Same base URL rule as lib/api.ts.
 */
const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
export const HEALTH_URL = `${API}/health`;
export const WARM_STAMP = '__fantWarmAt';

export const WARMUP_SCRIPT = `(function(){try{window.${WARM_STAMP}=Date.now();fetch(${JSON.stringify(HEALTH_URL)},{mode:'no-cors',cache:'no-store',credentials:'omit'}).catch(function(){});}catch(e){}})();`;

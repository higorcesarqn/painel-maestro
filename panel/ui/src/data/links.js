// Links to the trackers only (#9): a URL from the API becomes an href only when it is an https link of github.com,
// dev.azure.com or *.visualstudio.com, the same rule as the server's projection (trackerUrl in
// bin/flow-projection.js). Anything else (another host, http, javascript:, user:password@) gives null and the page
// shows no link. This is the only place where the page builds an href from data.
const TRACKER_HOST = /^(github\.com|dev\.azure\.com|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.visualstudio\.com)$/;

export function trackerHref(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !TRACKER_HOST.test(u.hostname)) return null;
  return u.href;
}

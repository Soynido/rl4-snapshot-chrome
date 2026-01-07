/**
 * Canonicalize an object by sorting keys recursively and excluding `checksum`.
 * @param {any} obj
 * @returns {any}
 */
function canonicalize(obj) {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((x) => canonicalize(x));
  }

  if (typeof obj === 'object') {
    const out = {};
    const keys = Object.keys(obj)
      .filter((k) => k !== 'checksum')
      .sort();
    for (const k of keys) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }

  return obj; // primitives
}

/**
 * Calculate SHA-256 checksum (hex) of a snapshot with canonicalization.
 * Steps:
 * 1) canonicalize (sorted keys, exclude `checksum`)
 * 2) JSON.stringify
 * 3) SHA-256 via Web Crypto API
 * 4) return hex string (64 chars)
 *
 * @param {any} snapshot
 * @returns {Promise<string>}
 */
async function calculateChecksum(snapshot) {
  const canonical = canonicalize(snapshot);
  const canonicalJson = JSON.stringify(canonical);

  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalJson);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// Expose globally for popup.html simple script loading (no bundler).
// eslint-disable-next-line no-undef
if (typeof window !== 'undefined') {
  window.canonicalize = canonicalize;
  window.calculateChecksum = calculateChecksum;
}



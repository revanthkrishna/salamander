// Phase 2A: URL & domain normalization utilities
//
// Rules per TECH_DESIGN.md §2.4 and REQUIREMENTS.md §6 edge cases 7, 14, 15, 16, 17:
//   1. Scheme: normalize to https://; http:// → https://
//   2. Hostname: lowercase
//   3. www prefix: strip www. (but NOT other subdomains)
//   4. Port: preserve non-standard ports; strip standard ports (80 for http, 443 for https)
//   5. Path: preserve case exactly as-is
//   6. Trailing slash: strip from path (but https://example.com/ → https://example.com)
//   7. Query params: strip entirely
//   8. Fragment: strip entirely
//
// Example: "http://www.figma.com/blog/How-We-Built-Figma?ref=twitter#intro"
//        → "https://figma.com/blog/How-We-Built-Figma"

/**
 * Returns true if the port is a standard/redundant port that should be stripped.
 * Standard ports: 80 (http) and 443 (https). Port 80 on https is also stripped.
 */
function isStandardPort(port: string, protocol: string): boolean {
  if (port === '') return true; // no port specified — nothing to strip
  const p = parseInt(port, 10);
  return p === 80 || p === 443;
}

/**
 * Normalise a full URL:
 * - scheme → https
 * - hostname → lowercase, www. stripped
 * - port → preserved when non-standard (not 80 or 443); stripped otherwise
 * - path → preserved as-is (case-sensitive), trailing slash stripped
 * - query params and fragment → removed
 *
 * Special case: file:// URLs — returns the path only (no host/port).
 */
export function normaliseUrl(url: string): string {
  const parsed = new URL(url);

  // file:// URLs have no meaningful host; return path as https URL would be nonsensical
  if (parsed.protocol === 'file:') {
    return parsed.pathname;
  }

  // Normalize hostname: lowercase, strip www.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('www.')) {
    hostname = hostname.slice(4);
  }

  // Preserve port only when it's non-standard
  const portSuffix = isStandardPort(parsed.port, parsed.protocol) ? '' : `:${parsed.port}`;

  // Preserve path case; strip trailing slash
  let path = parsed.pathname;
  if (path === '/') {
    path = ''; // root URL: omit the slash entirely
  } else if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  // No query, no fragment — just https + hostname + optional port + path
  return `https://${hostname}${portSuffix}${path}`;
}

/**
 * Normalise a host (with optional port) for use as a storage key:
 * - Strips www. prefix from the hostname part
 * - Lowercases
 * - Preserves non-standard ports (not 80 or 443); strips standard ports
 *
 * Input may be:
 *   - `location.hostname`  → never has a port (e.g. "localhost", "www.example.com")
 *   - `location.host`      → includes port when non-default (e.g. "localhost:3000")
 *   - A stored domain string (e.g. "localhost:3000", "figma.com")
 *
 * Examples:
 *   "www.figma.com"    → "figma.com"
 *   "app.example.com"  → "app.example.com"   (non-www subdomain preserved)
 *   "localhost:3000"   → "localhost:3000"     (non-standard port preserved)
 *   "example.com:80"   → "example.com"        (standard port stripped)
 *   "example.com:443"  → "example.com"        (standard port stripped)
 */
export function normaliseDomain(host: string): string {
  // Split off port if present
  const colonIndex = host.indexOf(':');
  let hostname: string;
  let port: string;
  if (colonIndex !== -1) {
    hostname = host.slice(0, colonIndex);
    port = host.slice(colonIndex + 1);
  } else {
    hostname = host;
    port = '';
  }

  // Lowercase
  hostname = hostname.toLowerCase();

  // Strip www. prefix only (not other subdomains)
  if (hostname.startsWith('www.')) {
    hostname = hostname.slice(4);
  }

  // Preserve port only when non-standard
  const portNum = port === '' ? NaN : parseInt(port, 10);
  const keepPort = port !== '' && portNum !== 80 && portNum !== 443;

  return keepPort ? `${hostname}:${port}` : hostname;
}

/**
 * Generate the export filename for a normalised domain.
 * Dots and colons are replaced with underscores (colons appear in "localhost:3000").
 *
 * Examples:
 *   "figma.com"      → "annotations-figma_com.yaml"
 *   "localhost:3000" → "annotations-localhost_3000.yaml"
 */
export function exportFilename(domain: string): string {
  return `annotations-${domain.replace(/[.:]/g, '_')}.yaml`;
}

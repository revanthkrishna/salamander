// Phase 2A: URL & domain normalization utilities
//
// Rules per TECH_DESIGN.md §2.4 and REQUIREMENTS.md §6 edge cases 7, 14, 15, 16, 17:
//   1. Scheme: normalize to https://; http:// → https://
//   2. Hostname: lowercase
//   3. www prefix: strip www. (but NOT other subdomains)
//   4. Port: strip
//   5. Path: preserve case exactly as-is
//   6. Trailing slash: strip from path (but https://example.com/ → https://example.com)
//   7. Query params: strip entirely
//   8. Fragment: strip entirely
//
// Example: "http://www.figma.com/blog/How-We-Built-Figma?ref=twitter#intro"
//        → "https://figma.com/blog/How-We-Built-Figma"

/**
 * Normalise a full URL:
 * - scheme → https
 * - hostname → lowercase, www. stripped, port stripped
 * - path → preserved as-is (case-sensitive), trailing slash stripped
 * - query params and fragment → removed
 */
export function normaliseUrl(url: string): string {
  const parsed = new URL(url);

  // Normalize hostname: lowercase, strip port (parsed.hostname excludes port), strip www.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('www.')) {
    hostname = hostname.slice(4);
  }

  // Preserve path case; strip trailing slash
  let path = parsed.pathname;
  if (path === '/') {
    path = ''; // root URL: omit the slash entirely
  } else if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  // No port, no query, no fragment — just https + hostname + path
  return `https://${hostname}${path}`;
}

/**
 * Normalise a domain/hostname for use as a storage key:
 * - Strips www. prefix
 * - Lowercases
 * - Strips port (e.g. ":8080")
 *
 * Examples:
 *   "www.figma.com"    → "figma.com"
 *   "app.example.com"  → "app.example.com"   (non-www subdomain preserved)
 *   "example.com:8080" → "example.com"
 */
export function normaliseDomain(hostname: string): string {
  // Strip port
  const colonIndex = hostname.indexOf(':');
  let host = colonIndex !== -1 ? hostname.slice(0, colonIndex) : hostname;

  // Lowercase
  host = host.toLowerCase();

  // Strip www. prefix only (not other subdomains)
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }

  return host;
}

/**
 * Generate the export filename for a normalised domain.
 * Dots are replaced with underscores.
 *
 * Example: "figma.com" → "annotations-figma_com.yaml"
 */
export function exportFilename(domain: string): string {
  return `annotations-${domain.replace(/\./g, '_')}.yaml`;
}

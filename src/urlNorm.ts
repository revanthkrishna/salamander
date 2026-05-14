// TODO: Implement in Phase 2 - Storage & Types Engineer
export function normaliseUrl(url: string): string { return url; }
export function normaliseDomain(hostname: string): string { return hostname; }
export function exportFilename(domain: string): string { return `annotations-${domain.replace(/\./g, '_')}.yaml`; }

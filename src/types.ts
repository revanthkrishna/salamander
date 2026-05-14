// TODO: Implement in Phase 2 - Storage & Types Engineer
export interface Annotation {
  pinNumber: number;
  note: string;
  fingerprint: Fingerprint;
  offset: { x: number; y: number };
  createdAt: string;
}

export interface Fingerprint {
  cssSelector: string;
  xpath: string;
  textSnippet: string;
  tagName: string;
}

export interface DomainMeta {
  nextPinNumber: number;
  importedFilename: string | null;
  wasImported: boolean;
  version: number;
}

export interface DomainData {
  meta: DomainMeta;
  pages: Record<string, Annotation[]>;
}

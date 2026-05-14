// TODO: Implement in Phase 2 - Storage & Types Engineer
import type { DomainData, Annotation } from './types';
export async function getDomainData(domain: string): Promise<DomainData | null> { return null; }
export async function saveDomainData(domain: string, data: DomainData): Promise<void> {}
export async function clearDomainData(domain: string): Promise<void> {}
export async function setTabActive(tabId: number): Promise<void> {}
export async function removeTabActive(tabId: number): Promise<void> {}
export async function isTabActive(tabId: number): Promise<boolean> { return false; }

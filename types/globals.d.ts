declare var FinancialStatementDownloader: any;

/**
 * The contract every provider must satisfy. content.js and core/ui.js call
 * these by name, so a provider missing one fails only at runtime, on the site,
 * unless its object literal is annotated `@type {FsdProvider}`.
 */
interface FsdProvider {
  id: string;
  label: string;
  /** Whether the provider claims the page the content script is running in. */
  isSupportedPage(): boolean;
  /** Element the launcher is inserted after; null falls back to a fixed button. */
  findMountPoint(): Element | null;
  renderControls(container: Element, state?: any): void;
  readOptions(container: Element): Promise<any>;
  discoverDocuments(options?: any, report?: any, controller?: any): Promise<any[]>;
  downloadDocument(document: any, report?: any, controller?: any): Promise<any>;
  loadState?(): Promise<any>;
  matches?(url: string): boolean;
  requiresDateRange?: boolean;
  docTypes?: Array<{ code: string; label: string }>;
  helpers?: Record<string, any>;
}

interface FsdBatchOptions {
  [key: string]: any;
  attempts?: number;
  checkDownloadHistory?: boolean;
  delayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  storage?: any;
}

interface FsdRunBatchInput {
  controller?: any;
  options?: FsdBatchOptions;
  provider?: any;
  report?: (...args: any[]) => void;
}

interface Error {
  sessionExpired?: boolean;
  status?: number;
  stopped?: boolean;
}

declare namespace browser.runtime {
  interface MessageSender {
    origin?: string;
  }
}

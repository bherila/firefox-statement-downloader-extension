declare var FinancialStatementDownloader: any;

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

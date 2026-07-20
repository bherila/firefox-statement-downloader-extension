(function initializeRuntime(root) {
  'use strict';

  const namespace = root.FinancialStatementDownloader || {};

  function sleep(ms) {
    return new Promise((resolve) => root.setTimeout(resolve, ms));
  }

  function pad2(number) {
    return String(number).padStart(2, '0');
  }

  function assertYear(year, label) {
    if (!Number.isInteger(year) || year < 1) {
      throw new RangeError(`${label} must be a positive integer`);
    }
  }

  function assertMonth(month, label) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new RangeError(`${label} must be an integer from 1 through 12`);
    }
  }

  function monthRange(startYear, startMonth, endYear, endMonth) {
    assertYear(startYear, 'startYear');
    assertMonth(startMonth, 'startMonth');
    assertYear(endYear, 'endYear');
    assertMonth(endMonth, 'endMonth');

    const startIndex = startYear * 12 + startMonth - 1;
    const endIndex = endYear * 12 + endMonth - 1;
    if (startIndex > endIndex) {
      throw new RangeError('start month must not be after end month');
    }

    const months = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      months.push({
        year: Math.floor(index / 12),
        month: (index % 12) + 1,
      });
    }
    return months;
  }

  async function withRetry(fn, options = {}, onRetry) {
    if (typeof fn !== 'function') {
      throw new TypeError('fn must be a function');
    }

    const attempts = options.attempts === undefined ? 4 : options.attempts;
    const baseDelayMs = options.baseDelayMs === undefined ? 3000 : options.baseDelayMs;
    const wait = options.sleep === undefined ? sleep : options.sleep;

    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError('attempts must be a positive integer');
    }
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
      throw new RangeError('baseDelayMs must be a non-negative number');
    }
    if (typeof wait !== 'function') {
      throw new TypeError('options.sleep must be a function');
    }
    if (onRetry !== undefined && typeof onRetry !== 'function') {
      throw new TypeError('onRetry must be a function');
    }

    for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
      try {
        return await fn();
      } catch (error) {
        if (attemptIndex === attempts - 1) {
          // Rethrow the original value so Error fields such as `status` are retained.
          throw error;
        }

        const normalDelay = baseDelayMs * Math.pow(2, attemptIndex);
        const delayMs = error && error.status === 429 ? normalDelay * 4 : normalDelay;
        const retryNumber = attemptIndex + 1;
        const maxRetries = attempts - 1;

        if (onRetry) {
          await onRetry(error, delayMs, retryNumber, maxRetries);
        }
        await wait(delayMs);
      }
    }

    // The loop always returns or throws. This guards against future loop changes.
    throw new Error('retry loop ended unexpectedly');
  }

  function requiredString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`${field} must be a non-empty string`);
    }
    return value.trim();
  }

  function normalizeDocument(provider, raw) {
    const normalizedProvider = requiredString(provider, 'provider');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('raw document must be an object');
    }

    const document = {
      provider: normalizedProvider,
      id: requiredString(raw.id, 'id'),
      title: requiredString(raw.title, 'title'),
      category: requiredString(raw.category, 'category'),
      filename: requiredString(raw.filename, 'filename'),
    };

    if (raw.date !== undefined && raw.date !== null) {
      document.date = raw.date;
    }
    if (raw.account !== undefined && raw.account !== null) {
      document.account = raw.account;
    }
    if (raw.metadata !== undefined && raw.metadata !== null) {
      if (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
        throw new TypeError('metadata must be an object when provided');
      }
      document.metadata = { ...raw.metadata };
    }

    return document;
  }

  Object.assign(namespace, {
    sleep,
    pad2,
    monthRange,
    withRetry,
    normalizeDocument,
  });
  root.FinancialStatementDownloader = namespace;
})(globalThis);

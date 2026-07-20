(function initializeStorage(root) {
  'use strict';

  const namespace = root.FinancialStatementDownloader || {};
  const STORAGE_PREFIX = 'fsd';
  const BUCKETS = new Set(['settings', 'state', 'template', 'done']);

  function requireProviderId(providerId) {
    if (typeof providerId !== 'string' || providerId.trim() === '') {
      throw new TypeError('providerId must be a non-empty string');
    }
    return providerId.trim();
  }

  function storageArea() {
    if (!root.browser || !root.browser.storage || !root.browser.storage.local) {
      throw new Error('browser.storage.local is unavailable');
    }
    return root.browser.storage.local;
  }

  function keyFor(providerId, bucket) {
    if (!BUCKETS.has(bucket)) {
      throw new RangeError(`unknown provider storage bucket: ${bucket}`);
    }
    return `${STORAGE_PREFIX}:${requireProviderId(providerId)}:${bucket}`;
  }

  function documentId(documentOrId) {
    const value = typeof documentOrId === 'object' && documentOrId !== null
      ? documentOrId.id
      : documentOrId;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError('document id must be a non-empty string');
    }
    return value.trim();
  }

  function createProviderStorage(providerId) {
    const id = requireProviderId(providerId);

    async function load(bucket, fallback = null) {
      const key = keyFor(id, bucket);
      const stored = await storageArea().get(key);
      return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : fallback;
    }

    async function save(bucket, value) {
      const key = keyFor(id, bucket);
      await storageArea().set({ [key]: value });
      return value;
    }

    async function loadDoneObject() {
      const done = await load('done', {});
      return done && typeof done === 'object' && !Array.isArray(done) ? done : {};
    }

    return {
      providerId: id,
      loadSettings: () => load('settings'),
      saveSettings: (settings) => save('settings', settings),
      loadState: () => load('state'),
      saveState: (state) => save('state', state),
      loadTemplate: () => load('template'),
      saveTemplate: (template) => save('template', template),
      async loadDone() {
        return new Set(Object.keys(await loadDoneObject()));
      },
      async isDone(documentOrId) {
        const done = await loadDoneObject();
        return Object.prototype.hasOwnProperty.call(done, documentId(documentOrId));
      },
      async markDone(documentOrId) {
        const docId = documentId(documentOrId);
        const done = await loadDoneObject();
        done[docId] = true;
        await save('done', done);
      },
      async clearDone() {
        await save('done', {});
      },

      // Legacy keys were global (for example, `template` and `done`). A provider must
      // call this method explicitly, naming the buckets it owns. Nothing migrates merely
      // because a provider storage object was created.
      async migrateLegacy(buckets) {
        if (!Array.isArray(buckets) || buckets.some((bucket) => !BUCKETS.has(bucket))) {
          throw new TypeError('legacy migration buckets must be an array of known bucket names');
        }
        const uniqueBuckets = [...new Set(buckets)];
        if (uniqueBuckets.length === 0) {
          return [];
        }

        const legacy = await storageArea().get(uniqueBuckets);
        const migrated = [];
        for (const bucket of uniqueBuckets) {
          if (!Object.prototype.hasOwnProperty.call(legacy, bucket)) {
            continue;
          }
          const namespacedKey = keyFor(id, bucket);
          const existing = await storageArea().get(namespacedKey);
          if (Object.prototype.hasOwnProperty.call(existing, namespacedKey)) {
            continue;
          }
          await storageArea().set({ [namespacedKey]: legacy[bucket] });
          migrated.push(bucket);
        }
        return migrated;
      },
    };
  }

  namespace.createProviderStorage = createProviderStorage;
  namespace.storage = Object.assign(namespace.storage || {}, {
    keyFor,
    createProviderStorage,
  });
  root.FinancialStatementDownloader = namespace;
})(globalThis);

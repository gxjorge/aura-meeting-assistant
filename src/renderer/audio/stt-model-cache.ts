const DB_NAME = 'aura-stt-model-cache';
const DB_VERSION = 1;
const STORE_NAME = 'models';

interface CachedModelRecord {
  key: string;
  sourceUrl: string;
  blob: Blob;
  cachedAt: number;
}

const objectUrls = new Map<string, string>();

export function createSttModelCacheKey(modelUrl: string): string {
  return `stt-model:${modelUrl.trim()}`;
}

export function shouldCacheModelUrl(modelUrl: string): boolean {
  const trimmed = modelUrl.trim().toLowerCase();
  return trimmed.length > 0 && !trimmed.startsWith('blob:');
}

export function resolveSttModelSourceUrl(modelUrl: string, documentUrl: string): string {
  const trimmed = modelUrl.trim();
  if (!trimmed || trimmed.startsWith('blob:') || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    return trimmed;
  }

  const baseUrl = new URL(documentUrl);
  if (baseUrl.protocol === 'file:' && trimmed.startsWith('/')) {
    return new URL(`.${trimmed}`, baseUrl).toString();
  }

  return new URL(trimmed, baseUrl).toString();
}

export async function resolveCachedSttModelUrl(modelUrl: string): Promise<string> {
  const sourceUrl = resolveSttModelSourceUrl(modelUrl, globalThis.location.href);
  if (!shouldCacheModelUrl(sourceUrl) || !('indexedDB' in globalThis)) {
    return sourceUrl;
  }

  const key = createSttModelCacheKey(sourceUrl);
  const existingUrl = objectUrls.get(key);
  if (existingUrl) return existingUrl;

  const cached = await getCachedModel(key);
  if (cached) {
    const objectUrl = URL.createObjectURL(cached.blob);
    objectUrls.set(key, objectUrl);
    console.log('[STT cache] Reusing cached local speech model:', modelUrl);
    return objectUrl;
  }

  console.log('[STT cache] Downloading local speech model once:', sourceUrl);
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download speech model (${response.status})`);
  }

  const blob = await response.blob();
  await putCachedModel({
    key,
    sourceUrl,
    blob,
    cachedAt: Date.now(),
  });

  const objectUrl = URL.createObjectURL(blob);
  objectUrls.set(key, objectUrl);
  return objectUrl;
}

async function openDb(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Failed to open STT model cache'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
  });
}

async function getCachedModel(key: string): Promise<CachedModelRecord | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onerror = () => reject(request.error ?? new Error('Failed to read STT model cache'));
      request.onsuccess = () => resolve((request.result as CachedModelRecord | undefined) ?? null);
    });
  } finally {
    db.close();
  }
}

async function putCachedModel(record: CachedModelRecord): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.onerror = () => reject(transaction.error ?? new Error('Failed to write STT model cache'));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(STORE_NAME).put(record);
    });
  } finally {
    db.close();
  }
}

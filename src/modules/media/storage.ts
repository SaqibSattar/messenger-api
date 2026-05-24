import { createHmac, randomBytes } from 'node:crypto';
import { env } from '../../config/env';

/**
 * Storage provider abstraction.
 *
 * Two implementations live here:
 *
 *   - `memory`  — produces synthetic signed URLs backed by an HMAC token.
 *                 Used for dev and tests; no bytes are ever uploaded anywhere.
 *                 Verifying the signature requires the same signing secret,
 *                 so the URL cannot be forged by clients.
 *
 *   - `s3`      — placeholder that throws unless wired to the AWS SDK. We
 *                 expose the shape so production deployments can drop in the
 *                 SDK-backed implementation without touching the service
 *                 layer. Adding the SDK is a separate, scope-bounded change.
 *
 * The boundary is intentionally narrow: the service never sees URLs or
 * buckets, only the key it should hand to the provider. The provider owns
 * the URL format, signature, and expiry math.
 */

export interface UploadUrlSpec {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  expiresInSeconds: number;
}

export interface UploadUrlInstructions {
  url: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadUrlSpec {
  storageKey: string;
  expiresInSeconds: number;
}

export interface DownloadUrlInstructions {
  url: string;
  expiresAt: Date;
}

export interface GenerateStorageKeyParams {
  attachmentId: string;
  ownerId: string;
  extension: string;
}

export interface StorageProvider {
  readonly name: string;
  generateStorageKey(params: GenerateStorageKeyParams): string;
  createUploadUrl(spec: UploadUrlSpec): Promise<UploadUrlInstructions>;
  createDownloadUrl(spec: DownloadUrlSpec): Promise<DownloadUrlInstructions>;
  deleteObject(storageKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Restrict the extension to ASCII alphanumerics + a couple of safe punctuation
// chars. Anything weirder is dropped — extensions only exist so the storage
// key has a parseable suffix; the provider never trusts them for routing.
const sanitizeExtensionForKey = (extension: string): string => {
  const lower = extension.toLowerCase();
  if (!/^[a-z0-9]{1,16}$/.test(lower)) return 'bin';
  return lower;
};

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

// ---------------------------------------------------------------------------
// Memory provider (dev/test)
// ---------------------------------------------------------------------------

class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory';

  generateStorageKey(params: GenerateStorageKeyParams): string {
    const ext = sanitizeExtensionForKey(params.extension);
    // Per-attachment random nonce so two attachments with the same id (only
    // possible across providers) still produce different keys. ownerId is
    // included so post-mortem audit can scope by user without joining back
    // to Mongo.
    const nonce = randomBytes(12).toString('hex');
    return `attachments/${params.ownerId}/${params.attachmentId}/${nonce}.${ext}`;
  }

  async createUploadUrl(spec: UploadUrlSpec): Promise<UploadUrlInstructions> {
    const expiresAt = new Date(Date.now() + spec.expiresInSeconds * 1000);
    const expiresMs = expiresAt.getTime();
    // Tie the signature to the key + content-type + ceiling size + expiry.
    // A client that tampers with any of those fields invalidates the URL.
    const payload = [
      'PUT',
      spec.storageKey,
      spec.mimeType,
      spec.sizeBytes.toString(),
      expiresMs.toString()
    ].join('\n');
    const signature = sign(env.STORAGE_SIGNING_SECRET, payload);
    const baseUrl = env.STORAGE_PUBLIC_BASE_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/${encodeURI(spec.storageKey)}?expires=${expiresMs}&maxBytes=${spec.sizeBytes}&signature=${signature}`;
    return {
      url,
      method: 'PUT',
      headers: {
        'Content-Type': spec.mimeType
      },
      expiresAt
    };
  }

  async createDownloadUrl(
    spec: DownloadUrlSpec
  ): Promise<DownloadUrlInstructions> {
    const expiresAt = new Date(Date.now() + spec.expiresInSeconds * 1000);
    const expiresMs = expiresAt.getTime();
    const payload = ['GET', spec.storageKey, expiresMs.toString()].join('\n');
    const signature = sign(env.STORAGE_SIGNING_SECRET, payload);
    const baseUrl = env.STORAGE_PUBLIC_BASE_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/${encodeURI(spec.storageKey)}?expires=${expiresMs}&signature=${signature}`;
    return { url, expiresAt };
  }

  async deleteObject(_storageKey: string): Promise<void> {
    // No-op for the memory provider. Real providers must remove the object.
  }
}

// ---------------------------------------------------------------------------
// S3 provider (placeholder — wire to the SDK in deployment-specific code)
// ---------------------------------------------------------------------------

class UnconfiguredS3StorageProvider implements StorageProvider {
  readonly name = 's3';

  generateStorageKey(params: GenerateStorageKeyParams): string {
    const ext = sanitizeExtensionForKey(params.extension);
    const nonce = randomBytes(12).toString('hex');
    return `attachments/${params.ownerId}/${params.attachmentId}/${nonce}.${ext}`;
  }

  async createUploadUrl(): Promise<UploadUrlInstructions> {
    throw new Error(
      'STORAGE_PROVIDER=s3 selected but no S3 SDK is wired up — provide a real implementation before enabling in production'
    );
  }

  async createDownloadUrl(): Promise<DownloadUrlInstructions> {
    throw new Error(
      'STORAGE_PROVIDER=s3 selected but no S3 SDK is wired up — provide a real implementation before enabling in production'
    );
  }

  async deleteObject(): Promise<void> {
    throw new Error(
      'STORAGE_PROVIDER=s3 selected but no S3 SDK is wired up — provide a real implementation before enabling in production'
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: StorageProvider | null = null;

export const getStorageProvider = (): StorageProvider => {
  if (cached) return cached;
  cached = env.STORAGE_PROVIDER === 's3'
    ? new UnconfiguredS3StorageProvider()
    : new MemoryStorageProvider();
  return cached;
};

// Test/dev only: reset the cached provider so an override can take effect on
// the next call. Never exported into runtime code paths.
export const __resetStorageProviderForTests = (): void => {
  cached = null;
};

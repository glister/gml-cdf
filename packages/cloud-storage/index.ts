import type { Readable } from 'node:stream';
import { BlobSASPermissions, BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { parse, z } from '@repo/env';
import { createLogger, type Logger } from '@repo/logging';

/**
 * Azure Blob Storage client with stream support. Points at the Azurite emulator
 * locally via `AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true`, and a
 * real storage account in prod.
 */

const envSchema = z.object({
  AZURE_STORAGE_CONNECTION_STRING: z.string().min(1),
  AZURE_STORAGE_CONTAINER: z.string().min(1),
});

export interface CloudStorage {
  readonly container: ContainerClient;
  /** Create the container if it doesn't exist. */
  ensureContainer(): Promise<void>;
  uploadBuffer(blobName: string, data: Buffer, contentType?: string): Promise<string>;
  uploadStream(blobName: string, stream: Readable, contentType?: string): Promise<string>;
  /** Returns a readable stream of the blob's contents. */
  download(blobName: string): Promise<NodeJS.ReadableStream>;
  /** Time-limited read SAS URL. */
  generateSasUrl(blobName: string, expiresInSeconds: number): Promise<string>;
}

export interface CreateCloudStorageOptions {
  logger?: Logger;
}

export function createCloudStorage(options: CreateCloudStorageOptions = {}): CloudStorage {
  const env = parse(envSchema);
  const logger = options.logger ?? createLogger({ service: 'cloud-storage' });

  const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING);
  const container = service.getContainerClient(env.AZURE_STORAGE_CONTAINER);

  return {
    container,

    async ensureContainer() {
      await container.createIfNotExists();
    },

    async uploadBuffer(blobName, data, contentType) {
      const blob = container.getBlockBlobClient(blobName);
      await blob.uploadData(data, {
        blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
      });
      logger.debug('cloud-storage.uploaded', { blobName, bytes: data.length });
      return blob.url;
    },

    async uploadStream(blobName, stream, contentType) {
      const blob = container.getBlockBlobClient(blobName);
      await blob.uploadStream(stream, undefined, undefined, {
        blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
      });
      logger.debug('cloud-storage.uploaded-stream', { blobName });
      return blob.url;
    },

    async download(blobName) {
      const blob = container.getBlockBlobClient(blobName);
      const response = await blob.download();
      if (!response.readableStreamBody) {
        throw new Error(`Blob "${blobName}" has no readable body`);
      }
      return response.readableStreamBody;
    },

    async generateSasUrl(blobName, expiresInSeconds) {
      const blob = container.getBlockBlobClient(blobName);
      const expiresOn = new Date(Date.now() + expiresInSeconds * 1000);
      return blob.generateSasUrl({
        permissions: BlobSASPermissions.parse('r'),
        expiresOn,
      });
    },
  };
}

export { BlobServiceClient };

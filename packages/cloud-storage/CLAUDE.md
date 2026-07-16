# @repo/cloud-storage

Azure Blob Storage client with stream support. Built package (tsup → dist) with
`development` export condition. Deps: `@azure/storage-blob`, `@repo/env`,
`@repo/logging`, `zod`.

`createCloudStorage({ logger? })` reads `AZURE_STORAGE_CONNECTION_STRING` +
`AZURE_STORAGE_CONTAINER` via `@repo/env` `parse()` and returns a `CloudStorage`:
`ensureContainer()`, `uploadBuffer()`, `uploadStream()`, `download()` (returns a
readable stream), `generateSasUrl()`.

Locally points at Azurite (`UseDevelopmentStorage=true`); prod uses a real
storage account connection string.

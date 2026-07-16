# @repo/worker

Azure Service Bus consumer. Built with tsup (ESM, node24).

## Layout

- `src/index.ts` — boots the Service Bus client, `startHandlers`, and wires
  graceful SIGINT/SIGTERM shutdown. Boots on import unless `VITEST` is set.
- `src/registry.ts` — `startHandlers`/`stopHandlers`: opens a
  `ServiceBusReceiver` per queue/subscription. `handleMessage` completes on
  success, abandons on throw (exported for unit testing the ack/nack semantics).
- `src/types.ts` — `SubscriptionHandler`: return to complete, throw to abandon.
- `src/handlers/` — `index.ts` barrel of registrations + one file per handler
  (`hello-world` example).
- `scripts/publish.ts` — `pnpm --filter @repo/worker trigger` sends a test
  message to the `hello-world` queue.

Connection string comes from `SERVICE_BUS_CONNECTION_STRING` via `@repo/env`
(emulator locally, real namespace in prod). Log via `@repo/logging`.

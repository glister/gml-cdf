# @repo/service-bus

Azure Service Bus queue/topic/subscription helpers. Built package (tsup → dist)
with `development` export condition. Deps: `@azure/service-bus`, `@repo/logging`.

`createServiceBus({ connectionString, logger? })` → `ServiceBus` with:
`send(queueOrTopic, body, extra?)`, `sender()`, `receiver(queue)`,
`subscription(topic, sub)`, `close()`.

The connection string is passed IN by the caller (worker/api read it via
`@repo/env`) — this package never touches env, staying decoupled. Locally it's
the emulator's fixed dev string (`UseDevelopmentEmulator=true`); in prod a real
namespace string.

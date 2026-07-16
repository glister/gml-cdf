# @repo/sms

Twilio SMS — **stubbed**. Built package (tsup → dist) with `development` export
condition. Only dep: `@repo/logging`.

`createSmsClient({ logger? })` returns an `SmsClient` whose `send()` currently
logs instead of sending. Replace the stub body with the Twilio SDK when wiring
real delivery; keep the `SmsClient` interface stable so callers don't change.

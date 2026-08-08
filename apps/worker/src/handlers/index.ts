// Side-effect import: loading `@repo/trpc` registers the `tasks.*` (core plan
// 08 §9.6) and `approval.*` (core plan 09 §5.5) effect handlers, the pilot
// subject loaders and the pilot warning provider in `@repo/workflow`'s
// registries. Without it the effects consumer below would dead-letter every
// `tasks.raiseList` and `approval.open` message as an unknown effect — each
// registry is populated by its owning plan's module, and someone has to load
// them in this process. One import covers every engine, which is the point of
// registering through the package barrel.
import '@repo/trpc';
// Side-effect import: registers the **email** channel adapter (core plan 10
// §5.3). It cannot live beside the in-app adapter in `@repo/trpc`, because that
// package is imported by `apps/web` and a static `@repo/email` import would pull
// a mail transport into the browser bundle. This app owns concrete services, so
// it hands the adapter in — and the dispatcher never learns which process it is.
import './notification-email-channel.js';
// Side-effect import: registers the **Gotenberg renderer** and the **SharePoint
// document store** (core plan 11 §4.6). Same inversion, same reason: `@repo/trpc`
// is imported by `apps/web`, and a static `@repo/m365` import there would put a
// Graph SDK and its credential chain into the browser bundle. It also keeps
// ADR-0017's rule structural — Graph is reachable only from this process.
import './document-ports.js';
import type { HandlerRegistration } from '../types.js';
import { effectsHandler } from './effects.js';
import { helloWorldHandler } from './hello-world.js';
import { pilotDemoHandler } from './pilot-demo.js';
import { calendarOutlookSyncHandler } from './calendar-outlook-sync.js';

/** Barrel of all handler registrations. Add new handlers here. */
export const handlers: HandlerRegistration[] = [
  { queue: 'hello-world', handler: helloWorldHandler },
  // Pilot consumer of the domain-event journal relay (core plan 02 §5.2).
  { queue: 'domain-events', subscription: 'pilot-demo', handler: pilotDemoHandler },
  // Outlook calendar sync (core plan 12 §5.2). Subscribes to the journal relay
  // and resolves each event against the calendar-source registry, so the HR
  // plans bind leave to the same rail without touching this list.
  { queue: 'domain-events', subscription: 'calendar-sync', handler: calendarOutlookSyncHandler },
  // Scheduled identity sweeps — dispatched by message subject (core plan 03 §5.2).
  { queue: 'effects', handler: effectsHandler },
];

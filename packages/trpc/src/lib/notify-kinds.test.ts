import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  adminTestKind,
  defineNotificationKind,
  notificationKindRegistry,
  NotificationKindUnknownError,
  NotificationPayloadInvalidError,
  renderNotification,
  reminderChaseKind,
  requireNotificationKind,
  unregisterNotificationKindForTests,
} from './notify-kinds.js';

/**
 * Core plan 10 §10, "Kind registry" — the SA-023 guard.
 *
 * These are not tests of a lookup table. They are the tests that make the
 * content rule enforceable: a kind nobody registered cannot send, a payload
 * that does not fit a kind's schema cannot render, and a schema cannot be
 * registered permissive enough to let a profile row through.
 */

/** Register a throwaway kind and clean it up, so the shipped registry is untouched. */
function withKind<T>(kind: string, register: () => void, assert: () => T): T {
  try {
    register();
    return assert();
  } finally {
    unregisterNotificationKindForTests(kind);
  }
}

describe('defineNotificationKind — load-time rules', () => {
  it.each(['Task.Assigned', 'task assigned', 'task', '.task', 'task.', ''])(
    'rejects the malformed kind name %s',
    (kind) => {
      expect(() =>
        defineNotificationKind({
          kind,
          params: {},
          defaultChannels: ['in_app'],
          render: () => ({ title: 't', body: 'b', actionUrl: null }),
          description: 'd',
          registeredBy: 'test',
        }),
      ).toThrow(/invalid notification kind/);
    },
  );

  it('rejects a kind with no channels — a notification nobody can receive', () => {
    expect(() =>
      defineNotificationKind({
        kind: 'test.no_channels',
        params: {},
        defaultChannels: [],
        render: () => ({ title: 't', body: 'b', actionUrl: null }),
        description: 'd',
        registeredBy: 'test',
      }),
    ).toThrow(/no default channels/);
  });

  it('rejects a duplicate registration rather than letting import order decide', () => {
    withKind(
      'test.dupe',
      () =>
        defineNotificationKind({
          kind: 'test.dupe',
          params: {},
          defaultChannels: ['in_app'],
          render: () => ({ title: 't', body: 'b', actionUrl: null }),
          description: 'd',
          registeredBy: 'test',
        }),
      () => {
        expect(() =>
          defineNotificationKind({
            kind: 'test.dupe',
            params: {},
            defaultChannels: ['in_app'],
            render: () => ({ title: 'other', body: 'b', actionUrl: null }),
            description: 'd',
            registeredBy: 'test',
          }),
        ).toThrow(/duplicate notification kind/);
      },
    );
  });
});

describe('renderNotification — the gate every notification body passes', () => {
  it('refuses an unregistered kind', () => {
    expect(() => renderNotification('hr.absence.diagnosis_shared', {})).toThrow(
      NotificationKindUnknownError,
    );
  });

  it('refuses a payload with a key the kind never declared', () => {
    // The SA-023 mechanism in one assertion: a caller cannot smuggle a field
    // into a notification body by spreading a row into the payload, because the
    // registry builds every schema as `z.strictObject` and the extra key is
    // rejected before anything renders.
    expect(() =>
      renderNotification('admin.test', {
        note: 'hello',
        resolvedVia: 'role',
        medicalCondition: 'a diagnosis nobody should see',
      }),
    ).toThrow(NotificationPayloadInvalidError);
  });

  it('refuses a payload whose declared field is the wrong type', () => {
    expect(() => renderNotification('admin.test', { note: 42, resolvedVia: 'role' })).toThrow(
      NotificationPayloadInvalidError,
    );
  });

  it('refuses a nested object where a scalar was declared', () => {
    // A nested object is the shape a profile row arrives in.
    expect(() =>
      renderNotification('admin.test', { note: { text: 'x' }, resolvedVia: 'role' }),
    ).toThrow(NotificationPayloadInvalidError);
  });

  it('renders a valid payload to exactly the registry-permitted content', () => {
    const { rendered } = renderNotification('admin.test', { note: 'ping', resolvedVia: 'role' });
    expect(rendered.title).toBe('Test notification');
    expect(rendered.body).toContain('ping');
    expect(rendered.body).toContain('role');
    expect(rendered.actionUrl).toBe('/notifications');
  });

  it('renders a chase that names the class of item but not what it is about', () => {
    const { rendered } = renderNotification('reminder.chase', {
      sourceLabel: 'task',
      label: 'Upload your right-to-work document',
      occurrence: 3,
      dueDate: '2026-08-01',
      actionUrl: '/tasks/9d3',
    });
    expect(rendered.title).toBe('Still outstanding: task');
    expect(rendered.body).toContain('Upload your right-to-work document');
    expect(rendered.body).toContain('2026-08-01');
    expect(rendered.actionUrl).toBe('/tasks/9d3');
  });

  it('rejects an absolute action_url — an inbox row must not be a redirect target', () => {
    withKind(
      'test.absolute_link',
      () =>
        defineNotificationKind({
          kind: 'test.absolute_link',
          params: { to: z.string().max(300) },
          defaultChannels: ['in_app'],
          render: ({ to }) => ({ title: 't', body: 'b', actionUrl: to }),
          description: 'd',
          registeredBy: 'test',
        }),
      () => {
        expect(() =>
          renderNotification('test.absolute_link', { to: 'https://evil.example/steal' }),
        ).toThrow(/non-relative action_url/);
        // Protocol-relative is the case a naive startsWith('/') check waves through.
        expect(() => renderNotification('test.absolute_link', { to: '//evil.example' })).toThrow(
          /non-relative action_url/,
        );
        expect(() => renderNotification('test.absolute_link', { to: '/tasks/1' })).not.toThrow();
      },
    );
  });
});

describe('the shipped kinds', () => {
  it('registers exactly the two seed kinds core plan 10 owns', () => {
    expect([...notificationKindRegistry.keys()].sort()).toEqual(['admin.test', 'reminder.chase']);
  });

  // The SA-023 review gate, mechanised. Every shipped kind's schema is checked
  // for a field capable of carrying special-category detail — an unbounded
  // string, a free-text `detail`/`reason`/`note` on anything but the admin test,
  // or a non-scalar. A new kind that fails this has to argue its case in review.
  it.each([...notificationKindRegistry.values()])(
    'exposes no special-category-capable parameter: $kind',
    (def) => {
      for (const [field, schema] of Object.entries(def.payloadSchema.shape)) {
        // Scalars only: a nested object or array is how a profile row travels.
        const nested = schema.safeParse({ anything: 1 });
        expect(nested.success, `${def.kind}.${field} accepts an object`).toBe(false);

        // Strings must be bounded. An unbounded string is a place to paste a
        // fit note, and a bound is the cheapest structural discouragement there
        // is. 200 chars is a title; it is not a medical history.
        const long = schema.safeParse('x'.repeat(4000));
        expect(long.success, `${def.kind}.${field} accepts a 4000-character string`).toBe(false);
      }
    },
  );

  it('asks for in-app and email, and never for push while the channel is off', () => {
    // Push is designed and shipped disabled (ADR-0024). A kind defaulting to it
    // today would produce nothing but `suppressed` rows.
    for (const def of notificationKindRegistry.values()) {
      expect(def.defaultChannels).not.toContain('push');
      expect(def.defaultChannels).toContain('in_app');
    }
  });

  it('exposes the shipped definitions by name', () => {
    expect(requireNotificationKind('admin.test')).toBe(adminTestKind);
    expect(requireNotificationKind('reminder.chase')).toBe(reminderChaseKind);
  });
});

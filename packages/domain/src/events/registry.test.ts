import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from './define.js';
import { eventDefinition, eventTypes, isEventType } from './registry.js';

describe('event registry', () => {
  it('every registry key equals its definition type', () => {
    for (const [key, def] of Object.entries(eventTypes)) {
      expect(def.type).toBe(key);
    }
  });

  it('registers platform.demo.pinged at schema version 1', () => {
    const def = eventDefinition('platform.demo.pinged');
    expect(def?.schemaVersion).toBe(1);
    expect(isEventType('platform.demo.pinged')).toBe(true);
    expect(isEventType('platform.nope.happened')).toBe(false);
  });

  it('the demo payload rejects unknown keys (strict — the PII lint) and enforces bounds', () => {
    const def = eventDefinition('platform.demo.pinged');
    expect(def).toBeDefined();
    expect(def!.payloadSchema.safeParse({ note: 'ok' }).success).toBe(true);
    // An accidental profile-field spread is rejected.
    expect(def!.payloadSchema.safeParse({ note: 'ok', email: 'a@b.com' }).success).toBe(false);
    // The length cap holds.
    expect(def!.payloadSchema.safeParse({ note: 'x'.repeat(201) }).success).toBe(false);
  });

  it('registers every identity lifecycle event at schema version 1', () => {
    const identityEvents = Object.keys(eventTypes).filter((t) => t.startsWith('platform.person.'));
    // The full §4.3 set — a regression guard against dropping one.
    expect(identityEvents.length).toBe(16);
    for (const t of identityEvents) {
      expect(eventDefinition(t)?.schemaVersion).toBe(1);
    }
  });

  it('the merged payload accepts IDs/deltas and rejects a spread profile field (PII-minimal)', () => {
    const def = eventDefinition('platform.person.merged');
    expect(def).toBeDefined();
    const ok = {
      mergeId: '00000000-0000-7000-8000-000000000001',
      supersededPersonId: '00000000-0000-7000-8000-000000000002',
      movedUserIds: ['u1'],
      copiedFlagIds: [],
    };
    expect(def!.payloadSchema.safeParse(ok).success).toBe(true);
    // A name leaking into the payload is rejected structurally (ADR-0019).
    expect(def!.payloadSchema.safeParse({ ...ok, familyName: 'Smith' }).success).toBe(false);
  });

  it('the profile_status_changed payload requires from/to and a non-empty reason', () => {
    const def = eventDefinition('platform.person.profile_status_changed');
    expect(
      def!.payloadSchema.safeParse({
        from: 'draft_shell',
        to: 'information_requested',
        reason: 'intake',
      }).success,
    ).toBe(true);
    expect(
      def!.payloadSchema.safeParse({ from: 'draft_shell', to: 'information_requested', reason: '' })
        .success,
    ).toBe(false);
    // An unknown status literal is rejected by the enum.
    expect(def!.payloadSchema.safeParse({ from: 'nope', to: 'active', reason: 'x' }).success).toBe(
      false,
    );
  });
});

describe('defineEvent name and version validation', () => {
  it('accepts a namespaced past-tense dotted name', () => {
    expect(() => defineEvent('hr.leave_booking.approved', 1, z.strictObject({}))).not.toThrow();
  });

  it.each([
    'platform', // single segment
    'Platform.demo.pinged', // uppercase
    'platform..pinged', // empty segment
    'platform.demo.', // trailing dot
    '.platform.demo', // leading dot
    'platform.demo pinged', // space
    '1platform.demo.pinged', // leading digit
  ])('rejects malformed name %j', (name) => {
    expect(() => defineEvent(name, 1, z.strictObject({}))).toThrow(/invalid event type/i);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a non-positive-integer schema version %s', (v) => {
    expect(() => defineEvent('platform.demo.beeped', v, z.strictObject({}))).toThrow(
      /schemaVersion/,
    );
  });
});

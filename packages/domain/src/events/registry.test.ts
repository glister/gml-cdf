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
    // Core plan 03 §4.3, listed explicitly rather than matched by prefix: the
    // list catches a rename as well as a deletion, and core plan 04's
    // allocation events share the `platform.person.` namespace without being
    // part of this set.
    const identityEvents = [
      'platform.person.created',
      'platform.person.invited',
      'platform.person.credential_linked',
      'platform.person.signed_in',
      'platform.person.duplicate_flagged',
      'platform.person.duplicate_dismissed',
      'platform.person.merged',
      'platform.person.merge_reversed',
      'platform.person.flag_added',
      'platform.person.flag_ended',
      'platform.person.access_expiry_set',
      'platform.person.access_expired',
      'platform.person.reengaged',
      'platform.person.profile_status_changed',
      'platform.person.relationship_changed',
      'platform.person.precreation_check_overridden',
    ];
    expect(identityEvents).toHaveLength(16);
    for (const t of identityEvents) {
      expect(isEventType(t), `${t} is not registered`).toBe(true);
      expect(eventDefinition(t)?.schemaVersion).toBe(1);
    }
  });

  it('registers every authorisation event at schema version 1 (core plan 04 §4.2)', () => {
    const authzEvents = [
      'platform.role.granted',
      'platform.role.revoked',
      'platform.data.special_category.accessed',
      'platform.person.allocation_added',
      'platform.person.allocation_ended',
    ];
    for (const t of authzEvents) {
      expect(isEventType(t), `${t} is not registered`).toBe(true);
      expect(eventDefinition(t)?.schemaVersion).toBe(1);
    }
  });

  it('the special-category read payload carries field NAMES only (ADR-0015/0019)', () => {
    const def = eventDefinition('platform.data.special_category.accessed');
    expect(def).toBeDefined();
    const ok = {
      entity: 'platform.person_flag',
      fields: ['flag_type', 'reason'],
      readerPersonId: '00000000-0000-7000-8000-000000000001',
      procedure: 'platform.identity.getPerson',
    };
    expect(def!.payloadSchema.safeParse(ok).success).toBe(true);
    // A values map alongside the names is rejected structurally.
    expect(
      def!.payloadSchema.safeParse({ ...ok, values: { flag_type: 'safeguarding' } }).success,
    ).toBe(false);
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

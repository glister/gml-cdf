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

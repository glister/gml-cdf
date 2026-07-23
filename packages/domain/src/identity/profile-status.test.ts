import { describe, expect, it } from 'vitest';
import { allowedTransitions, canTransition, type ProfileStatus } from './profile-status.js';

const LEGAL: ReadonlyArray<[ProfileStatus, ProfileStatus]> = [
  ['draft_shell', 'information_requested'],
  ['information_requested', 'information_submitted'],
  ['information_submitted', 'pending_review'],
  ['pending_review', 'incomplete_rejected'],
  ['incomplete_rejected', 'information_requested'],
  ['pending_review', 'approved_not_active'],
  ['approved_not_active', 'active'],
  ['active', 'active_with_restrictions'],
  ['active_with_restrictions', 'active'],
  ['active', 'inactive'],
  ['active_with_restrictions', 'inactive'],
  ['active', 'leaver'],
  ['active_with_restrictions', 'leaver'],
  ['inactive', 'reactivated'],
  ['leaver', 'reactivated'],
  ['reactivated', 'active'],
];

describe('canTransition', () => {
  it.each(LEGAL)('permits the legal edge %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['draft_shell', 'leaver'],
    ['draft_shell', 'active'],
    ['information_requested', 'active'],
    ['active', 'reactivated'],
    ['leaver', 'active'],
    ['inactive', 'active'],
    ['pending_review', 'active'],
  ] as ReadonlyArray<[ProfileStatus, ProfileStatus]>)(
    'rejects the illegal edge %s → %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    },
  );

  it('rejects a self-loop (no-op transition)', () => {
    expect(canTransition('active', 'active')).toBe(false);
  });
});

describe('allowedTransitions', () => {
  it('lists the branch targets of pending_review', () => {
    expect([...allowedTransitions('pending_review')].sort()).toEqual([
      'approved_not_active',
      'incomplete_rejected',
    ]);
  });
});

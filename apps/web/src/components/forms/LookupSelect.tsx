import * as React from 'react';
import { trpcReact } from '~/trpc';
import { Select, type SelectProps } from './Select';
import type { LookupListType } from '~/lib/reference-data';

/**
 * The single dropdown primitive for Tier 1 reference data (core plan 05 §9.4,
 * PL-006). Every later form that needs a department, job role, sickness type,
 * PPE type, leaver reason, document category or equipment type uses this — that
 * is what "defined once, reused consistently" means in practice, and it is why
 * AC-D5 is demonstrable at all.
 *
 * Three things it deliberately does, so no caller has to think about them:
 *
 *  - **Only active values.** Retired values are hidden by the procedure, which
 *    is the whole mechanism behind PL-007's deactivate-don't-delete. A picker
 *    that offered one would undo it.
 *  - **Server order.** `sort_order` then label, as the administrator arranged
 *    them — never re-sorted here.
 *  - **Cached for five minutes.** Reference data changes a few times a year and
 *    is read on nearly every form; there is no server cache because at CDF's
 *    scale a seven-row list is cheaper to read than to invalidate correctly.
 *
 * When a value is added through the admin screen, the editor invalidates this
 * query, so the new value appears without a reload (AC-D1).
 */
export interface LookupSelectProps extends Omit<SelectProps, 'children'> {
  listType: LookupListType;
  /** Leading option shown when nothing is chosen. */
  placeholder?: string;
  /**
   * A value that is already on the record but has since been retired. Kept in
   * the list so editing an old record does not silently drop its value —
   * historical records must still display (PL-007).
   */
  retainedValue?: { id: string; label: string } | null;
}

export function LookupSelect({
  listType,
  placeholder = 'Choose an option',
  retainedValue = null,
  ...props
}: LookupSelectProps) {
  const options = trpcReact.platform.lookup.options.useQuery(
    { listType },
    { staleTime: 5 * 60 * 1000 },
  );

  const items = options.data ?? [];
  const showsRetained = retainedValue && !items.some((o) => o.id === retainedValue.id);

  return (
    <Select {...props} disabled={props.disabled ?? options.isLoading}>
      <option value="">{options.isLoading ? 'Loading…' : placeholder}</option>
      {showsRetained && (
        <option value={retainedValue.id}>{retainedValue.label} (no longer offered)</option>
      )}
      {items.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LookupSelect } from './LookupSelect.js';

/**
 * `LookupSelect` is the single dropdown primitive every later form reuses for
 * Tier 1 reference data (core plan 05 §10, PL-006), so a regression here is a
 * regression in every consuming form at once.
 *
 * The query is mocked rather than served: what is worth protecting is what this
 * component does with the rows — which is deliberately almost nothing. Order and
 * membership are the server's decision (ADR-0004), and the failure this guards
 * against is a future "helpful" sort or filter being added here.
 */

const useQuery = vi.fn();
vi.mock('~/trpc', () => ({
  trpcReact: { platform: { lookup: { options: { useQuery: () => useQuery() } } } },
}));

const OPTIONS = [
  // Deliberately NOT alphabetical: this is the order the administrator set via
  // sort_order, and it must survive untouched.
  { id: 'id-3', code: 'stress_anxiety', label: 'Stress / Anxiety', description: null },
  { id: 'id-1', code: 'cold_flu', label: 'Cold / Flu', description: null },
  { id: 'id-2', code: 'other', label: 'Other', description: null },
];

function optionLabels() {
  return screen.getAllByRole('option').map((o) => o.textContent);
}

describe('LookupSelect', () => {
  it('renders the server order verbatim, never re-sorted alphabetically', () => {
    useQuery.mockReturnValue({ data: OPTIONS, isLoading: false });
    render(<LookupSelect listType="sickness_type" aria-label="Sickness type" />);

    expect(optionLabels()).toEqual(['Choose an option', 'Stress / Anxiety', 'Cold / Flu', 'Other']);
  });

  it('shows a loading placeholder and stays disabled until the list arrives', () => {
    useQuery.mockReturnValue({ data: undefined, isLoading: true });
    render(<LookupSelect listType="department" aria-label="Department" />);

    expect(screen.getByRole('combobox', { name: 'Department' })).toBeDisabled();
    expect(optionLabels()).toEqual(['Loading…']);
  });

  it('keeps a retired value that is already on the record, marked as such', () => {
    // PL-007: deactivating hides a value from NEW entries, but editing an older
    // record must not silently drop the value it already holds.
    useQuery.mockReturnValue({ data: OPTIONS, isLoading: false });
    render(
      <LookupSelect
        listType="sickness_type"
        aria-label="Sickness type"
        retainedValue={{ id: 'id-retired', label: 'Legacy reason' }}
      />,
    );

    expect(optionLabels()).toContain('Legacy reason (no longer offered)');
  });

  it('does not duplicate a retained value that is still active', () => {
    useQuery.mockReturnValue({ data: OPTIONS, isLoading: false });
    render(
      <LookupSelect
        listType="sickness_type"
        aria-label="Sickness type"
        retainedValue={{ id: 'id-1', label: 'Cold / Flu' }}
      />,
    );

    expect(optionLabels().filter((l) => l?.startsWith('Cold / Flu'))).toEqual(['Cold / Flu']);
  });

  it('accepts a caller-supplied placeholder', () => {
    useQuery.mockReturnValue({ data: OPTIONS, isLoading: false });
    render(
      <LookupSelect listType="job_role" aria-label="Job role" placeholder="Select a job role" />,
    );

    expect(optionLabels()[0]).toBe('Select a job role');
  });
});

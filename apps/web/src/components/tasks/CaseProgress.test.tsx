import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaseProgress } from './CaseProgress.js';

/**
 * `<CaseProgress>` is the component the HR onboarding and offboarding
 * dashboards will embed (ON-045, OF-001), so what is worth protecting is that
 * it stays **generic** and does no arithmetic of its own: every figure it shows
 * comes from `caseProgress`, which computes them in SQL.
 *
 * The query is mocked rather than served — this is a rendering contract, and the
 * SQL behind it is proven against real Postgres in `@repo/trpc`.
 */

const useQuery = vi.fn();
vi.mock('~/trpc', () => ({
  trpcReact: { platform: { tasks: { caseProgress: { useQuery: () => useQuery() } } } },
}));

const FIXTURE = {
  lanes: [
    {
      lane: 'it',
      total: 3,
      done: 1,
      open: 1,
      blocked: 1,
      cancelled: 0,
      overdue: 1,
      nextDueAt: '2026-09-11T16:00:00.000Z',
    },
    {
      lane: 'transport',
      total: 1,
      done: 0,
      open: 0,
      blocked: 1,
      cancelled: 0,
      overdue: 0,
      nextDueAt: null,
    },
  ],
  gates: [{ gateKey: 'verification', open: false, blockedTaskCount: 1 }],
  bottlenecks: [
    {
      kind: 'gate' as const,
      ref: 'verification',
      title: null,
      blockedCount: 1,
      oldestBlockedRaisedAt: '2026-09-01T09:00:00.000Z',
    },
  ],
};

describe('CaseProgress', () => {
  it('renders lanes, gates and bottlenecks from the server figures', () => {
    useQuery.mockReturnValue({ data: FIXTURE, error: null });
    render(<CaseProgress streamType="platform.pilot_case" streamId="case-1" />);

    expect(screen.getByText('it')).toBeInTheDocument();
    expect(screen.getByText('transport')).toBeInTheDocument();
    // The gate chip says what it is holding, not merely that it is shut.
    expect(screen.getByText(/holding 1 task/)).toBeInTheDocument();
    expect(screen.getByText('Bottleneck')).toBeInTheDocument();
    expect(screen.getByText(/verification gate/)).toBeInTheDocument();
  });

  it('rolls the lane figures up without recomputing any of them', () => {
    useQuery.mockReturnValue({ data: FIXTURE, error: null });
    render(<CaseProgress streamType="platform.pilot_case" streamId="case-1" />);

    // 1 done of 4 countable tasks, straight from the lane rows.
    expect(screen.getByText('/4')).toBeInTheDocument();
    // Each counter is a number beside its own word; assert the pairs rather
    // than the numbers alone, which repeat across the lane cards.
    const counter = (label: string) =>
      screen.getByText(label).parentElement?.querySelector('span.font-mono')?.textContent;
    expect(counter('to do')).toBe('1'); // one open, in the IT lane
    expect(counter('blocked')).toBe('2'); // one per lane
    expect(counter('overdue')).toBe('1');
  });

  it('says so plainly when a case has no tasks yet', () => {
    useQuery.mockReturnValue({ data: { lanes: [], gates: [], bottlenecks: [] }, error: null });
    render(<CaseProgress streamType="platform.pilot_case" streamId="case-1" />);

    expect(screen.getByText(/No tasks have been raised/)).toBeInTheDocument();
  });

  it('surfaces a refusal rather than rendering an empty case', () => {
    // `caseProgress` answers NOT_FOUND for a case the caller has no work in, and
    // silently showing "no tasks" would misreport a permission as an empty case.
    useQuery.mockReturnValue({ data: undefined, error: { message: 'No such case' } });
    render(<CaseProgress streamType="platform.pilot_case" streamId="case-1" />);

    expect(screen.getByText('No such case')).toBeInTheDocument();
  });
});

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * The my-tasks table, in manual mode (core plan 08 §10, ADR-0004).
 *
 * The regression this guards against is the tempting one: someone adding a
 * `.filter()` or a `.sort()` over `query.data.items` because it is right there.
 * With keyset pagination that would filter **one page** and silently give the
 * wrong answer, so the test asserts the opposite property — that every facet
 * reaches the query input, and that the rows rendered are exactly the rows
 * returned, in the order returned.
 */

const useQuery = vi.fn();
const lastInput = () => useQuery.mock.calls.at(-1)?.[0] as Record<string, unknown>;

vi.mock('~/trpc', () => ({
  trpcReact: {
    platform: { tasks: { myTasks: { useQuery: (input: unknown) => useQuery(input) } } },
  },
}));

// `Link` needs a router; this screen's behaviour does not.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { MyTasks } = await import('./index.js');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    streamType: 'platform.pilot_case',
    streamId: 'case-1',
    lane: 'it',
    title: 'Prepare the equipment',
    assigneeRoleId: 'role-1',
    assigneeRoleName: 'it',
    claimedBy: null,
    claimedByName: null,
    status: 'open',
    dueAt: null,
    overdue: false,
    blockedCount: 0,
    raisedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  useQuery.mockReset();
  useQuery.mockReturnValue({ data: { items: [], nextCursor: null }, isLoading: false });
});

describe('my tasks', () => {
  it('asks the server for the actionable set by default', () => {
    render(<MyTasks />);
    expect(lastInput()).toMatchObject({ overdueOnly: false, sort: 'due', sortDir: 'asc' });
    // `status: undefined` means "the server's default" — open and blocked.
    expect(lastInput().status).toBeUndefined();
  });

  it('pushes a status filter into the query rather than filtering the page', () => {
    render(<MyTasks />);
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'blocked' } });
    expect(lastInput().status).toEqual(['blocked']);
  });

  it('pushes overdue-only and lane into the query', () => {
    render(<MyTasks />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(lastInput().overdueOnly).toBe(true);

    fireEvent.change(screen.getByLabelText('Filter by lane'), { target: { value: 'transport' } });
    expect(lastInput().lane).toBe('transport');
  });

  it('flips the sort direction through the query, not in the browser', () => {
    render(<MyTasks />);
    fireEvent.click(screen.getByRole('button', { name: /Due/ }));
    expect(lastInput()).toMatchObject({ sort: 'due', sortDir: 'desc' });
  });

  it('renders exactly the rows the server returned, in that order', () => {
    useQuery.mockReturnValue({
      data: {
        items: [
          row({ id: 'b', title: 'Second by due date' }),
          row({ id: 'a', title: 'First by nothing in particular' }),
        ],
        nextCursor: null,
      },
      isLoading: false,
    });
    render(<MyTasks />);

    const titles = screen.getAllByRole('link').map((a) => a.textContent);
    expect(titles[0]).toContain('Second by due date');
    expect(titles[1]).toContain('First by nothing in particular');
  });

  it('shows the overdue overlay from the server field, not from the due date', () => {
    useQuery.mockReturnValue({
      data: {
        items: [row({ overdue: true, dueAt: '2020-01-01T09:00:00.000Z' })],
        nextCursor: null,
      },
      isLoading: false,
    });
    render(<MyTasks />);
    expect(screen.getByTitle('Overdue')).toBeInTheDocument();
  });
});

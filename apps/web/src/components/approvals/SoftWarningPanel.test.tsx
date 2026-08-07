import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ApprovalWarning, WarningAck } from '@repo/trpc/schemas';
import { SoftWarningPanel } from './SoftWarningPanel';

/**
 * The soft-warning panel (core plan 09 §5.3, PL-017 / AC-D6).
 *
 * The regression this guards against is the plausible one: someone deciding
 * that an amber panel full of unacknowledged warnings ought to gate the Approve
 * button. PL-017, HL-038 and the design system's own note on `SoftWarningBlock`
 * all say the opposite, and the guarantee is easy to erode by accident —
 * "require acknowledgement before proceeding" reads like good practice until you
 * notice it turns an advisory into a block, which is what a workflow guard is
 * for.
 *
 * So the assertions are deliberately about **absence**: the panel exposes no
 * validity, and its acknowledgement state is a record rather than a gate.
 */

function warning(over: Partial<ApprovalWarning> = {}): ApprovalWarning {
  return {
    provider: 'pilot_spend',
    code: 'large_amount',
    severity: 'warning',
    message: 'This is a large amount.',
    ...over,
  };
}

describe('SoftWarningPanel', () => {
  it('renders nothing at all when there are no warnings', () => {
    const { container } = render(<SoftWarningPanel warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each warning’s message', () => {
    render(
      <SoftWarningPanel
        warnings={[warning(), warning({ code: 'other', message: 'Something else.' })]}
      />,
    );
    expect(screen.getByText('This is a large amount.')).toBeInTheDocument();
    expect(screen.getByText('Something else.')).toBeInTheDocument();
  });

  /**
   * The component's whole API surface for "may this be approved?" is: there
   * isn't one. It reports acknowledgements upward and nothing else, so a caller
   * *cannot* ask it whether to disable a button.
   */
  it('reports acknowledgements without reporting validity', () => {
    const onAcknowledgeChange = vi.fn<(next: WarningAck[]) => void>();
    render(
      <SoftWarningPanel
        warnings={[warning()]}
        acknowledged={[]}
        onAcknowledgeChange={onAcknowledgeChange}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onAcknowledgeChange).toHaveBeenCalledWith([
      { provider: 'pilot_spend', code: 'large_amount' },
    ]);
  });

  it('un-acknowledges on a second click', () => {
    const onAcknowledgeChange = vi.fn<(next: WarningAck[]) => void>();
    render(
      <SoftWarningPanel
        warnings={[warning()]}
        acknowledged={[{ provider: 'pilot_spend', code: 'large_amount' }]}
        onAcknowledgeChange={onAcknowledgeChange}
      />,
    );

    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onAcknowledgeChange).toHaveBeenCalledWith([]);
  });

  /**
   * Two warnings with the same code from different providers are different
   * warnings. Keying on the code alone would let one provider's acknowledgement
   * silently tick another's.
   */
  it('keeps warnings from different providers separate', () => {
    const onAcknowledgeChange = vi.fn<(next: WarningAck[]) => void>();
    render(
      <SoftWarningPanel
        warnings={[warning(), warning({ provider: 'team_capacity', message: 'Two are off.' })]}
        acknowledged={[{ provider: 'pilot_spend', code: 'large_amount' }]}
        onAcknowledgeChange={onAcknowledgeChange}
      />,
    );

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
  });

  /** Read-only for the requester's preview and for a request already decided. */
  it('renders without checkboxes when no handler is given', () => {
    render(<SoftWarningPanel warnings={[warning()]} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('This is a large amount.')).toBeInTheDocument();
  });

  /**
   * The footnote is the user-facing half of the guarantee. Someone rewording it
   * into "you must acknowledge these" would be describing behaviour the panel
   * does not have.
   */
  it('states that the advisories do not block approval', () => {
    render(<SoftWarningPanel warnings={[warning()]} />);
    expect(screen.getByText(/You can still approve/i)).toBeInTheDocument();
  });
});

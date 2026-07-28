import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './button.js';

describe('Button', () => {
  it('renders its children as an accessible button', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('applies the primary design-system classes by default', () => {
    render(<Button>Save</Button>);
    const cls = screen.getByRole('button', { name: 'Save' }).className;
    expect(cls).toContain('bg-brand');
    expect(cls).toContain('rounded-full');
  });

  it('applies the neutral variant and square shape', () => {
    render(
      <Button variant="neutral" shape="square">
        Cancel
      </Button>,
    );
    const cls = screen.getByRole('button', { name: 'Cancel' }).className;
    expect(cls).toContain('bg-surface-card');
    expect(cls).toContain('rounded-md');
  });

  it('renders a start icon alongside its label', () => {
    render(<Button startIcon={<svg data-testid="glyph" />}>With icon</Button>);
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'With icon' })).toBeInTheDocument();
  });
});

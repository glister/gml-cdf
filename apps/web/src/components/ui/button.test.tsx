import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './button.js';

describe('Button', () => {
  it('renders its children as an accessible button', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('applies the outline variant classes', () => {
    render(<Button variant="outline">Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('border');
  });
});

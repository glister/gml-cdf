import { describe, expect, it } from 'vitest';
import { createEmailClient, renderOtpEmail } from './index.js';

describe('renderOtpEmail', () => {
  it('renders the code into the HTML', async () => {
    const html = await renderOtpEmail('123456');
    expect(html).toContain('123456');
    expect(html).toContain('verification code');
  });
});

describe('createEmailClient', () => {
  it('constructs an SMTP transport when EMAIL_SMTP_HOST is set (.env.test)', () => {
    // Does not connect; just validates transport selection wiring.
    const client = createEmailClient();
    expect(typeof client.sendOtp).toBe('function');
    expect(typeof client.send).toBe('function');
  });
});

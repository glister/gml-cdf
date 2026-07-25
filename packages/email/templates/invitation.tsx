// Templates are consumed as source in dev (the `development` export condition),
// where the consuming app's tsx/esbuild applies its automatic JSX runtime only
// to files in the app's own tsconfig scope. These out-of-scope templates fall
// back to esbuild's default classic transform (`React.createElement`), so every
// template MUST import React to provide that binding — otherwise it throws
// "React is not defined" at runtime. Convention: React is the first import.
import React from 'react';
import type { CSSProperties } from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Section,
  Text,
} from '@react-email/components';

export interface InvitationEmailProps {
  /** The web sign-in URL (the invitee authenticates with an email OTP). */
  signInUrl: string;
}

/** Account invitation email (core plan 03, PL-036). No token — OTP is the factor. */
export function InvitationEmail({ signInUrl }: InvitationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>You&apos;ve been invited to CD Fencing</Heading>
          <Text style={paragraph}>
            An account has been created for you. Sign in with your email address — we&apos;ll send a
            one-time code to confirm it&apos;s you.
          </Text>
          <Section style={buttonBox}>
            <Button style={button} href={signInUrl}>
              Sign in
            </Button>
          </Section>
          <Text style={muted}>If you weren&apos;t expecting this, you can ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default InvitationEmail;

const main: CSSProperties = {
  backgroundColor: '#f4f4f5',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};
const container: CSSProperties = { margin: '0 auto', padding: '32px', maxWidth: '480px' };
const heading: CSSProperties = { fontSize: '20px', fontWeight: 600, color: '#18181b' };
const paragraph: CSSProperties = { fontSize: '14px', color: '#3f3f46' };
const buttonBox: CSSProperties = { margin: '24px 0', textAlign: 'center' };
const button: CSSProperties = {
  backgroundColor: '#18181b',
  color: '#ffffff',
  fontSize: '14px',
  fontWeight: 600,
  padding: '12px 24px',
  borderRadius: '8px',
  textDecoration: 'none',
};
const muted: CSSProperties = { fontSize: '12px', color: '#a1a1aa' };

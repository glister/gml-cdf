import type { CSSProperties } from 'react';
import { Body, Container, Head, Heading, Html, Section, Text } from '@react-email/components';

export interface OtpEmailProps {
  code: string;
  /** Minutes until the code expires (for display). */
  expiresInMinutes?: number;
}

/** One-time passcode email template. */
export function OtpEmail({ code, expiresInMinutes = 5 }: OtpEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>Your verification code</Heading>
          <Text style={paragraph}>
            Enter this code to sign in. It expires in {expiresInMinutes} minutes.
          </Text>
          <Section style={codeBox}>
            <Text style={codeText}>{code}</Text>
          </Section>
          <Text style={muted}>If you didn&apos;t request this, you can ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default OtpEmail;

const main: CSSProperties = {
  backgroundColor: '#f4f4f5',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};
const container: CSSProperties = {
  margin: '0 auto',
  padding: '32px',
  maxWidth: '480px',
};
const heading: CSSProperties = { fontSize: '20px', fontWeight: 600, color: '#18181b' };
const paragraph: CSSProperties = { fontSize: '14px', color: '#3f3f46' };
const codeBox: CSSProperties = {
  margin: '24px 0',
  padding: '16px',
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  textAlign: 'center',
};
const codeText: CSSProperties = {
  fontSize: '32px',
  fontWeight: 700,
  letterSpacing: '8px',
  color: '#18181b',
  margin: 0,
};
const muted: CSSProperties = { fontSize: '12px', color: '#a1a1aa' };

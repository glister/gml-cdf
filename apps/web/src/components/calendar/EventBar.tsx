import type { CalendarEvent } from '@repo/trpc';
import { cn } from '~/lib/utils';

/**
 * One colour-coded bar (core plan 12 §5.3; design system
 * `components/calendar/MonthCalendar`).
 *
 * **Colour is the type/team/kind; the treatment is the status.** Approved bars
 * are solid with a small dot; requested bars are outlined and lightly hatched.
 * That split is the design system's, and it is load-bearing for AC-D6: a
 * colour-blind reading of "is this booked or asked for?" has to work, so the
 * distinction is never carried by hue.
 *
 * The `background`/`borderColor` are inline because they are a **server-resolved
 * value** — the feed's one colour `CASE` (§6) decides them, so no class can
 * express them. Everything else — layout, hover, focus, truncation — is a class,
 * per `apps/web/CLAUDE.md`.
 */

export interface EventBarProps {
  event: CalendarEvent;
  /** Square off the left edge — the bar continues from the previous week. */
  continuesLeft?: boolean;
  continuesRight?: boolean;
  onClick?: () => void;
}

/** The bar's text. A restricted row shows the label the server injected — only. */
export function barLabel(event: CalendarEvent): string {
  if (event.personId === null) return event.label;
  const first = event.personLabel?.split(' ')[0] ?? '';
  const base = first || event.label;
  return event.dayPart ? `${base} · ½` : base;
}

export function EventBar({ event, continuesLeft, continuesRight, onClick }: EventBarProps) {
  const approved = event.status === 'approved';
  const label = barLabel(event);
  const title = `${event.label}${event.personLabel ? ` — ${event.personLabel}` : ''}${
    approved ? '' : ' (requested)'
  }`;

  const style = approved
    ? { background: event.colour, borderColor: event.colour, color: '#ffffff' }
    : {
        // Outlined + hatched: the colour stays the identity, the fill stays open.
        borderColor: event.colour,
        color: event.colour,
        backgroundImage: `repeating-linear-gradient(135deg, ${event.colour}1f 0 5px, transparent 5px 10px)`,
      };

  const className = cn(
    'flex h-5 w-full min-w-0 items-center gap-[5px] overflow-hidden truncate border px-[7px]',
    'text-left font-sans text-2xs font-semibold leading-none',
    'rounded-xs',
    continuesLeft && 'rounded-l-none',
    continuesRight && 'rounded-r-none',
    onClick ? 'cursor-pointer hover:brightness-95' : 'cursor-default',
  );

  const body = (
    <>
      {approved && (
        <span
          aria-hidden="true"
          className="size-[5px] shrink-0 rounded-full bg-current opacity-85"
        />
      )}
      <span className="truncate">{label}</span>
    </>
  );

  if (!onClick) {
    return (
      <span title={title} style={style} className={className}>
        {body}
      </span>
    );
  }

  return (
    <button type="button" title={title} style={style} className={className} onClick={onClick}>
      {body}
    </button>
  );
}

/** The square swatch used by the legend and the day list. */
export function ColourSwatch({ colour, className }: { colour: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ background: colour }}
      className={cn('size-[11px] shrink-0 rounded-[3px]', className)}
    />
  );
}

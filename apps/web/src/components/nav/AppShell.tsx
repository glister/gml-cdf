import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  ChevronDown,
  GitMerge,
  KeyRound,
  LayoutDashboard,
  Menu,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react';
import { cn } from '~/lib/utils';
import { ConnectLockup } from '~/components/auth/ConnectLockup';
import { Avatar } from '~/components/data-display/Avatar';
import { trpcReact } from '~/trpc';
import { holdsAnyRole } from '~/lib/authz';
import { NavSectionLabel } from './NavSectionLabel';

/* The authenticated application shell (CD Fencing Design System —
   components/navigation/AppShell), translated to Tailwind: a dark brand-green
   sidebar (Connect wordmark, grouped nav, pinned user), a sticky top bar and a
   scrollable content area. Responsive via CSS: full sidebar at `lg`, an
   off-canvas drawer below (toggle is interaction state, not layout detection —
   no matchMedia). Active nav state comes from the router's `data-status`. */

export interface AppShellUser {
  name: string;
  role?: string | null;
}

const navItemClass = cn(
  'group relative flex items-center gap-2.5 rounded-md px-3 py-2 font-sans text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]',
  "before:absolute before:left-0 before:top-1/2 before:hidden before:h-[18px] before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-green-400 before:content-['']",
  'data-[status=active]:bg-green-700 data-[status=active]:font-bold data-[status=active]:text-white data-[status=active]:before:block',
);

function NavItemInner({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <>
      <span className="inline-flex shrink-0 text-white/60 group-data-[status=active]:text-white">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {count != null && (
        <span className="ml-auto shrink-0 rounded-full bg-white/[0.14] px-1.5 text-center font-mono text-2xs font-semibold text-white">
          {count}
        </span>
      )}
    </>
  );
}

/**
 * The Access section, shown only to holders of the roles that can actually use
 * it (core plan 04 §9.4).
 *
 * **This is UX only** (ADR-0003). Hiding a link is a convenience, never the
 * control: every procedure behind these routes is a `roleProcedure`, and a
 * direct API call from someone without the grant is rejected regardless of what
 * the menu shows. `grants.mine` is a `protectedProcedure` precisely because
 * seeing your own grants is not privileged.
 */
function AccessNavSection() {
  const mine = trpcReact.platform.authz.grants.mine.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const canAdminister = holdsAnyRole(mine.data, ['administrator']);
  const canAllocate = holdsAnyRole(mine.data, ['administrator', 'hr_user']);
  if (!canAdminister && !canAllocate) return null;

  return (
    <>
      <NavSectionLabel>Access</NavSectionLabel>
      <div className="flex flex-col gap-0.5">
        {canAdminister && (
          <>
            <Link to="/admin/authz/grants" className={navItemClass}>
              <NavItemInner icon={<KeyRound size={20} strokeWidth={1.9} />} label="Role grants" />
            </Link>
            <Link to="/admin/authz/roles" className={navItemClass}>
              <NavItemInner icon={<ShieldCheck size={20} strokeWidth={1.9} />} label="Roles" />
            </Link>
          </>
        )}
        {canAllocate && (
          <Link to="/admin/authz/allocations" className={navItemClass}>
            <NavItemInner icon={<UserCog size={20} strokeWidth={1.9} />} label="Allocations" />
          </Link>
        )}
      </div>
    </>
  );
}

function Sidebar({ user }: { user: AppShellUser | null }) {
  return (
    <aside
      role="navigation"
      aria-label="Primary"
      className="flex h-full w-[260px] shrink-0 flex-col border-r border-white/[0.07] bg-[linear-gradient(180deg,var(--color-green-900)_0%,#072a15_100%)]"
    >
      <div className="flex h-16 shrink-0 items-center border-b border-white/[0.07] px-4">
        <ConnectLockup size="xs" tone="light" />
      </div>
      <nav className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-0.5">
          <Link to="/dashboard" className={navItemClass}>
            <NavItemInner
              icon={<LayoutDashboard size={20} strokeWidth={1.9} />}
              label="Dashboard"
            />
          </Link>
        </div>
        <NavSectionLabel>People</NavSectionLabel>
        <div className="flex flex-col gap-0.5">
          <Link to="/admin/people" activeOptions={{ exact: true }} className={navItemClass}>
            <NavItemInner icon={<Users size={20} strokeWidth={1.9} />} label="People" />
          </Link>
          <Link to="/admin/people/duplicates" className={navItemClass}>
            <NavItemInner icon={<GitMerge size={20} strokeWidth={1.9} />} label="Duplicates" />
          </Link>
        </div>
        <AccessNavSection />
      </nav>
      {user && (
        <div className="shrink-0 border-t border-white/[0.07] p-3">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <Avatar name={user.name} size="sm" className="bg-white/[0.16]! text-white!" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-sans text-sm font-semibold text-white">
                {user.name}
              </span>
              {user.role && (
                <span className="truncate font-sans text-2xs text-white/55">{user.role}</span>
              )}
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}

function TopBar({
  user,
  onSignOut,
  onMenu,
}: {
  user: AppShellUser | null;
  onSignOut?: () => void;
  onMenu: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex h-[60px] w-full items-center gap-3 border-b border-border-subtle bg-surface-card px-4">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open navigation menu"
        className="inline-flex size-10 items-center justify-center rounded-full text-body transition-colors hover:bg-gray-100 lg:hidden"
      >
        <Menu size={20} strokeWidth={2} />
      </button>
      <div className="flex-1" />
      {user && (
        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2.5 rounded-full py-1 pl-1.5 pr-2 transition-colors hover:bg-gray-100"
          >
            <Avatar name={user.name} size="sm" />
            <span className="hidden flex-col items-start leading-tight sm:flex">
              <span className="font-sans text-sm font-semibold text-strong">{user.name}</span>
              {user.role && <span className="font-sans text-2xs text-muted">{user.role}</span>}
            </span>
            <ChevronDown size={16} className="text-muted" />
          </button>
          {open && (
            <>
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className="fixed inset-0 z-40 cursor-default"
              />
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[200px] rounded-md border border-border-subtle bg-surface-card p-1.5 shadow-lg"
              >
                <div className="border-b border-border-subtle px-2.5 pb-2.5 pt-1.5">
                  <div className="font-sans text-sm font-semibold text-strong">{user.name}</div>
                  {user.role && (
                    <div className="mt-0.5 font-mono text-2xs text-muted">{user.role}</div>
                  )}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onSignOut?.();
                  }}
                  className="mt-1.5 block w-full rounded-sm px-2.5 py-2 text-left font-sans text-sm font-medium text-status-danger transition-colors hover:bg-status-danger-bg"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface AppShellProps {
  user?: AppShellUser | null;
  onSignOut?: () => void;
  children?: React.ReactNode;
}

export function AppShell({ user = null, onSignOut, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface-page font-sans">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar user={user} />
      </div>

      {/* Mobile off-canvas drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 cursor-default bg-[rgba(33,31,29,0.44)]"
          />
          <div className="absolute bottom-0 left-0 top-0 shadow-xl">
            <Sidebar user={user} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 shrink-0">
          <TopBar user={user} onSignOut={onSignOut} onMenu={() => setDrawerOpen(true)} />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-5 lg:px-8 lg:py-6">{children}</main>
      </div>
    </div>
  );
}

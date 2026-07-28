import { createFileRoute, Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { trpcReact } from '../../../../trpc.js';
import { PageHeader } from '../../../../components/nav/PageHeader.js';
import { StatusPill } from '../../../../components/data-display/StatusPill.js';
import { Button } from '../../../../components/ui/button.js';
import {
  MODULE_LABELS,
  MODULE_OPTIONS,
  ROLE_LABELS,
  type ModuleKey,
  type RoleKey,
} from '../../../../lib/authz.js';

export const Route = createFileRoute('/_authenticated/admin/authz/roles')({
  component: RolesScreen,
});

function RolesScreen() {
  const roles = trpcReact.platform.authz.roles.list.useQuery();
  const byModule = trpcReact.platform.authz.roles.byModule.useQuery();

  // Index the per-module holder counts for the matrix. Both the counts and the
  // grouping come from SQL — this is only a lookup for rendering.
  const counts = new Map<string, number>();
  for (const row of byModule.data ?? []) {
    counts.set(`${row.module}::${row.roleKey}`, Number(row.holders));
  }

  const isLoading = roles.isLoading || byModule.isLoading;
  const error = roles.error ?? byModule.error;

  return (
    <div className="mx-auto flex max-w-[1160px] flex-col gap-4">
      <PageHeader
        title="Roles"
        description="The standard role set, held as data. A role means nothing on its own — it applies only in the modules it has been granted in."
        primaryAction={
          <Link to="/admin/authz/grants">
            <Button variant="secondary" startIcon={<ShieldCheck size={17} />}>
              Manage grants
            </Button>
          </Link>
        }
      />

      {error ? (
        <div className="rounded-lg border border-border-subtle bg-surface-card px-4 py-10 text-center font-sans text-sm text-status-danger">
          Couldn’t load roles. Try again.
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border border-border-subtle bg-surface-card px-4 py-10 text-center font-sans text-sm text-muted">
          Loading roles…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* The role set */}
          <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="px-4 py-3 text-left font-sans text-xs font-semibold uppercase tracking-wide text-muted">
                    Role
                  </th>
                  <th className="px-4 py-3 text-left font-sans text-xs font-semibold uppercase tracking-wide text-muted">
                    What it is for
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-sans text-xs font-semibold uppercase tracking-wide text-muted">
                    Live grants
                  </th>
                </tr>
              </thead>
              <tbody>
                {(roles.data ?? []).map((role) => (
                  <tr
                    key={role.id}
                    className="border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top">
                      <span className="text-sm font-semibold text-strong">
                        {ROLE_LABELS[role.key as RoleKey] ?? role.name}
                      </span>
                      {role.is_system && (
                        <span className="ml-2 font-mono text-2xs uppercase tracking-wide text-muted">
                          system
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="text-sm text-body">{role.description}</span>
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      <StatusPill
                        tone={Number(role.activeGrantCount) > 0 ? 'success' : 'neutral'}
                        dot={false}
                      >
                        {Number(role.activeGrantCount)}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Per-module matrix — who holds what, where */}
          <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card">
            <div className="border-b border-border-subtle px-4 py-3">
              <h2 className="font-sans text-sm font-bold tracking-tight text-strong">
                Grants by module
              </h2>
              <p className="mt-0.5 font-sans text-xs text-muted">
                Live holders of each role, per module. A blank cell means nobody holds that role
                there — including Administrator, which has no implicit reach.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th className="sticky left-0 bg-surface-card px-4 py-3 text-left font-sans text-xs font-semibold uppercase tracking-wide text-muted">
                      Module
                    </th>
                    {(roles.data ?? []).map((role) => (
                      <th
                        key={role.id}
                        className="whitespace-nowrap px-3 py-3 text-center font-sans text-xs font-semibold text-muted"
                      >
                        {ROLE_LABELS[role.key as RoleKey] ?? role.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MODULE_OPTIONS.map(([moduleKey]) => (
                    <tr
                      key={moduleKey}
                      className="border-b border-border-subtle transition-colors last:border-0 hover:bg-gray-50"
                    >
                      <td className="sticky left-0 whitespace-nowrap bg-surface-card px-4 py-2.5 font-sans text-sm text-body">
                        {MODULE_LABELS[moduleKey as ModuleKey]}
                      </td>
                      {(roles.data ?? []).map((role) => {
                        const n = counts.get(`${moduleKey}::${role.key}`) ?? 0;
                        return (
                          <td
                            key={role.id}
                            className="px-3 py-2.5 text-center font-mono text-sm tabular-nums"
                          >
                            {n > 0 ? (
                              <span className="text-strong">{n}</span>
                            ) : (
                              <span className="text-border-strong">·</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

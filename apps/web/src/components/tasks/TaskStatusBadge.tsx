import * as React from 'react';
import { StatusPill } from '~/components/data-display/StatusPill';
import { taskTone, TASK_STATUS_LABEL } from '~/lib/tasks';

/**
 * A task's status, with overdue as an **overlay** rather than a fifth status
 * (design system, `components/tasks/taskModel`).
 *
 * `overdue` comes from the server, computed in the same SQL expression the
 * dashboard counts and the reminder sweep use. Deriving it here from `dueAt`
 * would give the row and the count behind it two different answers on either
 * side of midnight.
 */
export function TaskStatusBadge({
  status,
  overdue = false,
  size = 'md',
}: {
  status: string;
  overdue?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <StatusPill tone={taskTone(status)} overdue={overdue} size={size}>
      {TASK_STATUS_LABEL[status] ?? status}
    </StatusPill>
  );
}

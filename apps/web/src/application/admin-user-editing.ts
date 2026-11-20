export function changedFields<User extends object, Key extends keyof User>(
  current: User, values: Pick<User, Key>,
): Partial<Pick<User, Key>> {
  const patch: Partial<Pick<User, Key>> = {};
  for (const key of Object.keys(values) as Key[]) {
    if (values[key] !== current[key]) patch[key] = values[key];
  }
  return patch;
}

export interface AdminUserEdit<Patch> {
  patch: Patch;
  save(): Promise<unknown>;
}

/** Save flags, quota and usage in order; retain acknowledgements for safe retries. */
export async function saveAdminUserEdits<Patch extends object>(
  edits: { flags: AdminUserEdit<Patch>; quota: AdminUserEdit<Patch>; usage: AdminUserEdit<Patch> },
  deps: { acknowledged(patch: Patch): void; refresh(): Promise<void> },
): Promise<void> {
  const updates = [edits.flags, edits.quota, edits.usage].filter(({ patch }) => Object.keys(patch).length > 0);
  if (updates.length === 0) return;
  try {
    for (const update of updates) {
      await update.save();
      deps.acknowledged(update.patch);
    }
  } finally {
    await deps.refresh();
  }
}

/** Client action availability; the server rechecks current authority on writes. */
export function adminUserActions(actorId: string, target: { id: string; is_admin: boolean }) {
  return { delete: !target.is_admin && target.id !== actorId, editFlags: target.id !== actorId };
}

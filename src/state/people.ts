import type { UserGroup, UserProfile } from '../domain/types';
import type { DirectoryService } from '../services/types';

export interface ChangeReport {
  saved: string[];
  failed: { name: string; error: string }[];
}

/**
 * Save profiles changed in Users & groups (one person, a bulk action or an import),
 * one person at a time so a failure is reported against that person and the rest
 * still go through. A change to `active` goes through `setActive` (which also takes a
 * deactivated person out of their groups); group membership is written to both the
 * profile and the group rows.
 */
export async function saveUserChanges(directory: DirectoryService, users: UserProfile[], groups: UserGroup[], changed: UserProfile[]): Promise<ChangeReport> {
  const report: ChangeReport = { saved: [], failed: [] };
  const current = new Map(groups.map((g) => [g.id, { ...g, memberIds: [...g.memberIds] }]));
  for (const next of changed) {
    const prev = users.find((u) => u.systemuserid === next.systemuserid);
    try {
      const activating = prev && (prev.active !== false) !== (next.active !== false);
      if (activating) {
        await directory.setActive(next.systemuserid, next.active !== false);
        if (next.active === false) for (const g of current.values()) g.memberIds = g.memberIds.filter((m) => m !== next.systemuserid);
      } else {
        await directory.saveUser(next);
        for (const g of current.values()) {
          const has = g.memberIds.includes(next.systemuserid);
          const want = next.groupIds.includes(g.id);
          if (has === want) continue;
          const updated = { ...g, memberIds: want ? [...g.memberIds, next.systemuserid] : g.memberIds.filter((m) => m !== next.systemuserid) };
          await directory.saveGroup(updated);
          current.set(g.id, updated);
        }
      }
      report.saved.push(next.fullname);
    } catch (e) {
      report.failed.push({ name: next.fullname || next.email, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

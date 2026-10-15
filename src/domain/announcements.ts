import type { UserGroup, UserProfile } from './types';

// Announcements: a message an Admin puts in front of Folium users (a form revision
// taking effect, a DocuSign outage). Each one is an `ev_foliumsetting` row named
// "Announcement", so past ones stay in Dataverse as a record of what people were told.

export type AnnouncementSeverity = 'info' | 'warn' | 'critical';

export interface Announcement {
  id: string;
  /** Plain text, up to `ANNOUNCEMENT_MAX` characters. Links are shown as links; no HTML. */
  message: string;
  severity: AnnouncementSeverity;
  /** ISO timestamp it starts showing. */
  startsOn: string;
  /** ISO timestamp it stops showing. Empty means until an Admin removes it. */
  endsOn?: string;
  /** Groups who see it. Empty means everyone. */
  groupIds?: string[];
  /** People can hide it for themselves. A critical announcement never can. */
  dismissible: boolean;
  /** Also post it to the Teams channel (the optional flow in DEPLOY.md §5c). */
  postToTeams?: boolean;
  createdBy: string;
  createdOn: string;
  modifiedBy?: string;
  modifiedOn?: string;
}

export const ANNOUNCEMENT_MAX = 1000;
/** At most this many show at once; the rest are counted ("+2 more"). */
export const ANNOUNCEMENTS_SHOWN = 2;

export const SEVERITY_LABEL: Record<AnnouncementSeverity, string> = { info: 'Information', warn: 'Warning', critical: 'Critical' };

/** Whether people can hide it: only when the Admin allowed it, and never when it's critical. */
export const canDismiss = (a: Pick<Announcement, 'severity' | 'dismissible'>) => a.dismissible && a.severity !== 'critical';

/** Where an announcement is in its life, for Administration › Announcements. */
export function announcementPhase(a: Pick<Announcement, 'startsOn' | 'endsOn'>, now: Date): 'scheduled' | 'live' | 'past' {
  const t = now.getTime();
  if (new Date(a.startsOn).getTime() > t) return 'scheduled';
  if (a.endsOn && new Date(a.endsOn).getTime() <= t) return 'past';
  return 'live';
}

const RANK: Record<AnnouncementSeverity, number> = { critical: 0, warn: 1, info: 2 };

/**
 * What this person sees now: live announcements for everyone or for a group they're in,
 * without the ones they dismissed (a critical one can't be), critical first, then the
 * newest. At most `limit` (two by default), with a count of the rest.
 */
export function activeAnnouncements(
  list: Announcement[],
  me: Pick<UserProfile, 'systemuserid'> | undefined,
  groups: Pick<UserGroup, 'id' | 'memberIds'>[],
  now: Date,
  dismissed: Iterable<string> = [],
  limit = ANNOUNCEMENTS_SHOWN,
): { shown: Announcement[]; more: number } {
  const hidden = new Set(dismissed);
  const mine = new Set(me ? groups.filter((g) => g.memberIds.includes(me.systemuserid)).map((g) => g.id) : []);
  const live = list
    .filter((a) => a.message.trim() && announcementPhase(a, now) === 'live')
    .filter((a) => !a.groupIds?.length || a.groupIds.some((g) => mine.has(g)))
    .filter((a) => !(canDismiss(a) && hidden.has(a.id)))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.startsOn.localeCompare(a.startsOn) || b.createdOn.localeCompare(a.createdOn));
  return { shown: live.slice(0, limit), more: Math.max(0, live.length - limit) };
}

/** What's wrong with an announcement before it's saved, by field. Empty when it can be saved. */
export function announcementProblems(a: Pick<Announcement, 'message' | 'startsOn' | 'endsOn'>): Partial<Record<'message' | 'startsOn' | 'endsOn', string>> {
  const out: ReturnType<typeof announcementProblems> = {};
  if (!a.message.trim()) out.message = 'Write the message.';
  else if (a.message.length > ANNOUNCEMENT_MAX) out.message = `Keep it to ${ANNOUNCEMENT_MAX.toLocaleString()} characters (it’s ${a.message.length.toLocaleString()}).`;
  if (!a.startsOn || Number.isNaN(new Date(a.startsOn).getTime())) out.startsOn = 'Choose when it starts.';
  if (a.endsOn) {
    if (Number.isNaN(new Date(a.endsOn).getTime())) out.endsOn = 'Choose a valid end, or leave it empty.';
    else if (!out.startsOn && new Date(a.endsOn) <= new Date(a.startsOn)) out.endsOn = 'It has to end after it starts.';
  }
  return out;
}

/**
 * An announcement as it's stored: trimmed, a critical one never dismissible, no empty
 * end or audience. Throws when it can't be saved, so a service never stores one that's
 * too long or blank.
 */
export function cleanAnnouncement(a: Announcement): Announcement {
  const message = a.message.trim();
  const problems = announcementProblems({ ...a, message });
  const first = Object.values(problems)[0];
  if (first) throw new Error(first);
  const { endsOn, groupIds, postToTeams, ...rest } = a;
  return {
    ...rest,
    message,
    dismissible: canDismiss(a),
    ...(endsOn ? { endsOn } : {}),
    ...(groupIds?.length ? { groupIds: [...new Set(groupIds)] } : {}),
    ...(postToTeams ? { postToTeams } : {}),
  };
}

/** Text and links in a message, in order. Only http(s) URLs become links. */
export type MessagePart = { text: string } | { href: string; text: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
/** Punctuation that ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?)\]]+$/;

export function messageParts(message: string): MessagePart[] {
  const out: MessagePart[] = [];
  let last = 0;
  for (const m of message.matchAll(URL_RE)) {
    let url = m[0];
    const trail = TRAILING.exec(url)?.[0] ?? '';
    // Keep a closing bracket that has its opening one inside the URL (a Wikipedia link).
    const keep = trail.startsWith(')') && url.slice(0, -trail.length).includes('(') ? 1 : 0;
    url = url.slice(0, url.length - trail.length + keep);
    const start = m.index ?? 0;
    if (start > last) out.push({ text: message.slice(last, start) });
    out.push({ href: url, text: url });
    last = start + url.length;
  }
  if (last < message.length) out.push({ text: message.slice(last) });
  return out;
}

/** How often an open Folium checks for new announcements when its window regains focus. */
export const ANNOUNCEMENT_REFRESH_MS = 15 * 60_000;

import type { FormTemplate, UserGroup, UserProfile } from '../../domain/types';
import { usageEvents, type UsageEvent } from '../../domain/usage';

// A year of made-up usage for the demo, so reporting (#32) has something to show. It's
// generated the same way every time from a fixed seed and isn't stored: only events
// recorded in the demo itself go to localStorage.

/** Small deterministic RNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;

/**
 * Events for the year before `until`, from the given users and live templates. Popular
 * forms are used far more than the rest, as in Laser App's numbers.
 */
export function seedUsage(users: UserProfile[], groups: UserGroup[], templates: FormTemplate[], until: Date = new Date('2026-10-13T17:00:00Z')): UsageEvent[] {
  const rand = rng(31);
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const forms = templates.filter((t) => t.status === 'Live' || t.status === 'Retired');
  if (!forms.length) return [];
  // Weight forms by position: the first few take most of the use.
  const weighted = forms.flatMap((t, i) => Array.from({ length: Math.max(1, 8 - i) }, () => t));
  const workers = users.filter((u) => u.role !== 'Admin');
  const advisors = users.filter((u) => u.role === 'User');
  const out: UsageEvent[] = [];
  let n = 0;
  for (let d = 365; d >= 1; d--) {
    const day = new Date(until.getTime() - d * DAY);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const sessions = Math.floor(rand() * 4);
    for (let s = 0; s < sessions; s++) {
      const user = pick(workers);
      // Riley stopped using Folium in March.
      if (user.lastSeenOn && new Date(user.lastSeenOn) < day) continue;
      const actingFor = user.role === 'Assistant' ? pick(advisors) : user;
      const packet = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(weighted)).filter((t, i, a) => a.indexOf(t) === i);
      const at = (h: number) => new Date(day.getTime() + (13 + s + h) * 3_600_000);
      const ctx = (h: number) => ({ user, actingFor, groups, contactId: `c-demo-${n % 40}`, requestId: `seed-req-${n}`, at: at(h), batchId: `seed-${n}-${h}` });
      out.push(...usageEvents('form.added', ctx(0), packet));
      const r = rand();
      if (r < 0.12) {
        out.push(...usageEvents('send.blocked', ctx(0.2), packet, { detail: { blockingChecks: [pick(['required', 'check:0', 'state', 'state:licence', 'format:contact.ev_ssn'])] } }));
      }
      if (r < 0.55) {
        const signers = 1 + Math.floor(rand() * 2);
        out.push(...usageEvents('request.sent', ctx(0.5), packet, { detail: { signerCount: signers, auth: pick(['sms', 'email', 'kba']) } }));
        const viewedAfter = 0.5 + rand() * 30;
        if (rand() < 0.93) out.push(...usageEvents('request.viewed', ctx(viewedAfter), packet));
        const end = rand();
        if (end < 0.8) out.push(...usageEvents('request.signed', ctx(viewedAfter + 1 + rand() * 96), packet));
        else if (end < 0.85) out.push(...usageEvents('request.declined', ctx(viewedAfter + 4), packet));
        else if (end < 0.9) out.push(...usageEvents('request.voided', ctx(viewedAfter + 30), packet));
        else if (end < 0.95) out.push(...usageEvents('request.expired', ctx(60 * 24), packet));
      } else if (r < 0.7) {
        out.push(...usageEvents('request.inperson', ctx(0.5), packet, { detail: { mode: 'flatten' } }));
      } else if (r < 0.85) {
        out.push(...usageEvents(pick(['pdf.fillable', 'pdf.fillable', 'pdf.print'] as const), ctx(0.3), packet, { detail: { mode: 'fillable' } }));
      } else {
        out.push(...usageEvents('draft.saved', ctx(0.3), packet));
      }
      n++;
    }
  }
  return out.filter((e) => new Date(e.occurredOn) <= until);
}

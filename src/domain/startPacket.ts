import type { Account, ClientRecord, FormTemplate } from './types';

/**
 * Start a packet from a description ("Priya is rolling her Fidelity 401(k) into a Praxis
 * IRA"). Phase 1 is deterministic: intents recognised by keyword, forms found by name and
 * the keywords Marketing tags them with, and the client's accounts from Dynamics 365. It
 * only ever picks templates; it never writes form content. Every form it adds carries a
 * sentence saying why, which Review shows under the forms.
 */

export interface PacketSuggestion {
  template: FormTemplate;
  /** "Transfer of assets was added because Priya's Dynamics 365 record lists a Fidelity 401(k)." */
  reason: string;
}

/** Employer plans a rollover comes out of. */
const EMPLOYER_PLAN = /\b(401\s?\(?k\)?|403\s?\(?b\)?|457(\s?\(?b\)?)?|tsp|pension|employer plan)/i;

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const haystack = (t: FormTemplate) => norm(`${t.name} ${(t.keywords ?? []).join(' ')}`);

interface Intent {
  id: string;
  /** What in the description triggers it. */
  when: RegExp;
  /** Intents it stands in for: a rollover already covers "transfer", an RMD a distribution. */
  over?: string[];
  forms: { match: RegExp; reason: (ctx: ReasonContext) => string | undefined }[];
}

interface ReasonContext {
  name: string;
  first: string;
  text: string;
  client?: ClientRecord;
  /** The phrase in the description that triggered the intent. */
  said: string;
}

/** An account the client already holds of a type the description names ("into a Roth IRA"). */
function targetAccount(text: string, client?: ClientRecord): { type: string; account?: Account } | undefined {
  if (!/\bira\b/i.test(text)) return undefined;
  const type = /\broth\b/i.test(text) ? 'Roth IRA' : 'Traditional IRA';
  return { type, account: client?.accounts.find((a) => a.ev_accounttype === type) };
}

/** The employer plan the client holds, from the CRM or (failing that) as the advisor typed it. */
function employerPlan(ctx: ReasonContext): string | undefined {
  const held = ctx.client?.accounts.find((a) => EMPLOYER_PLAN.test(a.ev_accounttype) || EMPLOYER_PLAN.test(a.name));
  if (held) return `${ctx.first}’s Dynamics 365 record lists ${aOrAn(held.ev_custodian ?? held.ev_accounttype)} ${held.ev_custodian ? `${held.ev_custodian} ${held.ev_accounttype}` : held.ev_accounttype}`;
  return undefined;
}

const aOrAn = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

const INTENTS: Intent[] = [
  {
    id: 'rollover',
    when: /\b(roll(ing|ed)?[\s-]?over|rollover|transfer(ring)?\s+(in|from)|toa|acat)\b|\b401\s?\(?k\)?|\b403\s?\(?b\)?/i,
    over: ['transfer', 'open'],
    forms: [
      {
        match: /\b(transfer|rollover|toa|acat)/,
        reason: (ctx) => {
          const plan = employerPlan(ctx);
          if (plan) return `${ctx.name} was added because ${plan}.`;
          return `${ctx.name} was added for the rollover you described.`;
        },
      },
      {
        // A rollover needs somewhere to land: only when the client doesn't hold that IRA yet.
        match: /\bapplication\b|open account|new ira/,
        reason: (ctx) => {
          const target = targetAccount(ctx.text, ctx.client);
          if (!target || target.account) return undefined;
          return `${ctx.name} was added because Dynamics 365 has no ${target.type} for ${ctx.first} to receive the rollover.`;
        },
      },
      {
        match: /beneficiar/,
        reason: (ctx) => {
          const target = targetAccount(ctx.text, ctx.client);
          if (!target || target.account) return undefined;
          return `${ctx.name} was added because a new ${target.type} needs its own beneficiaries.`;
        },
      },
    ],
  },
  { id: 'beneficiary', when: /beneficiar|\bbene\b|\btod\b|primary and contingent/i, forms: [{ match: /beneficiar/, reason: (ctx) => `${ctx.name} matches “${ctx.said}”.` }] },
  {
    id: 'address',
    when: /\baddress\b|\bmov(ed|ing)\b|new (phone|email)|name change|changed (her|his|their) name/i,
    forms: [{ match: /address|contact change/, reason: (ctx) => `${ctx.name} matches “${ctx.said}”.` }],
  },
  {
    id: 'rmd',
    when: /\brmds?\b|required minimum|turns? 7[2-5]\b/i,
    over: ['distribution'],
    forms: [{ match: /required minimum|\brmd\b/, reason: (ctx) => `${ctx.name} was added for the required minimum distribution.` }],
  },
  {
    id: 'swp',
    when: /systematic|\bswp\b|monthly (income|withdrawals?|payments?)|periodic/i,
    over: ['distribution'],
    forms: [{ match: /systematic/, reason: (ctx) => `${ctx.name} matches “${ctx.said}”.` }],
  },
  {
    id: 'roth',
    when: /roth conversion|convert(ing)?\b.*\broth\b/i,
    forms: [{ match: /roth conversion/, reason: (ctx) => `${ctx.name} matches “${ctx.said}”.` }],
  },
  {
    id: 'distribution',
    when: /withdraw|distribution|take (some )?money out|cash out|\bqcd\b|charitable/i,
    forms: [{ match: /distribution request|\bdistribution\b/, reason: (ctx) => `${ctx.name} matches “${ctx.said}”.` }],
  },
  {
    id: 'transfer',
    when: /\btransfer\b/i,
    forms: [{ match: /\btransfer\b/, reason: (ctx) => `${ctx.name} matches “${ctx.said}”.` }],
  },
  {
    id: 'open',
    when: /\bopen(ing)? (a |an )?(new )?(ira|account|brokerage)|new (ira|account)\b/i,
    forms: [{ match: /\bapplication\b/, reason: (ctx) => `${ctx.name} matches “${ctx.said}”.` }],
  },
];

/** Words that say nothing about which form, for the fallback search. */
const STOP = new Set('a an and the to for from into of on in her his their them they is are was be needs need wants want would like client account accounts form forms she he it with this that some has have'.split(' '));

/**
 * Forms for a description, each with why. `templates` should be what the advisor can
 * use now (current revisions, their groups, the packet state's versions). Forms are
 * returned in the order the intents name them, without repeats.
 */
export function suggestPacket(text: string, templates: FormTemplate[], client?: ClientRecord): PacketSuggestion[] {
  const said = text.trim();
  if (!said) return [];
  const first = client?.contact.firstname ?? 'the client';
  const hit = INTENTS.map((i) => ({ intent: i, m: said.match(i.when) })).filter((x): x is { intent: Intent; m: RegExpMatchArray } => !!x.m);
  const covered = new Set(hit.flatMap((h) => h.intent.over ?? []));
  const out: PacketSuggestion[] = [];
  const add = (template: FormTemplate, reason: string) => {
    if (!out.some((s) => s.template.id === template.id)) out.push({ template, reason });
  };
  for (const { intent, m } of hit) {
    if (covered.has(intent.id)) continue;
    for (const f of intent.forms) {
      // A form named for it beats one that only lists it as a keyword (PX-305 lists "RMD").
      const t = templates.find((x) => f.match.test(norm(x.name))) ?? templates.find((x) => f.match.test(haystack(x)));
      if (!t) continue;
      const reason = f.reason({ name: t.name, first, text: said, client, said: m[0].trim() });
      if (reason) add(t, reason);
    }
  }
  if (out.length) return out;

  // Nothing recognised: fall back to the words themselves against names and keywords.
  const words = [...new Set(norm(said).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/))].filter((w) => w.length > 2 && !STOP.has(w));
  const scored = templates
    .map((t) => ({ t, words: words.filter((w) => new RegExp(`\\b${w}`).test(haystack(t))) }))
    .filter((x) => x.words.length)
    .sort((a, b) => b.words.length - a.words.length)
    .slice(0, 3);
  for (const { t, words: w } of scored) add(t, `${t.name} matches “${w.join(' ')}”.`);
  return out;
}

/** Ready-made descriptions for the chips under Start a packet. */
export const START_CHIPS = ['Roll over 401(k) to IRA', 'Update beneficiaries', 'Change of address'];

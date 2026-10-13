import type { FormTemplate } from '../../domain/types';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop accents so "Bénéficiaire" matches "beneficiaire"
    .replace(/[^a-z0-9 ]/g, ' ');

/**
 * Rank templates for a query. Matches form numbers exactly (EV-1120, "1120"), names,
 * issuers, categories and the synonyms Marketing tags forms with ("SWP", "TOA", "RMD").
 */
export function searchTemplates(list: FormTemplate[], query: string): FormTemplate[] {
  const q = norm(query).trim();
  if (!q) return list;
  const terms = q.split(/\s+/);
  const scored = list
    .map((t) => {
      const name = norm(t.name);
      const num = norm(t.formNumber).replace(/\s/g, '');
      const kw = norm((t.keywords ?? []).join(' '));
      const other = norm(`${t.issuer ?? ''} ${t.source} ${t.category} ${t.description ?? ''}`);
      let score = 0;
      for (const term of terms) {
        const compact = term.replace(/\s/g, '');
        let s = 0;
        if (num === compact || num.endsWith(compact)) s = 12;
        else if (num.includes(compact)) s = 8;
        if (name.startsWith(term)) s = Math.max(s, 9);
        else if (new RegExp(`\\b${term}`).test(name)) s = Math.max(s, 7);
        else if (name.includes(term)) s = Math.max(s, 4);
        if (new RegExp(`\\b${term}`).test(kw)) s = Math.max(s, 6);
        if (new RegExp(`\\b${term}`).test(other)) s = Math.max(s, 3);
        if (!s) return { t, score: 0 };
        score += s;
      }
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return scored.map((x) => x.t);
}

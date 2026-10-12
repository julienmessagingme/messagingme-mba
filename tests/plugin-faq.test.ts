import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAQ } from '../scripts/plugin/faq';
import { MARQUE_DEBUT, PAGES_FAQ, blocFaqVitrine, pageAvecFaq, skillFaq } from '../scripts/plugin/generer';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { QUOTAS_API_DEFAUT } from '../src/api/quotas';
import { STATUT_PAR_CODE } from '../src/api/erreurs';
import { DROITS } from '../src/offres/offres';

/**
 * LA FAQ A UNE SEULE SOURCE (lot 10) : `scripts/plugin/faq.ts`. Ses copies (la skill du plugin, le bloc des pages
 * développeurs de la vitrine) se refont ici et doivent être identiques au caractère près : sinon `npm run plugin:generer`.
 */
const RACINE = resolve(__dirname, '..');
const lire = (p: string) => readFileSync(resolve(RACINE, p), 'utf8');

describe('la source', () => {
  it('chaque entrée a ses deux langues, une ancre unique et une source nommée', () => {
    const ids = FAQ.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of FAQ) {
      for (const t of [e.question.fr, e.question.en, e.reponse.fr, e.reponse.en, e.source]) expect(t.trim(), e.id).not.toBe('');
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('🔴 aucune réponse ne chiffre ce que facture Meta : seule la grille de Meta, par son lien', () => {
    const meta = FAQ.find((e) => e.id === 'ce-que-meta-facture')!;
    for (const t of [meta.reponse.fr, meta.reponse.en]) {
      expect(t).not.toMatch(/\d+[,.]\d+\s*(€|cts?|centimes?|cents?)|€\s*\d/);
      expect(t).toContain('https://developers.facebook.com/docs/whatsapp/pricing');
    }
    // Ailleurs non plus : un prix par message de Meta se compte en centimes, jamais les nôtres.
    for (const e of FAQ) {
      for (const t of [e.reponse.fr, e.reponse.en]) expect(t, e.id).not.toMatch(/\b0[,.]\d|\bcts?\b|centimes?|\bcents?\b|\$\s*\d|\d\s*\$/);
    }
  });

  it('🔴 les limites d’envoi sont celles du code, l’offre ET le quota du jour de l’API', () => {
    const e = FAQ.find((x) => x.id === 'combien-de-messages')!;
    expect(e.reponse.fr).toContain(QUOTAS_API_DEFAUT.envois.toLocaleString('fr-FR').replace(/\u202f/g, ' '));
    expect(e.reponse.en).toContain(QUOTAS_API_DEFAUT.envois.toLocaleString('en-US'));
    expect(e.reponse.en).toContain('quota_exceeded');
    // Le Pro « sans plafond » ne se dit que si le code n'en pose aucun.
    expect(e.reponse.en.includes('no cap from us on Pro')).toBe(DROITS.pro.limites.envoisModelesMois === null);
  });

  it('le prix du numéro fourni vient du code', () => {
    const e = FAQ.find((x) => x.id === 'numero-fourni')!;
    const euros = (PRIX_NUMERO_HT_CENTIMES / 100).toFixed(2);
    expect(e.reponse.fr).toContain(euros.replace('.', ','));
    expect(e.reponse.en).toContain(euros);
  });

  it('chaque nom en code cité existe : un outil du catalogue, ou un code de refus de l’API', () => {
    const connus = new Set([...Object.keys(CATALOGUE_MCP), ...Object.keys(STATUT_PAR_CODE)]);
    for (const e of FAQ) {
      for (const m of `${e.reponse.fr} ${e.reponse.en}`.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
        expect(connus.has(m[0]), `${e.id} : ${m[0]}`).toBe(true);
      }
    }
  });
});

describe('les copies sont à jour (sinon : npm run plugin:generer)', () => {
  it('la skill du plugin', () => {
    expect(lire('plugin/skills/faq/SKILL.md')).toBe(skillFaq());
  });

  it('les pages de la vitrine qui portent les marques', () => {
    for (const { chemin, langue } of PAGES_FAQ) {
      if (!existsSync(resolve(RACINE, chemin))) continue;
      const html = lire(chemin);
      expect(pageAvecFaq(html, langue), chemin).toBe(html);
    }
  });

  it('le bloc de la vitrine porte chaque question, et son balisage FAQPage les mêmes', () => {
    for (const langue of ['fr', 'en'] as const) {
      const bloc = blocFaqVitrine(langue);
      expect(bloc.startsWith(MARQUE_DEBUT)).toBe(true);
      const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(bloc)![1]!) as { mainEntity: Array<{ name: string }> };
      expect(ld.mainEntity.map((q) => q.name)).toEqual(FAQ.map((e) => e.question[langue]));
      for (const e of FAQ) expect(bloc).toContain(`id="faq-${e.id}"`);
    }
  });
});

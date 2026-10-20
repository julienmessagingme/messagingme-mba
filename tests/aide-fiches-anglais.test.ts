import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fichesDuDepot } from '../db/charger-aide';
import { empreinteATraduire } from '../scripts/aide-proposer';
import { champDeFiche, lireFicheDuDepot, publicationDe } from '../src/aide/fiches';
import { erreursDeStructure, structureFiche } from '../src/aide/structure';
import { ETAPES_CARTE_META, PREREQUIS_META } from '../web/lib/partage/etapes-meta';

/**
 * LES FICHES PUBLIQUES EN ANGLAIS (plan du centre d'aide, tâche 4). Chaque fiche publique a sa version anglaise à côté
 * d'elle, dans `docs/aide/fiches/en/`, qui sert la page anglaise du centre d'aide. Elle porte l'empreinte du français
 * qu'elle traduit : un français retouché sans son anglais rend ce test rouge, au lieu de laisser la page anglaise dire
 * l'ancienne version. Le bot, lui, ne lit que les fiches françaises.
 */
const FR = new URL('../docs/aide/fiches/', import.meta.url);
const EN = new URL('../docs/aide/fiches/en/', import.meta.url);
const publiques = readdirSync(FR)
  .filter((n) => n.endsWith('.md'))
  .filter((n) => publicationDe(readFileSync(new URL(n, FR), 'utf8')) !== null);
const anglaises = existsSync(EN) ? readdirSync(EN).filter((n) => n.endsWith('.md')) : [];
const lireEn = (nom: string) => readFileSync(new URL(nom, EN), 'utf8');

describe('les fiches publiques en anglais', () => {
  it('il y a des fiches publiques, sinon ce test ne prouve rien', () => {
    expect(publiques.length).toBeGreaterThanOrEqual(9);
  });

  it('chaque fiche publique a sa version anglaise, et aucune anglaise n’est orpheline', () => {
    expect(anglaises.sort()).toEqual([...publiques].sort());
  });

  for (const nom of publiques) {
    describe(nom, () => {
      it('🔴 traduit le français ACTUEL', () => {
        const fr = lireFicheDuDepot(nom, readFileSync(new URL(nom, FR), 'utf8'));
        const attendue = empreinteATraduire(fr);
        expect(champDeFiche(lireEn(nom), 'traduit_de'),
          `le français de ${nom} a changé : retraduire, puis traduit_de: ${attendue}`).toBe(attendue);
      });

      it('suit la grammaire anglaise, avec autant d’étapes que le français', () => {
        const fr = lireFicheDuDepot(nom, readFileSync(new URL(nom, FR), 'utf8'));
        const en = lireFicheDuDepot(nom, lireEn(nom));
        expect(erreursDeStructure(en.corps, 'en')).toEqual([]);
        const etapes = (corps: string, l: 'fr' | 'en') => structureFiche(corps, l).sections.filter((s) => s.type === 'etape').length;
        expect(etapes(en.corps, 'en')).toBe(etapes(fr.corps, 'fr'));
        expect(en.titre).not.toBe('');
      });

      it('a un slug anglais, sans guillemets français ni tiret long', () => {
        const texte = lireEn(nom);
        expect(champDeFiche(texte, 'slug')).toMatch(/^[a-z0-9-]+$/);
        expect(texte).not.toMatch(/[«»]/);
        expect(texte).not.toMatch(/[—–]/);
      });
    });
  }

  it('🔴 la version anglaise du guide Meta reprend mot pour mot les étapes anglaises de la console', () => {
    // Le pendant de tests/etapes-meta.test.ts, qui garde la française : Meta ne doit pas se lire de deux façons.
    const plat = (t: string): string => t.replace(/\s+/g, ' ');
    const fiche = plat(lireEn('ce-qu-il-faut-chez-meta.md'));
    for (const e of [...PREREQUIS_META, ...ETAPES_CARTE_META]) expect(fiche).toContain(plat(e.en));
  });

  it('les slugs sont uniques', () => {
    const slugs = anglaises.map((n) => champDeFiche(lireEn(n), 'slug'));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('🔴 le chargeur du bot ne voit aucune fiche anglaise', () => {
    for (const f of fichesDuDepot()) expect(existsSync(new URL(`${f.cle}.md`, FR)), f.cle).toBe(true);
    expect(fichesDuDepot().length).toBe(readdirSync(FR).filter((n) => n.endsWith('.md')).length);
  });
});

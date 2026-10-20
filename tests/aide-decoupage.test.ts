import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fichesDuDepot, morceauxDuDepot } from '../db/charger-aide';
import { MORCEAU_MAX, decouperFiche, type FicheFichier } from '../src/aide/fiches';
import { structureFiche } from '../src/aide/structure';

/**
 * LE BOT REÇOIT LA BONNE ÉTAPE (plan du centre d'aide, tâche 2). Il ne recevait que les 2 000 premiers caractères de
 * chaque fiche : sur « Lancer une campagne », les étapes 1 et 2. Les fiches longues sont désormais chargées en
 * morceaux, une étape par morceau, et la recherche retrouve le morceau qui répond.
 */

const fiches = fichesDuDepot();
const plat = (t: string) => t.replace(/\s+/g, ' ').trim();
/** Les phrases d'un texte : l'unité que le découpage peut séparer, jamais couper. */
const phrases = (t: string) => plat(t).split(/(?<=[.!?])\s+/).filter((p) => p !== '');

describe('decouperFiche, sur les fiches réelles', () => {
  it('il y a des fiches longues, sinon ce test ne prouve rien', () => {
    expect(fiches.filter((f) => f.corps.length > MORCEAU_MAX).length).toBeGreaterThan(10);
  });

  it('aucun morceau ne dépasse ce que le bot reçoit', () => {
    for (const m of fiches.flatMap(decouperFiche)) expect(m.corps.length, m.cle).toBeLessThanOrEqual(MORCEAU_MAX);
  });

  it('rien n’est perdu : chaque phrase et chaque point de liste d’une fiche est dans un de ses morceaux', () => {
    for (const f of fiches) {
      const tout = plat(decouperFiche(f).map((m) => m.corps).join('\n\n').replace(/^- /gm, ''));
      for (const p of phrases(f.corps.replace(/^- /gm, ''))) expect(tout, `${f.cle} : « ${p.slice(0, 50)} »`).toContain(p.replace(/^## /, ''));
    }
  });

  it('une fiche courte reste entière, sous sa clé, et garde donc son vecteur', () => {
    const courtes = fiches.filter((f) => f.corps.length <= MORCEAU_MAX);
    expect(courtes.length).toBeGreaterThan(0);
    for (const f of courtes) expect(decouperFiche(f)).toEqual([f]);
  });

  it('une fiche longue donne des morceaux numérotés, qui gardent titre, écran et source', () => {
    for (const f of fiches.filter((x) => x.corps.length > MORCEAU_MAX)) {
      const m = decouperFiche(f);
      expect(m.map((x) => x.cle), f.cle).toEqual(m.map((_, i) => `${f.cle}#${i + 1}`));
      for (const x of m) {
        expect(x.titre).toBe(f.titre);
        expect(x.ecran).toBe(f.ecran);
        expect(x.sourceSection).toBe(f.sourceSection);
        expect(x.sourceEmpreinte).toBe(f.sourceEmpreinte);
      }
    }
  });

  it('🔴 « Lancer une campagne » : une étape par morceau, et chaque morceau d’étape commence par son marqueur', () => {
    const f = fiches.find((x) => x.cle === 'lancer-une-campagne')!;
    const m = decouperFiche(f);
    for (const e of structureFiche(f.corps).sections.filter((s) => s.type === 'etape')) {
      const marque = `**${e.numero}. ${e.titre}.**`;
      const siens = m.filter((x) => x.corps.includes(marque));
      expect(siens.length, marque).toBeGreaterThan(0);
      // Le contexte : un morceau qui porte l'étape commence par elle, jamais au milieu d'un autre sujet.
      for (const x of siens) expect(x.corps.startsWith(marque), `${x.cle} commence par ${marque}`).toBe(true);
    }
    // La programmation (étape 5) est atteignable : elle était au-delà des 2 000 premiers caractères.
    expect(f.corps.indexOf('**5. ')).toBeGreaterThan(MORCEAU_MAX);
    expect(m.some((x) => x.corps.startsWith('**5. '))).toBe(true);
  });

  it('les clés des morceaux sont uniques sur tout le dépôt', () => {
    const cles = morceauxDuDepot().map((m) => m.cle);
    expect(new Set(cles).size).toBe(cles.length);
    expect(cles).toContain('lancer-une-campagne#1');
  });

  it('🔴 le chargeur charge les MORCEAUX, pas les fiches entières', () => {
    const source = readFileSync(new URL('../db/charger-aide.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/chargerFiches\(client, morceaux\)/);
    expect(source).toMatch(/const morceaux = morceauxDuDepot\(\)/);
  });
});

describe('decouperFiche, sur des cas construits', () => {
  const base: FicheFichier = { cle: 'x', titre: 'X', corps: '', ecran: null, sourceSection: null, sourceEmpreinte: null };
  const phrase = (i: number) => `Phrase numéro ${i} qui dit quelque chose d’utile au client.`;

  it('un paragraphe plus long que la borne se coupe entre deux phrases, jamais au milieu', () => {
    const long = Array.from({ length: 80 }, (_, i) => phrase(i)).join(' ');
    const m = decouperFiche({ ...base, corps: `Le chapeau.\n\n${long}` });
    expect(m.length).toBeGreaterThan(1);
    for (const x of m) {
      expect(x.corps.length).toBeLessThanOrEqual(MORCEAU_MAX);
      expect(x.corps.trim()).toMatch(/[.!?]$/);
    }
    for (let i = 0; i < 80; i++) expect(m.some((x) => x.corps.includes(phrase(i))), String(i)).toBe(true);
  });

  it('une étape trop longue se continue dans un morceau qui porte encore son marqueur', () => {
    const detail = Array.from({ length: 80 }, (_, i) => phrase(i)).join(' ');
    const m = decouperFiche({ ...base, corps: `Le chapeau.\n\n**1. Le geste.** Faire ceci.\n\n${detail}` });
    const etape = m.filter((x) => x.corps.includes('Phrase numéro'));
    expect(etape.length).toBeGreaterThan(1);
    for (const x of etape) expect(x.corps.startsWith('**1. Le geste.**')).toBe(true);
  });

  it('une longue liste se coupe entre ses points', () => {
    const liste = Array.from({ length: 60 }, (_, i) => `- ${phrase(i)}`).join('\n');
    const m = decouperFiche({ ...base, corps: `Le chapeau.\n\n${liste}` });
    expect(m.length).toBeGreaterThan(1);
    for (const x of m) for (const ligne of x.corps.split('\n').filter((l) => l.startsWith('- '))) {
      expect(ligne).toMatch(/^- Phrase numéro \d+ qui dit quelque chose d’utile au client\.$/);
    }
  });
});

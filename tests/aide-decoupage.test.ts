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

  it('🔴 dans toute fiche longue à étapes, chaque morceau qui porte une étape commence par son marqueur', () => {
    // Porté sur TOUTES les fiches à étapes, pas sur le contenu d'une seule : la tâche 3 réécrit les fiches, et un test lié
    // à la place d'une étape dans un texte deviendrait rouge sur un push de `.md` seuls, qui ne lance pas la CI.
    const aEtapes = fiches.filter((f) => f.corps.length > MORCEAU_MAX && structureFiche(f.corps).sections.some((s) => s.type === 'etape'));
    expect(aEtapes.length).toBeGreaterThan(0);
    for (const f of aEtapes) {
      const m = decouperFiche(f);
      for (const e of structureFiche(f.corps).sections.filter((s) => s.type === 'etape')) {
        const marque = `**${e.numero}. ${e.titre}.**`;
        const siens = m.filter((x) => x.corps.includes(marque));
        expect(siens.length, `${f.cle} ${marque}`).toBeGreaterThan(0);
        for (const x of siens) expect(x.corps.startsWith(marque), `${x.cle} commence par ${marque}`).toBe(true);
      }
    }
  });

  it('les clés des morceaux sont uniques sur tout le dépôt', () => {
    const cles = morceauxDuDepot().map((m) => m.cle);
    expect(new Set(cles).size).toBe(cles.length);
    expect(cles.some((c) => c.includes('#'))).toBe(true);
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

  it('🔴 une étape au-delà des 2 000 premiers caractères a son morceau, qui commence par elle', () => {
    const remplissage = Array.from({ length: 12 }, (_, i) => phrase(i)).join(' ');
    const corps = ['Le chapeau.', ...[1, 2, 3, 4, 5].map((n) => `**${n}. Étape ${n}.** Faire le geste ${n}. ${remplissage}`)].join('\n\n');
    expect(corps.indexOf('**5. ')).toBeGreaterThan(MORCEAU_MAX);
    const m = decouperFiche({ ...base, corps });
    for (const n of [1, 2, 3, 4, 5]) {
      const siens = m.filter((x) => x.corps.includes(`**${n}. Étape ${n}.**`));
      expect(siens.length, String(n)).toBeGreaterThan(0);
      for (const x of siens) expect(x.corps.startsWith(`**${n}. Étape ${n}.**`)).toBe(true);
    }
  });

  it('un encadré long se coupe, chaque part garde son marqueur, rien n’est perdu', () => {
    const long = Array.from({ length: 80 }, (_, i) => phrase(i)).join(' ');
    const m = decouperFiche({ ...base, corps: `Le chapeau.\n\n**1. Le geste.** Faire ceci.\n\n**Bon à savoir.** ${long}` });
    const encadre = m.filter((x) => x.corps.includes('Phrase numéro'));
    expect(encadre.length).toBeGreaterThan(1);
    for (const x of encadre) {
      expect(x.corps.startsWith('**Bon à savoir.**')).toBe(true);
      expect(x.corps.length).toBeLessThanOrEqual(MORCEAU_MAX);
    }
    for (let i = 0; i < 80; i++) expect(encadre.some((x) => x.corps.includes(phrase(i))), String(i)).toBe(true);
  });

  it('un intertitre reste avec ce qu’il annonce, et la suite de sa section le porte encore', () => {
    const long = Array.from({ length: 80 }, (_, i) => phrase(i)).join(' ');
    const avant = Array.from({ length: 30 }, (_, i) => `Avant ${i}.`).join(' ');
    const m = decouperFiche({ ...base, corps: `Le chapeau.\n\n${avant}\n\n## Suivre ce que ça donne\n\n${long}` });
    for (const x of m) expect(x.corps.trimEnd().endsWith('## Suivre ce que ça donne'), x.cle).toBe(false);
    for (const x of m.filter((y) => y.corps.includes('Phrase numéro'))) {
      expect(x.corps.startsWith('## Suivre ce que ça donne'), x.cle).toBe(true);
    }
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

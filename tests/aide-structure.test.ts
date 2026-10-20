import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lireFicheDuDepot } from '../src/aide/fiches';
import { CHAPEAU_MAX, TETE_MAX, erreursDeStructure, structureFiche, type SectionFiche } from '../src/aide/structure';

/**
 * LA STRUCTURE D'UNE FICHE (plan du centre d'aide, tâche 1). La fiche est la seule source du bot et des pages publiques ;
 * ce module dit ce qu'elle contient (chapeau, étapes, encadrés), et `erreursDeStructure` refuse ce qui ferait d'une
 * étape un simple paragraphe sans que personne ne le voie.
 */

const fiche = (cle: string) =>
  lireFicheDuDepot(`${cle}.md`, readFileSync(new URL(`../docs/aide/fiches/${cle}.md`, import.meta.url), 'utf8'));
const etapes = (sections: SectionFiche[]) =>
  sections.filter((s): s is Extract<SectionFiche, { type: 'etape' }> => s.type === 'etape');

describe('structureFiche', () => {
  it('lit les étapes d’une fiche réelle dans l’ordre, chacune avec sa tête et son détail', () => {
    // Sans figer le TEXTE de la fiche : elle se réécrit, et un push de `.md` seuls ne lance pas la CI.
    const s = structureFiche(fiche('lancer-une-campagne').corps);
    expect(s.chapeau).not.toBe('');
    const e = etapes(s.sections);
    expect(e.length).toBeGreaterThanOrEqual(3);
    expect(e.map((x) => x.numero)).toEqual(e.map((_, i) => i + 1));
    for (const x of e) expect(x.tete, `étape ${x.numero}`).not.toBe('');
    // Des paragraphes de détail appartiennent à leur étape, ils ne deviennent pas de la prose.
    expect(e.some((x) => x.detail.length > 0)).toBe(true);
  });

  it('garde un encadré à sa place entre deux étapes, et la prose d’avant la première étape', () => {
    const corps = [
      'Le chapeau.',
      'Une phrase d’introduction.',
      '**1. Premier.** Faire ceci.',
      'Un détail du premier.',
      '**Bon à savoir.** Une mise en garde.',
      '**2. Second.** Faire cela.',
    ].join('\n\n');
    const s = structureFiche(corps);
    expect(s.chapeau).toBe('Le chapeau.');
    expect(s.sections.map((x) => x.type)).toEqual(['prose', 'etape', 'encadre', 'etape']);
    expect(s.sections[1]).toEqual({
      type: 'etape', numero: 1, titre: 'Premier', tete: 'Faire ceci.',
      detail: [{ type: 'paragraphe', texte: 'Un détail du premier.' }],
    });
    expect(s.sections[2]).toEqual({ type: 'encadre', texte: 'Une mise en garde.' });
  });

  it('lit l’encadré anglais, les intertitres, les listes et les lignes coupées', () => {
    const corps = [
      'The lead,\nwrapped on two lines.',
      '## A heading',
      'Some prose:',
      '- **One** : first item,\n  continued.\n- Two.',
      '**Good to know.** A warning.',
    ].join('\n\n');
    const s = structureFiche(corps, 'en');
    expect(s.chapeau).toBe('The lead, wrapped on two lines.');
    expect(s.sections).toEqual([
      { type: 'prose', titre: 'A heading', blocs: [
        { type: 'paragraphe', texte: 'Some prose:' },
        { type: 'liste', items: ['**One** : first item, continued.', 'Two.'] },
      ] },
      { type: 'encadre', texte: 'A warning.' },
    ]);
  });

  it('une fiche sans étape se lit en prose, et ne lève jamais, même vide', () => {
    const s = structureFiche(fiche('la-fenetre-de-24-heures').corps);
    expect(etapes(s.sections)).toHaveLength(0);
    expect(s.chapeau).not.toBe('');
    expect(structureFiche('')).toEqual({ chapeau: '', sections: [] });
  });
});

describe('erreursDeStructure', () => {
  const bonne = ['Le chapeau.', '**1. Premier.** Faire ceci.', '**2. Second.** Faire cela.'].join('\n\n');

  it('rien à redire sur une fiche qui suit la grammaire', () => {
    expect(erreursDeStructure(bonne, 'fr')).toEqual([]);
  });

  it('signale un numéro sauté', () => {
    const corps = ['Le chapeau.', '**1. A.** x.', '**3. B.** y.'].join('\n\n');
    expect(erreursDeStructure(corps, 'fr').join(' ')).toMatch(/num[ée]ro/i);
  });

  it('signale un marqueur mal écrit, qui ferait d’une étape un simple paragraphe', () => {
    for (const faux of ['**3 . Titre.** x.', '**2.Titre.** x.', '**2. Titre** x.']) {
      const corps = ['Le chapeau.', '**1. A.** x.', faux].join('\n\n');
      expect(erreursDeStructure(corps, 'fr'), faux).not.toEqual([]);
    }
  });

  it('🔴 signale une étape ou un encadré collé au paragraphe d’avant, sans ligne vide (il disparaîtrait dans l’étape précédente)', () => {
    expect(erreursDeStructure(['Le chapeau.', '**1. A.** x.', '**2. B.** Faire cela.\n**3. C.** Puis ceci.'].join('\n\n'), 'fr')).not.toEqual([]);
    expect(erreursDeStructure(['Le chapeau.', '**1. A.** x.\n**Bon à savoir.** y.'].join('\n\n'), 'fr')).not.toEqual([]);
  });

  it('une liste numérotée collée sous un paragraphe est signalée (elle serait recollée en un seul paragraphe)', () => {
    expect(erreursDeStructure(['Le chapeau.', 'Faites ceci :\n1. Ouvrir.\n2. Fermer.'].join('\n\n'), 'fr')).not.toEqual([]);
  });

  it('une ligne coupée qui commence par un nombre et un point n’est pas une liste numérotée', () => {
    expect(erreursDeStructure(['Le chapeau.', 'Le plafond passe de 10 à\n15. Il se règle dans Paramètres.'].join('\n\n'), 'fr')).toEqual([]);
  });

  it('signale un « Bon à savoir » sans son gras, et celui d’une autre langue', () => {
    expect(erreursDeStructure(['Le chapeau.', 'Bon à savoir : x.'].join('\n\n'), 'fr')).not.toEqual([]);
    expect(erreursDeStructure(['Le chapeau.', '**Good to know.** x.'].join('\n\n'), 'fr')).not.toEqual([]);
  });

  it('refuse ce que la page ne sait pas rendre : accent grave, lien, italique, titre de niveau 1 ou 3, liste numérotée', () => {
    for (const faux of ['Un `code`.', 'Un [lien](https://x.fr).', 'Un *mot* penché.', '# Titre', '### Titre', '1. Un point.']) {
      expect(erreursDeStructure(['Le chapeau.', faux].join('\n\n'), 'fr'), faux).not.toEqual([]);
    }
  });

  it('borne le chapeau et la tête d’une étape', () => {
    expect(erreursDeStructure('a'.repeat(CHAPEAU_MAX), 'fr')).toEqual([]);
    expect(erreursDeStructure('a'.repeat(CHAPEAU_MAX + 1), 'fr')).not.toEqual([]);
    expect(erreursDeStructure(['Le chapeau.', `**1. A.** ${'b'.repeat(TETE_MAX + 1)}`].join('\n\n'), 'fr')).not.toEqual([]);
  });

  it('refuse une fiche sans chapeau, ou une étape sans tête', () => {
    expect(erreursDeStructure('', 'fr')).not.toEqual([]);
    expect(erreursDeStructure('**1. A.** x.', 'fr')).not.toEqual([]);
    expect(erreursDeStructure(['Le chapeau.', '**1. A.**'].join('\n\n'), 'fr')).not.toEqual([]);
  });
});

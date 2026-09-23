import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MODELES_CHOISIS } from '../src/agent/modeles';
import { fournisseurDuModele, logoDuModele, pastilleDuModele } from '../web/lib/logos-llm';

/**
 * 🔴 TOUT FOURNISSEUR DU CATALOGUE A UN LOGO, OU DIT POURQUOI IL N'EN A PAS.
 *
 * Sans ce test, ajouter un modèle d'un fournisseur neuf au catalogue donnerait une pastille grise dans
 * l'en-tête, en silence, et personne ne le saurait avant de tomber dessus. C'est le même motif que la liste
 * des sections d'aide sans fiche : l'absence doit être une DÉCISION, pas un oubli.
 */
const RACINE = resolve(__dirname, '..');
const DOSSIER = join(RACINE, 'web', 'public', 'llm');

/** Les fournisseurs qu'on assume SANS logo, avec la raison. Vide aujourd'hui : les cinq marques du
 * catalogue sont déposées dans `web/public/llm/`. Reste déclarée pour qu'un fournisseur ajouté demain
 * sans logo puisse encore se dispenser. */
const SANS_LOGO: ReadonlyMap<string, string> = new Map([]);

describe('les logos de fournisseurs de modèles', () => {
  it('🔴 chaque fournisseur du catalogue a son fichier, ou sa dispense écrite', () => {
    const manquants = [...new Set(MODELES_CHOISIS.map((m) => fournisseurDuModele(m.id)))]
      .filter((f): f is string => f !== null)
      .filter((f) => !existsSync(join(DOSSIER, `${f}.png`)) && !SANS_LOGO.has(f));
    expect(manquants, 'fournisseur(s) du catalogue sans logo : déposez `web/public/llm/<fournisseur>.png`, '
      + 'ou inscrivez-le dans SANS_LOGO avec sa raison').toEqual([]);
  });

  it('⚠️ et la dispense ne survit pas au fournisseur qu elle dispense', () => {
    // Sans ce sens-là, retirer un modèle du catalogue laisserait une dispense permanente pour un
    // fournisseur qui n'existe plus, pendant qu'un neuf passerait inaperçu.
    const reels = new Set(MODELES_CHOISIS.map((m) => fournisseurDuModele(m.id)));
    expect([...SANS_LOGO.keys()].filter((f) => !reels.has(f))).toEqual([]);
  });

  it('le logo se dérive du PRÉFIXE, et son alt est VIDE', () => {
    const l = logoDuModele('anthropic/claude-haiku-4.5');
    expect(l).toEqual({ src: '/llm/anthropic.png', alt: '' });
  });

  it('🔴 un modèle hors catalogue ou sans préfixe rend null, il ne jette pas', () => {
    // Un agent peut porter un modèle « en place, hors liste » : c'est un cas NORMAL de cet écran.
    expect(logoDuModele('fournisseur-inconnu/modele-x')).toBeNull();
    expect(logoDuModele('un-modele-sans-slash')).toBeNull();
    expect(logoDuModele('')).toBeNull();
  });

  it('la pastille de repli rend toujours quelque chose de lisible', () => {
    expect(pastilleDuModele('fournisseur-inconnu/modele-x')).toBe('FO');
    expect(pastilleDuModele('un-modele-sans-slash')).toBe('UN');
  });
});

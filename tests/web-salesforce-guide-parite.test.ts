import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ETAPES_GUIDE } from '../src/salesforce/connexion';

/**
 * 🔴 LES ÉTAPES DU GUIDE SALESFORCE, TROIS FOIS ÉCRITES ET TENUES ALIGNÉES (plan 2026-09-26, lot L1).
 *
 * Le serveur rend chaque manque de la connexion avec son étape (`ETAPES_GUIDE`), la console en garde un miroir
 * (`web/lib/salesforce.ts`, elle ne peut pas importer `src/`), et la page tuto porte une ancre par étape. Une
 * étape ajoutée d'un seul côté donnerait un lien vers une ancre qui n'existe pas, sans erreur nulle part.
 */
const RACINE = resolve(__dirname, '..');
const lire = (f: string): string => readFileSync(resolve(RACINE, f), 'utf8');

describe('les étapes du guide Salesforce', () => {
  it('le miroir de la console est la liste du serveur, dans le même ordre', () => {
    const m = /ETAPES_GUIDE_SALESFORCE = \[([^\]]*)\] as const/.exec(lire('web/lib/salesforce.ts'));
    const miroir = [...(m?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
    expect(miroir).toEqual([...ETAPES_GUIDE]);
  });

  it('la page tuto porte une ancre pour CHAQUE étape, et aucune autre', () => {
    const ids = [...lire('web/app/tuto-salesforce/page.tsx').matchAll(/^\s*id: '([a-z-]+)',$/gm)].map((x) => x[1]);
    expect([...ids].sort()).toEqual([...ETAPES_GUIDE].sort());
  });
});

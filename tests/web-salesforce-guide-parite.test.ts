import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ETAPES_GUIDE } from '../web/lib/partage/salesforce';

/**
 * 🔴 LES ÉTAPES DU GUIDE SALESFORCE ET LES ANCRES DE LA PAGE TUTO (plan 2026-09-26, lot L1).
 *
 * Le serveur rend chaque manque de la connexion avec son étape (`ETAPES_GUIDE`, partagée avec la console), et la
 * page tuto porte une ancre par étape. Une étape sans ancre donnerait un lien qui ne mène nulle part, sans erreur.
 */
const RACINE = resolve(__dirname, '..');
const lire = (f: string): string => readFileSync(resolve(RACINE, f), 'utf8');

describe('les étapes du guide Salesforce', () => {
  it('la page tuto porte une ancre pour CHAQUE étape, et aucune autre', () => {
    const ids = [...lire('web/app/tuto-salesforce/page.tsx').matchAll(/^\s*id: '([a-z-]+)',$/gm)].map((x) => x[1]);
    expect([...ids].sort()).toEqual([...ETAPES_GUIDE].sort());
  });
});

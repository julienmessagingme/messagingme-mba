import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTIONS, HANDLED_BY, SENTIMENTS } from '../src/analysis/schema';
import * as console_ from '../web/lib/analyse';

/**
 * LES CODES D'UNE ANALYSE CÔTÉ CONSOLE SONT CEUX DU SCHÉMA, ET CHACUN A SON LIBELLÉ (Tout sur la fiche, lot 1).
 *
 * La console n'importe jamais `src/` : `web/lib/analyse.ts` porte sa copie de `SENTIMENTS`, `ACTIONS` et
 * `HANDLED_BY`. Une valeur ajoutée au schéma sans libellé s'afficherait en code brut sur la fiche. Il vit à la
 * RACINE : seul `ci.yml` tourne sur un changement de `src/`, et c'est là que la liste change.
 */
const RACINE = resolve(__dirname, '..');
const lire = (chemin: string): string => readFileSync(resolve(RACINE, chemin), 'utf8').split('\r\n').join('\n');
const fr = (f: string): string => f;
const en = (f: string, e?: string): string => e ?? f;

describe('les codes d’une analyse : la console connaît ceux du schéma', () => {
  it('🔴 les trois listes de la console sont celles du schéma, dans le même ordre', () => {
    expect([...console_.SENTIMENTS]).toEqual([...SENTIMENTS]);
    expect([...console_.ACTIONS]).toEqual([...ACTIONS]);
    expect([...console_.TRAITE_PAR]).toEqual([...HANDLED_BY]);
  });

  it('🔴 chaque valeur a un libellé français ET anglais, jamais sa clé brute', () => {
    const paires: Array<[readonly string[], (v: string, t: typeof en) => string]> = [
      [SENTIMENTS, console_.sentimentLabel], [ACTIONS, console_.actionLabel], [HANDLED_BY, console_.traiteParLabel],
    ];
    for (const [valeurs, libelle] of paires) {
      for (const v of valeurs) {
        expect(libelle(v, fr), `pas de libellé français pour ${v}`).not.toBe(v);
        expect(libelle(v, en), `pas de libellé anglais pour ${v}`).not.toBe(v);
      }
    }
  });

  it('⚠️ une valeur inconnue s’affiche telle quelle, jamais vide', () => {
    expect(console_.sentimentLabel('inconnu', fr)).toBe('inconnu');
    expect(console_.actionLabel('inconnu', fr)).toBe('inconnu');
    expect(console_.traiteParLabel('inconnu', fr)).toBe('inconnu');
  });

  it('🔴 les écrans n’en portent plus de copie', () => {
    for (const ecran of ['web/components/ConversationAnalysisCard.tsx', 'web/components/ContactDetail.tsx']) {
      const source = lire(ecran);
      expect(source, `${ecran} n’importe pas @/lib/analyse`).toContain("from '@/lib/analyse'");
      expect(source, `${ecran} porte son propre libellé de sentiment`).not.toContain("case 'negatif'");
      expect(source, `${ecran} porte son propre libellé d’action`).not.toContain("case 'creer_devis'");
      expect(source, `${ecran} porte sa propre liste`).not.toMatch(/const (SENTIMENTS|ACTIONS) =/);
    }
  });
});

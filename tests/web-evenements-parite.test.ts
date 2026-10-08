import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHAMPS_DU_TYPE, TYPES_ABONNABLES, TYPES_DECOCHES_PAR_DEFAUT, TYPE_BESOIN_REPONSE, TYPE_ESSAI } from '../src/evenements/types';
import { TYPES_DOCUMENTES } from '../web/lib/evenements-dictionnaire';
import { PAGES_DOC } from '../web/lib/doc-api-pages';

/**
 * LA DOCUMENTATION DES WEBHOOKS SORTANTS DIT CE QUE LE SERVEUR ENVOIE (lot 12). Un type ou un champ ajouté au contrat
 * (`src/evenements/types.ts`) sans sa ligne de doc, ou une ligne de doc qui survit à un champ retiré, casse ici.
 */
describe('la page « Webhooks sortants » et le contrat du serveur', () => {
  it('🔴 les mêmes types, les mêmes champs, dans le même ordre', () => {
    const doc = Object.fromEntries(TYPES_DOCUMENTES.map((d) => [d.type, [...d.champs]]));
    const serveur = Object.fromEntries(Object.entries(CHAMPS_DU_TYPE).map(([t, c]) => [t, [...c]]));
    expect(doc).toEqual(serveur);
    expect(TYPES_DOCUMENTES.map((d) => d.type)).toEqual([...TYPES_ABONNABLES, TYPE_BESOIN_REPONSE, TYPE_ESSAI]);
  });

  it('les types décochés par défaut sont ceux que la doc annonce', () => {
    expect(TYPES_DOCUMENTES.filter((d) => d.decocheParDefaut).map((d) => d.type).sort()).toEqual([...TYPES_DECOCHES_PAR_DEFAUT].sort());
  });

  it('la page est inscrite dans la carte de la doc, et elle monte le tableau des types', () => {
    const page = PAGES_DOC.find((p) => p.cle === 'webhooks');
    expect(page?.href).toBe('/developers/api/webhooks');
    const src = readFileSync(new URL(`../${page!.fichier}`, import.meta.url), 'utf8');
    expect(src).toMatch(/TYPES_DOCUMENTES\.map/);
    for (const ancre of page!.ancres) expect(src).toContain(`id="${ancre}"`);
  });
});

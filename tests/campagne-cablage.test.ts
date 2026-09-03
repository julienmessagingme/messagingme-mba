import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DU PLAFOND DE CAMPAGNE, LU DANS LA SOURCE (constat B4 de l'audit externe du 2026-09-02).
 *
 * 🔴 POURQUOI CE TEST NE PEUT PAS ÊTRE UN TEST ORDINAIRE. Les tests de la route montent un FAUX câblage : ils
 * prouvent que la route demande bien une sélection bornée, et rien du câblage RÉEL de `src/index.ts`. Or c'est
 * exactement là que le défaut s'était glissé une seconde fois : le câblage relayait
 * `contactIdsForTarget(tenant, target)` vers un contrat qui déclare `(tenant, target, limite)`. Une flèche à
 * DEUX paramètres est parfaitement assignable à un contrat qui en déclare TROIS, donc **le troisième est avalé
 * en silence et le compilateur ne dit rien** : la route passait soigneusement `plafond + 1`, et le store
 * retombait sur son plafond technique de 100 000.
 *
 * C'est le même piège que les `Pick` passe-plats du même audit : ce qui traverse un câblage ne se vérifie pas
 * au type, il se vérifie en le regardant. D'où ce test, qui lit le fichier.
 */
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
/** Sans les commentaires : sinon une explication qui CITE le bon code ferait passer un câblage fautif. */
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('câblage du plafond de campagne', () => {
  it('🔴 la borne est RELAYÉE au store, elle n’est pas avalée par une flèche trop courte', () => {
    // La ligne entière, ancrée : un `toMatch` sur le seul nom de la dépendance passerait aussi sur la version
    // fautive à deux paramètres, qui est précisément celle qu'on veut interdire.
    expect(sansCommentaires, 'la résolution de cible doit relayer sa limite au store')
      .toMatch(/contactIdsForTarget: \(tenant, target, limite\) => contactStore\.contactIdsForTarget\(tenant, target, limite\)/);
    // Et la forme fautive ne doit plus exister DANS LE CÂBLAGE DES CAMPAGNES. Le mini-CRM garde la sienne à
    // deux paramètres, volontairement : ses actions en masse n'ont pas de plafond de campagne à respecter.
    const bloc = sansCommentaires.slice(sansCommentaires.indexOf('plafondDestinataires') - 3000, sansCommentaires.indexOf('plafondDestinataires'));
    expect(bloc, 'aucun câblage de campagne ne doit relayer la cible sans sa limite')
      .not.toMatch(/contactIdsForTarget: \(tenant, target\) =>/);
  });

  it('🔴 « tous les contacts » RÉSOUT ses identifiants bornés, il ne les compte plus', () => {
    // Le compte était une garde sur un nombre que personne n'utilisait ensuite : la campagne se construisait à
    // partir d'un SECOND chargement, plus tard, sans borne. Entre les deux, un import concurrent passait.
    expect(sansCommentaires, 'le chemin « tous les contacts » doit résoudre un jeu d’identifiants borné')
      .toMatch(/identifiantsDeTousLesContacts: \(tenant: string, limite: number\) => contactStore\.contactIdsForTarget\(tenant, \{ filters: \{\} \}, limite\)/);
    // Le compteur d'avant ne doit plus être câblé nulle part : le laisser en place ferait croire à une garde.
    expect(sansCommentaires, 'le compteur d’avant ne doit plus exister').not.toMatch(/compterContacts:/);
  });
});

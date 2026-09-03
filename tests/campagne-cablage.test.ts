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

/**
 * LE CONTRÔLE DES PROPRIÉTÉS EN TROP NE TRAVERSE PAS UN SPREAD (constat C1 du contre-audit du 2026-09-03).
 *
 * 🔴 CE QUE LE COMMENTAIRE DU LOT C1 AFFIRMAIT, ET QUI ÉTAIT FAUX. Après avoir regroupé les capacités du
 * moteur dans un objet `moteur`, le code annonçait qu'une capacité mal orthographiée « ne compile plus, même à
 * l'intérieur du spread conditionnel ». Mesuré au compilateur, c'est l'inverse. Quatre formes, quatre
 * résultats :
 *
 *   1. propriété en trop dans un littéral DIRECT sur une cible typée : refusée (TS2353) ;
 *   2. la même introduite par un SPREAD : passe en silence ;
 *   3. `satisfies` sur le littéral EXTÉRIEUR qui contient le spread : passe en silence ;
 *   4. `satisfies` sur l'objet INTÉRIEUR du spread : refusée (TS2561).
 *
 * Or les capacités du worker qui vivent dans un spread conditionnel sont EXACTEMENT `boutonsTraces` et
 * `jetonsPourContacts`, celles dont l'absence a fait échouer toutes les campagnes à lien tracé le 2026-09-02.
 * Le regroupement en objet a fermé la moitié du trou (la liste recopiée) et le commentaire a annoncé l'autre
 * moitié sans la fermer.
 *
 * ⚠️ POURQUOI CE TEST LIT LA SOURCE plutôt que d'écrire un `@ts-expect-error`. Un `@ts-expect-error` prouve
 * que le compilateur refuse une faute dans le fichier de TEST ; il ne dit rien de la présence de la garde
 * dans `src/worker.ts`, qui est la seule chose qui protège la production. Retirer le `satisfies` du worker
 * laisserait un `@ts-expect-error` parfaitement vert.
 */
const sourceWorker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerSansCommentaires = sourceWorker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('câblage des capacités du moteur de campagne', () => {
  it('🔴 le spread conditionnel porte son propre `satisfies`, sinon il n’est gardé par rien', () => {
    expect(workerSansCommentaires, 'le bloc de capacités conditionnelles doit être contraint sur place')
      .toMatch(/\}\s*satisfies Partial<CapacitesMoteur>\)\),/);
  });

  it('les deux capacités de la panne du 2026-09-02 sont bien DANS le bloc ainsi gardé', () => {
    // Le `satisfies` ne vaut que pour l'objet qu'il conclut : le poser sur un autre bloc laisserait
    // celles-ci sans garde tout en donnant l'apparence d'une.
    const debut = workerSansCommentaires.indexOf('...(dryRun ? {} : ({');
    const fin = workerSansCommentaires.indexOf('satisfies Partial<CapacitesMoteur>', debut);
    expect(debut, 'le spread conditionnel des capacités doit exister').toBeGreaterThan(0);
    expect(fin).toBeGreaterThan(debut);
    const bloc = workerSansCommentaires.slice(debut, fin);
    for (const capacite of ['boutonsTraces', 'jetonsPourContacts', 'getTemplateCarousel', 'getTemplateHeaderMedia']) {
      expect(bloc, `${capacite} doit être dans le bloc gardé`).toContain(`${capacite}:`);
    }
  });
});

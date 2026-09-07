import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DE LA CATÉGORIE D'UN TEMPLATE ENVOYÉ PAR UN SCÉNARIO.
 *
 * 🔴 POURQUOI CE TEST NE PEUT PAS ÊTRE UN TEST ORDINAIRE, et pourquoi il a fallu l'écrire.
 *
 * `logTemplateSent` reçoit son contexte dans un objet FACULTATIF, avec une valeur par défaut. Retirer
 * l'argument aux deux points d'appel de `src/workflow/wiring.ts` **passe le typecheck sans une erreur** et
 * ne fait échouer AUCUN test de `tests/inbox-outbound-log.test.ts` : ceux-ci prouvent que la fonction
 * transmet ce qu'on lui donne, jamais qu'on le lui donne. Mesuré en retirant les deux arguments le
 * 2026-09-07 : `tsc --noEmit` propre, suite verte. Le défaut serait donc revenu en silence.
 *
 * Un facultatif est commode pour l'appelant qui n'a rien à dire, et c'est une trappe pour celui qui a
 * quelque chose à dire et l'oublie. Même famille que le plafond de campagne avalé par une flèche trop
 * courte (`tests/campagne-cablage.test.ts`) : ce qui traverse un câblage ne se vérifie pas au type, il se
 * vérifie en le regardant.
 *
 * CE QUE LE DÉFAUT COÛTAIT : un envoi sans catégorie remonte en VOLUME mais ne produit aucun coût
 * (`estimateCostSeries` ignore la ligne, `src/stats/cost.ts`). L'écran affiche zéro sans rien signaler.
 * Vécu chez le tenant Demo, 22 envois de scénario invisibles du coût estimé.
 */
const source = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8');
/** Sans les commentaires : sinon une explication qui CITE le bon code ferait passer un câblage fautif. */
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('câblage de la catégorie du template (scénario)', () => {
  it('🔴 les DEUX branches de sendTemplate journalisent la catégorie', () => {
    const appels = sansCommentaires.match(/logTemplateSent\([^;]*?\);/g) ?? [];
    // Deux branches, et pas une de moins : « variables déjà résolues » (campagne scénario) et « hints »
    // (réponse au webhook). Leur divergence a déjà laissé le carousel, puis l'en-tête média, non branchés
    // côté campagne : c'est le défaut récurrent de ce couple.
    expect(appels).toHaveLength(2);
    for (const a of appels) {
      expect(a, `cet appel n’a pas de contexte : ${a}`).toMatch(/templateCategory:/);
    }
  });

  it('🔴 chaque branche lit la catégorie de SA propre lecture de template', () => {
    // Le piège est ici : les deux branches lisent le template dans des variables différentes
    // (`luCampagne` côté campagne, `info` côté hints). Recopier l'une dans l'autre compilerait et
    // journaliserait une catégorie qui n'est pas celle du template envoyé.
    expect(sansCommentaires, 'la branche campagne doit lire luCampagne')
      .toMatch(/logTemplateSent\(inboxStore, tenant, waId, name, res\.messageId, \{ templateCategory: luCampagne\?\.category \?\? null \}\)/);
    expect(sansCommentaires, 'la branche hints doit lire info')
      .toMatch(/logTemplateSent\(inboxStore, tenant, waId, name, res\.messageId, \{ templateCategory: info\.category \?\? null \}\)/);
  });

  it('🔴 la catégorie est LUE de la réponse Meta, jamais devinée du nom du template', () => {
    // Elle ne coûte aucun appel : `tplClient.list` demande déjà `category` dans ses `fields`
    // (`src/meta/templates.ts`) et la rend. `TplInfo` la jetait, c'est tout ce qui manquait.
    expect(sansCommentaires, 'templateVarInfo doit conserver la catégorie rendue par Meta')
      .toMatch(/category: tpl\.category\.toLowerCase\(\)/);
    // Minuscules : Meta rend 'MARKETING'/'UTILITY', la base stocke 'marketing'/'utility' côté campagne, et
    // `estimateCostSeries` compare en minuscules. Sans l'alignement, la ligne remonte et reste à zéro,
    // c'est-à-dire exactement le défaut qu'on répare, sous une autre forme.
    expect(sansCommentaires, 'aucune catégorie ne doit être déduite du nom du template')
      .not.toMatch(/category:\s*(name|templateName)\b/);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LES SEUILS DE L'ÉCRAN D'EXPLOITATION (contre-audit du 2026-09-03).
 *
 * 🔴 CE QUI ÉTAIT FAUX, ET POURQUOI ÇA NE SE VOYAIT PAS. La carte de latence colorait en rouge la seule
 * ATTENTE avant prise. Or le SLO 1 promet qu'un message entrant est TRAITÉ en moins de trente secondes, donc
 * l'attente PLUS le traitement, et le type du serveur le disait déjà : le bout en bout est « ce que
 * l'utilisateur ressent réellement ». Une file prise en une seconde et traitée en quarante-cinq restait donc
 * verte pendant que l'objectif était violé, et cette couleur est la SEULE alarme du produit sur la latence.
 * Le cas n'est pas théorique : `agent-turn` est un appel modèle, sa durée vit presque entièrement dans le
 * traitement, donc cette file serait restée verte quelle que soit la lenteur du modèle. Les mesures de
 * production le montraient déjà en petit, `campaign-run` affichant 0,11 s d'attente pour 2,1 s de bout en bout.
 *
 * ⚠️ CE TEST LIT LA SOURCE, et il faut savoir ce que ça vaut. Il ne prouve pas le rendu, il prouve que la
 * règle écrite est la bonne. C'est le même parti que `api-base.test.ts` : sur une page qui n'a pas de harnais
 * de rendu, un test de source vaut mieux qu'un seuil que personne ne relit.
 */
const source = readFileSync(new URL('../app/ops/page.tsx', import.meta.url), 'utf8');
const sansCommentaires = source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('carte de latence : ce qui déclenche le rouge', () => {
  it('🔴 le bout en bout a son propre seuil, il n’est plus affiché sans alarme', () => {
    expect(sansCommentaires, 'le bout en bout doit être comparé au seuil')
      .toMatch(/l\.boutEnBoutP95Secondes >= SEUIL_S/);
  });

  it('l’attente garde le sien : les deux mesures ne se corrigent pas au même endroit', () => {
    // Remplacer l'un par l'autre aurait fermé un trou en en ouvrant un second : une file dont l'attente
    // explose mais dont le traitement reste court redeviendrait verte.
    expect(sansCommentaires).toMatch(/l\.attenteP95Secondes >= SEUIL_S/);
  });

  it('🔴 le seuil est une constante NOMMÉE, plus un littéral recopié', () => {
    // Deux littéraux `30` à deux endroits, c'est deux endroits à corriger le jour où le SLO bouge, et un seul
    // qu'on corrigera.
    expect(sansCommentaires).toMatch(/const SEUIL_S = 30;/);
    expect(sansCommentaires, 'plus aucune comparaison à un 30 en dur').not.toMatch(/Secondes >= 30\b/);
  });

  it('le pire cas est AFFICHÉ : il était calculé, transporté, et lu par personne', () => {
    // Il tient lieu de p99, que le document de SLO promettait et que rien ne mesurait. Sur les effectifs
    // réels du produit un p99 vaudrait le maximum, et le maximum le majore dans tous les cas.
    expect(sansCommentaires).toMatch(/l\.boutEnBoutMaxSecondes/);
  });

  it('la carte DIT que les jobs échoués n’y sont pas', () => {
    // Le fait était divulgué, sa conséquence non : un mauvais jour peut afficher un excellent p95, puisque
    // les jobs qui ont échoué en sont absents. La phrase renvoie vers la carte qui les compte.
    expect(source).toMatch(/les jobs échoués n’y figurent pas/);
  });
});

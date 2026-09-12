import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * TOUT PLAN DIT PAR QUELLE MÉTHODE IL SERA LIVRÉ, et ce test l'exige (2026-09-12).
 *
 * 🔴 POURQUOI UN TEST ET PAS UNE CONSIGNE. La demande de Julien est « qu'on se pose la question
 * systématiquement », et une règle systématique qui repose sur la mémoire de celui qui l'applique a déjà
 * échoué dans ce workspace : c'est mot pour mot l'histoire du hook `workflow-autorisation.js`, écrit après
 * qu'une consigne identique n'a pas tenu deux jours. Le remède qui marche est le même à chaque fois : rendre
 * l'oubli MÉCANIQUEMENT visible.
 *
 * 🔴 CE QUE LE CHOIX DÉCIDE, et pourquoi il se fait AVANT. « Le problème n'est pas le temps que ça met, mais
 * le temps que ça prendrait si c'est livré n'importe comment » (Julien, 2026-09-12). Une feature qui touche
 * un chemin que la production emprunte ne se livre pas comme un écran isolé : un message parti ne se rappelle
 * pas, un chiffre faux fait prendre une décision. Choisir après coup, c'est choisir la méthode qu'on a déjà
 * suivie.
 *
 * ⚠️ CE TEST NE JUGE PAS LE CHOIX, il exige qu'il soit ÉCRIT et argumenté. Une méthode légère sur un lot
 * léger est un bon choix ; ne pas avoir posé la question n'en est pas un. Taxer le travail trivial de
 * cérémonie ferait contourner la règle, ce qui est pire que de ne pas l'avoir.
 *
 * ⚠️ IL NE S'APPLIQUE QU'AUX PLANS ÉCRITS À PARTIR DE LA DATE DE LA RÈGLE. Les dix plans antérieurs ont été
 * livrés, leur méthode est de l'histoire : les rouvrir pour y écrire un choix rétrospectif produirait une
 * justification inventée, c'est-à-dire exactement ce que ce dépôt combat.
 */

const RACINE = resolve(__dirname, '..');
const DOSSIER = join(RACINE, 'docs', 'superpowers', 'plans');

/** Le jour où la règle a été posée. Un plan nommé avant n'y est pas soumis. */
const DEPUIS = '2026-09-12';

/** La section obligatoire, au mot près : c'est elle que la consigne globale nomme. */
const SECTION = '## Méthode de livraison';

/**
 * Les quatre méthodes connues.
 *
 * ⚠️ Une seule suffit, et la liste est OUVERTE par construction : le jour où une cinquième apparaît, c'est
 * ce tableau qu'on étend, et le test dira alors aux plans en cours qu'elle existe. Une liste fermée aurait
 * transformé ce contrôle en frein à l'invention d'une meilleure façon de faire.
 */
const METHODES = ['en direct', 'feature-loop', 'implémenteur', 'workflow'];

/** Les plans soumis à la règle : nommés `AAAA-MM-JJ-...`, à partir de la date de la règle. */
function plansSoumis(): string[] {
  return readdirSync(DOSSIER)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(f))
    .filter((f) => f.slice(0, 10) >= DEPUIS);
}

describe('tout plan dit par quelle méthode il sera livré', () => {
  it('il y a bien des plans soumis à la règle, sinon ce test ne prouve rien', () => {
    // 🔴 LA GARDE DE LA GARDE. Sans ce cas, un `forEach` sur une liste vide rendrait ce fichier VERT tout en
    // ne vérifiant rien, et personne ne s'en apercevrait : c'est le mode de panne le plus silencieux d'un
    // test qui boucle sur un dossier.
    expect(plansSoumis().length).toBeGreaterThan(0);
  });

  for (const fichier of plansSoumis()) {
    describe(fichier, () => {
      const contenu = readFileSync(join(DOSSIER, fichier), 'utf8');

      it('porte la section « Méthode de livraison »', () => {
        expect(contenu).toContain(SECTION);
      });

      it('nomme une méthode connue', () => {
        const apres = contenu.slice(contenu.indexOf(SECTION)).toLowerCase();
        expect(METHODES.some((m) => apres.includes(m.toLowerCase()))).toBe(true);
      });

      it('dit POURQUOI cette méthode, et pas seulement laquelle', () => {
        // Le choix sans sa raison ne se relit pas : six mois plus tard, personne ne sait si la méthode a été
        // pesée ou copiée du plan d'à côté. On exige donc un mot de causalité dans la section.
        const section = contenu.slice(contenu.indexOf(SECTION));
        const fin = section.indexOf('\n## ', 1);
        const corps = (fin > 0 ? section.slice(0, fin) : section).toLowerCase();
        expect(/parce que|car |raison|pourquoi/.test(corps)).toBe(true);
      });

      it('nomme l’essai RÉEL qui clôt la feature', () => {
        // 🔴 AUCUNE MÉTHODE NE REMPLACE ÇA, et c'est la leçon mesurée du chantier des campagnes : les tests
        // d'interface sont écrits par celui qui a écrit le composant, donc ils vérifient ce qu'il a pensé à
        // vérifier, et un mécanisme qui n'a jamais tourné sur de vraies données n'est pas éprouvé, il est
        // seulement vert. Le plan doit dire par quel geste réel on saura que ça marche.
        const section = contenu.slice(contenu.indexOf(SECTION));
        const fin = section.indexOf('\n## ', 1);
        const corps = (fin > 0 ? section.slice(0, fin) : section).toLowerCase();
        expect(/essai r|essai é|vérification réelle|sur un vrai|en vrai/.test(corps)).toBe(true);
      });
    });
  }
});

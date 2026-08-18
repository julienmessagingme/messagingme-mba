import type { Locale } from './locale';
import type { MbaFaqPreview, MbaFaqImportResult } from './api-mba';

/**
 * Mise en mots d'un aperçu et d'un résultat d'import de FAQ. Fonctions PURES, sorties des composants pour être
 * testables : vitest ne rend aucun composant React dans ce projet, donc ce qui n'est pas ici n'est vérifié que
 * par un test de bout en bout.
 */

/** Compteurs d'un aperçu, prêts à afficher. */
export function resumeApercu(plan: MbaFaqPreview, locale: Locale): string {
  const fr = locale === 'fr';
  const n = plan.aCreer.length;
  const m = plan.aMettreAJour.length;
  if (n === 0 && m === 0) {
    return fr
      ? `Rien à écrire : les ${plan.inchangees} questions de cette source sont déjà en place à l’identique.`
      : `Nothing to write: all ${plan.inchangees} questions in this source are already in place, unchanged.`;
  }
  const morceaux = fr
    ? [n > 0 ? `${n} à créer` : '', m > 0 ? `${m} à mettre à jour` : '', plan.inchangees > 0 ? `${plan.inchangees} inchangée${plan.inchangees > 1 ? 's' : ''}` : '']
    : [n > 0 ? `${n} to create` : '', m > 0 ? `${m} to update` : '', plan.inchangees > 0 ? `${plan.inchangees} unchanged` : ''];
  return morceaux.filter((p) => p !== '').join(', ') + '.';
}

/**
 * Résultat d'un import. Le cas interrompu (réponse 207) n'est PAS un échec : une partie est écrite. Le message
 * doit dire ce qui reste ET que relancer la même source ne duplique rien, sinon le réflexe est de tout refaire
 * depuis zéro en croyant que rien n'est passé.
 */
export function resumeImport(res: MbaFaqImportResult, locale: Locale): { kind: 'success' | 'warning'; texte: string } {
  const fr = locale === 'fr';
  const ecrit = fr
    ? `${res.created} créée${res.created > 1 ? 's' : ''}, ${res.updated} mise${res.updated > 1 ? 's' : ''} à jour, ${res.unchanged} inchangée${res.unchanged > 1 ? 's' : ''}.`
    : `${res.created} created, ${res.updated} updated, ${res.unchanged} unchanged.`;

  if (res.failed === null) return { kind: 'success', texte: ecrit };

  return {
    kind: 'warning',
    texte: fr
      ? `${ecrit} L’import s’est arrêté sur « ${res.failed.question} » : ${res.failed.error}. Il reste ${res.remaining} question${res.remaining > 1 ? 's' : ''}. Relancez la même source : ce qui est déjà écrit ne sera pas dupliqué.`
      : `${ecrit} The import stopped on “${res.failed.question}”: ${res.failed.error}. ${res.remaining} question(s) left. Re-run the same source: what is already written will not be duplicated.`,
  };
}

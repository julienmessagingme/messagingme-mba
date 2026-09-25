import type { FlowRefreshReport } from './api';

/**
 * Phrase de compte-rendu du bouton « Rafraîchir » de l'écran Formulaires.
 *
 * Pure et isolée de l'écran pour être testée : c'est le SEUL endroit où l'utilisateur apprend qu'un
 * formulaire importé n'a pas la même portée qu'un formulaire construit ici (ses réponses ne remplissent
 * aucune fiche contact, faute de structure renvoyée par Meta). Une phrase muette ferait passer cette
 * différence pour un bug, plus tard, en production.
 */
export function messageRafraichissement(r: FlowRefreshReport, t: (fr: string, en: string) => string): string {
  const s = (n: number) => (n > 1 ? 's' : '');
  const parties: string[] = [];
  if (r.importes > 0) parties.push(t(`${r.importes} formulaire${s(r.importes)} importé${s(r.importes)}`, `${r.importes} form${s(r.importes)} imported`));
  if (r.majs > 0) parties.push(t(`${r.majs} mis à jour`, `${r.majs} updated`));
  if (r.ignores > 0) {
    parties.push(t(`${r.ignores} ignoré${s(r.ignores)} (déprécié ou bloqué chez Meta)`, `${r.ignores} skipped (deprecated or blocked on Meta)`));
  }
  if (r.absents > 0) {
    // Volontairement pas supprimés : effacer ici perdrait le rattachement d'un retour de formulaire encore
    // en vol à sa fiche contact. On informe, l'utilisateur décide.
    parties.push(t(`${r.absents} présent${s(r.absents)} ici mais plus chez Meta`, `${r.absents} present here but no longer on Meta`));
  }
  if (parties.length === 0) return t('Aucun changement : la liste est déjà à jour.', 'No change: the list is already up to date.');

  const phrase = `${parties.join(', ')}.`;
  if (r.importes === 0) return phrase;
  return `${phrase} ${t(
    "Un formulaire importé s’envoie normalement, mais ses réponses n’alimentent pas les fiches contact : Meta ne renvoie pas sa structure.",
    'An imported form sends normally, but its answers do not fill in contact records: Meta does not return its structure.',
  )}`;
}

import type { CanalEtage } from './campagne-chaine';

/**
 * QUELS SCÉNARIOS PEUVENT OUVRIR CET ÉTAGE.
 *
 * 🔴 UN ÉTAGE A UN CANAL, UN SCÉNARIO A UN CANAL D'OUVERTURE, ET LES DEUX DOIVENT COÏNCIDER. Proposer sur
 * un étage de repli RCS un scénario qui ouvre par un modèle WhatsApp produit une campagne que Meta refuse
 * ENTIÈREMENT, pas un destinataire : le coût d'un faux positif n'est pas un envoi raté, c'est la campagne.
 *
 * ⚠️ C'est une fonction PURE et elle vit dans `web/lib/` pour ça : c'est le seul endroit du front qui se
 * teste sans navigateur.
 */

/** Le strict nécessaire pour trier : le reste de la fiche ne regarde pas cette règle. */
export interface ScenarioChoisissable {
  id: string;
  name: string;
  /**
   * Par quoi il ouvre. `null` = il ne peut ouvrir aucune campagne.
   *
   * ⚠️ ABSENT = UN SERVEUR PLUS ANCIEN qui ne rend pas encore le champ, et c'est le cas qui décide de la
   * forme de cette fonction (cf. `scenariosPourEtage`).
   */
  canalOuverture?: 'whatsapp' | 'rcs' | null;
}

export function scenariosPourEtage<T extends ScenarioChoisissable>(
  scenarios: readonly T[],
  canal: CanalEtage,
): T[] {
  /**
   * 🔴 AUCUN SCÉNARIO N'OUVRE UN E-MAIL. Le canal d'ouverture ne vaut que `whatsapp` ou `rcs` : un étage
   * e-mail n'a donc rien à se voir proposer. Ce n'est pas une question de version de serveur, c'est une
   * propriété du produit, d'où le traitement à part.
   */
  if (canal === 'email') return [];
  return scenarios.filter((s) => {
    /**
     * ⚠️ ABSENT = ON GARDE, et c'est le choix qui compte ici. Masquer ce qu'on ne sait pas ferait
     * disparaître TOUTE la liste au premier déploiement partiel (le front part sur Vercel à chaque push,
     * l'API suit à la main) : l'écran annoncerait « aucun scénario lançable sur cet espace » à un client
     * qui en a douze. Le récapitulatif refuse de toute façon ce qui ne peut pas ouvrir l'étage, donc la
     * pire conséquence d'un choix trop large est un refus expliqué au moment du lancement.
     */
    if (s.canalOuverture === undefined) return true;
    return s.canalOuverture === canal;
  });
}

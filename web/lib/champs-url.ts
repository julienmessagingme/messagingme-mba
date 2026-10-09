/**
 * Les champs du contact dans l'adresse d'un bouton « Lien » : `https://site.fr/commande/{numero_commande}`. Fonctions
 * PURES, sans IO.
 *
 * Le serveur soumet à Meta notre lien tracé, et notre redirection remplit chaque `{cle}` au clic avec la fiche de
 * celui qui clique. 🔴 Un champ ne se trouve qu'APRÈS le nom du site : une valeur de fiche peut être écrite par le
 * contact lui-même, et dans l'hôte elle ferait de notre domaine un redirecteur ouvert.
 *
 * La règle (`analyserChampsUrl`) est partagée avec le serveur (`./partage/champs-url`). Les MESSAGES, eux, vivent dans
 * le formulaire (traduits).
 */
import { analyserChampsUrl, MOTIF_CHAMP } from './partage/champs-url';

/** Une valeur d'exemple plausible pour un champ, dans l'aperçu de l'adresse. */
export function exempleDeChamp(cle: string): string {
  switch (cle) {
    case 'prenom': return 'Marie';
    case 'nom': return 'Martin';
    case 'telephone': return '+33612345678';
    default: return 'A1234';
  }
}

/**
 * L'adresse telle qu'un contact la recevrait, chaque champ remplacé par une valeur d'exemple encodée comme le fera la
 * redirection. `null` si l'adresse ne porte aucun champ, ou si elle est refusée.
 */
export function exempleUrl(brut: string): string | null {
  const a = analyserChampsUrl(brut);
  if (!a.ok || a.cles.length === 0) return null;
  return brut.trim().replace(MOTIF_CHAMP, (_m, cle: string) => encodeURIComponent(exempleDeChamp(cle)));
}

/**
 * L'INTERRUPTEUR HUBSPOT DE L'ESPACE, vu de la console (migration 0179, design validé par Julien le 2026-09-25).
 *
 * Les décisions d'affichage vivent ici, en fonctions pures, pour être testées sans navigateur. L'Accueil et
 * la carte de Paramètres > Intégrations les appellent ; aucun des deux ne refait le calcul à sa façon.
 */

/**
 * La valeur de l'interrupteur, ou `undefined` quand l'API ne la rend pas.
 *
 * 🔴 `undefined` N'EST PAS `false`. Une API antérieure à 0179 ne rend pas le champ, et la console se publie
 * AVANT l'API : lire l'absence comme « éteint » ferait disparaître le bloc HubSpot de l'Accueil d'un client
 * qui s'en sert, pendant toute la fenêtre entre les deux déploiements.
 */
export function lireHubspotActif(reglages: { hubspotActif?: unknown } | null | undefined): boolean | undefined {
  const v = reglages?.hubspotActif;
  return typeof v === 'boolean' ? v : undefined;
}

/** Ce que l'Accueil montre de HubSpot : le bloc, une ligne qui renvoie vers Paramètres, ou rien. */
export type AffichageHubspotAccueil = 'bloc' | 'renvoi' | 'rien';

/**
 * Le bloc HubSpot de l'Accueil s'affiche dès que l'interrupteur est allumé, numéro ou pas.
 *
 * ⚠️ TROIS CAS, et chacun a sa raison :
 * - interrupteur inconnu (API plus ancienne) : le comportement d'avant, le bloc suit la présence d'un numéro ;
 * - interrupteur éteint MAIS portail relié : le bloc quand même. L'état est atteignable (on éteint pendant que
 *   la connexion ouverte dans un autre onglet aboutit), et cacher le bloc cacherait la seule porte de sortie,
 *   la « Déconnexion complète » ;
 * - éteint, sans portail : une ligne discrète renvoie vers Paramètres > Intégrations, où il s'allume.
 */
export function affichageHubspotAccueil(p: { actif: boolean | undefined; aUnNumero: boolean; portailRelie: boolean }): AffichageHubspotAccueil {
  if (p.actif === undefined) return p.aUnNumero ? 'bloc' : 'rien';
  if (p.actif || p.portailRelie) return 'bloc';
  return 'renvoi';
}

/**
 * Ce que la carte de Paramètres > Intégrations permet.
 *
 * 🔴 L'EXTINCTION EST BLOQUÉE TANT QU'UN PORTAIL EST RELIÉ, comme côté serveur (qui rend 409) : l'écran le
 * dit AVANT le clic plutôt que de laisser l'administrateur découvrir le refus. Allumer, jamais bloqué.
 * ⚠️ `portailRelie` inconnu : ni blocage ni proposition de connexion, on ne promet rien qu'on n'a pas lu.
 */
export function etatCarteHubspot(p: { actif: boolean; portailRelie: boolean | undefined }): { extinctionBloquee: boolean; proposerConnexion: boolean } {
  return {
    extinctionBloquee: p.actif && p.portailRelie === true,
    proposerConnexion: p.actif && p.portailRelie === false,
  };
}

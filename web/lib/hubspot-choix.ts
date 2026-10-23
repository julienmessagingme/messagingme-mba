import type { ChoixHubspot, TenantSettings } from './api';
import type { FonctionOffre } from './offre';

/**
 * LE CHOIX DES FONCTIONS HUBSPOT (lot 1bis, `components/ReglageHubspot.tsx`) : la logique de l'écran, en fonctions
 * pures, testées dans `hubspot-choix.test.ts`.
 */

/** Où en est l'écran : lecture, rien de relié, étape de choix à valider, ou choix déjà fait. */
export type EtapeHubspot = 'lecture' | 'echec' | 'connecter' | 'choisir' | 'regle';

export function etapeHubspot(p: { lecture: 'en_cours' | 'ok' | 'echec'; relie: boolean | undefined; valideLe: string | null | undefined }): EtapeHubspot {
  if (p.lecture === 'en_cours') return 'lecture';
  if (p.lecture === 'echec' || p.relie === undefined) return 'echec';
  if (!p.relie) return 'connecter';
  // Une API antérieure au lot 1bis ne rend pas la date (`undefined`) : on ne propose pas une étape qu'elle ne sait
  // pas enregistrer, on montre le choix tel qu'il est.
  return p.valideLe === null ? 'choisir' : 'regle';
}

/** La fonction d'offre qu'il faut pour ALLUMER une ligne. Éteindre n'en demande jamais. */
export const FONCTION_REQUISE: Partial<Record<keyof ChoixHubspot, FonctionOffre>> = {
  analyse: 'analyse',
  listes: 'crm',
  reponse: 'inbox',
};

/** La ligne est-elle fermée par l'offre ? `fonctions` absente (offre inconnue) : tout est ouvert, le serveur tranche. */
export function fermeeParLOffre(champ: keyof ChoixHubspot, fonctions: ReadonlySet<FonctionOffre> | null | undefined): boolean {
  const f = FONCTION_REQUISE[champ];
  return f !== undefined && !!fonctions && !fonctions.has(f);
}

/**
 * Le choix proposé à l'étape de choix : ce qui écrit dans HubSpot sans rien ouvrir est coché, ce qui ouvre une porte
 * est décoché (décision 2 du cadrage). Une fonction que l'offre n'ouvre pas est décochée (le serveur refuserait).
 */
export function choixParDefaut(p: { routingMode: 'mm_routing' | 'hubspot_native' | undefined; fonctions: ReadonlySet<FonctionOffre> | null | undefined }): ChoixHubspot {
  return {
    analyse: !fermeeParLOffre('analyse', p.fonctions),
    passage: true,
    injoignable: true,
    reponse: false,
    listes: false,
    taches: p.routingMode !== 'hubspot_native',
  };
}

/**
 * Le choix en vigueur, lu dans les réglages et le portail. Un champ absent prend le défaut de la migration 0251. Une
 * fonction que l'offre ne permet plus (espace descendu d'offre) se lit éteinte : elle ne marche pas, l'écran ne doit
 * pas la dire allumée.
 */
export function choixActuel(s: TenantSettings, routingMode: 'mm_routing' | 'hubspot_native' | undefined, fonctions?: ReadonlySet<FonctionOffre> | null): ChoixHubspot {
  return {
    analyse: s.hubspotAnalyse !== false && !fermeeParLOffre('analyse', fonctions),
    passage: s.hubspotPassage !== false,
    injoignable: s.hubspotInjoignable !== false,
    reponse: s.hubspotReponse === true,
    listes: s.hubspotListsEnabled === true && !fermeeParLOffre('listes', fonctions),
    taches: routingMode !== 'hubspot_native',
  };
}

/**
 * Le corps à envoyer. 🔴 « Créer des tâches » vaut pour tout le PORTAIL et n'est connu que par une lecture qui peut
 * échouer : il ne part qu'à la validation de l'étape de choix s'il est connu, ou quand c'est SA ligne qu'on bascule.
 * Le renvoyer à chaque bascule d'une autre ligne l'écraserait depuis une valeur devinée ou périmée (relecture du lot
 * 1bis, le seul rouge).
 */
export function corpsDuChoix(choix: ChoixHubspot, p: { envoyerTaches: boolean }): Omit<ChoixHubspot, 'taches'> & { taches?: boolean } {
  const { taches, ...reste } = choix;
  return p.envoyerTaches ? { ...reste, taches } : reste;
}

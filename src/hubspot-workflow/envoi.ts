import { compteurEnvoiRefuse, type RapportEnvoi } from '../api/envoi-public';
import { VALEUR_ACCEPTEE } from '../api/modele-envoi';
import { VALEUR_MAX_CARACTERES } from '../http/hubspot-modeles';
import type { EnvoyerPublic } from '../shopify/envoi';
import type { ChampsFiche } from '../campaign/build';

import { PREFIXE_LIGNE_HUBSPOT } from './ligne';

export { PREFIXE_LIGNE_HUBSPOT };

/**
 * L'ENVOI D'UN MODÈLE POUR UN WORKFLOW HUBSPOT, quatrième adaptateur de `lancerEnvoiPublic` après `/v1/sends`, l'outil MCP et
 * Shopify (cadrage `~/mm-hubspot/docs/2026-10-27-action-workflow-modele-cadrage.md`, décisions 1 à 11 validées par Julien
 * le 2026-10-27 ; plan du même jour, lot 1). Le cœur garde tout : la catégorie lue chez Meta (par le cache de cinq
 * minutes du moteur, `templateVarInfo`), STOP et blocage relus à l'envoi, le numéro délié ou suspendu, la limite du mois,
 * la fiche créée pour un numéro inconnu, la clé scellée avec la campagne, l'envoi en file.
 *
 * Les choix de l'adaptateur, et rien d'autre :
 *   - 🔴 AUCUN `consent` dans le destinataire (à l'inverse de Shopify) : l'inscription dans un workflow n'est pas un accord
 *     (décision 3). Et `serviceSeulement` : un modèle Marketing est refusé sur la catégorie que Meta rend ;
 *   - 🔴 la clé `hubspot-workflow:<numéro>:<modèle>:<langue>` : sa vie de 24 h EST la garde « pas deux fois le même modèle
 *     au même contact en 24 h » (décision 11). Un nouvel essai au même corps rejoue le rapport (même `sendId`) ; un autre
 *     corps (d'autres valeurs) rend `deja_envoye`. Le connecteur, qui voit le `callbackId`, distingue un nouvel essai d'une
 *     réinscription ;
 *   - le compteur est celui de l'appelant (les plafonds des workflows, minute et jour comptés ensemble), jamais celui de
 *     l'API ; le cœur l'appelle juste après la clé, donc il compte des TENTATIVES (un STOP ou un numéro délié aussi) ;
 *   - une ligne de Campagnes par envoi, nommée par le workflow, et aucune quand personne ne part (`sansCampagneVide`).
 *
 * LE LANCEMENT D'UN SCÉNARIO (action « Lancer un scénario Messaging Me », cadrage
 * `~/mm-hubspot/docs/2026-10-29-action-workflow-scenario-cadrage.md`, décisions 1 à 10 validées par Julien le 2026-10-29)
 * passe par le même adaptateur, la cible changée : `{ scenario: <code scn_> }`, catégorie `utility` déclarée (le cœur
 * retient la plus stricte des deux, celle qu'il lit chez Meta pour le modèle d'ouverture, donc `serviceSeulement` refuse
 * une ouverture Marketing), la clé `hubspot-workflow-scenario:<numéro>:<code>` (décision 5), et les valeurs en source
 * `literal` : le cœur refuse des variables par destinataire sur un scénario, et un appel n'a qu'un destinataire. Le
 * démarrage a lieu dans le worker, en `workflow_hubspot` (la ligne le décide, `lancementDeCampagne`).
 */

/** Ce qu'un envoi devient, rendu tel quel au connecteur, qui en fait le résultat de l'exécution dans HubSpot. */
export type IssueWorkflow =
  | 'envoye' | 'stop' | 'bloque' | 'sans_numero' | 'fixe' | 'marketing_refuse' | 'modele_refuse' | 'valeur_invalide'
  | 'deja_envoye' | 'plafond_minute' | 'plafond_jour' | 'limite_contacts' | 'limite_modeles' | 'numero_indisponible'
  | 'en_cours' | 'meta_indisponible' | 'refuse'
  // Le lancement d'un scénario : introuvable, ambigu ou plus envoyable ; l'offre sans scénarios ; un opérateur qui tient
  // le fil (décision 3, jugé par la route avant la clé).
  | 'scenario_refuse' | 'hors_offre' | 'conseiller_en_main';

/** Ce qu'un workflow fait partir : un modèle (et sa langue), ou un scénario désigné par son code `scn_`. */
export type CibleWorkflow = { modele: string; langue: string } | { scenario: string };

export interface EnvoiWorkflow {
  tenantId: string;
  /** Le numéro en E.164, déjà normalisé par la route. */
  telephone: string;
  cible: CibleWorkflow;
  /** Les valeurs de {{1}}, {{2}}... dans l'ordre, déjà normalisées (`valeursDuWorkflow`). */
  valeurs: readonly string[];
  /** L'identifiant du workflow HubSpot : le nom de la ligne dans Campagnes (la requête de HubSpot ne porte pas son nom). */
  workflowId: string;
  /** Les champs que l'action transaction écrit sur la fiche, avec la campagne et seulement pour un envoi neuf. */
  champsFiche?: ChampsFiche;
}

/** Le plafond qui a refusé, rempli par le compteur de l'appelant. */
export type PlafondRefuse = 'minute' | 'jour';

/**
 * La clé de l'envoi : le numéro et le modèle (avec sa langue), ou le numéro et le scénario. Sa vie de 24 h borne la
 * répétition (décision 11 de l'action modèle, décision 5 de l'action scénario).
 */
export function cleDuWorkflow(telephone: string, cible: CibleWorkflow): string {
  const numero = telephone.replace(/\D/g, '');
  return 'scenario' in cible
    ? `hubspot-workflow-scenario:${numero}:${cible.scenario}`
    : `hubspot-workflow:${numero}:${cible.modele}:${cible.langue}`;
}

/**
 * Les valeurs telles que Meta les accepte : un retour à la ligne ou une tabulation (fréquents dans une adresse) devient une
 * espace, au plus quatre espaces de suite ; les champs vides de la fin sont retirés (l'action a dix champs fixes). Un vide
 * au milieu, une valeur trop longue ou encore refusée par Meta : `null`.
 */
export function valeursDuWorkflow(brutes: readonly string[]): string[] | null {
  const valeurs = brutes.map((v) => v.replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').trim());
  while (valeurs.length > 0 && valeurs[valeurs.length - 1] === '') valeurs.pop();
  if (valeurs.some((v) => v === '' || v.length > VALEUR_MAX_CARACTERES || !VALEUR_ACCEPTEE.test(v))) return null;
  return valeurs;
}

export async function envoyerPourWorkflow(
  envoyer: EnvoyerPublic, e: EnvoiWorkflow, compter: (unites: number) => Promise<PlafondRefuse | null>,
): Promise<{ issue: IssueWorkflow; sendId?: string }> {
  const cles = e.valeurs.map((_, i) => `v${i + 1}`);
  const scenario = 'scenario' in e.cible;
  const corps = 'scenario' in e.cible
    ? {
      idempotencyKey: cleDuWorkflow(e.telephone, e.cible),
      target: { scenario: e.cible.scenario },
      category: 'utility',
      params: e.valeurs.map((value, i) => ({ position: i + 1, source: { type: 'literal', value } })),
      recipients: [{ phone: e.telephone }],
    }
    : {
      idempotencyKey: cleDuWorkflow(e.telephone, e.cible),
      target: { template: { name: e.cible.modele, language: e.cible.langue } },
      params: cles.map((cle, i) => ({ position: i + 1, source: { type: 'variable', key: cle } })),
      recipients: [{
        phone: e.telephone,
        ...(cles.length > 0 ? { variables: Object.fromEntries(cles.map((cle, i) => [cle, e.valeurs[i] ?? ''])) } : {}),
      }],
    };
  // Rempli par le compteur, dans la fermeture : typé à la déclaration pour que TypeScript ne le fige pas à `null`.
  let plafond = null as PlafondRefuse | null;
  const r = await envoyer(e.tenantId, corps, async (unites) => {
    plafond = await compter(unites);
    return plafond === null;
  }, {
    nom: `${PREFIXE_LIGNE_HUBSPOT}${e.workflowId}`, sansCampagneVide: true, serviceSeulement: true,
    ...(e.champsFiche ? { champsFiche: e.champsFiche } : {}),
  });
  if (compteurEnvoiRefuse(r)) return { issue: plafond === 'jour' ? 'plafond_jour' : 'plafond_minute' };
  const c = r.corps as { code?: unknown; limite?: unknown; categorie?: unknown } | null;
  if (r.statut === 201 || r.statut === 200) return issueDuRapport(r.corps as RapportEnvoi);
  if (r.statut === 402 && c?.code === 'plan_feature_unavailable') return { issue: 'hors_offre' };
  if (r.statut === 402) return { issue: c?.limite === 'envoisModelesMois' ? 'limite_modeles' : 'refuse' };
  if (r.statut === 409 && c?.code === 'idempotency_in_progress') return { issue: 'en_cours' };
  if (r.statut === 409 && c?.code === 'scenario_ambiguous') return { issue: 'scenario_refuse' };
  if (r.statut === 409) return { issue: 'numero_indisponible' };
  // La même clé avec un autre corps : ce modèle est déjà parti à ce numéro, avec d'autres valeurs, dans les 24 h.
  if (r.statut === 422 && c?.code === 'idempotency_key_reused') return { issue: 'deja_envoye' };
  if (r.statut === 422 && c?.code === 'template_rejected' && c.categorie !== undefined && c.categorie !== 'utility') {
    return { issue: 'marketing_refuse' };
  }
  // La catégorie n'a pas pu être lue chez Meta : une panne, que HubSpot doit relancer (décision 6), jamais un refus
  // définitif. L'autre source de ce code (une catégorie non admise, Authentification) n'atteint pas le cœur : la route
  // ne laisse passer que les modèles Service du catalogue.
  if (r.statut === 422 && c?.code === 'template_category_unknown') return { issue: 'meta_indisponible' };
  // Un scénario introuvable, dépublié, qui n'ouvre plus par un modèle envoyable, ou dont le modèle d'ouverture a disparu.
  if (r.statut === 404 || r.statut === 422) return { issue: scenario ? 'scenario_refuse' : 'modele_refuse' };
  return { issue: 'refuse' };
}

function issueDuRapport(rapport: RapportEnvoi): { issue: IssueWorkflow; sendId?: string } {
  if (rapport.recipientCount > 0) return { issue: 'envoye', sendId: rapport.sendId };
  const motif = rapport.skipped[0]?.reason;
  if (motif === 'opted_out') return { issue: 'stop' };
  if (motif === 'blocked_contact') return { issue: 'bloque' };
  if (motif === 'plan_limit_reached') return { issue: 'limite_contacts' };
  if (motif === 'invalid_phone' || motif === 'no_phone' || motif === 'invalid_recipient') return { issue: 'sans_numero' };
  return { issue: 'refuse' };
}

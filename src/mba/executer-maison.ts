import { REPONSE_MAISON, lireValeurChamp, type CibleMaison } from './outils-maison';
import { clesAntiRejeu } from './anti-rejeu';
import type { VerrousCourts } from '../db/verrous-courts';

/**
 * Exécuter un geste de l'agent de Meta pour un contact. Aucun geste n'est réécrit ici : chaque dépendance est la
 * fonction qui le fait déjà ailleurs (pose de tag, écriture de champ, envoi à un bloc, lancement de scénario) ;
 * ce module choisit laquelle et traduit l'issue en ce que l'agent de Meta lit.
 */
export interface DepsMaison {
  /** `creerPoserTagAgent` : pose, déclaration dans Contenus > Tags, `tag_added` si l'étiquette est nouvelle. */
  poserTag(tenantId: string, waId: string, tag: string): Promise<void>;
  ecrireChamp(tenantId: string, waId: string, champ: string, valeur: string): Promise<void>;
  /**
   * Le champ existe-t-il encore dans le mini-CRM ? Sans cette question, un outil dont le champ a été supprimé
   * écrirait sous une clé qu'aucun écran ne montre plus.
   */
  champExiste(tenantId: string, champ: string): Promise<boolean>;
  /** Le contact est-il bloqué dans l'Inbox ? Un contact bloqué ne reçoit rien de nous, pas plus d'un outil. */
  contacts: { isBlockedByWaId(tenantId: string, waId: string): Promise<boolean> };
  /**
   * Envoie le bloc seul (`blocSeul`), par un démarrage au bloc (le type de lancement `agent_meta_bloc`) : il
   * reprend le fil à l'agent de Meta, envoie, et le lui rend à l'accusé. Rend `true`, ou la raison du refus lue
   * par l'agent.
   */
  envoyerBloc(tenantId: string, waId: string, cible: { workflowId: string; code: string }): Promise<true | string>;
  /** Lance le scénario depuis son début, exactement comme le bouton de l'Inbox. Même contrat de retour. */
  lancerScenario(tenantId: string, waId: string, workflowId: string): Promise<true | string>;
  /**
   * Un envoi ne se rejoue pas pour le même client et le même outil, le temps d'une demande (`src/mba/anti-rejeu.ts`).
   * Les verrous courts partagés par les copies de l'API : un rappel servi par une autre copie est refusé aussi.
   */
  antiRejeu: VerrousCourts;
  /**
   * L'identifiant du dernier message reçu du client, ou `null`. Il entre dans la clé de l'anti-rejeu : un rappel
   * dans le même tour partage ce message, une nouvelle demande non.
   */
  inbox: { dernierMessageDuClient(tenantId: string, waId: string): Promise<string | null> };
}

export type IssueMaison = { ok: true; reponse: string } | { ok: false; erreur: string };

/** Ce que l'agent de Meta lit quand le champ visé a été supprimé du mini-CRM. */
export const CHAMP_DISPARU = "Ce champ n'existe plus sur la fiche du client : l'information n'a pas été enregistrée.";

export async function executerOutilMaison(
  deps: DepsMaison,
  input: { tenantId: string; waId: string; outilId: string; cible: CibleMaison; corps: unknown },
): Promise<IssueMaison> {
  const { tenantId, waId, cible } = input;
  switch (cible.handler) {
    case 'tag_fixe':
      await deps.poserTag(tenantId, waId, cible.tag);
      return { ok: true, reponse: REPONSE_MAISON.tag_fixe };
    case 'champ_fixe': {
      if (!(await deps.champExiste(tenantId, cible.champ))) return { ok: false, erreur: CHAMP_DISPARU };
      const lu = lireValeurChamp(cible, input.corps);
      if (!lu.ok) return { ok: false, erreur: lu.erreur };
      await deps.ecrireChamp(tenantId, waId, cible.champ, lu.valeur);
      return { ok: true, reponse: REPONSE_MAISON.champ_fixe };
    }
    case 'bloc_fixe':
    case 'scenario_fixe': {
      // 🔴 Le blocage est lu avant tout envoi : une garde posée après l'effet ne garde rien.
      if (await deps.contacts.isBlockedByWaId(tenantId, waId)) return { ok: false, erreur: CONTACT_BLOQUE };
      // Un rappel du même outil pour le même message du client ne renvoie rien : il répond « déjà traitée », ce qui
      // clôt le tour. Deux clés prises d'un seul geste atomique (des appels simultanés, sur une copie ou sur
      // plusieurs, n'en laissent partir qu'un) : le message du client (une nouvelle demande relance) et un plancher
      // de 30 s (une réaction ou une demande en deux messages ne relance pas). Gardées sur une exception (le message
      // a pu partir), relâchées sur un refus. Une prise qui échoue (base injoignable) lève : rien ne part.
      const dernier = await deps.inbox.dernierMessageDuClient(tenantId, waId);
      const prise = await deps.antiRejeu.prendre(clesAntiRejeu(tenantId, waId, input.outilId, dernier));
      if (prise === null) return { ok: true, reponse: REPONSE_DEJA_TRAITE };
      const issue = cible.handler === 'bloc_fixe'
        ? await deps.envoyerBloc(tenantId, waId, { workflowId: cible.workflowId, code: cible.code })
        : await deps.lancerScenario(tenantId, waId, cible.workflowId);
      if (issue === true) return { ok: true, reponse: REPONSE_MAISON[cible.handler] };
      // Un relâchement raté retarde seulement une redemande jusqu'à l'échéance ; il ne doit pas cacher la raison du
      // refus à l'agent de Meta.
      await deps.antiRejeu.relacher(prise).catch(() => {});
      return { ok: false, erreur: issue };
    }
  }
}

/**
 * Ce que l'agent de Meta lit quand il rappelle un envoi déjà pris en charge pour ce client : de quoi clore son
 * tour, sans affirmer plus que « déjà traitée ». Ni « le client a reçu » (faux après une exception ou un refus),
 * ni « n'écris rien » : le fil a pu lui revenir, et le silence laisserait le client sans réponse. La consigne
 * d'attendre la fin du parcours est portée par la première réponse (`REPONSE_MAISON.scenario_fixe`).
 */
export const REPONSE_DEJA_TRAITE = 'Cette demande vient déjà d’être traitée pour ce message du client : ne rappelle pas cet outil maintenant. Si le client le redemande plus tard, rappelle cet outil.';

/** Ce que l'agent de Meta lit quand le client est bloqué dans l'Inbox. */
export const CONTACT_BLOQUE = 'Ce client est bloqué : aucun message ne lui est envoyé.';

/**
 * Ce que l'agent de Meta lit quand un geste a planté (une exception, pas un refus). Pas d'invitation à réessayer
 * pour un envoi : l'exception a pu survenir après le départ du message, qui partirait deux fois. Un tag ou un
 * champ se reposent sans dégât.
 */
export function erreurDePanne(cible: CibleMaison): string {
  return cible.handler === 'bloc_fixe' || cible.handler === 'scenario_fixe'
    ? 'Le message n’a pas pu être confirmé : ne relance pas cet outil pour cette demande.'
    : 'l’action n’a pas pu être faite, réessayez plus tard';
}

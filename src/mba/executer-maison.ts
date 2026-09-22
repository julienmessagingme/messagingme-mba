import { REPONSE_MAISON, lireValeurChamp, type CibleMaison } from './outils-maison';
import type { AntiRejeu } from './anti-rejeu';

/**
 * EXÉCUTER UN GESTE DE L'AGENT DE META pour un contact (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 AUCUN GESTE N'EST RÉÉCRIT ICI : chaque dépendance est la fonction qui le fait déjà ailleurs (la pose d'un
 * tag des agents IA, l'écriture de champ du mini-CRM, l'envoi à un bloc de l'API publique, le lancement d'un
 * scénario de l'Inbox). Ce module ne fait que choisir laquelle, et traduire l'issue en ce que l'agent de Meta lit.
 */
export interface DepsMaison {
  /** `creerPoserTagAgent` : pose, déclaration dans Contenus > Tags, `tag_added` si l'étiquette est nouvelle. */
  poserTag(tenantId: string, waId: string, tag: string): Promise<void>;
  ecrireChamp(tenantId: string, waId: string, champ: string, valeur: string): Promise<void>;
  /**
   * Le champ existe-t-il encore dans le mini-CRM ? 🔴 Sans cette question, un outil dont le champ a été supprimé
   * écrivait quand même la valeur, sous une clé qu'aucun écran ne montre plus, pendant que l'onglet Outils
   * affichait « ce champ n'existe plus ». Même source que cette ligne rouge : la liste des champs de l'espace.
   */
  champExiste(tenantId: string, champ: string): Promise<boolean>;
  /** Le contact est-il bloqué dans l'Inbox ? Un contact bloqué ne reçoit rien de nous, pas plus d'un outil. */
  estBloque(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Envoie le bloc SEUL (`blocSeul`), par le même chemin qu'un envoi à un bloc de l'API publique
   * (`startFromNode`) : il REPREND le fil à l'agent de Meta, envoie, et le lui rend à l'accusé de l'envoi. Rend
   * `true`, ou la raison du refus telle que l'agent de Meta la lira.
   */
  envoyerBloc(tenantId: string, waId: string, cible: { workflowId: string; code: string }): Promise<true | string>;
  /** Lance le scénario depuis son début, exactement comme le bouton de l'Inbox. Même contrat de retour. */
  lancerScenario(tenantId: string, waId: string, workflowId: string): Promise<true | string>;
  /** Un envoi ne se rejoue pas pour le même client et le même outil, le temps d'une demande (`src/mba/anti-rejeu.ts`). */
  antiRejeu: Pick<AntiRejeu, 'prendre' | 'oublier'>;
  /**
   * L'identifiant du dernier message REÇU du client (`PgInboxStore.dernierMessageDuClient`), ou `null`. Il entre
   * dans la clé de l'anti-rejeu : un rappel dans le même tour de l'agent partage ce message, une nouvelle demande
   * du client, non.
   */
  dernierMessageDuClient(tenantId: string, waId: string): Promise<string | null>;
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
      // 🔴 LE BLOCAGE EST LU AVANT TOUT ENVOI : une garde posée après l'effet ne garde rien.
      if (await deps.estBloque(tenantId, waId)) return { ok: false, erreur: CONTACT_BLOQUE };
      // 🔴 UN RAPPEL DU MÊME OUTIL POUR LE MÊME MESSAGE DU CLIENT NE RENVOIE RIEN (essai réel du 2026-09-22 : sept
      // appels dans le même tour, sept fois le premier message du scénario). Il répond « déjà traitée », ce qui
      // clôt le tour. La clé se PREND d'un seul geste, APRÈS la dernière attente : sept appels simultanés n'en
      // laissent partir qu'un. Elle est GARDÉE sur une exception (le message a pu partir) ; seul un refus, qui n'a
      // rien envoyé, l'oublie.
      // ⚠️ LE MESSAGE DU CLIENT EST DANS LA CLÉ (second essai du même jour) : « Je peux avoir le statut de ma
      // commande ? Encore une fois », 55 s après la première demande, était pris pour un rappel et rien ne
      // repartait. Une NOUVELLE demande du client est un nouveau message, donc une nouvelle clé.
      const dernier = await deps.dernierMessageDuClient(tenantId, waId);
      const cle = `${tenantId}:${waId}:${input.outilId}:${dernier ?? '-'}`;
      if (!deps.antiRejeu.prendre(cle)) return { ok: true, reponse: REPONSE_DEJA_TRAITE };
      const issue = cible.handler === 'bloc_fixe'
        ? await deps.envoyerBloc(tenantId, waId, { workflowId: cible.workflowId, code: cible.code })
        : await deps.lancerScenario(tenantId, waId, cible.workflowId);
      if (issue === true) return { ok: true, reponse: REPONSE_MAISON[cible.handler] };
      deps.antiRejeu.oublier(cle);
      return { ok: false, erreur: issue };
    }
  }
}

/**
 * Ce que l'agent de Meta lit quand il rappelle un envoi déjà pris en charge pour ce client : de quoi clore son tour.
 *
 * 🔴 IL N'AFFIRME RIEN DE PLUS QUE « DÉJÀ TRAITÉE » (revues finales du 2026-09-22). Ni « le client a reçu » : faux
 * après une exception, ou quand le premier appel finit en refus, et l'agent de Meta le répéterait au client. Ni
 * « n'écris rien, la conversation te reviendra » : ce rappel part aussi quand AUCUN parcours ne tourne (premier
 * appel refusé, exception, parcours court déjà fini et client qui redemande), le fil est alors déjà revenu à
 * l'agent de Meta, et lui ordonner le silence laisserait le client sans réponse. La consigne d'attendre la fin du
 * parcours est portée par la PREMIÈRE réponse (`REPONSE_MAISON.scenario_fixe`), dans le même tour.
 */
export const REPONSE_DEJA_TRAITE = 'Cette demande vient déjà d’être traitée pour ce client : ne rappelle plus cet outil pour elle.';

/** Ce que l'agent de Meta lit quand le client est bloqué dans l'Inbox. */
export const CONTACT_BLOQUE = 'Ce client est bloqué : aucun message ne lui est envoyé.';

/**
 * Ce que l'agent de Meta lit quand un geste a PLANTÉ (une exception, pas un refus).
 *
 * 🔴 PAS D'INVITATION À RÉESSAYER POUR UN ENVOI (revue finale du 2026-09-22) : l'exception a pu survenir APRÈS
 * que le message soit parti (une panne de base au journal), et le relancer l'enverrait deux fois au client. Un
 * tag ou un champ, eux, se reposent sans dégât.
 */
export function erreurDePanne(cible: CibleMaison): string {
  return cible.handler === 'bloc_fixe' || cible.handler === 'scenario_fixe'
    ? 'Le message n’a pas pu être confirmé : ne relance pas cet outil pour cette demande.'
    : 'l’action n’a pas pu être faite, réessayez plus tard';
}

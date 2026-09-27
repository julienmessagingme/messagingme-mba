/**
 * Qui reçoit la conversation quand un destinataire de campagne répond.
 *
 * Le tour de rôle se joue à l'arrivée de la réponse, pas au lancement : la plupart des destinataires ne
 * répondent pas, et répartir d'avance afficherait une charge imaginaire. Le rang vit sur la campagne
 * (`campaigns.tour_de_role_rang`) et n'avance que quand une conversation devient réelle. Dépendances injectées,
 * règle de roulement pure.
 */

/**
 * Le membre dont c'est le tour, ou `null` si l'équipe est vide.
 *
 * Le rang ne se remet jamais à zéro et dépasse vite la taille de l'équipe : le modulo est la règle, et c'est ici
 * seulement qu'on le ramène dans l'équipe (le borner aussi en base casserait la succession des rangs). Le double
 * modulo corrige le signe : en JavaScript `-1 % 3` vaut `-1`, et `membres[-1]` laisserait la conversation non
 * assignée. L'ordre des membres doit être stable d'un appel à l'autre (le câblage trie par création puis id).
 */
export function prochainAssigne(membres: string[], rang: number): string | null {
  if (membres.length === 0) return null;
  const i = ((rang % membres.length) + membres.length) % membres.length;
  return membres[i] ?? null;
}

/**
 * Ce qui se passe quand le contact répond. Deux valeurs exclusives, pas de « agent IA » : un agent IA n'existe
 * pas hors d'un scénario (`agent_sessions.run_id` est NOT NULL), il reprend une campagne par « modèle +
 * scénario ».
 */
export type Devenir = 'mba' | 'inbox';

/**
 * La campagne à laquelle cette réponse se rattache : qui répond (`devenir`, propriété de l'étage) et, quand la
 * conversation revient à l'équipe, à qui elle va (`assignation`, propriété de la campagne).
 */
export interface CampagneAssignante {
  campaignId: string;
  /**
   * Le devenir de l'étage où se trouvait ce destinataire. `null` = campagne d'avant ce réglage :
   * `devenirEffectif` reproduit ce qu'elle faisait.
   */
  devenir: Devenir | null;
  /**
   * Comment la conversation se répartit dans l'équipe. Politique de campagne et non d'étage : un rang par étage
   * ferait tourner deux roulements sur la même équipe, donc servirait deux fois la même personne.
   */
  assignation: 'personne' | 'tour_de_role' | null;
  /** La personne, quand `assignation` vaut `personne`. `null` = elle a quitté l'espace depuis. */
  assignationUserId: string | null;
  /**
   * Ce message est-il la PREMIÈRE réponse du contact depuis l'envoi de cette campagne (au plus un entrant depuis
   * `sent_at`, lui-même) ? Seule celle-là prend le fil. Requis : sans lui, chaque message du contact reprendrait le
   * fil pour l'équipe, pour toujours, défaisant un « Rendre la main » ou figeant un scénario lancé depuis.
   * L'affectation, elle, n'en dépend pas : `assigned_to is null` la borne déjà à une par conversation.
   */
  premiereReponse: boolean;
}

/** Ce qu'il faut faire de cette réponse, une fois la campagne trouvée. */
export interface DecisionDevenir {
  devenir: Devenir;
  /**
   * Faut-il prendre le fil à l'agent de Meta avant d'agir ? Faux pour toute campagne d'avant ce réglage : leur
   * faire prendre le fil changerait après coup des conversations déjà en cours.
   */
  prendreLeFil: boolean;
}

/**
 * Ce qui doit se passer, déduit de ce que la campagne porte. Pure. Le choix de l'opérateur est exclusif :
 *  - `mba`   : on ne prend rien, l'agent de Meta, répondeur primaire du numéro, répond ;
 *  - `inbox` : on prend le fil et personne ne répond automatiquement, un humain reprend.
 */
export function devenirEffectif(c: CampagneAssignante): DecisionDevenir {
  if (c.devenir !== null) return { devenir: c.devenir, prendreLeFil: c.devenir !== 'mba' };
  // Campagne d'avant ce réglage : on reproduit ce qu'elle faisait, sans jamais toucher au fil.
  return { devenir: c.assignation !== null ? 'inbox' : 'mba', prendreLeFil: false };
}

export interface AssignationDeps {
  /**
   * La campagne à laquelle ce contact répond (la PLUS RÉCENTE qu'on lui a servie), si elle décide de quelque chose,
   * ou `null` (le cas courant, à garder bon marché). Une campagne plus récente qui ne décide de rien masque les
   * précédentes : c'est à elle que le contact répond.
   */
  campagneDeLaReponse(tenantId: string, waId: string): Promise<CampagneAssignante | null>;
  /** Les membres de l'espace qui peuvent recevoir une conversation, dans un ordre stable. */
  membres(tenantId: string): Promise<string[]>;
  /** Prend le prochain rang de cette campagne et l'avance, en une écriture. */
  prendreUnRang(tenantId: string, campaignId: string): Promise<number>;
  /** Écrit l'affectation. `false` = elle n'a pas été posée (déjà assignée, membre hors espace). */
  assigner(tenantId: string, waId: string, userId: string): Promise<boolean>;
  /**
   * Prend le fil pour l'équipe (`ControleDuFil.prendrePourLEquipe`, `src/inbox/fil.ts`) : à l'agent de Meta chez
   * Meta, puis `app_human` chez nous, pour qu'aucun robot ne réponde et que la conversation entre dans « À
   * traiter ». Un opérateur qui la tient déjà la garde. `false` = Meta a refusé. Optionnelle : absente, aucun fil
   * n'est pris (câblages de test de l'assignation seule).
   */
  prendreLeFil?(tenantId: string, waId: string): Promise<boolean>;
}

/**
 * Assigne la conversation de ce contact et rend la personne, ou `null` si personne ne l'a reçue.
 *
 * On cherche la campagne d'abord, on prend un rang ensuite et seulement si le roulement est en jeu : sinon le
 * roulement avancerait à chaque message entrant de l'espace. Un rang peut être consommé sans que personne ne
 * reçoive la conversation (écriture refusée) : un roulement qui saute une place ne fait de tort à personne,
 * alors qu'un rang pris après l'écriture laisserait deux réponses simultanées tomber sur la même personne.
 * Rien n'est levé ici : une assignation ratée ne doit jamais empêcher d'enregistrer le message.
 */
export async function assignerReponse(
  tenantId: string,
  waId: string,
  deps: AssignationDeps,
): Promise<string | null> {
  const campagne = await deps.campagneDeLaReponse(tenantId, waId);
  if (!campagne) return null;

  const decision = devenirEffectif(campagne);

  /**
   * Le fil se prend avant tout le reste, et son échec arrête tout : si Meta refuse, son agent répondra quoi
   * qu'on fasse, et assigner la conversation ferait hériter à un humain d'un échange qu'un robot a commencé.
   *
   * 🔴 À la PREMIÈRE réponse seulement (`premiereReponse`). Les suivantes laissent le fil à qui le tient : un
   * opérateur qui l'a rendu à l'agent de Meta, ou le délai de reprise qui l'a rendu, ne se font pas défaire par le
   * message suivant du client.
   */
  if (decision.prendreLeFil && campagne.premiereReponse && deps.prendreLeFil
    && !(await deps.prendreLeFil(tenantId, waId))) {
    // eslint-disable-next-line no-console
    console.warn(`devenir de campagne ${campagne.campaignId} non appliqué pour ${waId} : Meta n’a pas cédé le fil, son agent répond`);
    return null;
  }

  // L'agent de Meta : ne rien prendre suffit à ce qu'il réponde.
  if (decision.devenir === 'mba') return null;

  // Reste `inbox` : le fil est à nous, personne ne répond automatiquement, on répartit.
  if (campagne.assignation === null) return null;

  let userId: string | null;
  if (campagne.assignation === 'personne') {
    // `personne` sans personne (collaborateur parti, `on delete set null`) n'assigne pas au premier venu :
    // l'écran affiche « assignée à une personne ».
    userId = campagne.assignationUserId;
  } else {
    const membres = await deps.membres(tenantId);
    // Équipe vide : pas de rang pris, personne à servir.
    if (membres.length === 0) return null;
    userId = prochainAssigne(membres, await deps.prendreUnRang(tenantId, campagne.campaignId));
  }
  if (!userId) return null;

  // On rend ce qui a été écrit : `assigner` refuse une conversation déjà affectée ou un membre parti.
  return (await deps.assigner(tenantId, waId, userId)) ? userId : null;
}

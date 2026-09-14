/**
 * QUI REÇOIT LA CONVERSATION QUAND UN DESTINATAIRE DE CAMPAGNE RÉPOND.
 *
 * 🔴 LE TOUR DE RÔLE SE JOUE À L'ARRIVÉE DE LA RÉPONSE, PAS AU LANCEMENT, et c'est la décision qui
 * structure tout ce module. Répartir cinq mille conversations d'avance attribuerait des conversations
 * qui n'existeront JAMAIS : la très grande majorité des destinataires d'une campagne ne répondent pas.
 * Les compteurs de charge de l'équipe (`/inbox`, la page « qui a quoi ») afficheraient alors une
 * répartition imaginaire, et l'opérateur le moins chargé aurait l'air d'être le plus occupé. Le rang vit
 * donc sur la campagne (`campaigns.tour_de_role_rang`, migration 0134) et n'avance que quand une
 * conversation devient RÉELLE.
 *
 * ⚠️ CE MODULE NE TOUCHE NI À LA BASE NI AU RÉSEAU : ses quatre dépendances sont injectées, et la règle
 * de roulement est une fonction PURE. C'est ce qui permet d'éprouver « le rang dépasse l'équipe après un
 * départ » en quelques millisecondes plutôt que de monter une campagne, deux comptes et un webhook.
 */

/**
 * LE MEMBRE DONT C'EST LE TOUR, ou `null` si l'équipe est vide.
 *
 * 🔴 LE MODULO EST LA RÈGLE, PAS UN ACCÈS DIRECT. Le rang ne se remet jamais à zéro : il compte les
 * réponses depuis le début de la campagne, donc il dépasse la taille de l'équipe dès la quatrième
 * réponse à trois. `membres[rang]` rendrait `undefined`, et la conversation tomberait dans « À traiter »
 * en silence à partir de là.
 *
 * 🔴 ET C'EST ICI, ET NULLE PART AILLEURS, QUE LE RANG EST RAMENÉ DANS L'ÉQUIPE. Le dépôt a essayé de
 * le borner AUSSI en base, par un `% 32767` qui protégeait un `smallint` : deux rangs consécutifs y
 * valaient 32766 puis 0, et les deux tombaient sur la MÊME personne pour une équipe de 2, 3 ou 6. Un
 * tour de rôle n'a besoin que de rangs CONSÉCUTIFS ET DISTINCTS ; les borner deux fois, c'est créer un
 * endroit où ils cessent de l'être.
 *
 * ⚠️ LE DOUBLE MODULO CORRIGE LE SIGNE, ET SA JUSTIFICATION A CHANGÉ, DONC ELLE EST RÉÉCRITE. Il
 * existait parce que le dépôt rendait alors `tour_de_role_rang - 1`, une soustraction qui pouvait sortir
 * de l'intervalle ; cette soustraction a été retirée (cf. `prendreUnRangDeTourDeRole`), et AUCUN
 * appelant ne produit plus de rang négatif aujourd'hui. Il reste quand même, pour une raison qui ne
 * dépend d'aucun appelant : `%` garde en JavaScript le SIGNE de son opérande gauche, donc `-1 % 3` vaut
 * `-1` et `membres[-1]` vaut `undefined`. Le symptôme serait une conversation NON ASSIGNÉE, c'est-à-dire
 * un silence, sur une fonction exportée que n'importe quel appelant futur peut appeler.
 *
 * ⚠️ L'ORDRE DES MEMBRES EST CELUI QUE L'APPELANT DONNE, et il doit être STABLE d'un appel à l'autre
 * (le câblage trie par date de création puis par identifiant). Un ordre qui change entre deux réponses
 * ferait tourner le roulement sur une liste différente, donc reviendrait à tirer au sort.
 */
export function prochainAssigne(membres: string[], rang: number): string | null {
  if (membres.length === 0) return null;
  const i = ((rang % membres.length) + membres.length) % membres.length;
  return membres[i] ?? null;
}

/**
 * Ce qui se passe quand le contact répond. Les deux valeurs sont EXCLUSIVES.
 *
 * 🔴 IL N'Y A PAS DE TROISIÈME VALEUR « agent IA », ET C'EST UN FAIT D'ARCHITECTURE, PAS UN OUBLI.
 * `agent_sessions.run_id` est `NOT NULL` et référence `workflow_runs` : un agent IA de ce produit ne sait
 * pas exister hors d'un scénario. Pour qu'un agent reprenne une campagne, le chemin est « modèle +
 * scénario », qui existe et qui est éprouvé (tranché par Julien le 2026-09-14).
 */
export type Devenir = 'mba' | 'inbox';

/**
 * La campagne à laquelle cette réponse se rattache, et ce qu'elle demande.
 *
 * ⚠️ ELLE DIT DEUX CHOSES DEPUIS LA MIGRATION 0144, et ce commentaire n'en nommait qu'une : QUI RÉPOND
 * (`devenir`, propriété de l'étage) et, quand la conversation revient à l'équipe, À QUI elle va
 * (`assignation`, propriété de la campagne). Les deux se lisent en un seul aller-retour.
 */
export interface CampagneAssignante {
  campaignId: string;
  /**
   * Le devenir de l'ÉTAGE où se trouvait ce destinataire (migration 0144).
   *
   * ⚠️ `null` = campagne créée AVANT le câblage du devenir. Elle n'a alors jamais rien pris à l'agent de
   * Meta, et son seul réglage qui voyageait était l'assignation : `devenirEffectif` reproduit exactement
   * ce qu'elle faisait, cf. la justification là-bas.
   */
  devenir: Devenir | null;
  /**
   * Comment la conversation se répartit dans l'équipe, quand elle lui revient.
   *
   * ⚠️ ELLE RESTE UNE POLITIQUE DE CAMPAGNE, pas d'étage, et ce n'est pas une inconséquence : le tour de
   * rôle compte ses réponses sur un rang unique (`campaigns.tour_de_role_rang`), et un rang par étage
   * ferait tourner deux roulements indépendants sur la même équipe, donc servirait deux fois la même
   * personne.
   */
  assignation: 'personne' | 'tour_de_role' | null;
  /** La personne, quand `assignation` vaut `personne`. `null` = elle a quitté l'espace depuis. */
  assignationUserId: string | null;
}

/** Ce qu'il faut faire de cette réponse, une fois la campagne trouvée. */
export interface DecisionDevenir {
  devenir: Devenir;
  /**
   * Faut-il PRENDRE le fil à l'agent de Meta avant d'agir ?
   *
   * 🔴 FAUX POUR TOUTE CAMPAGNE D'AVANT LE CÂBLAGE, et c'est ce qui rend la migration 0144 sans effet
   * rétroactif. Ces campagnes sont parties sans que personne ne prenne le fil : leur faire prendre le fil
   * aujourd'hui changerait, après coup, ce qui se passe sur des conversations déjà en cours.
   */
  prendreLeFil: boolean;
}

/**
 * CE QUI DOIT SE PASSER, déduit de ce que la campagne porte. PURE.
 *
 * 🔴 LE CHOIX DE L'OPÉRATEUR EST EXCLUSIF, ET C'EST TOUTE LA RÈGLE (tranché par Julien le 2026-09-14 :
 * « si le user répond "la conversation arrive dans l'Inbox", eh bien ça arrive dans l'Inbox »). Donc :
 *
 *  - `mba`    : on ne prend rien, l'agent de Meta répond, c'est lui le répondeur primaire du numéro ;
 *  - `inbox`  : on PREND le fil, et personne ne répond automatiquement. « Arrive dans l'Inbox » veut dire
 *               qu'un humain reprend, pas qu'un robot a déjà répondu avant lui.
 */
export function devenirEffectif(c: CampagneAssignante): DecisionDevenir {
  if (c.devenir !== null) return { devenir: c.devenir, prendreLeFil: c.devenir !== 'mba' };
  // Campagne d'avant 0144 : on reproduit à l'identique ce qu'elle faisait, sans jamais toucher au fil.
  return { devenir: c.assignation !== null ? 'inbox' : 'mba', prendreLeFil: false };
}

export interface AssignationDeps {
  /**
   * La campagne assignante dont ce contact attend une réponse, ou `null`.
   *
   * ⚠️ ELLE REND `null` DANS L'ÉCRASANTE MAJORITÉ DES CAS, et c'est le chemin à garder bon marché : la
   * plupart des messages entrants de la console n'ont rien à voir avec une campagne.
   */
  campagneDeLaReponse(tenantId: string, waId: string): Promise<CampagneAssignante | null>;
  /** Les membres de l'espace qui peuvent recevoir une conversation, dans un ordre STABLE. */
  membres(tenantId: string): Promise<string[]>;
  /** Prend LE prochain rang de cette campagne, et l'avance, en UNE écriture. */
  prendreUnRang(tenantId: string, campaignId: string): Promise<number>;
  /** Écrit l'affectation. `false` = elle n'a pas été posée (déjà assignée, membre hors espace). */
  assigner(tenantId: string, waId: string, userId: string): Promise<boolean>;
  /**
   * Prend le fil à l'agent de Meta. `false` = Meta a refusé, ou il n'y avait rien à prendre.
   *
   * ⚠️ OPTIONNELLE : absente, aucun fil n'est jamais pris, ce qui est le comportement d'avant la migration
   * 0144. Les câblages de test n'ont donc rien à déclarer pour continuer d'exercer l'assignation seule.
   */
  prendreLeFil?(tenantId: string, waId: string): Promise<boolean>;
}

/**
 * ASSIGNE LA CONVERSATION DE CE CONTACT, ET REND LA PERSONNE, ou `null` si personne ne l'a reçue.
 *
 * 🔴 L'ORDRE DES TROIS APPELS EST LA MOITIÉ DE LA CORRECTION. On cherche la campagne D'ABORD, on prend
 * un rang ENSUITE, et seulement si le roulement est réellement en jeu : prendre un rang avant de savoir
 * ferait avancer le roulement à chaque message entrant de l'espace, et la répartition n'aurait plus
 * aucun rapport avec les réponses de la campagne.
 *
 * ⚠️ UN RANG PEUT ÊTRE CONSOMMÉ SANS QUE PERSONNE NE REÇOIVE LA CONVERSATION : si l'écriture est
 * refusée (conversation déjà assignée, membre parti entre-temps), le rang est déjà avancé. C'est assumé,
 * et c'est le bon sens du compromis : un roulement qui saute une place ne fait de tort à personne, alors
 * qu'un rang pris APRÈS l'écriture laisserait deux réponses simultanées tomber sur la même personne.
 *
 * ⚠️ RIEN N'EST LEVÉ ICI. L'appelant est le chemin d'un message entrant, qui est le cœur du produit : une
 * assignation ratée ne doit jamais empêcher d'enregistrer le message. C'est l'appelant qui isole.
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
   * 🔴 LE FIL SE PREND AVANT TOUT LE RESTE, ET SON ÉCHEC ARRÊTE TOUT. Si Meta refuse de nous le céder,
   * son agent répondra quoi qu'on fasse : lancer notre agent IA par-dessus ferait recevoir DEUX messages
   * au contact, et assigner la conversation à un humain lui ferait hériter d'un échange qu'un robot a
   * déjà commencé sans qu'il le sache. Dans les deux cas, mieux vaut ne rien faire et le dire.
   */
  if (decision.prendreLeFil && deps.prendreLeFil && !(await deps.prendreLeFil(tenantId, waId))) {
    // eslint-disable-next-line no-console
    console.warn(`devenir de campagne ${campagne.campaignId} non appliqué pour ${waId} : Meta n’a pas cédé le fil, son agent répond`);
    return null;
  }

  /**
   * L'AGENT DE META : on ne fait rien, et c'est exactement l'intention. Il est le répondeur primaire du
   * numéro, donc ne rien prendre suffit à ce qu'il réponde.
   */
  if (decision.devenir === 'mba') return null;

  // Reste `inbox` : le fil est à nous, personne ne répond automatiquement, on répartit.
  if (campagne.assignation === null) return null;

  let userId: string | null;
  if (campagne.assignation === 'personne') {
    // 🔴 `personne` SANS PERSONNE N'ASSIGNE PAS AU PREMIER VENU. La colonne est nullable, et elle est
    // remise à `null` au départ d'un collaborateur (`on delete set null`, migration 0134). Retomber sur
    // le roulement donnerait la conversation à quelqu'un que l'opérateur n'a pas choisi, sur une
    // campagne dont l'écran affiche « assignée à une personne ».
    userId = campagne.assignationUserId;
  } else {
    const membres = await deps.membres(tenantId);
    // ⚠️ ÉQUIPE VIDE : on ne prend PAS de rang. Il n'y a personne à servir, donc rien à faire avancer.
    if (membres.length === 0) return null;
    userId = prochainAssigne(membres, await deps.prendreUnRang(tenantId, campagne.campaignId));
  }
  if (!userId) return null;

  // ⚠️ ON REND CE QUI A ÉTÉ ÉCRIT, PAS CE QU'ON VOULAIT ÉCRIRE. `assigner` refuse quand la conversation
  // est déjà affectée ou quand le membre n'est plus de cet espace : rendre le nom quand même ferait
  // croire, au journal comme à l'appelant, que quelqu'un a reçu la conversation.
  return (await deps.assigner(tenantId, waId, userId)) ? userId : null;
}

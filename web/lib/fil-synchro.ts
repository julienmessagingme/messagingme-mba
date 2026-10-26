/**
 * LA SYNCHRONISATION DU FIL DE L'INBOX, sans React (audit de structure du 2026-10-25, lot D du plan
 * `docs/superpowers/plans/2026-10-26-audits-simplicite-structure.md`). Ce qu'un tour de relevé fait de la réponse du
 * serveur : quels messages ajouter ou remplacer, où poser le curseur du delta, quand marquer le fil lu, et quand le
 * prochain tour doit reprendre le fil entier. `web/app/inbox/page.tsx` garde la requête en vol, son annulation et le
 * minuteur ; il ne fait qu'appliquer ce que rend `tourDuFil`.
 */

/** Le point de reprise du delta : le DERNIER message reçu, tel que le serveur l'a rendu. */
export interface CurseurFil {
  at: string;
  id: string;
}

/** Ce que la synchronisation retient d'un tour à l'autre. Côté React, une `ref` : jamais de l'état rendu. */
export interface EtatSynchroFil {
  /** Le curseur du delta ; `null` = le prochain tour demande le fil entier. */
  borne: CurseurFil | null;
  /**
   * 🔴 LE PROCHAIN CHARGEMENT REMPLACE LE FIL AU LIEU DE S'Y AJOUTER. Remettre `borne` à zéro ne suffit pas : le
   * serveur renverrait bien le fil entier, mais l'ajout est dédoublonné par identifiant, donc les bulles déjà
   * affichées garderaient leur ancien texte. ⚠️ EXPLICITE, jamais déduit de « `borne` est nul » : un serveur qui ne
   * rend pas de curseur repart du fil entier à chaque tour, et remplacer à chaque fois changerait la référence du
   * tableau toutes les 4 secondes, donc relancerait l'effet de défilement en boucle.
   */
  remplacerAuProchain: boolean;
  /** Le tour précédent disait-il la traduction impossible ? Sert à voir le moment où elle le redevient. */
  traductionIndisponible: boolean;
  /** Le dernier message déjà vu : on ne marque « lu » qu'au vrai changement, jamais à chaque tour. */
  dernierVu: string | null;
}

/**
 * L'état d'un fil qui vient de s'ouvrir. ⚠️ GELÉ : il sert de valeur initiale à la `ref` de chaque conversation, et une
 * écriture en place (`ref.current.borne = ...`) ferait fuir le curseur d'une conversation à la suivante. Chaque
 * transition rend un nouvel objet.
 */
export const ETAT_INITIAL_FIL: Readonly<EtatSynchroFil> = Object.freeze({ borne: null, remplacerAuProchain: false, traductionIndisponible: false, dernierVu: null });

/** Ce que la synchronisation lit d'un message : son identifiant, et le curseur que le serveur lui donne. */
export interface MessageDuFil {
  id: string;
  /** Absent (serveur plus ancien) : aucun curseur n'est posé, le tour suivant redemande le fil entier. */
  curseur?: string;
}

export interface TourDuFil<M> {
  etat: EtatSynchroFil;
  /**
   * À passer à `setMessages`, ou `null` : ne pas toucher aux messages. Rend `prev` TEL QUEL quand rien de nouveau
   * n'arrive : la référence ne change pas, donc l'effet de défilement ne se redéclenche pas. C'est ce qui rend le fil
   * calme.
   */
  messages: ((prev: M[]) => M[]) | null;
  /** Le fil a un nouveau dernier message : le dire au serveur (la pastille des non-lus). */
  marquerLu: boolean;
}

/** Ce que demande le prochain tour : la suite du fil après le curseur, ou le fil entier. */
export function demandeDuTour(etat: EtatSynchroFil): { apres?: CurseurFil } {
  return etat.borne ? { apres: etat.borne } : {};
}

/**
 * Un tour de relevé : la réponse du serveur appliquée à l'état. `etaitUnDelta` se lit AVANT la requête (la suite du
 * tour réécrit le curseur) ; `etat` est celui du moment de la réponse.
 */
export function tourDuFil<M extends MessageDuFil>(
  etat: EtatSynchroFil,
  reponse: { messages: M[]; traductionIndisponible?: boolean },
  o: { cibleLecture: string | undefined; etaitUnDelta: boolean },
): TourDuFil<M> {
  // ⚠️ Consommé ici, après la réponse : une requête qui échoue ou qui est annulée n'arrive jamais jusque-là, donc le
  // remplacement reste DÛ, sinon le fil resterait à moitié traduit jusqu'au prochain clic.
  const remplacer = etat.remplacerAuProchain;
  let borne = etat.borne;
  let dernierVu = etat.dernierVu;
  let marquerLu = false;
  // 🔴 REMPLACEMENT INTÉGRAL : les bulles déjà à l'écran viennent de changer de langue, leurs identifiants non.
  let messages: TourDuFil<M>['messages'] = remplacer ? () => reponse.messages : null;
  const arrivee = reponse.messages.at(-1);
  if (arrivee !== undefined) {
    // 🔴 LE CURSEUR VIENT DU SERVEUR ET REPART TEL QUEL : `createdAt` n'a que la milliseconde là où Postgres stocke la
    // microseconde, et le dernier message repassait le filtre à chaque tour. Absent : aucun curseur, repli sûr (trop de
    // messages plutôt que trop peu, et le dédoublonnage le rend invisible).
    borne = arrivee.curseur ? { at: arrivee.curseur, id: arrivee.id } : null;
    // En AJOUT DÉDOUBLONNÉ, sauf quand le fil vient d'être remplacé : les bulles reviennent alors avec les mêmes
    // identifiants et un AUTRE texte, et le dédoublonnage ré-écraserait le remplacement par l'ancienne langue. Le
    // composant est remonté à chaque conversation, donc `prev` ne mélange jamais deux fils.
    if (!remplacer) {
      messages = (prev) => {
        const connus = new Set(prev.map((m) => m.id));
        const nouveaux = reponse.messages.filter((m) => !connus.has(m.id));
        return nouveaux.length === 0 ? prev : [...prev, ...nouveaux];
      };
    }
    if (arrivee.id !== dernierVu) {
      dernierVu = arrivee.id;
      marquerLu = true;
    }
  }
  const indisponible = reponse.traductionIndisponible === true;
  let remplacerAuProchain = false;
  /**
   * 🔴 LA TRADUCTION VIENT DE DEVENIR POSSIBLE (la clé de l'espace s'est ouverte, un crédit rechargé) : le fil déjà
   * affiché est en VO, et le tour suivant ne ramènerait que le delta, déjà traduit. Le prochain reprend donc le fil
   * entier, et il remplace. ⚠️ Seulement après un DELTA : un fil entier vient d'arriver traduit, le redemander
   * paierait deux fois.
   */
  if (o.cibleLecture && etat.traductionIndisponible && !indisponible && o.etaitUnDelta) {
    borne = null;
    remplacerAuProchain = true;
  }
  return { etat: { borne, remplacerAuProchain, traductionIndisponible: indisponible, dernierVu }, messages, marquerLu };
}

/**
 * 🔴 LA LANGUE DE LECTURE A CHANGÉ : le prochain chargement reprend le fil entier (sinon l'historique resterait dans sa
 * langue d'origine), et il remplace (sinon l'ajout dédoublonné ignorerait les bulles retraduites).
 */
export function apresChangementDeLangue(etat: EtatSynchroFil): EtatSynchroFil {
  return { ...etat, borne: null, remplacerAuProchain: true };
}

/** Le fil a été effacé côté serveur : le delta ne doit pas repartir d'un message qui n'existe plus. */
export function apresEffacement(etat: EtatSynchroFil): EtatSynchroFil {
  return { ...etat, borne: null };
}

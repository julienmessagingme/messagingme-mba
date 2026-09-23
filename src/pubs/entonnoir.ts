/**
 * L'ENTONNOIR D'UNE PUBLICITÉ (lot 3, commit 3, spec § 3.5). Module PUR : des nombres entrent, des nombres
 * sortent, aucune IO.
 *
 * 🔴 CE QUE CET ÉCRAN SERT À DÉCIDER, et pourquoi ses divisions comptent. Un client regarde ces chiffres
 * pour répondre à une seule question : « est-ce que j'arrête cette campagne ou est-ce que je remets du
 * budget ? ». Un coût par prospect faux d'un facteur dix, ou affiché comme `0` alors qu'il est inconnu,
 * fait prendre la mauvaise décision sur de l'argent réel. C'est pour ça que le calcul est ici, pur et
 * éprouvé, plutôt que dans le JSX d'un composant.
 *
 * 🔴 « NON DISPONIBLE » N'EST PAS « ZÉRO », ET C'EST TOUT LE SUJET. Zéro prospect ne donne pas un coût par
 * prospect de zéro : il ne donne AUCUN coût par prospect. Afficher `0 €` là où l'on ne sait pas est le
 * chiffre le plus trompeur possible, puisqu'il ressemble au meilleur résultat imaginable. `null` traverse
 * donc tout le module, et l'écran écrit « non disponible ».
 */

/** Ce que la base a compté pour une campagne. Tous les nombres sont bruts, aucun n'est déjà dérivé. */
export interface ComptesPub {
  /** La dépense chez Meta, dans la devise du compte. `null` = jamais lue. */
  depense: number | null;
  /** Les clics sur le lien vers WhatsApp, tels que Meta les compte. `null` = jamais lus. */
  clics: number | null;
  /** CONTACTS DISTINCTS arrivés par cette campagne. Pas des arrivées : un contact qui reclique reste un. */
  leads: number;
  /** Contacts distincts dont une arrivée porte `qualifie_le`. */
  qualifies: number;
  /**
   * LES LEADS NON PRIS EN CHARGE, comptés à part : reprise refusée, désabonnés, bloqués, et publicité
   * dont le scénario n'est pas branché.
   *
   * 🔴 ILS NE SONT PAS RETIRÉS DES `leads`, et ils ne sont pas non plus noyés dedans. Ce sont des clics
   * PAYÉS qui n'ont produit aucune conversation : les soustraire flatterait le taux de passage, les taire
   * les rendrait invisibles. Ils s'affichent donc à côté, avec leur nom.
   */
  nonPrisEnCharge: number;
}

/** Une étape de l'entonnoir, telle que l'écran l'affiche. */
export interface EtapeEntonnoir {
  /** Le nombre atteint à cette étape. `null` = on ne l'a pas encore lu chez Meta. */
  nombre: number | null;
  /** Ce que coûte UNE unité de cette étape. `null` = indéterminé (pas de dépense connue, ou zéro unité). */
  cout: number | null;
  /** La part de l'étape PRÉCÉDENTE qui arrive ici, entre 0 et 1. `null` = indéterminé. */
  passage: number | null;
}

export interface Entonnoir {
  depense: number | null;
  clics: EtapeEntonnoir;
  leads: EtapeEntonnoir;
  qualifies: EtapeEntonnoir;
  nonPrisEnCharge: number;
}

/**
 * UNE DIVISION QUI PEUT NE PAS AVOIR DE RÉPONSE.
 *
 * ⚠️ LE NOM DIT QU'ELLE PEUT NE RIEN RENDRE. `diviser` tout court inviterait à l'appeler comme un
 * opérateur, et à oublier que son résultat est nullable ; c'est aussi un nom trop générique pour un dépôt
 * qui porte déjà trois constantes homonymes ailleurs.
 *
 * 🔴 TROIS CAS RENDENT `null`, ET PAS UN SEUL. Le dénominateur nul est le cas qu'on voit ; les deux autres
 * sont ceux qu'on oublie : un numérateur INCONNU (`null`, parce que Meta n'a pas encore été lu) n'est pas
 * un numérateur nul, et un résultat non fini (`Infinity`, `NaN`) ne doit jamais atteindre un écran. Le
 * dernier cas est ce qui reste quand on a « corrigé » les deux premiers à la main, et c'est celui qui
 * affiche `Infinity €` à un client.
 */
export function diviserOuRien(numerateur: number | null, denominateur: number | null): number | null {
  if (numerateur === null || denominateur === null) return null;
  if (denominateur === 0) return null;
  const r = numerateur / denominateur;
  return Number.isFinite(r) ? r : null;
}

/**
 * L'ENTONNOIR COMPLET : dépense, clics, prospects, qualifiés, avec le coût de chaque étape et le taux de
 * passage vers la suivante.
 *
 * ⚠️ LE PREMIER TAUX DE PASSAGE EST CELUI QU'ON CHERCHE, et il a un nom que personne n'emploie : la part
 * des clics qui n'écrivent JAMAIS. Un clic payé qui n'ouvre pas de conversation est la perte la plus
 * silencieuse de ce produit, parce qu'elle ne laisse aucune trace ailleurs que dans cet écart.
 */
export function entonnoir(c: ComptesPub): Entonnoir {
  return {
    depense: c.depense,
    clics: {
      nombre: c.clics,
      cout: diviserOuRien(c.depense, c.clics),
      // Rien ne précède les clics : le taux de passage n'a pas de sens ici, et `null` le dit.
      passage: null,
    },
    leads: {
      nombre: c.leads,
      cout: diviserOuRien(c.depense, c.leads),
      passage: diviserOuRien(c.leads, c.clics),
    },
    qualifies: {
      nombre: c.qualifies,
      cout: diviserOuRien(c.depense, c.qualifies),
      passage: diviserOuRien(c.qualifies, c.leads),
    },
    nonPrisEnCharge: c.nonPrisEnCharge,
  };
}

/**
 * LES ISSUES QUI COMPTENT COMME « NON PRIS EN CHARGE », et elles seules.
 *
 * 🔴 `agent_meta` N'EN FAIT PAS PARTIE, et c'est la distinction qui décide de la justesse de l'écran. Un
 * lead confié à l'agent de Meta EST pris en charge : quelqu'un lui répond, c'est même ce que le client a
 * demandé. Le compter comme perdu ferait afficher « 100 % de prospects perdus » sur une publicité qui
 * fonctionne exactement comme prévue.
 *
 * ⚠️ `inchange` non plus : ce sont les leads d'avant le lien, ou d'une pub qu'on ne pilote pas. Ils ne
 * concernent pas l'entonnoir de CETTE campagne.
 *
 * 🔴 `sans_scenario` EN FAIT PARTIE, ET C'EST LE CAS LE PLUS UTILE DE LA LISTE. Il dit qu'une publicité
 * promet un scénario qui n'existe pas, ou qui n'est pas encore publié : le client a payé le clic, et
 * notre routage ne lui a rien servi. C'est un défaut de CONFIGURATION, donc réparable, et le seul moyen
 * de le voir est qu'il apparaisse dans ce compte plutôt que de se fondre dans les prospects servis.
 */
export const ISSUES_NON_PRISES_EN_CHARGE = ['reprise_refusee', 'desabonne', 'bloque', 'sans_scenario'] as const;

/**
 * OÙ VA LE LEAD D'UNE PUBLICITÉ CLICK-TO-WHATSAPP. Module PUR : aucune IO, aucun import qui tire pg, aucune
 * horloge. Les faits entrent, une décision sort.
 *
 * 🔴 POURQUOI UNE FONCTION PURE ET PAS UNE SUITE DE `if` DANS LE CÂBLAGE (spec § 3.3, décision de Julien du
 * 2026-09-22). Cette règle décide, pour un vrai client qui vient de cliquer sur une publicité PAYÉE, qui lui
 * répond : l'agent de Meta, un scénario, ou personne. Six cas, dont trois « on ne fait rien » qui se
 * ressemblent à l'œil et ne veulent pas dire la même chose. Écrite dans le chemin du webhook, elle ne serait
 * éprouvable qu'en montant un webhook, un contact, une pub et un agent ; écrite ici, chaque ligne du tableau
 * de la spec est un test de trois lignes.
 *
 * 🔴 ET C'EST LA MÊME LEÇON QUE `retirerAncienAcces` (lot 2), payée la semaine dernière : une décision qui
 * vit dans un `if` du câblage finit gardée par un test qui lit le TEXTE de ce `if`, et un test de source
 * pince une ORTHOGRAPHE, pas une sémantique. Trois écritures du même bug avaient traversé deux gardes
 * successives.
 *
 * Le modèle est `src/inbox/assignation-campagne.ts` (`devenirEffectif`), qui répond à la question jumelle
 * pour une réponse de campagne.
 */

/** Qui répond aux leads d'une campagne. Exclusif : c'est l'un OU l'autre, jamais les deux. */
export type DestinationPub = 'scenario' | 'agent_meta';

/**
 * L'ISSUE d'une arrivée, inscrite sur `arrivees_pub.issue`. Les HUIT valeurs reprennent le tableau de la
 * spec § 3.3 (sept lignes) plus `sans_scenario`, ajoutée par une relecture à froid, et elles servent DEUX
 * choses : comprendre après coup ce qui s'est passé pour un lead précis, et
 * compter à part, dans l'entonnoir, les clics payés qui n'ont abouti à rien.
 *
 * ⚠️ C'EST UNE VALEUR, ET LE TYPE EN DÉCOULE, pas l'inverse. Un type seul ne peut pas être comparé au
 * CHECK de la migration 0170 à l'exécution, donc l'accord entre les deux ne tenait par rien.
 * `tests/pubs-entonnoir.test.ts` LIT le fichier SQL et exige l'égalité des deux listes.
 */
export const ISSUES_ROUTAGE = [
  /** Aucune campagne connue : les declencheurs ordinaires tournent, exactement comme avant ce lot. */
  'inchange',
  /** La pub envoie ses leads a l'agent de Meta : on ne declenche rien, il repond, c'est lui le primaire. */
  'agent_meta',
  /** Le fil a ete repris a l'agent de Meta, le scenario a la main. */
  'reprise_reussie',
  /** Meta a refuse de rendre le fil : son agent garde le lead, et le scenario ne part pas. */
  'reprise_refusee',
  /** Le contact a dit STOP. Rien ne part, et l'arrivee le dit plutot que de disparaitre. */
  'desabonne',
  /** Le contact est bloque. Rien ne part. */
  'bloque',
  /** Cas nominal : le scenario de la pub, et lui seul, est evalue. */
  'scenario',
  /**
   * La publicite confie ses leads a un scenario, et il n'y a RIEN a demarrer : scenario supprime, ou
   * publicite pas encore publiee (son automation nait eteinte).
   *
   * ELLE EXISTE PARCE QU'ON NE PREND PAS LE FIL DANS CE CAS, et c'est tout ce qu'elle dit. Relevee par
   * une relecture a froid : sans elle, un lead `standby` faisait prendre le fil a l'agent de Meta pour
   * que PERSONNE ne parle ensuite, donc un clic PAYE repondu par un silence de vingt-quatre heures, la
   * ou l'agent de Meta repondait avant ce lot.
   */
  'sans_scenario',
] as const;

export type IssueRoutage = typeof ISSUES_ROUTAGE[number];

/** La publicité qui pilote ce lead, telle que nos tables la connaissent. */
export interface PubDuLead {
  /** L'identifiant Meta de la CAMPAGNE. C'est le niveau du lien, pas la pub (spec § 1). */
  campagneId: string;
  destination: DestinationPub;
  /**
   * L'automation possédée par cette pub, ET SEULEMENT SI ELLE EST ALLUMÉE.
   *
   * 🔴 `null` VEUT DIRE « RIEN NE PARTIRA », ET C'EST CE SENS-LÀ QUI COMPTE. Il couvre DEUX états, et les
   * confondre est précisément ce qui a créé une régression : le scénario supprimé (`on delete set null`,
   * migration 0170) ET la publicité pas encore publiée, dont l'automation naît éteinte. Dans les deux cas
   * il n'y a rien à démarrer, donc rien ne justifie de prendre le fil à l'agent de Meta.
   *
   * ⚠️ LE FILTRE SUR `enabled` EST DANS LA REQUÊTE, pas ici : la règle est pure, elle ne sait pas
   * interroger. C'est `PgPublicitesStore.pubDeLaCampagne` qui ne rend l'identifiant que si l'automation
   * est allumée, et un test d'intégration le tient.
   */
  automationId: string | null;
}

/**
 * Tout ce que la règle regarde. Rassemblé par le câblage AVANT l'appel, jamais lu paresseusement ici : une
 * règle pure qui irait chercher ses faits ne serait plus pure.
 */
export interface FaitsDuLead {
  /** `null` = aucune campagne connue pour cette pub, ou une campagne qui n'est pas à nous. */
  pub: PubDuLead | null;
  bloque: boolean;
  desabonne: boolean;
  /** Le message est arrivé pendant que l'agent de Meta tenait le fil (`field === 'standby'`). */
  enStandby: boolean;
}

/**
 * CE QU'IL FAUT FAIRE, et les quatre cas sont exhaustifs.
 *
 * ⚠️ `reprendre_puis_pub` est le SEUL à ne pas porter son issue, et ce n'est pas un oubli : elle dépend de
 * la réponse de Meta, que seul le câblage connaîtra. Les trois autres la portent, donc le compilateur
 * interdit d'en inventer une au moment de l'écrire.
 */
export type DecisionRoutage =
  | { sorte: 'inchange'; issue: 'inchange' }
  | { sorte: 'aucun_declencheur'; issue: 'agent_meta' | 'bloque' | 'desabonne' | 'sans_scenario' }
  | { sorte: 'pub_seule'; issue: 'scenario'; automationId: string | null }
  | { sorte: 'reprendre_puis_pub'; automationId: string | null };

/**
 * LA RÈGLE, ligne par ligne du tableau de la spec § 3.3, DANS SON ORDRE.
 *
 * 🔴 L'ORDRE DES TESTS EST LA MOITIÉ DE LA RÈGLE, et il n'est pas celui qu'on écrirait d'instinct :
 *
 *  1. **La campagne d'abord.** Sans campagne connue, on ne touche à RIEN. C'est le cas de l'immense majorité
 *     du trafic publicitaire d'aujourd'hui (une pub créée dans le Gestionnaire, un `referral` de publication)
 *     et il doit continuer de se comporter exactement comme avant ce lot.
 *  2. **La destination avant l'état du contact.** Une pub « agent de Meta » ne regarde ni le blocage ni le
 *     désabonnement, et c'est correct : nous n'envoyons rien, donc il n'y a rien à retenir. C'est l'agent de
 *     Meta qui parle, sur le numéro du client, et ces deux gardes-là protègent NOS envois.
 *  3. **Bloqué avant désabonné.** Les deux rendent « rien ne part », mais pas pour la même raison, et
 *     l'entonnoir les compte séparément. Un contact à la fois bloqué et désabonné est d'abord un contact
 *     bloqué : c'est une décision de modération, elle prime sur un état de consentement.
 *  4. **`standby` en dernier**, parce que c'est le seul cas qui demande un geste chez Meta avant d'agir.
 *
 * ⚠️ `bloque` ET `desabonne` NE SONT PAS LUS dans les deux premières branches, et un test le pince : le
 * câblage a le droit de ne pas aller les chercher quand la campagne est inconnue ou qu'elle va à l'agent de
 * Meta, ce qui lui économise deux requêtes sur le chemin chaud de CHAQUE message entrant publicitaire.
 */
export function routerLeLead(f: FaitsDuLead): DecisionRoutage {
  if (f.pub === null) return { sorte: 'inchange', issue: 'inchange' };
  if (f.pub.destination === 'agent_meta') return { sorte: 'aucun_declencheur', issue: 'agent_meta' };
  if (f.bloque) return { sorte: 'aucun_declencheur', issue: 'bloque' };
  if (f.desabonne) return { sorte: 'aucun_declencheur', issue: 'desabonne' };
  // 🔴 RIEN À DÉMARRER : ON NE TOUCHE À RIEN, ET SURTOUT PAS AU FIL. `automationId` est nul quand le
  // scénario a été supprimé, ou quand la publicité n'est pas encore publiée (son automation naît éteinte,
  // et c'est la publication qui l'allume). Prendre le fil à l'agent de Meta pour que personne ne parle
  // ensuite transformerait un clic payé en silence de vingt-quatre heures, alors que sans nous l'agent de
  // Meta aurait répondu. Ce test passe donc AVANT le standby, et c'est tout son intérêt.
  if (f.pub.automationId === null) return { sorte: 'aucun_declencheur', issue: 'sans_scenario' };
  if (f.enStandby) return { sorte: 'reprendre_puis_pub', automationId: f.pub.automationId };
  return { sorte: 'pub_seule', issue: 'scenario', automationId: f.pub.automationId };
}

/**
 * CE QUE LES DÉCLENCHEURS ONT LE DROIT DE FAIRE DE CE MESSAGE.
 *
 * 🔴 `seule` EST CE QUI DÉBRANCHE « TOUTES LES PUBS » ET « NOUVEAU CONTACT ». La spec (§ 3.3) exige que
 * **seule** l'automation de la pub soit évaluée quand la campagne est reliée. Ce n'est pas exprimable par la
 * mise en correspondance des déclencheurs : une automation `ctwa_ad` sans pub précise veut dire « n'importe
 * quelle pub », et elle a raison de le vouloir partout ailleurs. C'est donc une RESTRICTION posée en amont,
 * et c'est elle qui change le comportement des automations DÉJÀ créées.
 */
export type RestrictionDeclencheurs =
  /** Rien à restreindre : le message suit le chemin ordinaire. */
  | { sorte: 'tous' }
  /** Aucun déclencheur ne s'applique à ce message. */
  | { sorte: 'aucun' }
  /** Une seule automation est évaluée, celle de la pub, et elle passe quand même ses trois filtres. */
  | { sorte: 'seule'; automationId: string };

/**
 * CE QUE LE ROUTAGE LÈGUE AUX DÉCLENCHEURS pour UN message.
 *
 * ⚠️ LA CAMPAGNE VOYAGE AVEC LA RESTRICTION, et pas seulement l'automation à retenir. L'automation d'une pub
 * porte `{campaignId}` dans sa configuration : sans cette valeur dans l'événement, elle serait retenue par la
 * restriction puis REFUSÉE par sa propre correspondance, et le lead n'irait nulle part. Les deux moitiés se
 * posent ensemble ou pas du tout.
 */
export interface RoutageDuMessage {
  restriction: RestrictionDeclencheurs;
  /** `null` = campagne inconnue. C'est le cas de tout le trafic d'avant ce lot. */
  campagneId: string | null;
  /**
   * LE FIL A ÉTÉ PRIS À L'AGENT DE META POUR CE MESSAGE, et voici à qui il appartient. `null` = on n'a rien
   * pris, donc il n'y a rien à rendre.
   *
   * 🔴 IL EXISTE POUR QU'ON PUISSE LE RENDRE, et c'est le filet du seul cas que la règle ne peut pas
   * prévoir : on prend le fil AVANT de savoir si l'automation va réellement démarrer. Elle peut encore
   * être retenue par son anti-rebond, ou refuser parce que son scénario a disparu. Sans ce retour, le fil
   * resterait à nous et personne ne parlerait, jusqu'au balayage de contrôle, vingt-quatre heures plus
   * tard, quand la fenêtre de service de Meta est déjà fermée.
   */
  repris: { tenantId: string; waId: string } | null;
}

/**
 * La restriction qui découle de la décision, une fois la reprise tentée.
 *
 * ⚠️ `repriseReussie` n'est lu que pour la décision qui en demande une, et il vaut alors exactement ce que
 * Meta a répondu. Sur un refus, on retombe sur `aucun` : l'agent de Meta garde le lead et NOUS ne devons
 * surtout pas lui répondre par-dessus, ce qui ferait recevoir deux messages au contact.
 *
 * ⚠️ UNE AUTOMATION ABSENTE VAUT `aucun`, JAMAIS `tous`. Le scénario d'une pub a pu être supprimé : la pub
 * reste, la destination reste `scenario`, et il n'y a plus rien à démarrer. Retomber sur le chemin ordinaire
 * ferait ramasser ce lead par une automation par mot-clé, c'est-à-dire répondre à côté sur un clic payé.
 */
export function restrictionDuRoutage(d: DecisionRoutage, repriseReussie: boolean): RestrictionDeclencheurs {
  if (d.sorte === 'inchange') return { sorte: 'tous' };
  if (d.sorte === 'aucun_declencheur') return { sorte: 'aucun' };
  if (d.sorte === 'reprendre_puis_pub' && !repriseReussie) return { sorte: 'aucun' };
  return d.automationId === null ? { sorte: 'aucun' } : { sorte: 'seule', automationId: d.automationId };
}

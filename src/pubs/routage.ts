/**
 * Où va le lead d'une publicité Click-to-WhatsApp. Module pur : les faits entrent, une décision sort.
 *
 * La règle décide qui répond à un client qui vient de cliquer une publicité payée (l'agent de Meta, un
 * scénario, ou personne). Six cas, dont trois « on ne fait rien » qui ne veulent pas dire la même chose :
 * écrite ici, chaque ligne du tableau est un test de trois lignes ; dans un `if` du câblage, elle finirait
 * gardée par un test qui lit le texte du `if`. Modèle : `devenirEffectif` (`src/inbox/assignation-campagne.ts`).
 */

/** Qui répond aux leads d'une campagne. Exclusif : c'est l'un ou l'autre, jamais les deux. */
export type DestinationPub = 'scenario' | 'agent_meta';

/**
 * L'issue d'une arrivée, inscrite sur `arrivees_pub.issue`. Elle sert à comprendre après coup ce qui s'est
 * passé pour un lead, et à compter à part les clics payés qui n'ont abouti à rien. Une valeur dont le type
 * découle, pour que `tests/pubs-entonnoir.test.ts` compare la liste au CHECK de la base.
 */
export const ISSUES_ROUTAGE = [
  /** Aucune campagne connue : les déclencheurs ordinaires tournent comme pour tout message. */
  'inchange',
  /** La pub envoie ses leads à l'agent de Meta : on ne déclenche rien, il répond, c'est lui le primaire. */
  'agent_meta',
  /** Le fil a été repris à l'agent de Meta, le scénario a la main. */
  'reprise_reussie',
  /**
   * La reprise n'a pas eu lieu et le scénario ne part pas : Meta a refusé de rendre le fil (son agent garde le
   * lead), ou un opérateur tient la conversation (il la garde, le message l'attend dans l'Inbox).
   */
  'reprise_refusee',
  /** Le contact a dit STOP. Rien ne part, et l'arrivée le dit plutôt que de disparaître. */
  'desabonne',
  /** Le contact est bloqué. Rien ne part. */
  'bloque',
  /** Cas nominal : le scénario de la pub, et lui seul, est évalué. */
  'scenario',
  /**
   * La publicité confie ses leads à un scénario et il n'y a rien à démarrer (scénario supprimé, ou publicité
   * pas encore publiée, son automation naît éteinte). On ne prend alors pas le fil : l'agent de Meta continue
   * de répondre, au lieu d'un silence de vingt-quatre heures sur un clic payé.
   */
  'sans_scenario',
] as const;

export type IssueRoutage = typeof ISSUES_ROUTAGE[number];

/** La publicité qui pilote ce lead, telle que nos tables la connaissent. */
export interface PubDuLead {
  /** L'identifiant Meta de la campagne : c'est le niveau du lien, pas la pub. */
  campagneId: string;
  destination: DestinationPub;
  /**
   * L'automation possédée par cette pub, seulement si elle est allumée. `null` = rien ne partira, qu'il
   * s'agisse d'un scénario supprimé ou d'une publicité pas encore publiée ; rien ne justifie alors de prendre
   * le fil. Le filtre sur `enabled` est dans la requête (`PgPublicitesStore.pubDeLaCampagne`), la règle étant
   * pure.
   */
  automationId: string | null;
}

/**
 * Tout ce que la règle regarde, rassemblé par le câblage avant l'appel, jamais lu paresseusement ici : une
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
 * Ce qu'il faut faire, en quatre cas exhaustifs. `reprendre_puis_pub` seul ne porte pas son issue : elle
 * dépend de la réponse de Meta, que seul le câblage connaîtra. Les autres la portent, donc le compilateur
 * interdit d'en inventer une.
 */
export type DecisionRoutage =
  | { sorte: 'inchange'; issue: 'inchange' }
  | { sorte: 'aucun_declencheur'; issue: 'agent_meta' | 'bloque' | 'desabonne' | 'sans_scenario' }
  | { sorte: 'pub_seule'; issue: 'scenario'; automationId: string | null }
  | { sorte: 'reprendre_puis_pub'; automationId: string | null };

/**
 * La règle, dans l'ordre du tableau, et l'ordre des tests est la moitié de la règle :
 *
 *  1. la campagne d'abord : sans campagne connue, on ne touche à rien ;
 *  2. la destination avant l'état du contact : une pub « agent de Meta » ne regarde ni blocage ni
 *     désabonnement, car nous n'envoyons rien, et ces gardes protègent nos envois ;
 *  3. bloqué avant désabonné : une décision de modération prime sur un état de consentement, et
 *     l'entonnoir les compte à part ;
 *  4. `standby` en dernier, seul cas qui demande un geste chez Meta avant d'agir.
 *
 * `bloque` et `desabonne` ne sont pas lus dans les deux premières branches (un test le pince) : le câblage
 * peut ne pas aller les chercher, deux requêtes de moins sur le chemin chaud.
 */
export function routerLeLead(f: FaitsDuLead): DecisionRoutage {
  if (f.pub === null) return { sorte: 'inchange', issue: 'inchange' };
  if (f.pub.destination === 'agent_meta') return { sorte: 'aucun_declencheur', issue: 'agent_meta' };
  if (f.bloque) return { sorte: 'aucun_declencheur', issue: 'bloque' };
  if (f.desabonne) return { sorte: 'aucun_declencheur', issue: 'desabonne' };
  // Rien à démarrer : on ne touche pas au fil. Prendre le fil à l'agent de Meta pour que personne ne parle
  // transformerait un clic payé en silence ; ce test passe donc avant le standby.
  if (f.pub.automationId === null) return { sorte: 'aucun_declencheur', issue: 'sans_scenario' };
  if (f.enStandby) return { sorte: 'reprendre_puis_pub', automationId: f.pub.automationId };
  return { sorte: 'pub_seule', issue: 'scenario', automationId: f.pub.automationId };
}

/**
 * Ce que les déclencheurs ont le droit de faire de ce message. `seule` débranche « toutes les pubs » et
 * « nouveau contact » : une automation `ctwa_ad` sans pub précise veut dire « n'importe quelle pub », et ce
 * n'est pas exprimable par la correspondance, d'où cette restriction posée en amont.
 */
export type RestrictionDeclencheurs =
  /** Rien à restreindre : le message suit le chemin ordinaire. */
  | { sorte: 'tous' }
  /** Aucun déclencheur ne s'applique à ce message. */
  | { sorte: 'aucun' }
  /** Une seule automation est évaluée, celle de la pub, et elle passe quand même ses trois filtres. */
  | { sorte: 'seule'; automationId: string };

/**
 * Ce que le routage lègue aux déclencheurs pour un message. La campagne voyage avec la restriction :
 * l'automation d'une pub porte `{campaignId}`, et sans cette valeur dans l'événement elle serait retenue par
 * la restriction puis refusée par sa propre correspondance.
 */
export interface RoutageDuMessage {
  restriction: RestrictionDeclencheurs;
  /** `null` = campagne inconnue. */
  campagneId: string | null;
  /**
   * Le fil a été pris à l'agent de Meta pour ce message, et voici à qui il appartient ; `null` = rien à
   * rendre. On prend le fil avant de savoir si l'automation démarrera (anti-rebond, scénario disparu) : sans ce
   * retour, personne ne parlerait jusqu'au balayage de contrôle, fenêtre de service déjà fermée. `contenu` : le
   * texte du lead, que l'agent reçoit quand on lui rend la conversation, pour y répondre tout de suite.
   */
  repris: { tenantId: string; waId: string; contenu: string } | null;
}

/**
 * La restriction qui découle de la décision, une fois la reprise tentée. Sur un refus de Meta, `aucun` :
 * répondre par-dessus son agent ferait recevoir deux messages au contact. Une automation absente vaut
 * `aucun`, jamais `tous` : le chemin ordinaire ferait ramasser le lead par une automation par mot-clé.
 */
export function restrictionDuRoutage(d: DecisionRoutage, repriseReussie: boolean): RestrictionDeclencheurs {
  if (d.sorte === 'inchange') return { sorte: 'tous' };
  if (d.sorte === 'aucun_declencheur') return { sorte: 'aucun' };
  if (d.sorte === 'reprendre_puis_pub' && !repriseReussie) return { sorte: 'aucun' };
  return d.automationId === null ? { sorte: 'aucun' } : { sorte: 'seule', automationId: d.automationId };
}

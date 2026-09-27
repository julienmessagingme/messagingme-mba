/**
 * La chaîne d'étages d'une campagne : une suite de tentatives, chacune sur son canal, qu'on parcourt tant que
 * la précédente n'a pas abouti. Le balayage fait avancer un destinataire d'étage (`bascule.ts`), le run sert le
 * canal de l'étage où il est (`etageServable`, `contenuDeLEtage`).
 *
 * Une chaîne à un seul étage n'a jamais de `rangSuivant`, donc aucune bascule. Les fonctions sont pures et ne
 * supposent rien de l'ordre du tableau : la lecture SQL peut rendre les lignes dans n'importe quel ordre.
 */

/**
 * Les canaux qu'un étage sait porter, miroir du CHECK de `campaign_etages.canal` : une liste plus étroite ici
 * refuserait de relire une ligne que la base accepte. Un étage e-mail se crée mais ne s'envoie pas : aucun
 * sender de campagne n'existe, le run le refuse avec sa raison et la bascule passe au suivant.
 */
export type CanalEtage = 'whatsapp' | 'rcs' | 'email';

/**
 * Le rang du premier étage. Constante partagée, pas un `1` recopié : elle sépare le rang dont le contenu vient
 * des colonnes de `campaigns` de ceux dont le contenu vient de leur ligne d'étage (`contenuDeLEtage`).
 */
export const RANG_INITIAL = 1;

/**
 * Le rang le plus haut d'une chaîne. Aussi écrit dans le CHECK `rang between 1 and 3` : les deux doivent rester
 * d'accord, sinon l'erreur sort à l'écriture en base et non à la validation.
 */
export const RANG_MAX = 3;

/** Un étage : un rang, un canal, et le contenu que ce canal sait envoyer. */
export interface Etage {
  rang: number;
  canal: CanalEtage;
  /** Étage WhatsApp : le template à envoyer. */
  templateName?: string;
  /** Étage WhatsApp : la langue du template. */
  templateLanguage?: string;
  /** Étage RCS : le message, tel que validé à la création (jsonb en base). */
  rcsMessage?: unknown;
  /** Étage e-mail : le modèle (`email_templates.id`). */
  emailTemplateId?: string;
  /**
   * Étage e-mail : la clé du jsonb `contacts.fields` qui porte l'adresse. `contacts` n'a pas de colonne `email`
   * et il n'existe aucune convention de nom (« mail », « email »...) : la clé appartient donc à l'étage.
   * Absente = on ne sait pas où lire l'adresse, l'étage est sauté (`prochainEtageServable`).
   */
  emailChamp?: string;
  /** Étage à scénario : démarre ce parcours au lieu d'envoyer un contenu propre. */
  workflowId?: string;
  /**
   * Le nom du scénario, en lecture seule : jamais écrit dans `campaign_etages`, il vient d'une jointure sur
   * `workflows` à la lecture (un scénario se renomme). Absent quand le scénario a été supprimé : l'écran retombe
   * sur l'identifiant.
   */
  workflowName?: string;
  /**
   * Ce qui se passe quand le contact répond à cet étage, propre à l'étage (un modèle WhatsApp peut renvoyer à
   * l'équipe, un scénario RCS décider lui-même). Absent = comportement d'avant. Deux valeurs seulement : un agent
   * IA n'existe pas hors d'un scénario (`agent_sessions.run_id` est NOT NULL).
   */
  devenir?: DevenirEtage;
}

/** L'étage d'un rang donné, ou `null` s'il n'y en a pas (« la chaîne s'arrête ici »). */
export function etageAuRang(chaine: Etage[], rang: number): Etage | null {
  return chaine.find((e) => e.rang === rang) ?? null;
}

/**
 * Le rang qui suit `rangCourant`, ou `null` s'il est le dernier.
 *
 * C'est le plus petit rang strictement supérieur, pas `rangCourant + 1` (une chaîne aux rangs 1 et 3 doit aller
 * jusqu'à 3) ni l'élément suivant du tableau (rien ne garantit qu'il soit trié : on reviendrait sur un rang déjà
 * franchi). `rangCourant` n'a pas besoin d'exister dans la chaîne : la réponse reste juste s'il vient d'être retiré.
 */
export function rangSuivant(chaine: Etage[], rangCourant: number): number | null {
  let suivant: number | null = null;
  for (const e of chaine) {
    if (e.rang > rangCourant && (suivant === null || e.rang < suivant)) suivant = e.rang;
  }
  return suivant;
}

/**
 * Un étage tel qu'un appelant le propose, avant validation. Distinct d'`Etage` : ici le rang est une intention
 * d'ordre, là une valeur écrite sous un CHECK et une clé primaire `(campaign_id, rang)`. Les confondre ferait
 * trancher Postgres, donc rendre une 5xx là où l'utilisateur attend une phrase.
 */
export interface EtageEntrant {
  rang: number;
  canal: CanalEtage;
  templateName?: string;
  templateLanguage?: string;
  rcsMessage?: unknown;
  emailTemplateId?: string;
  /** La clé du jsonb `contacts.fields` qui porte l'adresse. Cf. `Etage.emailChamp`. */
  emailChamp?: string;
  workflowId?: string;
  /**
   * Cf. `Etage.devenir`. Typé `string` et non `DevenirEtage` : entrée non validée, venue du corps d'une requête,
   * que `problemeDeChaine` vérifie en rendant un 4xx lisible.
   */
  devenir?: string;
}

/** Miroir du CHECK `campaign_etages_devenir_chk`, pas une supposition. */
export type DevenirEtage = 'mba' | 'inbox';
export const DEVENIRS: readonly string[] = ['mba', 'inbox'];

/** Les trois canaux que le CHECK de `campaign_etages.canal` accepte. Miroir du SQL, pas une supposition. */
const CANAUX: readonly string[] = ['whatsapp', 'rcs', 'email'];

/**
 * La chaîne renumérotée 1..N, dans l'ordre des rangs proposés.
 *
 * Elle trie avant de renuméroter : renuméroter par position passerait sur une entrée déjà triée et poserait le
 * contenu du rang 2 sur l'étage 1 dans le cas contraire. Le tri est stable, deux étages au même rang gardent
 * leur ordre d'arrivée. Elle ne tronque pas (une chaîne trop longue est refusée par `problemeDeChaine`) et ne
 * valide rien d'autre.
 */
export function normaliserChaine(entrants: EtageEntrant[]): Etage[] {
  return [...entrants]
    .sort((a, b) => a.rang - b.rang)
    .map((e, i) => {
      const { rang: _propose, ...contenu } = e;
      return { ...contenu, rang: RANG_INITIAL + i } as Etage;
    });
}

/**
 * Ce qui interdit d'écrire cette chaîne, en français, ou `null`. Un message et non un booléen : la route répond
 * 422 avec une phrase.
 *
 * `canalCampagne` est le canal déclaré (`campaigns.channel`). Le premier étage doit lui être égal, car le
 * contenu du rang 1 vient des colonnes de `campaigns` (`insertCampaignRow`, `contenuDeLEtage`) : une divergence
 * enverrait le contenu d'un canal en le journalisant sur un autre.
 */
export function problemeDeChaine(entrants: EtageEntrant[], canalCampagne: CanalEtage): string | null {
  if (!Array.isArray(entrants) || entrants.length === 0) {
    return "Cette campagne désigne une chaîne d'étages sans en donner aucun.";
  }
  if (entrants.length > RANG_MAX) {
    return `Une chaîne ne peut pas dépasser ${RANG_MAX} étages.`;
  }
  for (const e of entrants) {
    if (typeof e?.rang !== 'number' || !Number.isInteger(e.rang)) {
      return "Le rang d'un étage doit être un entier.";
    }
    if (typeof e?.canal !== 'string' || !CANAUX.includes(e.canal)) {
      return `Canal d'étage inconnu : les canaux disponibles sont ${CANAUX.join(', ')}.`;
    }
    // Refusé ici plutôt qu'en base : le CHECK `campaign_etages_devenir_chk` lèverait en 500, derrière une page
    // Cloudflare. Un corps mal formé sort en 4xx.
    if (e.devenir !== undefined && (typeof e.devenir !== 'string' || !DEVENIRS.includes(e.devenir))) {
      return `Devenir d'étage inconnu : les valeurs possibles sont ${DEVENIRS.join(', ')}.`;
    }
  }
  // Deux étages sur le même canal ne sont pas un repli (c'est un réessai déguisé), et le funnel par canal
  // (`funnelParCanal`) les confondrait en une seule ligne.
  const canaux = entrants.map((e) => e.canal);
  if (new Set(canaux).size !== canaux.length) {
    return "Deux étages d'une même chaîne ne peuvent pas partir sur le même canal.";
  }
  const premier = normaliserChaine(entrants)[0];
  if (premier && premier.canal !== canalCampagne) {
    return `Le premier étage doit partir sur le canal de la campagne (${canalCampagne}).`;
  }
  return null;
}

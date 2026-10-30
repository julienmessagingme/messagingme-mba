import { estUuid } from '../http/scope';

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
   * l'équipe, un scénario RCS décider lui-même). Absent = comportement d'avant. Deux valeurs : l'équipe (`inbox`), ou
   * « le répondeur automatique prend la main » (`mba`), dont `repondeur` dit lequel.
   */
  devenir?: DevenirEtage;
  /**
   * Qui prend la main quand le répondeur automatique la prend (`devenir: 'mba'`), propre à l'étage (migration 0263) :
   * l'agent de Meta, ou l'agent IA `repondeurAgentId`. Absent = le répondeur de l'espace. Lu par la remise, à la
   * première réponse depuis l'envoi seulement (`PgCampaignRepo.repondeurDeLaReponse`). Un agent IA peut désormais
   * répondre hors d'un scénario du client : le démarreur du répondeur le lance dans le scénario système caché de
   * l'espace (`src/repondeur/demarrer.ts`), ce qui manquait en 0145 (`agent_sessions.run_id` est NOT NULL).
   */
  repondeur?: RepondeurEtage;
  /** L'agent IA, quand `repondeur` vaut `agent`. Absent : un autre répondeur, ou l'agent supprimé depuis (`on delete set null`). */
  repondeurAgentId?: string;
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
  /** Cf. `Etage.repondeur`. Entrée non validée, comme `devenir` : `problemeDeRepondeur` la juge. */
  repondeur?: string;
  /** Cf. `Etage.repondeurAgentId`. Sa forme est jugée par `problemeDeRepondeur`, son espace par `preparerCampagne`. */
  repondeurAgentId?: string;
}

/** Miroir du CHECK `campaign_etages_devenir_chk`, pas une supposition. */
export type DevenirEtage = 'mba' | 'inbox';
export const DEVENIRS: readonly string[] = ['mba', 'inbox'];

/**
 * Miroir du CHECK `campaign_etages_repondeur_chk` (migration 0263), que `tests/migration-0263.test.ts` lit dans le fichier
 * pour l'égaler à cette liste.
 */
export type RepondeurEtage = 'mba' | 'agent';
export const REPONDEURS_ETAGE: readonly string[] = ['mba', 'agent'];

/**
 * Ce que la remise lit d'une réponse de campagne (`PgCampaignRepo.repondeurDeLaReponse`) : le répondeur que désigne
 * l'étage, et le nom de la campagne, que la frise du panneau Détail cite (« automatique : campagne Rentrée »).
 */
export type RepondeurDeLaReponse =
  | { nom: string; cible: 'mba' }
  | { nom: string; cible: 'agent'; agentId: string };

/** Le même message pour les deux façons de nommer un agent hors du répondeur « agent » (le CHECK 0263 le refuserait). */
const AGENT_SANS_REPONDEUR_AGENT = "Un agent IA ne se désigne que comme répondeur « agent » de l'étage.";

/**
 * Ce qui interdit le répondeur proposé pour un étage, en français, ou `null`. 🔴 UNE règle pour le premier étage (les
 * champs de la campagne), chaque étage de la chaîne (`problemeDeChaine`) et l'outil MCP `prepare_campaign` (qui passe
 * par `preparerCampagne`) : trois copies finiraient par diverger. Elle refuse ce que les CHECK de 0263 trancheraient en
 * 500, derrière une page Cloudflare, et la forme de l'identifiant, qui ferait lever Postgres (22P02) à la lecture de
 * l'agent. Elle ne lit rien : qu'un agent soit ACTIF et de CET espace se juge à part, par une lecture scopée
 * (`preparerCampagne`), la clé étrangère ne scopant pas l'espace. `null` vaut absent, comme le schéma MCP l'annonce.
 */
export function problemeDeRepondeur(e: { devenir?: unknown; repondeur?: unknown; repondeurAgentId?: unknown; canal?: unknown }): string | null {
  const repondeur = e.repondeur ?? undefined;
  const agentId = e.repondeurAgentId ?? undefined;
  if (repondeur === undefined) return agentId === undefined ? null : AGENT_SANS_REPONDEUR_AGENT;
  if (typeof repondeur !== 'string' || !REPONDEURS_ETAGE.includes(repondeur)) {
    return `Répondeur d'étage inconnu : les valeurs possibles sont ${REPONDEURS_ETAGE.join(', ')}.`;
  }
  /**
   * 🔴 WHATSAPP SEULEMENT (relecture de la livraison B, 2026-10-30) : une réponse RCS ou e-mail ne passe jamais par la
   * remise « personne ne suit » (`src/rcs/message-entrant.ts` écrit l'Inbox sans l'appeler), donc le répondeur désigné
   * sur un tel étage ne répondrait jamais, alors que l'étage l'aurait promis. Refusé ici plutôt qu'enregistré pour rien.
   */
  if (e.canal !== undefined && e.canal !== 'whatsapp') return 'Un répondeur ne se désigne que sur un étage WhatsApp.';
  // Le piège du NULL de 0263, côté code : un étage sans devenir n'a pas de répondeur automatique à désigner.
  if (e.devenir !== 'mba') return 'Un répondeur ne se choisit que si le répondeur automatique prend la main.';
  if (repondeur === 'mba') return agentId === undefined ? null : AGENT_SANS_REPONDEUR_AGENT;
  return estUuid(agentId) ? null : 'Ce répondeur est un agent IA : il faut le choisir.';
}

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
    // Le rang 1 aussi, bien que son contenu vienne des colonnes de la campagne : un corps mal formé sort en 4xx partout.
    const repondeur = problemeDeRepondeur(e);
    if (repondeur) return repondeur;
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

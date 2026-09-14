/**
 * LA CHAÎNE D'ÉTAGES D'UNE CAMPAGNE : le canal n'est plus un attribut de la campagne, c'est une SUITE
 * de tentatives, chacune sur son canal, qu'on parcourt tant que la précédente n'a pas abouti.
 *
 * 🔴 IL EST EN SERVICE DEPUIS LE 2026-09-12, et cet en-tête a dit le contraire (« ce module ne change
 * rien aujourd'hui ») tant que la chaîne n'était que déclarative. Le balayage fait avancer un
 * destinataire d'étage (`bascule.ts`), et le run SERT le canal de l'étage où il est (`etageServable` et
 * `contenuDeLEtage`, `src/campaign/engine.ts`).
 *
 * ⚠️ CE QUI RESTE VRAI DU PARC EXISTANT : une chaîne à UN seul étage a, par construction, un
 * `rangSuivant` toujours nul, donc aucune bascule n'est possible et le comportement est EXACTEMENT celui
 * d'avant. La migration 0134 a repris tout le parc au rang 1, et c'est ce qui a permis de déployer la
 * chaîne avant le moteur, puis de la vérifier sur du vrai trafic.
 *
 * ⚠️ Les fonctions sont PURES et ne supposent rien de l'ordre du tableau. Le contraire aurait été le
 * piège : la lecture SQL peut rendre les lignes dans n'importe quel ordre, et une chaîne construite par
 * un appelant n'est triée par personne.
 */

/**
 * Les canaux qu'un étage sait porter.
 *
 * ⚠️ UN ÉTAGE E-MAIL SE CRÉE (l'assistant le propose en troisième niveau) MAIS NE S'ENVOIE PAS : aucun
 * sender de campagne n'existe pour ce canal, donc le run le REFUSE avec sa raison (`run-job.ts`) et la
 * bascule passe au suivant. C'est le CHECK de la table qui fait foi sur cette liste
 * (`campaign_etages.canal`), et il porte les trois : une liste plus étroite ici refuserait de relire une
 * ligne que la base accepte d'écrire, ce qui est la pire des deux fautes.
 */
export type CanalEtage = 'whatsapp' | 'rcs' | 'email';

/**
 * Le rang du PREMIER étage, celui de toute campagne d'aujourd'hui.
 *
 * 🔴 CONSTANTE PARTAGÉE, PAS UN `1` RECOPIÉ. Elle est écrite par la reprise de 0134, par le défaut de
 * `campaign_recipients.etage_courant`, et par le journal des tentatives du moteur. Elle est SURTOUT ce
 * qui sépare le rang dont le contenu vient des colonnes de `campaigns` de ceux dont le contenu vient de
 * leur ligne d'étage (`contenuDeLEtage`, `src/campaign/engine.ts`) : un `1` en dur n'apparaîtrait dans
 * aucune liste de lecteurs le jour où cette frontière bougerait.
 */
export const RANG_INITIAL = 1;

/**
 * Le rang le plus haut qu'une chaîne puisse porter.
 *
 * ⚠️ IL EST AUSSI ÉCRIT DANS LE CHECK DE LA MIGRATION 0134 (`rang between 1 and 3`), et les deux doivent
 * rester d'accord : élargir ici sans élargir la contrainte ferait échouer l'écriture en base, pas la
 * validation en code, donc l'erreur sortirait au plus mauvais moment.
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
   * Étage e-mail : LA CLÉ DU JSONB `contacts.fields` QUI PORTE L'ADRESSE (migration 0135).
   *
   * 🔴 `contacts` N'A PAS DE COLONNE `email`, vérifié dans les migrations (0001 crée la table sans,
   * 0002 ajoute `fields`, aucun `alter table contacts` n'en a ajouté depuis), et il n'existe AUCUNE
   * convention de nom : un espace l'appelle « mail », un autre « email » (`src/workflow/wiring.ts`,
   * cas du 2026-08-25). La clé appartient donc à l'étage, et deux campagnes du même espace peuvent
   * viser deux champs différents.
   *
   * ⚠️ Absente = on ne sait pas où lire l'adresse, donc l'étage n'est pas servable et il est SAUTÉ
   * (`prochainEtageServable`, `src/campaign/bascule.ts`).
   */
  emailChamp?: string;
  /** Étage à SCÉNARIO : démarre ce parcours au lieu d'envoyer un contenu propre. */
  workflowId?: string;
  /**
   * CE QUI SE PASSE QUAND LE CONTACT RÉPOND À CET ÉTAGE (migration 0144).
   *
   * 🔴 PROPRE À L'ÉTAGE, ET C'EST TOUT L'INTÉRÊT : une chaîne de repli peut servir un modèle seul en
   * WhatsApp (dont les réponses vont à l'équipe) et un scénario en RCS (qui décide lui-même). Absent =
   * campagne d'avant le câblage, qui garde exactement son comportement.
   *
   * ⚠️ DEUX VALEURS, PAS TROIS : un agent IA ne sait pas exister hors d'un scénario
   * (`agent_sessions.run_id` est NOT NULL), donc « un agent IA reprend » passe par « modèle + scénario ».
   */
  devenir?: DevenirEtage;
}

/**
 * L'étage d'un rang donné, ou `null` s'il n'y en a pas.
 *
 * `null` veut dire « il n'y a rien à ce rang », ce que l'appelant lit comme « la chaîne s'arrête ici ».
 */
export function etageAuRang(chaine: Etage[], rang: number): Etage | null {
  return chaine.find((e) => e.rang === rang) ?? null;
}

/**
 * Le rang qui suit `rangCourant` dans la chaîne, ou `null` si `rangCourant` est le dernier.
 *
 * 🔴 C'EST LE PLUS PETIT RANG STRICTEMENT SUPÉRIEUR, PAS `rangCourant + 1`. Une chaîne dont un étage a
 * été retiré au milieu (rangs 1 et 3) doit continuer jusqu'à 3, pas s'arrêter sur un 2 qui n'existe
 * pas : `rangCourant + 1` rendrait un rang vide, que l'appelant traiterait comme un étage introuvable,
 * donc comme une fin de chaîne. Le repli le plus utile serait précisément celui qu'on perdrait.
 *
 * 🔴 ET CE N'EST PAS NON PLUS « L'ÉLÉMENT SUIVANT DU TABLEAU ». Cette écriture-là suppose la chaîne
 * triée, ce que rien ne garantit ; sur une chaîne arrivée dans le désordre elle peut rendre un rang
 * DÉJÀ franchi, c'est-à-dire faire tourner un destinataire en rond sur le même étage.
 *
 * ⚠️ `rangCourant` n'a pas besoin d'exister dans la chaîne : on répond « qu'y a-t-il après », pas « où
 * suis-je ». C'est ce qui rend la réponse juste même si l'étage courant vient d'être supprimé.
 */
export function rangSuivant(chaine: Etage[], rangCourant: number): number | null {
  let suivant: number | null = null;
  for (const e of chaine) {
    if (e.rang > rangCourant && (suivant === null || e.rang < suivant)) suivant = e.rang;
  }
  return suivant;
}

/**
 * UN ÉTAGE TEL QU'UN APPELANT LE PROPOSE, avant d'être cru.
 *
 * 🔴 IL EST DISTINCT D'`Etage` EXPRÈS, et la différence tient dans le rang : ici c'est une INTENTION
 * d'ordre, là c'est une valeur écrite en base sous un `check (rang between 1 and 3)` et une clé
 * primaire `(campaign_id, rang)`. Les confondre revient à écrire ce que le client a tapé, donc à faire
 * trancher Postgres, donc à rendre une 5xx que Cloudflare remplace par sa page d'erreur là où
 * l'utilisateur attend une phrase.
 */
export interface EtageEntrant {
  rang: number;
  canal: CanalEtage;
  templateName?: string;
  templateLanguage?: string;
  rcsMessage?: unknown;
  emailTemplateId?: string;
  /** La clé du jsonb `contacts.fields` qui porte l'adresse (migration 0135). Cf. `Etage.emailChamp`. */
  emailChamp?: string;
  workflowId?: string;
  /**
   * Cf. `Etage.devenir`. ⚠️ TYPÉ `string` ET NON `DevenirEtage` : c'est une entrée NON VALIDÉE, venue du
   * corps d'une requête. La fermer ici ferait croire au compilateur qu'elle est déjà sûre, alors que c'est
   * `problemeDeChaine` qui la vérifie et qui rend un 4xx lisible quand elle ne l'est pas.
   */
  devenir?: string;
}

/** Miroir du CHECK `campaign_etages_devenir_chk`, pas une supposition. */
export type DevenirEtage = 'mba' | 'inbox';
export const DEVENIRS: readonly string[] = ['mba', 'inbox'];

/** Les trois canaux que le CHECK de `campaign_etages.canal` accepte. Miroir du SQL, pas une supposition. */
const CANAUX: readonly string[] = ['whatsapp', 'rcs', 'email'];

/**
 * LA CHAÎNE RENUMÉROTÉE 1..N, DANS L'ORDRE DES RANGS PROPOSÉS.
 *
 * 🔴 ELLE TRIE AVANT DE RENUMÉROTER, ET C'EST TOUTE LA FONCTION. Renuméroter par position dans le
 * tableau donne le même résultat sur une entrée déjà triée, donc passe la moitié des tests, et pose le
 * contenu du rang 2 sur l'étage 1 dès qu'un client envoie ses étages dans un autre ordre. Le tri de
 * JavaScript est STABLE depuis ES2019 : deux étages au même rang gardent leur ordre d'arrivée plutôt
 * que d'échanger leur place d'une exécution à l'autre.
 *
 * ⚠️ ELLE NE TRONQUE PAS, et ce n'est pas un oubli : une chaîne trop longue est REFUSÉE par
 * `problemeDeChaine`. Tronquer supprimerait en silence un étage que l'opérateur a configuré, ce qui
 * est exactement le genre de perte qu'on ne découvre qu'à la recette.
 *
 * ⚠️ ELLE NE DÉCIDE RIEN D'AUTRE : ni canal valide, ni cohérence avec la campagne. Ces refus-là sont
 * des messages destinés à un humain, donc ils vivent dans `problemeDeChaine`, qui les rend.
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
 * CE QUI INTERDIT D'ÉCRIRE CETTE CHAÎNE, en français, ou `null` si rien ne l'interdit.
 *
 * 🔴 ELLE REND UN MESSAGE, PAS UN BOOLÉEN, parce que l'appelant est une route qui doit répondre 422
 * avec une phrase. Un booléen l'obligerait à rédiger le motif de son côté, c'est-à-dire à deviner
 * lequel des six refus vient de tomber.
 *
 * ⚠️ `canalCampagne` est le canal DÉCLARÉ de la campagne (`campaigns.channel`). Le premier étage doit
 * lui être égal parce que le contenu du rang 1 vient des COLONNES de `campaigns`, pas de sa ligne
 * d'étage : c'est l'invariant de la migration 0134, appliqué par `insertCampaignRow` et lu par
 * `contenuDeLEtage` (`src/campaign/engine.ts`). Une divergence enverrait le contenu d'un canal en le
 * journalisant sur un autre, ce qui fausse la ventilation sans rien casser de visible.
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
    // ⚠️ REFUSÉ ICI PLUTÔT QU'EN BASE. Le CHECK `campaign_etages_devenir_chk` le refuserait aussi, mais en
    // 500 (une violation de contrainte lève), donc derrière une page d'erreur Cloudflare qui n'expliquerait
    // rien. Un corps mal formé est un message destiné à l'utilisateur : il sort en 4xx.
    if (e.devenir !== undefined && (typeof e.devenir !== 'string' || !DEVENIRS.includes(e.devenir))) {
      return `Devenir d'étage inconnu : les valeurs possibles sont ${DEVENIRS.join(', ')}.`;
    }
  }
  // 🔴 DEUX ÉTAGES SUR LE MÊME CANAL NE SONT PAS UN REPLI. C'est d'abord un contresens produit (« WhatsApp
  // puis WhatsApp » est un réessai déguisé, cf. `web/lib/campagne-chaine.ts`), et c'est ensuite mesurable :
  // la ventilation par canal du funnel groupe par `canal` (`funnelParCanal`, `src/stats/store.pg.ts`), donc
  // les deux étages se confondraient en une seule ligne et l'écran ne dirait plus lequel a échoué.
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

import type { Pool } from 'pg';
import type { BusinessHours } from '../workflow/conditions';
import { estFrequenceMention, type FrequenceMentionIa } from '../agent/agent-store';
import { estModeTransfert, type ModeTransfert } from '../agent/disponibilite-equipe';
import { grilleDepuisLigne, type GrillePrix } from '../stats/prix';

/** Fuseau par défaut si le tenant n'a rien réglé (marché principal FR). */
export const DEFAULT_TIMEZONE = 'Europe/Paris';
/** Horaires d'ouverture par défaut : Lun-Ven 9h-18h, week-end fermé (jour '0' = dimanche). */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  '0': { closed: true, open: '', close: '' },
  '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' },
  '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' },
  '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};

export interface TenantSettings {
  mbaEnabled: boolean;
  /** Fuseau IANA du tenant (ex. 'Europe/Paris'). Défaut serveur si non réglé. Base de NOW / weekday / horaires. */
  timezone: string;
  /** Heures d'ouverture par jour ('0'..'6', 0 = dimanche). Défaut serveur si non réglé. */
  businessHours: BusinessHours;
  /** Toggle « Campagnes via données HubSpot » : OFF = aucun appel au connecteur. */
  hubspotListsEnabled: boolean;
  /**
   * Pause des campagnes via listes HubSpot (F3-b). Piloté ENSEMBLE avec la pause du push (F3-a) par l'action Pause du
   * toggle Synchronisation. true = campagnes listes suspendues (le gate effectif est `hubspotListsEnabled && !campaignsPaused`).
   * N'écrase jamais `hubspotListsEnabled` : la reprise (campaignsPaused -> false) restaure le réglage d'origine.
   */
  campaignsPaused: boolean;
  /** Auto-relance des échecs de livraison (F6). true = le sweeper relance 131049/131026 selon la politique de recouvrement. */
  autoRetryEnabled: boolean;
  /**
   * Durée du GEL après qu'un opérateur a pris la main, en secondes. Pendant ce temps, ni le scénario ni
   * l'agent de Meta n'écrivent au client.
   *
   * null = le client n'a rien réglé, le défaut du serveur s'applique. 0 = pas de reprise automatique,
   * la conversation reste à l'humain jusqu'à ce qu'il la rende explicitement.
   */
  controlHandbackSeconds: number | null;
  /**
   * Quand l'agent de Meta passe-t-il la main à un humain (écran « Activation ») ? Pilote `handoff.enabled`
   * chez Meta. `null` = jamais réglé : on n'écrit alors RIEN chez Meta, et l'écran montre le défaut usine.
   */
  mbaHandoffMode: MbaHandoffMode | null;
  /**
   * Quand un AGENT IA passe la main, l'équipe est-elle joignable ? Mêmes trois valeurs que le MBA, et c'est
   * délibéré : l'écran montre les deux agents côte à côte, et deux vocabulaires voisins pour la même
   * question seraient impossibles à rapprocher.
   *
   * 🔴 IL NE DÉCIDE PAS SI ON TRANSFÈRE : la conversation arrive dans « À traiter » dans tous les cas. Il
   * décide de ce que l'agent a le droit de PROMETTRE. Détail : `src/agent/disponibilite-equipe.ts`.
   *
   * ⚠️ UNE COLONNE À PART DE `mbaHandoffMode`, qui pilote `handoff.enabled` CHEZ META : les confondre ferait
   * reconfigurer l'agent de Meta quand le client règle son agent IA, et l'inverse.
   */
  agentTransfertMode: ModeTransfert | null;
  /**
   * La requête de connecteur (Tools > Connecteurs API) jouée quand quelqu'un se désabonne, ou `null`.
   *
   * 🔴 C'EST CE QUI REND UN REFUS OPPOSABLE AILLEURS QUE CHEZ NOUS : un opt-out qui ne vit que dans notre
   * base laisse le client continuer à écrire à cette personne depuis son CRM, et c'est lui qui en répond.
   *
   * ⚠️ `null` PAR DÉFAUT, POUR TOUT LE MONDE. Un défaut qui enverrait quoi que ce soit à un système tiers
   * sans qu'on l'ait choisi serait l'inverse de ce que le centre de sécurité garantit. Détail dans
   * `src/crm/poussee-optout.ts` et la migration 0139.
   */
  optoutRequestId: string | null;
  /**
   * CE QUE CET ESPACE FACTURE (migration 0154), en objet IMBRIQUE et jamais en six champs a plat.
   *
   * 🔴 IMBRIQUE, ET C'EST LA REGLE DU `Pick` RECOPIE DU `CLAUDE.md`. Six champs a plat forment une liste
   * qu'il faut tenir alignee a la main dans chaque contrat qu'ils traversent, et elle derive : le depot l'a
   * deja paye en production (deux capacites cablees dans le worker, absentes du contrat, jamais vues par le
   * moteur). Un objet passe d'un seul tenant.
   *
   * ⚠️ JAMAIS `null` : un espace qui n'a rien regle recoit `GRILLE_DEFAUT`, dont la marge a 100 reproduit
   * exactement le tarif Meta. Le defaut est donc invisible, ce qui est tout son interet.
   */
  prix: GrillePrix;
  /**
   * QUAND les agents IA de cet espace annoncent qu'ils sont des IA (migration 0140). `null` = rien n'a
   * jamais été réglé ici, le code retombe alors sur `session`, exactement le défaut de 0126.
   *
   * 🔴 AU NIVEAU DE L'ESPACE, ET PAS PAR AGENT, parce que l'AI Act (article 50) fait peser l'obligation sur
   * la marque DÉPLOYANTE. Un client qui a trois agents n'a pas à répondre trois fois à la même question de
   * conformité, et trois réponses différentes seraient trois politiques, ce qui n'existe pas juridiquement.
   *
   * ⚠️ LE META BUSINESS AGENT N'EST PAS GOUVERNÉ PAR CE RÉGLAGE : Meta écrit déjà « IA » sous les messages
   * de son agent, et notre propre déclaration en ferait deux. L'écran le dit.
   */
  mentionIaFrequence: FrequenceMentionIa | null;
  /**
   * Un AGENT peut-il PRENDRE une conversation du pot commun, c'est-à-dire se l'affecter (migration 0160) ?
   *
   * 🔴 PRENDRE, JAMAIS RÉAFFECTER (arbitrage de Julien du 2026-09-19) : la distribution reste le geste de
   * l'encadrement. `false` par défaut, donc le comportement d'avant le réglage pour tout espace qui n'a rien
   * choisi. La règle qui l'applique : `peutPrendre` (`src/inbox/assignment.ts`).
   */
  agentsPeuventPrendre: boolean;
}

/**
 * Les trois choix de l'écran « Activation ». `business_hours` est le seul qui varie dans la journée : c'est
 * le balayage qui bascule alors `handoff.enabled` selon les heures d'ouverture du tenant, Meta n'ayant
 * aucune notion d'horaires.
 */
export type MbaHandoffMode = 'always' | 'business_hours' | 'never';

/** Défaut usine tant que le client n'a rien choisi : l'agent passe la main. */
export const DEFAULT_MBA_HANDOFF_MODE: MbaHandoffMode = 'always';

/** Réglages par tenant (upsert). Toggle MBA on/off + toggle import de listes HubSpot. */
export class PgTenantSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const res = await this.pool.query<{ mba_enabled: boolean; hubspot_lists_enabled: boolean; campaigns_paused: boolean; auto_retry_enabled: boolean; control_handback_seconds: number | null; timezone: string | null; business_hours: BusinessHours | null; mba_handoff_mode: MbaHandoffMode | null; optout_request_id: string | null; mention_ia_frequence: string | null } & Record<string, unknown>>(
      /**
       * 🔴 `select *`, ET C'EST UN RENVERSEMENT ASSUME. La premiere version NOMMAIT les six colonnes de la
       * migration 0154, au motif qu'une etoile fait entrer toute colonne future sans qu'on l'ait decide. Ce
       * motif est reel, mais il pesait infiniment moins que ce qu'il achetait : cette methode est sur le
       * chemin de CHAQUE MESSAGE ENTRANT (`mbaActifPour`), du fuseau de chaque campagne, et de chaque tour
       * d'agent. La nommer en clair rendait la migration 0154 bloquante pour l'INGESTION : un deploiement
       * avant `migrate` ne cassait plus une page, il reproduisait le 2026-08-17, une heure et demie sans
       * enregistrer un seul message.
       *
       * ⚠️ ET LE MEME LOT AVAIT DEJA TRANCHE DANS L'AUTRE SENS, dans un AUTRE fichier (`PgStatsStore.grillePrix`,
       * `src/stats/store.pg.ts`) : elle
       * lit ces memes six colonnes en `select *` dans un `try/catch`, avec pour justification ecrite que la
       * migration n'est pas encore passee entre le deploiement de Vercel et celui du VPS. Deux lecteurs des
       * memes colonnes, deux decisions opposees, dans le meme commit. Releve en revue finale le 2026-09-18.
       *
       * ⚠️ AUCUN SECRET DANS CETTE TABLE : verifie colonne par colonne avant d'ouvrir l'etoile. Ce sont des
       * reglages d'espace, et `grilleDepuisLigne` ne lit que ce qu'elle connait, en retombant sur les
       * defauts pour le reste.
       */
      `select * from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    return {
      mbaEnabled: r?.mba_enabled ?? false,
      hubspotListsEnabled: r?.hubspot_lists_enabled ?? false,
      campaignsPaused: r?.campaigns_paused ?? false,
      autoRetryEnabled: r?.auto_retry_enabled ?? false,
      controlHandbackSeconds: r?.control_handback_seconds ?? null,
      timezone: r?.timezone ?? DEFAULT_TIMEZONE,
      businessHours: r?.business_hours ?? DEFAULT_BUSINESS_HOURS,
      mbaHandoffMode: r?.mba_handoff_mode ?? null,
      // ⚠️ Une valeur inconnue vaut `null`, donc le défaut `always`, donc le comportement d'aujourd'hui : une
      // base en retard sur la migration 0156 se comporte exactement comme avant.
      agentTransfertMode: estModeTransfert(r?.agent_transfert_mode) ? r.agent_transfert_mode : null,
      optoutRequestId: r?.optout_request_id ?? null,
      // ⚠️ Une valeur inconnue vaut `null`, donc « rien n'a été réglé », donc le défaut `session`. Une base
      // en retard (migration 0140 pas encore passée) se comporte comme avant, sans rien casser.
      mentionIaFrequence: estFrequenceMention(r?.mention_ia_frequence) ? r.mention_ia_frequence : null,
      // 🔴 LA MEME CONVERSION QUE LA LECTURE DES STATISTIQUES, par la MEME fonction pure. En ecrire une
      // seconde ici ferait deux facons de lire la meme ligne, et le jour ou l'une gere un `numeric` rendu
      // en chaine et pas l'autre, l'ecran de reglages et la carte des couts afficheraient deux prix.
      prix: grilleDepuisLigne(r ?? null),
      // ⚠️ `=== true` et pas `?? false` : une base en retard sur 0160 ne rend pas la colonne (`select *`),
      // et c'est alors le comportement d'avant, que personne ne peut prendre.
      agentsPeuventPrendre: r?.agents_peuvent_prendre === true,
    };
  }

  /**
   * La clé d'API posée chez Meta pour le relais du MBA (migration 0161), ou `null`.
   *
   * ⚠️ HORS DE `get()`, délibérément : seule la publication la lit, et l'ajouter au type des réglages aurait
   * obligé toutes les fixtures qui en construisent un à la déclarer.
   */
  async mbaRelaisCleId(tenantId: string): Promise<string | null> {
    const r = await this.pool.query<{ id: string | null }>(
      `select mba_relais_cle_id as id from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Retient la clé posée chez Meta (`null` = aucune). Upsert ciblé : n'écrase aucun autre réglage. */
  async setMbaRelaisCleId(tenantId: string, id: string | null): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mba_relais_cle_id, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mba_relais_cle_id = excluded.mba_relais_cle_id, updated_at = now()`,
      [tenantId, id],
    );
  }

  /**
   * Autorise (ou non) les agents à PRENDRE une conversation du pot commun. Upsert ciblé : n'écrase aucun
   * autre réglage.
   */
  async setAgentsPeuventPrendre(tenantId: string, actif: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, agents_peuvent_prendre, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set agents_peuvent_prendre = excluded.agents_peuvent_prendre, updated_at = now()`,
      [tenantId, actif],
    );
  }

  /**
   * Règle QUAND les agents de cet espace annoncent qu'ils sont des IA. Upsert ciblé : n'écrase aucun autre
   * réglage.
   *
   * ⚠️ IL N'Y A PAS DE « remettre à null » : le client choisit entre trois régimes, dont `jamais`. Rendre le
   * réglage à « non renseigné » n'aurait aucun sens pour lui, et ferait retomber l'espace sur un défaut
   * qu'il n'a pas choisi.
   */
  async setMentionIaFrequence(tenantId: string, frequence: FrequenceMentionIa): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mention_ia_frequence, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mention_ia_frequence = excluded.mention_ia_frequence, updated_at = now()`,
      [tenantId, frequence],
    );
  }

  /**
   * Branche (ou débranche, avec `null`) le connecteur prévenu à chaque désabonnement. Upsert ciblé : n'écrase
   * aucun autre réglage.
   *
   * ⚠️ L'EXISTENCE DE LA REQUÊTE EST VÉRIFIÉE PAR LA ROUTE, pas ici : ce store ne parle qu'à la base. La
   * contrainte de la migration 0139 reste la ceinture (une requête d'un AUTRE espace, ou inexistante, est
   * refusée par la clé étrangère plutôt qu'écrite).
   */
  async setOptoutRequestId(tenantId: string, requestId: string | null): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, optout_request_id, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set optout_request_id = excluded.optout_request_id, updated_at = now()`,
      [tenantId, requestId],
    );
  }

  /**
   * Enregistre le choix de l'écran « Activation ». Upsert ciblé : n'écrase aucun autre réglage. L'écriture
   * chez Meta (`handoff.enabled`) est faite par l'appelant, pas ici : ce store ne parle qu'à la base.
   */
  async setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mba_handoff_mode, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mba_handoff_mode = excluded.mba_handoff_mode, updated_at = now()`,
      [tenantId, mode],
    );
  }

  /**
   * Enregistre quand l'équipe est joignable pour les agents IA. Upsert ciblé : n'écrase aucun autre réglage.
   *
   * ⚠️ Rien n'est écrit chez Meta ici, contrairement à son voisin : ce réglage ne concerne QUE nos agents.
   */
  async setAgentTransfertMode(tenantId: string, mode: ModeTransfert): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, agent_transfert_mode, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set agent_transfert_mode = excluded.agent_transfert_mode, updated_at = now()`,
      [tenantId, mode],
    );
  }

  /** Règle le fuseau IANA du tenant (validé en amont par la route). Upsert ciblé : n'écrase aucun autre réglage. */
  async setTimezone(tenantId: string, timezone: string): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, timezone, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set timezone = excluded.timezone, updated_at = now()`,
      [tenantId, timezone],
    );
  }

  /** Règle les heures d'ouverture (déjà normalisées par la route). Upsert ciblé. */
  async setBusinessHours(tenantId: string, hours: BusinessHours): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, business_hours, updated_at) values ($1, $2::jsonb, now())
       on conflict (tenant_id) do update set business_hours = excluded.business_hours, updated_at = now()`,
      [tenantId, JSON.stringify(hours)],
    );
  }

  async setMbaEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mba_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mba_enabled = excluded.mba_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
  }

  /**
   * Règle la durée du gel après prise de main par un opérateur. `null` remet le défaut du serveur, `0`
   * supprime la reprise automatique. Upsert ciblé : n'écrase aucun autre réglage.
   */
  async setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, control_handback_seconds, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set control_handback_seconds = excluded.control_handback_seconds, updated_at = now()`,
      [tenantId, seconds],
    );
  }

  /**
   * Enregistre la grille de prix de l'espace. Upsert cible : n'ecrase aucun autre reglage.
   *
   * 🔴 LES SIX D'UN COUP, JAMAIS UN SEUL. Il n'existe pas de grille partielle : un `patch` a un champ
   * obligerait a fusionner avec l'existant a l'ecriture, et c'est precisement la ou le depot s'est deja
   * fait avoir (une liste REMPLACEE au lieu d'etre fusionnee, qui a detruit du travail client). L'appelant
   * a valide les six par `valideGrille`, qui refuse tout ce qui n'est pas complet.
   *
   * ⚠️ AUCUNE BORNE ICI : elles vivent dans `valideGrille` (pour le message) et dans les CHECK de la
   * migration 0154 (pour la garantie). Une troisieme copie ici serait la premiere a deriver.
   */
  async setGrillePrix(tenantId: string, g: GrillePrix): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, prix_marge_template, prix_service_centimes, prix_service_franchise,
                                    prix_service_depuis, prix_rcs_centimes, prix_rcs_conv_centimes, updated_at)
       values ($1, $2, $3, $4, $5::date, $6, $7, now())
       on conflict (tenant_id) do update set
         prix_marge_template = excluded.prix_marge_template,
         prix_service_centimes = excluded.prix_service_centimes,
         prix_service_franchise = excluded.prix_service_franchise,
         prix_service_depuis = excluded.prix_service_depuis,
         prix_rcs_centimes = excluded.prix_rcs_centimes,
         prix_rcs_conv_centimes = excluded.prix_rcs_conv_centimes,
         updated_at = now()`,
      [tenantId, g.margeTemplate, g.serviceCentimes, g.serviceFranchise, g.serviceDepuis,
       g.rcsSimpleCentimes, g.rcsConversationnelCentimes],
    );
  }

  /**
   * Délais de reprise par tenant, pour les tenants donnés, en MILLISECONDES. Utilisé par le balayage :
   * il lit un lot de conversations de plusieurs clients d'un coup et doit appliquer à chacune le réglage
   * de SON client. Les tenants sans réglage sont absents de la Map, l'appelant retombe sur son défaut.
   */
  /**
   * Quels tenants de ce lot ont l'agent de Meta allumé ? Un seul aller-retour, comme `handbackMsByTenant` :
   * le balayage traite un lot de conversations, une requête par tenant le rendrait quadratique.
   */
  async mbaActifParTenant(tenantIds: readonly string[]): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set();
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from tenant_settings where tenant_id = any($1::uuid[]) and mba_enabled = true`,
      [tenantIds],
    );
    return new Set(res.rows.map((r) => r.tenant_id));
  }

  async handbackMsByTenant(tenantIds: readonly string[]): Promise<Map<string, number>> {
    if (tenantIds.length === 0) return new Map();
    const res = await this.pool.query<{ tenant_id: string; control_handback_seconds: number }>(
      `select tenant_id, control_handback_seconds from tenant_settings
       where tenant_id = any($1::uuid[]) and control_handback_seconds is not null`,
      [[...tenantIds]],
    );
    return new Map(res.rows.map((r) => [r.tenant_id, r.control_handback_seconds * 1000]));
  }

  /**
   * Les tenants qui ont choisi « seulement pendant mes heures d'ouverture ». C'est le SEUL mode qui varie
   * dans la journée, donc le seul que le balayage a à connaître : `always` et `never` sont écrits une fois
   * chez Meta au moment du choix et n'ont plus rien à faire ensuite.
   *
   * Les défauts de fuseau et d'horaires sont appliqués ICI : un tenant qui n'a jamais réglé ses horaires
   * doit basculer sur le défaut usine (lun-ven 9h-18h), pas rester dans un état sans horaires du tout.
   */
  async tenantsHandoffSurHoraires(): Promise<Array<{ tenantId: string; timezone: string; businessHours: BusinessHours }>> {
    const res = await this.pool.query<{ tenant_id: string; timezone: string | null; business_hours: BusinessHours | null }>(
      `select tenant_id, timezone, business_hours from tenant_settings where mba_handoff_mode = 'business_hours'`,
    );
    return res.rows.map((r) => ({
      tenantId: r.tenant_id,
      timezone: r.timezone ?? DEFAULT_TIMEZONE,
      businessHours: r.business_hours ?? DEFAULT_BUSINESS_HOURS,
    }));
  }

  /** Active/désactive l'import de listes HubSpot. N'ÉCRASE PAS mba_enabled (upsert ciblé sur la colonne). */
  async setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, hubspot_lists_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set hubspot_lists_enabled = excluded.hubspot_lists_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
  }
}

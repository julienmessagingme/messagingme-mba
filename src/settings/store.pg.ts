import type { Pool } from 'pg';
import type { BusinessHours } from '../workflow/conditions';
import { estFrequenceMention, type FrequenceMentionIa } from '../agent/agent-store';
import { estModeTransfert, type ModeTransfert } from '../agent/disponibilite-equipe';
import type { GrillePrix } from '../stats/prix';

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
   * Pause des campagnes via listes HubSpot, pilotée avec la pause du push par l'action Pause du toggle
   * Synchronisation (gate effectif : `hubspotListsEnabled && !campaignsPaused`). N'écrase jamais
   * `hubspotListsEnabled` : la reprise restaure le réglage d'origine.
   */
  campaignsPaused: boolean;
  /** Auto-relance des échecs de livraison : le sweeper relance 131049/131026 selon la politique de recouvrement. */
  autoRetryEnabled: boolean;
  /**
   * Durée du gel après qu'un opérateur a pris la main, en secondes : ni le scénario ni l'agent de Meta
   * n'écrivent au client. null = défaut du serveur. 0 = pas de reprise automatique, la conversation reste à
   * l'humain jusqu'à ce qu'il la rende.
   */
  controlHandbackSeconds: number | null;
  /**
   * Quand l'agent de Meta passe-t-il la main à un humain (écran « Activation ») ? Pilote `handoff.enabled`
   * chez Meta. `null` = jamais réglé : on n'écrit rien chez Meta, et l'écran montre le défaut usine.
   */
  mbaHandoffMode: MbaHandoffMode | null;
  /**
   * Quand un agent IA passe la main, l'équipe est-elle joignable ? Mêmes trois valeurs que le MBA, pour que
   * l'écran compare les deux agents côte à côte. Il ne décide pas si on transfère (la conversation arrive
   * dans « À traiter » dans tous les cas), mais ce que l'agent a le droit de promettre
   * (`src/agent/disponibilite-equipe.ts`). Colonne distincte de `mbaHandoffMode`, qui pilote
   * `handoff.enabled` chez Meta : les confondre reconfigurerait l'agent de Meta quand le client règle son
   * agent IA.
   */
  agentTransfertMode: ModeTransfert | null;
  /**
   * La requête de connecteur (Tools > Connecteurs API) jouée quand quelqu'un se désabonne, ou `null`.
   * 🔴 C'est ce qui rend un refus opposable hors de chez nous : un opt-out qui ne vit que dans notre base
   * laisse le client écrire à cette personne depuis son CRM. `null` par défaut : rien ne part vers un
   * système tiers sans qu'on l'ait choisi. Détail dans `src/crm/poussee-optout.ts`.
   */
  optoutRequestId: string | null;
  /**
   * Quand les agents IA de cet espace annoncent qu'ils sont des IA. `null` = rien n'a été réglé, le code
   * retombe sur `session`. Au niveau de l'espace et pas par agent : l'AI Act (article 50) fait peser
   * l'obligation sur la marque déployante, qui n'a qu'une politique. Le Meta Business Agent n'est pas
   * gouverné par ce réglage : Meta écrit déjà « IA » sous ses messages.
   */
  mentionIaFrequence: FrequenceMentionIa | null;
  /**
   * Un agent peut-il prendre une conversation du pot commun, c'est-à-dire se l'affecter ? Prendre, jamais
   * réaffecter : la distribution reste le geste de l'encadrement. `false` par défaut. Règle : `peutPrendre`
   * (`src/inbox/assignment.ts`).
   */
  agentsPeuventPrendre: boolean;
  /**
   * L'interrupteur HubSpot de l'espace (Paramètres > Intégrations) : allumé, le bloc HubSpot s'affiche sur
   * l'Accueil, numéro WhatsApp ou pas. `false` par défaut.
   * Il ne s'éteint pas tant qu'un portail est relié (la route rend 409) : les analyses partiraient encore
   * vers HubSpot depuis un espace où il paraîtrait éteint. Il ne gouverne pas le masquage des fonctions
   * HubSpot des campagnes et des automations, qui suit le portail relié (`hubspotPortalConnecte`).
   */
  hubspotActif: boolean;
}

/**
 * Les trois choix de l'écran « Activation ». `business_hours` est le seul qui varie dans la journée : c'est
 * le balayage qui bascule alors `handoff.enabled` selon les heures d'ouverture du tenant, Meta n'ayant
 * aucune notion d'horaires.
 */
export type MbaHandoffMode = 'always' | 'business_hours' | 'never';

/**
 * Les colonnes de `tenant_settings` qu'un setter écrit seules.
 * 🔴 Union fermée : c'est ce qui rend sûr le nom de colonne interpolé dans `poser`, aucune valeur venue
 * d'une requête ne peut y entrer.
 */
type ColonneReglage =
  | 'hubspot_actif' | 'salesforce_actif' | 'mba_relais_cle_id' | 'agents_peuvent_prendre' | 'mention_ia_frequence'
  | 'optout_request_id' | 'mba_handoff_mode' | 'agent_transfert_mode' | 'timezone' | 'business_hours'
  | 'mba_enabled' | 'control_handback_seconds' | 'hubspot_lists_enabled';

/** Réglages par espace, un upsert ciblé par réglage. */
export class PgTenantSettingsStore {
  constructor(private readonly pool: Pool) {}

  /** Upsert ciblé d'un seul réglage : crée la ligne de l'espace au besoin, n'écrase aucun autre réglage. */
  private async poser(tenantId: string, colonne: ColonneReglage, valeur: unknown): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, ${colonne}, updated_at) values ($1, $2${colonne === 'business_hours' ? '::jsonb' : ''}, now())
       on conflict (tenant_id) do update set ${colonne} = excluded.${colonne}, updated_at = now()`,
      [tenantId, valeur],
    );
  }

  async get(tenantId: string): Promise<TenantSettings> {
    const res = await this.pool.query<{ mba_enabled: boolean; hubspot_lists_enabled: boolean; campaigns_paused: boolean; auto_retry_enabled: boolean; control_handback_seconds: number | null; timezone: string | null; business_hours: BusinessHours | null; mba_handoff_mode: MbaHandoffMode | null; optout_request_id: string | null; mention_ia_frequence: string | null } & Record<string, unknown>>(
      /**
       * `select *` : cette méthode est sur le chemin de chaque message entrant (`mbaActifPour`), du fuseau de
       * chaque campagne et de chaque tour d'agent. Nommer les colonnes rendrait chaque migration de
       * `tenant_settings` bloquante pour l'ingestion (un déploiement avant `migrate` casserait la réception).
       * Aucun secret dans cette table, et la conversion ci-dessous ne lit que ce qu'elle connaît.
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
      // Une valeur inconnue vaut `null`, donc le défaut `always` : une base en retard sur la migration se
      // comporte comme avant.
      agentTransfertMode: estModeTransfert(r?.agent_transfert_mode) ? r.agent_transfert_mode : null,
      optoutRequestId: r?.optout_request_id ?? null,
      // Une valeur inconnue vaut `null`, donc « rien n'a été réglé », donc le défaut `session`.
      mentionIaFrequence: estFrequenceMention(r?.mention_ia_frequence) ? r.mention_ia_frequence : null,
      // `=== true` : une base en retard ne rend pas la colonne (`select *`), et personne ne peut alors prendre.
      agentsPeuventPrendre: r?.agents_peuvent_prendre === true,
      // `=== true`, même raison : une base en retard ne rend pas la colonne, l'interrupteur se lit éteint.
      // L'Accueil montre quand même le bloc d'un espace relié à un portail.
      hubspotActif: r?.hubspot_actif === true,
    };
  }

  /**
   * Allume ou éteint l'interrupteur HubSpot de l'espace. La règle « pas d'extinction avec un portail relié »
   * est dans la route : ce store ne parle qu'à la base.
   */
  async setHubspotActif(tenantId: string, actif: boolean): Promise<void> {
    await this.poser(tenantId, 'hubspot_actif', actif);
  }

  /**
   * L'interrupteur Salesforce de l'espace, lu à part : seule la route de l'intégration le lit
   * (`src/http/salesforce.ts`), et un champ de plus dans `TenantSettings` s'imposerait à chaque fixture. Un
   * espace sans ligne de réglages est éteint.
   */
  async salesforceActif(tenantId: string): Promise<boolean> {
    const r = await this.pool.query<{ salesforce_actif: boolean }>(
      'select salesforce_actif from tenant_settings where tenant_id = $1',
      [tenantId],
    );
    return r.rows[0]?.salesforce_actif === true;
  }

  async setSalesforceActif(tenantId: string, actif: boolean): Promise<void> {
    await this.poser(tenantId, 'salesforce_actif', actif);
  }

  /**
   * La clé d'API posée chez Meta pour le relais du MBA, ou `null`. Hors de `get()` : seule la publication la
   * lit.
   */
  async mbaRelaisCleId(tenantId: string): Promise<string | null> {
    const r = await this.pool.query<{ id: string | null }>(
      `select mba_relais_cle_id as id from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Retient la clé posée chez Meta (`null` = aucune). */
  async setMbaRelaisCleId(tenantId: string, id: string | null): Promise<void> {
    await this.poser(tenantId, 'mba_relais_cle_id', id);
  }

  /** Autorise (ou non) les agents à prendre une conversation du pot commun. */
  async setAgentsPeuventPrendre(tenantId: string, actif: boolean): Promise<void> {
    await this.poser(tenantId, 'agents_peuvent_prendre', actif);
  }

  /**
   * Règle quand les agents de cet espace annoncent qu'ils sont des IA. Pas de retour à `null` : le client
   * choisit entre trois régimes, dont `jamais`, et « non renseigné » le ferait retomber sur un défaut qu'il
   * n'a pas choisi.
   */
  async setMentionIaFrequence(tenantId: string, frequence: FrequenceMentionIa): Promise<void> {
    await this.poser(tenantId, 'mention_ia_frequence', frequence);
  }

  /**
   * Branche (ou débranche, avec `null`) le connecteur prévenu à chaque désabonnement.
   * 🔴 La route vérifie que la requête appartient à cet espace ; la clé étrangère n'est que la ceinture (elle
   * refuse une requête inexistante, pas celle d'un autre espace).
   */
  async setOptoutRequestId(tenantId: string, requestId: string | null): Promise<void> {
    await this.poser(tenantId, 'optout_request_id', requestId);
  }

  /**
   * Enregistre le choix de l'écran « Activation ». L'écriture chez Meta (`handoff.enabled`) est faite par
   * l'appelant : ce store ne parle qu'à la base.
   */
  async setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<void> {
    await this.poser(tenantId, 'mba_handoff_mode', mode);
  }

  /**
   * Enregistre quand l'équipe est joignable pour les agents IA. Rien n'est écrit chez Meta : ce réglage ne
   * concerne que nos agents.
   */
  async setAgentTransfertMode(tenantId: string, mode: ModeTransfert): Promise<void> {
    await this.poser(tenantId, 'agent_transfert_mode', mode);
  }

  /** Règle le fuseau IANA du tenant (validé en amont par la route). */
  async setTimezone(tenantId: string, timezone: string): Promise<void> {
    await this.poser(tenantId, 'timezone', timezone);
  }

  /** Règle les heures d'ouverture (déjà normalisées par la route). */
  async setBusinessHours(tenantId: string, hours: BusinessHours): Promise<void> {
    await this.poser(tenantId, 'business_hours', JSON.stringify(hours));
  }

  async setMbaEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.poser(tenantId, 'mba_enabled', enabled);
  }

  /**
   * Règle la durée du gel après prise de main par un opérateur. `null` remet le défaut du serveur, `0`
   * supprime la reprise automatique.
   */
  async setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<void> {
    await this.poser(tenantId, 'control_handback_seconds', seconds);
  }

  /**
   * Enregistre la grille de prix globale : il n'y en a qu'une, pour tous les espaces. Les six champs
   * s'écrivent d'un coup, validés complets par `valideGrille` ; les bornes vivent là et dans les CHECK.
   * 🔴 `on conflict (id)` sur le singleton, pas un `update` nu : un `update` sans ligne ne fait rien et ne
   * rend aucune erreur, le prix saisi dans `/ops` partirait dans le vide. La clé primaire garantit qu'il n'y
   * aura jamais une seconde grille. `modifie_par` est la seule trace de qui a changé un prix : le jeton de
   * `/ops` est partagé, il n'y a aucune identité d'opérateur à enregistrer.
   */
  async setGrillePrixGlobale(g: GrillePrix, par: string): Promise<void> {
    await this.pool.query(
      `insert into grille_prix (id, prix_marge_template, prix_service_centimes, prix_service_franchise,
                                prix_service_depuis, prix_rcs_centimes, prix_rcs_conv_centimes,
                                modifie_le, modifie_par)
       values (true, $1, $2, $3, $4::date, $5, $6, now(), $7)
       on conflict (id) do update set
         prix_marge_template = excluded.prix_marge_template,
         prix_service_centimes = excluded.prix_service_centimes,
         prix_service_franchise = excluded.prix_service_franchise,
         prix_service_depuis = excluded.prix_service_depuis,
         prix_rcs_centimes = excluded.prix_rcs_centimes,
         prix_rcs_conv_centimes = excluded.prix_rcs_conv_centimes,
         modifie_le = now(),
         modifie_par = excluded.modifie_par`,
      [g.margeTemplate, g.serviceCentimes, g.serviceFranchise, g.serviceDepuis,
       g.rcsSimpleCentimes, g.rcsConversationnelCentimes, par.slice(0, 500)],
    );
  }

  /**
   * Quels tenants de ce lot ont l'agent de Meta allumé ? Un seul aller-retour : le balayage traite un lot de
   * conversations, une requête par tenant le rendrait quadratique.
   */
  async mbaActifParTenant(tenantIds: readonly string[]): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set();
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from tenant_settings where tenant_id = any($1::uuid[]) and mba_enabled = true`,
      [tenantIds],
    );
    return new Set(res.rows.map((r) => r.tenant_id));
  }

  /**
   * Délais de reprise des tenants donnés, en millisecondes, pour le balayage qui applique à chaque
   * conversation d'un lot le réglage de son client. Un tenant sans réglage est absent de la Map : l'appelant
   * retombe sur son défaut.
   */
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
   * Les tenants en mode « seulement pendant mes heures d'ouverture », le seul mode qui varie dans la
   * journée, donc le seul que le balayage bascule (`always` et `never` sont écrits une fois chez Meta).
   * Les défauts de fuseau et d'horaires s'appliquent ici : un tenant qui n'a rien réglé bascule sur le
   * défaut usine (lun-ven 9h-18h), pas dans un état sans horaires.
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

  /** Active ou désactive l'import de listes HubSpot. */
  async setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.poser(tenantId, 'hubspot_lists_enabled', enabled);
  }
}

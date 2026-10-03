import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { TenantSettings, MbaHandoffMode } from '../settings/store.pg';
import type { BusinessHours, DayHours } from '../workflow/conditions';
import { withinBusinessHours } from '../workflow/conditions';
import { espaceVerifie } from './scope';
import { estFrequenceMention, FREQUENCES_MENTION_IA, type FrequenceMentionIa } from '../agent/agent-store';
import { MODE_TRANSFERT_DEFAUT, type ModeTransfert } from '../agent/disponibilite-equipe';
import { reglerModeTransfert } from '../agent/reglages';
import { corpsDuRefus } from '../lib/issue';
import { valideGrille, BORNES_GRILLE } from '../stats/prix';
import { messageDe } from '../lib/erreur';

/** Ce que les routes lisent et écrivent des réglages de l'espace. */
export interface ReglagesDep {
  get(tenantId: string): Promise<TenantSettings>;
  setMbaEnabled(tenantId: string, enabled: boolean): Promise<void>;
  setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<void>;
  /** Durée du gel après prise de main par un opérateur, en secondes. null = défaut du serveur. */
  setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<void>;
  /** Quand l'agent de Meta passe la main à un humain (écran « Activation »). */
  setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<void>;
  /** Fuseau IANA du tenant. */
  setTimezone(tenantId: string, timezone: string): Promise<void>;
  /** Heures d'ouverture par jour ('0'..'6'). */
  setBusinessHours(tenantId: string, hours: BusinessHours): Promise<void>;
  /** Branche (ou débranche, avec `null`) le connecteur prévenu à chaque désabonnement. */
  setOptoutRequestId(tenantId: string, requestId: string | null): Promise<void>;
  /** Règle quand les agents de cet espace annoncent qu'ils sont des IA. */
  setMentionIaFrequence(tenantId: string, frequence: FrequenceMentionIa): Promise<void>;
  /** Quand l'équipe est joignable pour les agents IA. */
  setAgentTransfertMode(tenantId: string, mode: ModeTransfert): Promise<void>;
  /** Autorise (ou non) les agents à prendre une conversation du pot commun. */
  setAgentsPeuventPrendre(tenantId: string, actif: boolean): Promise<void>;
  /**
   * Allume ou éteint l'interrupteur HubSpot de l'espace. Toujours câblé, contrairement à
   * `disconnectHubspot` (Compte), qui dépend de `HUBSPOT_SERVICE_URL`.
   */
  setHubspotActif(tenantId: string, actif: boolean): Promise<void>;
}

export interface SettingsRouteDeps {
  reglages: ReglagesDep;
  rcs: {
    /**
     * Le canal RCS est-il exploitable pour ce tenant ? Vrai dès qu'un agent RCS lui est rattaché : dérivé de
     * l'état réel plutôt que d'un réglage, pour que l'interface ne promette jamais un canal qui ne peut pas
     * envoyer.
     */
    hasAgent(tenantId: string): Promise<boolean>;
  };
  /**
   * Applique `handoff.enabled` chez Meta. Best-effort : un échec ne fait pas échouer l'enregistrement (le
   * choix est en base, le balayage l'appliquera), sinon Meta injoignable empêcherait le client de régler son
   * outil.
   */
  applyMbaHandoffEnabled(tenantId: string, enabled: boolean): Promise<void>;
  /**
   * Un portail HubSpot est-il lié à cet espace ? Seul signal qui dise si la source HubSpot d'une campagne
   * est possible : `hubspotListsEnabled` dit si le client la veut, et un client qui délie son portail garde
   * l'interrupteur allumé. Lecture locale (schéma `mmhs` de la même base, jointure indexée sur
   * `tenant_id`), pas un appel au connecteur.
   * Requise : optionnelle, elle vaudrait `undefined`, donc « pas connecté » sur un câblage qui l'oublie.
   * 🔴 Elle lève sur une vraie panne de lecture, et chaque lecteur choisit son repli : l'affichage
   * (`GET /settings`) la lit « pas relié », l'extinction de l'interrupteur la refuse (503), sinon on
   * éteindrait HubSpot par-dessus un portail relié.
   */
  hubspotPortalConnecte(tenantId: string): Promise<boolean>;
  /** Les requêtes de connecteur de l'espace (Tools > Connecteurs API), réduites à ce que l'écran affiche. */
  listerRequetesConnecteur(tenantId: string): Promise<Array<{ id: string; label: string }>>;
  agents: {
    /**
     * Les agents de l'espace et la phrase que chacun dit. Le régime dit quand on annonce, pas ce qu'on
     * annonce, qui reste propre à chaque agent : un écran de conformité qui cacherait le texte promettrait
     * une vérification qu'il ne permet pas de faire.
     */
    listerPourConformite(tenantId: string): Promise<Array<{ id: string; label: string; status: string; mentionIa: string }>>;
  };
}

/** Fuseau IANA valide ? (Intl throw sur un identifiant inconnu.) */
function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Normalise/valide les heures d'ouverture d'un corps hostile : 7 jours '0'..'6', HH:MM valides, close > open si
 *  ouvert. null si invalide (une plage cassée est rejetée, pas silencieusement corrigée). */
function normalizeBusinessHours(raw: unknown): BusinessHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: BusinessHours = {};
  for (let d = 0; d <= 6; d += 1) {
    const day = r[String(d)];
    if (!day || typeof day !== 'object') return null;
    const dd = day as Record<string, unknown>;
    const closed = dd.closed === true;
    if (closed) { out[String(d)] = { closed: true, open: '', close: '' }; continue; }
    const open = String(dd.open ?? '');
    const close = String(dd.close ?? '');
    if (!HHMM.test(open) || !HHMM.test(close)) return null;
    if (close <= open) return null; // plage vide/inversée -> refus
    out[String(d)] = { closed: false, open, close } satisfies DayHours;
  }
  return out;
}

/**
 * Réglages tenant.
 * 🔴 Tout le module est monté avec la garde d'administration (`g.admin`, `src/server.ts`), lectures
 * comprises ; le paramètre s'appelle `garde`. Exceptions, toutes nommées ici : `GET /settings/mention-ia` et
 * `GET /settings/transfert-agent`, lectures ouvertes à l'encadrement (`gardeEncadrement`), et une seule
 * écriture ouverte à l'encadrement, `/settings/agents-peuvent-prendre` (un réglage d'équipe, pas une
 * décision de la marque).
 */
export function registerSettings(
  app: FastifyInstance,
  deps: SettingsRouteDeps,
  garde: Guard,
  /** La garde de l'encadrement (`admin` + `manager`), pour les exceptions nommées ci-dessus. */
  gardeEncadrement: Guard,
): void {
  const opts = { preHandler: garde };
  const optsEncadrement = { preHandler: gardeEncadrement };

  app.get('/tenants/:tenantId/settings', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const settings = await deps.reglages.get(tenant);
    const rcsEnabled = await deps.rcs.hasAgent(tenant);
    // Une panne de lecture vaut « pas relié » ici seulement : c'est un drapeau d'affichage, l'écran ne doit
    // pas tomber pour lui. L'extinction de l'interrupteur, elle, refuse (plus bas).
    const hubspotPortalConnecte = await deps.hubspotPortalConnecte(tenant).catch(() => false);
    return reply.code(200).send({ ...settings, rcsEnabled, hubspotPortalConnecte });
  });

  app.put('/tenants/:tenantId/settings', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const mbaEnabled = (req.body as { mbaEnabled?: unknown } | null)?.mbaEnabled;
    if (typeof mbaEnabled !== 'boolean') return reply.code(400).send({ error: 'mbaEnabled (booléen) requis' });
    await deps.reglages.setMbaEnabled(tenant, mbaEnabled);
    return reply.code(200).send({ mbaEnabled });
  });

  // Toggle « Campagnes via données HubSpot » (admin). Route dédiée : le PUT ci-dessus exige mbaEnabled.
  // OFF -> aucun appel au connecteur ; ON -> le client devra re-consentir crm.lists.read.
  app.patch('/tenants/:tenantId/settings/hubspot-lists', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const enabled = (req.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (booléen) requis' });
    await deps.reglages.setHubspotListsEnabled(tenant, enabled);
    return reply.code(200).send({ hubspotListsEnabled: enabled });
  });

  /**
   * L'interrupteur HubSpot de l'espace (Paramètres > Intégrations), admin. Sa lecture voyage avec
   * `GET /settings` (`hubspotActif`). Allumer n'est jamais refusé.
   * 🔴 Éteindre est refusé (409) tant qu'un portail est relié : les analyses continuent de partir vers lui,
   * un interrupteur éteint mentirait. Le client délie d'abord (« Déconnexion complète »). 409 et non 5xx,
   * dont Cloudflare remplace le corps.
   * Une lecture en échec refuse aussi l'extinction, en 503 (une vérification à retenter, pas un état à
   * corriger), jamais « pas relié » ; si le corps est remplacé en route, l'écran dit quand même de
   * réessayer (`messageDErreur`, `web/lib/http.ts`), et rien n'a été écrit.
   */
  app.patch('/tenants/:tenantId/settings/hubspot-actif', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const actif = (req.body as { actif?: unknown } | null)?.actif;
    // Un booléen, rien d'autre : une valeur bancale ne doit pas se lire « allumé » ni « éteint » par accident.
    if (typeof actif !== 'boolean') return reply.code(400).send({ error: 'actif (booléen) requis' });
    if (!actif) {
      let relie: boolean;
      try {
        relie = await deps.hubspotPortalConnecte(tenant);
      } catch {
        return reply.code(503).send({
          error: 'Impossible de vérifier pour l’instant si un portail HubSpot est relié à cet espace : HubSpot n’a pas été éteint. Réessayez dans un instant.',
        });
      }
      if (relie) {
        return reply.code(409).send({
          error: 'Un portail HubSpot est relié à cet espace : faites d’abord la « Déconnexion complète » depuis l’Accueil, puis éteignez HubSpot.',
        });
      }
    }
    await deps.reglages.setHubspotActif(tenant, actif);
    return reply.code(200).send({ hubspotActif: actif });
  });

  /**
   * Le connecteur prévenu à chaque désabonnement : lecture, admin seulement (alors que `mention-ia` est
   * ouverte à l'encadrement). Brancher un connecteur, c'est décider que des données de contact partent chez
   * un tiers : un manager consulte, il ne décide pas. L'écran n'affiche ce bloc qu'aux administrateurs.
   */
  app.get('/tenants/:tenantId/settings/poussee-optout', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { optoutRequestId } = await deps.reglages.get(tenant);
    return reply.code(200).send({ requestId: optoutRequestId, requetes: await deps.listerRequetesConnecteur(tenant) });
  });

  /**
   * Le connecteur prévenu à chaque désabonnement : écriture, admin seulement, comme la déclaration du
   * connecteur (c'est décider d'envoyer des données de contact à un système tiers).
   * 🔴 L'identifiant est vérifié contre les requêtes de cet espace, jamais accepté sur sa seule forme : un
   * uuid pris ailleurs ferait partir la poussée chez un autre client, et la clé étrangère ignore le tenant.
   */
  app.patch('/tenants/:tenantId/settings/poussee-optout', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const brut = (req.body as { requestId?: unknown } | null)?.requestId;
    if (brut === null) {
      await deps.reglages.setOptoutRequestId(tenant, null);
      return reply.code(200).send({ requestId: null });
    }
    if (typeof brut !== 'string' || brut.trim() === '') {
      return reply.code(400).send({ error: 'requestId (identifiant de requête, ou null) requis' });
    }
    const requestId = brut.trim();
    const connues = await deps.listerRequetesConnecteur(tenant);
    if (!connues.some((r) => r.id === requestId)) {
      // 400 et non 500 : Cloudflare remplace le corps des 5xx, et c'est un message destiné à l'utilisateur.
      return reply.code(400).send({ error: 'cette requête n’existe pas dans cet espace' });
    }
    await deps.reglages.setOptoutRequestId(tenant, requestId);
    return reply.code(200).send({ requestId });
  });

  /**
   * « L'IA se déclare comme telle » : lecture de la politique de l'espace et de ce que chaque agent dit.
   * Une politique par espace : l'AI Act (article 50) fait peser l'obligation sur la marque déployante, et
   * trois agents ne sont pas trois marques. Le Meta Business Agent n'est pas dans la liste : Meta écrit déjà
   * « IA » sous ses messages, et l'écran le dit.
   */
  app.get('/tenants/:tenantId/settings/mention-ia', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { mentionIaFrequence } = await deps.reglages.get(tenant);
    return reply.code(200).send({
      // `null` en base = rien n'a été réglé : l'écran montre le défaut effectif, celui que le runtime
      // appliquera, pas une case vide.
      frequence: mentionIaFrequence ?? 'session',
      reglee: mentionIaFrequence !== null,
      agents: await deps.agents.listerPourConformite(tenant),
    });
  });

  /**
   * ...et son écriture, admin seulement. `jamais` est un choix explicite du client, jamais un défaut posé
   * en silence : l'obligation ne joue que si l'IA n'est pas évidente du contexte, et c'est à la marque de
   * trancher. Pas de retour à « non réglé » : il ferait retomber le client sur un défaut qu'il n'a pas choisi.
   */
  app.patch('/tenants/:tenantId/settings/mention-ia', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const brut = (req.body as { frequence?: unknown } | null)?.frequence;
    if (!estFrequenceMention(brut)) {
      return reply.code(400).send({ error: `frequence requise (${FREQUENCES_MENTION_IA.join(' | ')})` });
    }
    await deps.reglages.setMentionIaFrequence(tenant, brut);
    return reply.code(200).send({ frequence: brut });
  });

  /**
   * Quand l'équipe est joignable, pour les agents IA. Mêmes trois valeurs que `mba_handoff_mode` pour
   * l'agent de Meta, les deux cohabitant sur l'écran. Ce réglage ne décide pas si on transfère (la
   * conversation arrive dans « À traiter » dans tous les cas), mais ce que l'agent a le droit de promettre.
   */
  app.get('/tenants/:tenantId/settings/transfert-agent', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentTransfertMode } = await deps.reglages.get(tenant);
    return reply.code(200).send({
      // Le défaut effectif, celui que le runtime appliquera, jamais une case vide (même raison que sa voisine).
      mode: agentTransfertMode ?? MODE_TRANSFERT_DEFAUT,
      reglee: agentTransfertMode !== null,
    });
  });

  /** ...et son écriture, admin seulement, comme tout ce qui change ce qu'un robot dit à de vrais contacts. */
  app.patch('/tenants/:tenantId/settings/transfert-agent', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // `reglerModeTransfert`, que l'outil MCP `set_transfer_mode` appelle aussi.
    const r = await reglerModeTransfert(deps.reglages, tenant, (req.body as { mode?: unknown } | null)?.mode);
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send({ mode: r.valeur });
  });

  /**
   * Les agents peuvent-ils prendre une conversation du pot commun ? Lecture et écriture ouvertes à
   * l'encadrement, seule écriture du module qui l'est : un manager distribue déjà le travail de son équipe.
   * Prendre, jamais réaffecter : activé, ce réglage laisse un agent s'affecter une conversation que personne
   * n'a, et rien d'autre (`peutPrendre`, `src/inbox/assignment.ts`).
   */
  app.get('/tenants/:tenantId/settings/agents-peuvent-prendre', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentsPeuventPrendre } = await deps.reglages.get(tenant);
    return reply.code(200).send({ actif: agentsPeuventPrendre });
  });

  app.patch('/tenants/:tenantId/settings/agents-peuvent-prendre', optsEncadrement, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const actif = (req.body as { actif?: unknown } | null)?.actif;
    // Un booléen, rien d'autre : une valeur bancale ne doit pas se lire « activé » par accident.
    if (typeof actif !== 'boolean') return reply.code(400).send({ error: 'actif (booléen) requis' });
    await deps.reglages.setAgentsPeuventPrendre(tenant, actif);
    return reply.code(200).send({ actif });
  });

  // Pas de route `settings/auto-retry` : la relance obéit à la case de chaque campagne. `auto_retry_enabled`
  // reste lu pour les campagnes d'avant et ne s'écrit plus.

  /**
   * Durée du gel d'une conversation après qu'un opérateur a pris la main : ni le scénario ni l'agent de
   * Meta n'écrivent au client. `null` remet le défaut du serveur ; `0` supprime la reprise automatique (la
   * conversation reste à l'humain jusqu'à ce qu'il la rende).
   * Borne haute à 7 jours : au-delà, c'est un abandon qui n'apparaîtrait nulle part, et la promesse « le
   * client finit toujours par avoir une réponse » serait cassée en silence.
   */
  app.patch('/tenants/:tenantId/settings/control-handback', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const raw = (req.body as { seconds?: unknown } | null)?.seconds;
    if (raw === null) {
      await deps.reglages.setControlHandbackSeconds(tenant, null);
      return reply.code(200).send({ controlHandbackSeconds: null });
    }
    const MAX = 7 * 24 * 3600;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX) {
      return reply.code(400).send({ error: `seconds invalide (entier 0..${MAX}, ou null pour le défaut)` });
    }
    await deps.reglages.setControlHandbackSeconds(tenant, raw);
    return reply.code(200).send({ controlHandbackSeconds: raw });
  });

  /**
   * Quand l'agent de Meta passe-t-il la main à un humain ? (admin, route dédiée comme ses voisines)
   * Le choix est enregistré en base d'abord : c'est la source de vérité, et le balayage s'en sert pour faire
   * varier `business_hours` au fil de la journée. L'écriture chez Meta suit en best-effort, pour que le
   * réglage soit vrai tout de suite ; un échec côté Meta ne fait pas échouer l'enregistrement, le balayage
   * rattrapera. `enabled` ne décide pas si l'agent transfère (il décide seul), mais s'il lâche le fil
   * ensuite : « jamais » laisse l'agent garder la conversation.
   */
  app.patch('/tenants/:tenantId/settings/mba-handoff', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    if (mode !== 'always' && mode !== 'business_hours' && mode !== 'never') {
      return reply.code(400).send({ error: "mode invalide ('always' | 'business_hours' | 'never')" });
    }
    await deps.reglages.setMbaHandoffMode(tenant, mode);
    let applique = false;
    // Pour `business_hours` seulement, l'état à cet instant : le client règle souvent son outil pendant ses
    // heures d'ouverture, et verrait sinon un passage de main éteint jusqu'au balayage suivant.
    let voulu = mode === 'always';
    if (mode === 'business_hours') {
      const s = await deps.reglages.get(tenant);
      voulu = withinBusinessHours(new Date(), s.timezone, s.businessHours);
    }
    try {
      await deps.applyMbaHandoffEnabled(tenant, voulu);
      applique = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`mba-handoff: application chez Meta impossible pour ${tenant}:`, messageDe(err));
    }
    return reply.code(200).send({ mbaHandoffMode: mode, appliqueChezMeta: applique });
  });


  // Fuseau horaire du tenant (admin-only). Base de NOW / weekday / heures d'ouverture du node condition.
  app.patch('/tenants/:tenantId/settings/timezone', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const tz = (req.body as { timezone?: unknown } | null)?.timezone;
    if (!isValidTimeZone(tz)) return reply.code(400).send({ error: 'timezone IANA invalide (ex. Europe/Paris)' });
    await deps.reglages.setTimezone(tenant, tz);
    return reply.code(200).send({ timezone: tz });
  });

  // Heures d'ouverture par jour (admin-only). Corps { '0'..'6': { closed, open 'HH:MM', close 'HH:MM' } }.
  app.patch('/tenants/:tenantId/settings/business-hours', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const hours = normalizeBusinessHours((req.body as { businessHours?: unknown } | null)?.businessHours);
    if (hours === null) return reply.code(400).send({ error: 'businessHours invalide (7 jours, HH:MM, close > open)' });
    await deps.reglages.setBusinessHours(tenant, hours);
    return reply.code(200).send({ businessHours: hours });
  });
}

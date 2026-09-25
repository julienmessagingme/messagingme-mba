import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { TenantSettings, MbaHandoffMode } from '../settings/store.pg';
import type { BusinessHours, DayHours } from '../workflow/conditions';
import { withinBusinessHours } from '../workflow/conditions';
import { scopeTenant } from './scope';
import { estFrequenceMention, FREQUENCES_MENTION_IA, type FrequenceMentionIa } from '../agent/agent-store';
import {
  estModeTransfert, MODES_TRANSFERT, MODE_TRANSFERT_DEFAUT, type ModeTransfert,
} from '../agent/disponibilite-equipe';
import { valideGrille, BORNES_GRILLE } from '../stats/prix';

export interface SettingsRouteDeps {
  getSettings(tenantId: string): Promise<TenantSettings>;
  /**
   * Le canal RCS est-il exploitable pour ce tenant ? Vrai dès qu'un agent RCS lui est rattaché. Volontairement
   * DÉRIVÉ de l'état réel plutôt que porté par un réglage à basculer : le jour où l'agent est validé et
   * enregistré, l'outil s'allume seul, et il n'existe aucun état où l'interface promet un canal qui ne peut
   * pas envoyer. Absent du câblage -> false, donc briques éteintes.
   */
  rcsEnabledFor?(tenantId: string): Promise<boolean>;
  setMbaEnabled(tenantId: string, enabled: boolean): Promise<void>;
  setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<void>;
  /** Durée du gel après prise de main par un opérateur, en secondes. null = défaut du serveur. */
  setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<void>;
  /**
   * Enregistre la grille de prix de l'espace (migration 0154).
   *
   * OPTIONNELLE : absente, la route rend 503 et l'ecran masque la section, plutot que d'offrir un
   * formulaire qui ne mene nulle part. C'est le motif « offert-et-inerte » que le produit s'interdit, et
   * ce lot l'a precisement paye une fois : la migration a vecu trois semaines sans aucun ecran pour
   * l'ecrire.
   */

  /** Quand l'agent de Meta passe la main à un humain (écran « Activation »). */
  setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<void>;
  /**
   * Applique `handoff.enabled` chez Meta. Optionnelle : absente, le choix est enregistré en base et c'est le
   * balayage qui l'appliquera. Best-effort : un échec ne fait PAS échouer l'enregistrement, sinon Meta
   * injoignable empêcherait le client de régler son propre outil.
   */
  applyMbaHandoffEnabled?(tenantId: string, enabled: boolean): Promise<void>;
  /**
   * UN PORTAIL HUBSPOT EST-IL LIE A CET ESPACE ? (lot 9, 2026-09-23)
   *
   * 🔴 C'EST LE SEUL SIGNAL QUI REPOND A LA QUESTION, et ce n'est pas celui qu'on utilisait. L'ecran de
   * campagne masquait sa source HubSpot sur `hubspotListsEnabled`, qui est un INTERRUPTEUR d'espace : un
   * client qui DELIE son portail garde l'interrupteur allume, donc la source restait offerte et ne menait
   * nulle part. Les deux drapeaux repondent a deux questions (« le client veut-il cette source ? » et
   * « est-elle seulement possible ? ») et il faut les DEUX.
   *
   * ⚠️ LECTURE LOCALE, PAS UN APPEL AU CONNECTEUR : le mapping vit dans le schema `mmhs` de la MEME base
   * (jointure indexee sur `tenant_id`). Un aller-retour reseau sur une route que tous les ecrans appellent
   * aurait ete le mauvais prix.
   *
   * 🔴 REQUISE, PAS OPTIONNELLE : une dependance optionnelle vaudrait `undefined`, donc « pas connecte »,
   * donc la source disparaitrait pour un client qui l'a, sur une instance qui a juste oublie de la cabler.
   * C'est la regle du lot 2 du plan du 2026-09-14, appliquee a la lettre.
   *
   * 🔴 ELLE LÈVE SUR UNE VRAIE PANNE DE LECTURE, et chaque lecteur choisit son repli (relecture du lot 7,
   * 2026-09-25). Le câblage ne rend `false` que pour un schéma du connecteur ABSENT (`42P01`, instance sans
   * connecteur, où aucun portail ne peut être relié). L'affichage (`GET /settings`) lit une panne comme « pas
   * relié », comme avant ; ÉTEINDRE l'interrupteur la REFUSE (503), parce qu'un `false` inventé laissait éteindre
   * HubSpot par-dessus un portail relié, exactement ce que la route interdit.
   */
  hubspotPortalConnecte(tenantId: string): Promise<boolean>;
  /** Fuseau IANA du tenant. */
  setTimezone(tenantId: string, timezone: string): Promise<void>;
  /** Heures d'ouverture par jour ('0'..'6'). */
  setBusinessHours(tenantId: string, hours: BusinessHours): Promise<void>;
  /**
   * Les requêtes de connecteur de l'espace (Tools > Connecteurs API), réduites à ce que l'écran affiche.
   *
   * ⚠️ Optionnelle : absente, l'écran du Consentement dit que le branchement n'est pas disponible plutôt que
   * de proposer une liste vide, qui se lirait « vous n'avez aucun connecteur » et serait un mensonge.
   */
  listerRequetesConnecteur?(tenantId: string): Promise<Array<{ id: string; label: string }>>;
  /** Branche (ou débranche, avec `null`) le connecteur prévenu à chaque désabonnement. */
  setOptoutRequestId?(tenantId: string, requestId: string | null): Promise<void>;
  /** Règle QUAND les agents de cet espace annoncent qu'ils sont des IA (migration 0140). */
  setMentionIaFrequence?(tenantId: string, frequence: FrequenceMentionIa): Promise<void>;
  /**
   * QUAND L'ÉQUIPE EST JOIGNABLE POUR LES AGENTS IA (migration 0156).
   *
   * ⚠️ Absente -> la route rend 503 plutôt que d'accepter un réglage qui n'irait nulle part. C'est l'idiome
   * de ses voisines : un écran qui dirait « enregistré » sans rien écrire est pire qu'un écran indisponible.
   */
  setAgentTransfertMode?(tenantId: string, mode: ModeTransfert): Promise<void>;
  /**
   * Autorise (ou non) les agents à PRENDRE une conversation du pot commun (migration 0160). Absente -> la
   * route rend 503, comme ses voisines : un écran qui dirait « enregistré » sans rien écrire est pire qu'un
   * écran indisponible.
   */
  setAgentsPeuventPrendre?(tenantId: string, actif: boolean): Promise<void>;
  /**
   * Allume ou éteint l'interrupteur HubSpot de l'espace (migration 0179). Absente -> la route rend 503, comme
   * ses voisines : un écran qui dirait « enregistré » sans rien écrire est pire qu'un écran indisponible.
   */
  setHubspotActif?(tenantId: string, actif: boolean): Promise<void>;
  /**
   * Les agents de l'espace et la PHRASE que chacun dit.
   *
   * 🔴 LA PHRASE, PAS SEULEMENT LE NOM, et c'est ce qui fait de cet écran autre chose qu'un interrupteur.
   * Le régime dit QUAND on annonce ; il ne dit pas CE QU'ON ANNONCE, qui reste propre à chaque agent
   * (« Vous échangez avec un assistant automatique. »). Sur un écran de conformité, montrer un réglage sans
   * montrer le texte qu'il déclenche, c'est promettre une vérification qu'on ne permet pas de faire.
   */
  listerAgentsPourConformite?(tenantId: string): Promise<Array<{ id: string; label: string; status: string; mentionIa: string }>>;
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
 *
 * ⚠️ TOUT CE MODULE EST MONTÉ AVEC `gardeAdmin` (`src/server.ts`), y compris les GET. Ce docblock a dit
 * « GET ouvert (lecture), PUT admin-only » pendant longtemps : c'était faux, et la phrase a été recopiée
 * telle quelle dans une route neuve le 2026-09-13. Le paramètre s'appelle `garde` par héritage, mais
 * ce qu'on lui passe est la garde d'administration.
 *
 * ⚠️ DES EXCEPTIONS, TOUTES NOMMÉES ICI : `GET /settings/mention-ia` et `GET /settings/transfert-agent`,
 * des LECTURES ouvertes à l'encadrement par `gardeEncadrement`, dont l'ÉCRITURE reste admin. Et depuis le
 * 2026-09-19, UNE écriture ouverte à l'encadrement, la seule : `/settings/agents-peuvent-prendre`, parce que
 * Julien l'a voulue « à la main des admins et des managers ». C'est un réglage d'ÉQUIPE (qui distribue le
 * travail), pas une décision de la marque.
 */
export function registerSettings(
  app: FastifyInstance,
  deps: SettingsRouteDeps,
  garde: Guard,
  /**
   * La garde de l'ENCADREMENT (`admin` + `manager`), pour les seules LECTURES de conformité.
   *
   * ⚠️ ELLE NE PEUT PLUS ÊTRE ABSENTE (lot 2 du plan 2026-09-14). Elle était optionnelle et retombait alors
   * sur la garde d'administration, ce qui n'ouvrait à personne de plus et était donc le bon sens de l'échec.
   * Le type l'exige désormais, et le repli n'a plus d'objet.
   */
  gardeEncadrement: Guard,
): void {
  const opts = { preHandler: garde };
  const optsEncadrement = { preHandler: gardeEncadrement };

  app.get('/tenants/:tenantId/settings', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const settings = await deps.getSettings(tenant);
    const rcsEnabled = deps.rcsEnabledFor ? await deps.rcsEnabledFor(tenant) : false;
    // ⚠️ EN PARALLELE, pas en cascade : cette route est sur le chemin d'ouverture de plusieurs ecrans, et
    // les deux lectures sont independantes.
    // ⚠️ Une panne de lecture vaut « pas relié » ICI, et seulement ici : c'est un drapeau d'AFFICHAGE, et
    // l'écran ne doit pas tomber pour lui. L'extinction de l'interrupteur, elle, refuse (cf. plus bas).
    const hubspotPortalConnecte = await deps.hubspotPortalConnecte(tenant).catch(() => false);
    return reply.code(200).send({ ...settings, rcsEnabled, hubspotPortalConnecte });
  });

  app.put('/tenants/:tenantId/settings', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const mbaEnabled = (req.body as { mbaEnabled?: unknown } | null)?.mbaEnabled;
    if (typeof mbaEnabled !== 'boolean') return reply.code(400).send({ error: 'mbaEnabled (booléen) requis' });
    await deps.setMbaEnabled(tenant, mbaEnabled);
    return reply.code(200).send({ mbaEnabled });
  });

  // Toggle « Campagnes via données HubSpot » (admin-only). Route dédiée pour ne pas surcharger le PUT ci-dessus
  // (qui exige mbaEnabled). OFF -> aucun appel au connecteur ; ON -> le client devra re-consentir crm.lists.read.
  app.patch('/tenants/:tenantId/settings/hubspot-lists', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const enabled = (req.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (booléen) requis' });
    await deps.setHubspotListsEnabled(tenant, enabled);
    return reply.code(200).send({ hubspotListsEnabled: enabled });
  });

  /**
   * L'INTERRUPTEUR HUBSPOT DE L'ESPACE (migration 0179, Paramètres > Intégrations), admin seulement. Sa
   * lecture voyage avec `GET /settings` (`hubspotActif`), comme ses voisins.
   *
   * 🔴 ÉTEINDRE EST REFUSÉ (409) TANT QU'UN PORTAIL EST RELIÉ. Les analyses continuent de partir vers un
   * portail relié : un interrupteur éteint par-dessus mentirait. Le client délie d'abord (« Déconnexion
   * complète » de l'Accueil), puis éteint. 409 et non 5xx : le message est destiné à l'administrateur, et
   * Cloudflare remplace le corps des 5xx.
   *
   * ⚠️ LE LIEN SE LIT PAR `hubspotPortalConnecte`, la même lecture que le masquage du lot 9, dont le câblage
   * rend `false` quand le schéma du connecteur n'existe pas (instance sans connecteur, où aucun portail ne
   * peut être relié). Allumer n'est jamais refusé.
   *
   * 🔴 UNE LECTURE EN ÉCHEC REFUSE L'EXTINCTION (503), elle ne vaut jamais « pas relié » ici (relecture du lot 7,
   * 2026-09-25). Lue comme `false`, une panne de la base laissait éteindre HubSpot par-dessus un portail relié.
   * 503 et pas 409 : ce n'est pas un état de l'espace qu'il faudrait corriger, c'est une vérification impossible
   * à cet instant, qu'on retente. Si le corps est remplacé en route, l'écran dit quand même de réessayer
   * (`messageDErreur`, `web/lib/http.ts`), et RIEN n'a été écrit.
   */
  app.patch('/tenants/:tenantId/settings/hubspot-actif', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.setHubspotActif) return reply.code(503).send({ error: 'réglage indisponible' });
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
    await deps.setHubspotActif(tenant, actif);
    return reply.code(200).send({ hubspotActif: actif });
  });

  /**
   * LE CONNECTEUR PRÉVENU À CHAQUE DÉSABONNEMENT : lecture.
   *
   * ⚠️ ADMIN SEULEMENT, ALORS QUE SA VOISINE `mention-ia` EST OUVERTE À L'ENCADREMENT, et l'écart est le
   * sujet : brancher un connecteur, c'est décider que des données de contact partent chez un tiers. Un
   * manager CONSULTE, il ne décide pas. L'écran du Consentement n'affiche donc ce bloc que pour un
   * administrateur, plutôt que de montrer à un manager un réglage dont la lecture lui rendrait 403.
   *
   * ⚠️ CE COMMENTAIRE A ANNONCÉ « ouverte à tout compte authentifié, comme `GET /settings` », en se fiant au
   * docblock de `registerSettings` (« GET ouvert (lecture) »). Les deux étaient faux, mesuré en écrivant le
   * test. Une justification fausse est pire qu'aucune, parce qu'elle sera recopiée : celle-ci l'a été d'un
   * docblock voisin, lui-même faux depuis longtemps.
   */
  app.get('/tenants/:tenantId/settings/poussee-optout', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.listerRequetesConnecteur) return reply.code(503).send({ error: 'connecteurs indisponibles' });
    const { optoutRequestId } = await deps.getSettings(tenant);
    return reply.code(200).send({ requestId: optoutRequestId, requetes: await deps.listerRequetesConnecteur(tenant) });
  });

  /**
   * LE CONNECTEUR PRÉVENU À CHAQUE DÉSABONNEMENT : écriture, ADMIN SEULEMENT.
   *
   * 🔴 BRANCHER UN CONNECTEUR ICI, C'EST DÉCIDER D'ENVOYER DES DONNÉES DE CONTACT À UN SYSTÈME TIERS. Le
   * geste appartient donc à un administrateur, comme la déclaration du connecteur lui-même, et pas à un
   * manager qui consulte la liste des désabonnés.
   *
   * 🔴 L'IDENTIFIANT EST VÉRIFIÉ CONTRE LES REQUÊTES DE CET ESPACE, jamais accepté sur sa seule forme : un
   * uuid pris ailleurs pointerait sur le connecteur d'un AUTRE client, et la poussée partirait chez lui. La
   * clé étrangère de la migration 0139 ne suffirait pas, elle ignore le tenant.
   */
  app.patch('/tenants/:tenantId/settings/poussee-optout', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.setOptoutRequestId || !deps.listerRequetesConnecteur) return reply.code(503).send({ error: 'connecteurs indisponibles' });
    const brut = (req.body as { requestId?: unknown } | null)?.requestId;
    if (brut === null) {
      await deps.setOptoutRequestId(tenant, null);
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
    await deps.setOptoutRequestId(tenant, requestId);
    return reply.code(200).send({ requestId });
  });

  /**
   * « L'IA SE DÉCLARE COMME TELLE » : lecture de la politique de l'ESPACE, et de ce que chaque agent dit.
   *
   * 🔴 UNE POLITIQUE PAR ESPACE, PAS UNE PAR AGENT (migration 0140). L'AI Act, article 50, fait peser
   * l'obligation d'information sur la marque DÉPLOYANTE : trois agents ne sont pas trois marques, et trois
   * réponses différentes seraient trois politiques, ce qui n'existe pas juridiquement.
   *
   * ⚠️ LE META BUSINESS AGENT N'EST PAS DANS CETTE LISTE, ET CE N'EST PAS UN OUBLI : Meta écrit déjà « IA »
   * sous les messages de son agent. Lui appliquer notre déclaration par symétrie en ferait deux. L'écran le
   * dit, plutôt que de laisser croire que la politique couvre tout ce qui parle sur l'espace.
   */
  app.get('/tenants/:tenantId/settings/mention-ia', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { mentionIaFrequence } = await deps.getSettings(tenant);
    return reply.code(200).send({
      // `null` en base veut dire « rien n'a jamais été réglé ici » : l'écran montre le défaut EFFECTIF,
      // celui que le runtime appliquera, pas une case vide qui ne dirait rien de ce qui se passe.
      frequence: mentionIaFrequence ?? 'session',
      reglee: mentionIaFrequence !== null,
      agents: deps.listerAgentsPourConformite ? await deps.listerAgentsPourConformite(tenant) : [],
    });
  });

  /**
   * ...et son écriture, ADMIN SEULEMENT.
   *
   * 🔴 `jamais` EST UN CHOIX EXPLICITE DU CLIENT, jamais un défaut que nous poserions en silence.
   * L'obligation d'information ne joue que lorsqu'elle n'est pas évidente du contexte, et elle pèse sur la
   * marque déployante : c'est donc à elle de trancher (décision de Julien du 2026-09-09).
   *
   * ⚠️ IL N'Y A PAS DE RETOUR À « non réglé » : le client choisit entre trois régimes, dont `jamais`. Lui
   * offrir de revenir à « rien » le ferait retomber sur un défaut qu'il n'a pas choisi.
   */
  app.patch('/tenants/:tenantId/settings/mention-ia', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.setMentionIaFrequence) return reply.code(503).send({ error: 'réglage indisponible' });
    const brut = (req.body as { frequence?: unknown } | null)?.frequence;
    if (!estFrequenceMention(brut)) {
      // 400 et non 500 : Cloudflare remplace le corps des 5xx, et c'est un message destiné à l'utilisateur.
      return reply.code(400).send({ error: `frequence requise (${FREQUENCES_MENTION_IA.join(' | ')})` });
    }
    await deps.setMentionIaFrequence(tenant, brut);
    return reply.code(200).send({ frequence: brut });
  });

  /**
   * QUAND L'ÉQUIPE EST JOIGNABLE, pour les agents IA (lot 1 du plan du 2026-09-18).
   *
   * 🔴 MÊMES TROIS VALEURS QUE LE MBA, et c'est délibéré : `mba_handoff_mode` (migration 0067) pose déjà
   * cette question pour l'agent de Meta. Deux vocabulaires voisins seraient impossibles à rapprocher sur un
   * écran où les deux agents cohabitent.
   *
   * ⚠️ CE RÉGLAGE NE DÉCIDE PAS SI ON TRANSFÈRE : la conversation arrive dans « À traiter » dans tous les
   * cas. Il décide de ce que l'agent a le droit de PROMETTRE au contact. Une phrase « nous revenons vers
   * vous » sans ligne de travail derrière serait un mensonge poli.
   */
  app.get('/tenants/:tenantId/settings/transfert-agent', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentTransfertMode } = await deps.getSettings(tenant);
    return reply.code(200).send({
      // Le défaut EFFECTIF, celui que le runtime appliquera, jamais une case vide : même raison que sa
      // voisine, un écran qui ne dirait rien de ce qui se passe ne sert à personne.
      mode: agentTransfertMode ?? MODE_TRANSFERT_DEFAUT,
      reglee: agentTransfertMode !== null,
    });
  });

  /** ...et son écriture, ADMIN SEULEMENT, comme tout ce qui change ce qu'un robot dit à de vrais contacts. */
  app.patch('/tenants/:tenantId/settings/transfert-agent', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.setAgentTransfertMode) return reply.code(503).send({ error: 'réglage indisponible' });
    const brut = (req.body as { mode?: unknown } | null)?.mode;
    if (!estModeTransfert(brut)) {
      // 400 et non 500 : Cloudflare remplace le corps des 5xx, et c'est un message destiné à l'utilisateur.
      return reply.code(400).send({ error: `mode requis (${MODES_TRANSFERT.join(' | ')})` });
    }
    await deps.setAgentTransfertMode(tenant, brut);
    return reply.code(200).send({ mode: brut });
  });

  /**
   * LES AGENTS PEUVENT-ILS PRENDRE UNE CONVERSATION DU POT COMMUN ? (migration 0160, demande de Julien du
   * 2026-09-19 : « une option à la main des admins et des managers »).
   *
   * 🔴 LECTURE ET ÉCRITURE OUVERTES À L'ENCADREMENT, et c'est la seule écriture de ce module qui l'est. Un
   * manager distribue déjà le travail de son équipe ; décider si ses agents peuvent se servir eux-mêmes est
   * le prolongement de ce geste, pas une décision de la marque. Le reste de Paramètres lui reste fermé.
   *
   * 🔴 PRENDRE, JAMAIS RÉAFFECTER : activé, ce réglage laisse un agent s'affecter une conversation que
   * personne n'a, et rien d'autre. La règle : `peutPrendre` (`src/inbox/assignment.ts`).
   */
  app.get('/tenants/:tenantId/settings/agents-peuvent-prendre', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentsPeuventPrendre } = await deps.getSettings(tenant);
    return reply.code(200).send({ actif: agentsPeuventPrendre });
  });

  app.patch('/tenants/:tenantId/settings/agents-peuvent-prendre', optsEncadrement, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.setAgentsPeuventPrendre) return reply.code(503).send({ error: 'réglage indisponible' });
    const actif = (req.body as { actif?: unknown } | null)?.actif;
    // Un booléen, rien d'autre : une valeur bancale ne doit pas se lire « activé » par accident.
    if (typeof actif !== 'boolean') return reply.code(400).send({ error: 'actif (booléen) requis' });
    await deps.setAgentsPeuventPrendre(tenant, actif);
    return reply.code(200).send({ actif });
  });

  // ⚠️ PLUS DE ROUTE `settings/auto-retry` depuis le lot 3 de la liste du 2026-09-23 (migration 0165) : la relance
  // obéit à la case de chaque campagne. `auto_retry_enabled` reste LU pour les campagnes d'avant, et ne s'écrit
  // plus : un réglage sans écran ne se change plus par accident.

  /**
   * Durée du GEL d'une conversation après qu'un opérateur a pris la main : pendant ce temps, ni le
   * scénario ni l'agent de Meta n'écrivent au client. Route dédiée, même raison que ci-dessus.
   *
   * `null` remet le défaut du serveur. `0` supprime la reprise automatique : la conversation reste à
   * l'humain jusqu'à ce qu'il la rende, ce qui est un choix légitime mais qui déplace la responsabilité
   * sur l'opérateur.
   *
   * Borne haute à 7 jours : au-delà, ce n'est plus un gel, c'est un abandon, et la conversation
   * n'apparaîtrait nulle part comme problématique. Mieux vaut refuser que d'accepter en silence une
   * valeur qui casse la promesse « le client finit toujours par avoir une réponse ».
   */
  app.patch('/tenants/:tenantId/settings/control-handback', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const raw = (req.body as { seconds?: unknown } | null)?.seconds;
    if (raw === null) {
      await deps.setControlHandbackSeconds(tenant, null);
      return reply.code(200).send({ controlHandbackSeconds: null });
    }
    const MAX = 7 * 24 * 3600;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX) {
      return reply.code(400).send({ error: `seconds invalide (entier 0..${MAX}, ou null pour le défaut)` });
    }
    await deps.setControlHandbackSeconds(tenant, raw);
    return reply.code(200).send({ controlHandbackSeconds: raw });
  });

  /**
   * Quand l'agent de Meta passe-t-il la main à un humain ? (admin-only, route dédiée comme ses voisines).
   *
   * Le choix est enregistré en base D'ABORD : c'est lui la source de vérité, et le balayage s'en sert pour
   * faire varier `business_hours` au fil de la journée. L'écriture chez Meta suit, en best-effort, pour que
   * le réglage soit vrai immédiatement plutôt qu'au prochain passage du balayage. Un échec côté Meta ne fait
   * pas échouer l'enregistrement : le balayage rattrapera, et refuser le réglage parce que Meta hoquette
   * empêcherait le client de piloter son propre outil.
   *
   * ⚠️ `enabled` ne décide PAS si l'agent transfère (il décide seul), mais s'il LÂCHE le fil ensuite. C'est
   * pourquoi « jamais » ne coupe pas les transferts : il laisse l'agent garder la conversation.
   */
  /*
   * `PATCH /tenants/:tenantId/settings/prix` A ETE RETIREE LE 2026-09-23 (lot 8, migration 0168).
   *
   * 🔴 LE CLIENT NE FIXE PLUS, ET NE VOIT PLUS, CE QU'ON LUI FACTURE. Il y a desormais UNE grille pour tous
   * les espaces, reglee dans `/ops` (`PATCH /ops/prix`). Cette route-ci ecrivait les six colonnes de
   * `tenant_settings` depuis les Parametres, c'est-a-dire depuis un ecran que le client ouvre.
   *
   * ⚠️ ET `TenantSettings.prix` EST PARTI AVEC ELLE, deliberement : laisser le GET rendre la grille aurait
   * permis a n'importe quel ecran de la reafficher un jour sans que personne n'y pense. Le type est la garde.
   *
   * ⚠️ Un client qui appellerait encore cette adresse recoit un 404 de Fastify, pas un 500 : aucune console
   * deployee ne l'appelle, et l'ecran qui le faisait est retire dans le meme lot.
   */

  app.patch('/tenants/:tenantId/settings/mba-handoff', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    if (mode !== 'always' && mode !== 'business_hours' && mode !== 'never') {
      return reply.code(400).send({ error: "mode invalide ('always' | 'business_hours' | 'never')" });
    }
    await deps.setMbaHandoffMode(tenant, mode);
    let applique = false;
    if (deps.applyMbaHandoffEnabled) {
      // Pour `business_hours` seulement, l'état À CET INSTANT : le client règle souvent son outil pendant ses
      // heures d'ouverture, et verrait sinon un passage de main éteint jusqu'au balayage suivant. Les deux
      // autres modes n'ont pas besoin de relire les horaires.
      let voulu = mode === 'always';
      if (mode === 'business_hours') {
        const s = await deps.getSettings(tenant);
        voulu = withinBusinessHours(new Date(), s.timezone, s.businessHours);
      }
      try {
        await deps.applyMbaHandoffEnabled(tenant, voulu);
        applique = true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-handoff: application chez Meta impossible pour ${tenant}:`, err instanceof Error ? err.message : err);
      }
    }
    return reply.code(200).send({ mbaHandoffMode: mode, appliqueChezMeta: applique });
  });


  // Fuseau horaire du tenant (admin-only). Base de NOW / weekday / heures d'ouverture du node condition.
  app.patch('/tenants/:tenantId/settings/timezone', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const tz = (req.body as { timezone?: unknown } | null)?.timezone;
    if (!isValidTimeZone(tz)) return reply.code(400).send({ error: 'timezone IANA invalide (ex. Europe/Paris)' });
    await deps.setTimezone(tenant, tz);
    return reply.code(200).send({ timezone: tz });
  });

  // Heures d'ouverture par jour (admin-only). Corps { '0'..'6': { closed, open 'HH:MM', close 'HH:MM' } }.
  app.patch('/tenants/:tenantId/settings/business-hours', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const hours = normalizeBusinessHours((req.body as { businessHours?: unknown } | null)?.businessHours);
    if (hours === null) return reply.code(400).send({ error: 'businessHours invalide (7 jours, HH:MM, close > open)' });
    await deps.setBusinessHours(tenant, hours);
    return reply.code(200).send({ businessHours: hours });
  });
}

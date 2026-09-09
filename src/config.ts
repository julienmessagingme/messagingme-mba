import { z } from 'zod';
import { PLAFOND_DESTINATAIRES_DEFAUT } from './campaign/plafond';

/** Exporté pour les tests : `config` est parsé À L'IMPORT, donc inutilisable pour vérifier les fail-fast
 *  (il faudrait réimporter le module avec un autre environnement). Le schéma, lui, se parse à la demande. */
export const schema = z.object({
  PORT: z.coerce.number().default(8095),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  /** Token d'accès Meta pour l'envoi outbound (worker campaign-run). */
  META_ACCESS_TOKEN: z.string().default(''),
  /** Version Graph API pour les appels d'envoi. */
  META_GRAPH_VERSION: z.string().default('v25.0'),
  /** Version du schéma flow_json (indépendante de la version Graph). Vérifié live 2026-07-10 : 7.2
   *  supportée. Une dépréciation Meta = un changement d'env, pas de code. */
  META_FLOW_JSON_VERSION: z.string().default('7.2'),
  /** App ID Meta (public) — endpoint du resumable upload `/{appId}/uploads` (headers média carousel). */
  META_APP_ID: z.string().default('988129420727963'),
  /**
   * Router le marketing par MM Lite (`/marketing_messages`). Défaut 'false' -> endpoint standard
   * `/messages`. MM Lite exige un onboarding Business Manager ; sans lui -> erreur 131042. Passer
   * à 'true' seulement une fois le BM onboardé MM Lite.
   */
  META_MM_LITE: z.string().default('false'),
  /** Configuration Embedded Signup (Facebook Login for Business) : l'id de configuration du dashboard Meta.
   *  Vide -> bouton « Connecter » inactif au front et route de complétion en 503 (feature OFF). */
  META_ES_CONFIG_ID: z.string().default(''),
  /** Clé AES-256-GCM (64 hex = 32 octets) du chiffrement au repos des tokens business ES. Requise si ES activé. */
  ENCRYPTION_KEY: z.string().default(''),
  /**
   * Fournisseur des numéros du pool (Zadarma) : c'est lui qui reçoit l'appel de vérification de Meta et dont
   * on transcrit l'enregistrement pour capter l'OTP. Vides -> la capture est inerte et l'embarquement retombe
   * sur la saisie manuelle du code, qui reste le comportement d'aujourd'hui.
   */
  ZADARMA_API_KEY: z.string().default(''),
  ZADARMA_API_SECRET: z.string().default(''),
  /** Pays par défaut pour normaliser les numéros à l'import CSV. */
  DEFAULT_COUNTRY: z.string().default('FR'),
  /** Secret HMAC de signature des JWT de session (login console). */
  AUTH_SECRET: z.string().default('dev-insecure-change-me'),
  /** Mode démo : le worker n'appelle PAS Meta, il marque les envois `sent` (message-id synthétique). */
  DRY_RUN: z.string().default('false'),
  /** Un destinataire `sending` plus vieux que ça est ramené à `pending` par le sweeper (ms). */
  STALE_SENDING_MS: z.coerce.number().default(15 * 60 * 1000),
  /**
   * Débit par défaut (messages/minute) d'une campagne SANS ratePerMinute explicite. Avant ce défaut, une telle
   * campagne partait à plein régime (aucun frein). 30/min lisse le burst et protège la réputation du numéro, très
   * loin du plafond API Meta (~80 msg/s). Mettre à 0 (ou vide) = opt-out : retour au comportement « aucun frein ».
   * ⚠️ Doit rester >= le plancher de pacing.ts (30) sous peine de sous-dimensionner expireInSeconds ; en dessous,
   * pacing résout le MÊME défaut via resolveRatePerMinute, donc l'estimation reste alignée sur le débit réel.
   */
  CAMPAIGN_DEFAULT_RATE_PER_MINUTE: z.coerce.number().int().min(0).max(80).default(30),
  /**
   * Plafond de débit des routes AUTHENTIFIÉES, par utilisateur et par minute. Clé = `userId`, posée dans
   * `makeRequireAuth` (cf. le commentaire qui y explique pourquoi ce n'est pas `req.ip`).
   *
   * 300 est très large pour un humain : la console tire une dizaine d'appels en rafale à l'ouverture d'un
   * écran, quelques dizaines par minute en cliquant vite. Le but n'est pas de rationner l'usage normal, c'est
   * de borner le coût qu'un compte authentifié peut infliger à Postgres.
   *
   * 🔴 **0 DÉSACTIVE**, et c'est délibéré : ce plafond s'applique aux 235 routes authentifiées d'un produit en
   * production. Un mauvais calibrage couperait la console de tous les clients, et remettre la variable à 0
   * (puis `compose up -d --force-recreate`) va nettement plus vite qu'un déploiement de code.
   */
  RATE_LIMIT_USER_PAR_MINUTE: z.coerce.number().int().min(0).default(300),
  /**
   * Plafond des routes COÛTEUSES (import CSV, action en masse, purge, export d'historique, lancement de
   * campagne), par ESPACE et par minute. Clé = `tenantId` et non `userId` : ce qu'on borne ici est la charge
   * qu'un espace envoie à Postgres, et un espace à dix comptes disposerait sinon de dix fois le plafond.
   *
   * S'ajoute au plafond général sans le remplacer. 0 désactive, même raison que ci-dessus.
   */
  RATE_LIMIT_COUTEUX_PAR_MINUTE: z.coerce.number().int().min(0).default(10),
  /**
   * Provider du canal RCS. `fake` = provider factice : le canal est complet de bout en bout (campagne, bloc de
   * scénario, joignabilité, opt-out) mais rien ne part vers un opérateur. `google` (API RBM) arrive au lot 2 et
   * LÈVE au démarrage tant qu'il n'est pas implémenté : un serveur qui croit envoyer du vrai RCS et envoie dans
   * le vide est pire qu'un crash au boot.
   */
  RCS_PROVIDER: z.enum(['fake', 'smsmode', 'google']).default('fake'),
  /** Clé du CANAL RCS smsmode (pas celle du compte : une clé est rattachée à un canal, et une clé de canal
   *  SMS répond 403 « Channel type mismatch » sur l'API RCS). Secret serveur. */
  SMSMODE_RCS_API_KEY: z.string().default(''),
  /** URL publique qui reçoit les rapports de livraison smsmode. Vide -> aucun rapport, donc la sortie
   *  « non joignable » du bloc reste muette. */
  SMSMODE_CALLBACK_STATUS_URL: z.string().default(''),
  /** URL publique qui reçoit les réponses entrantes (MO) smsmode. */
  SMSMODE_CALLBACK_MO_URL: z.string().default(''),
  /** Intervalle du sweeper de récupération des `sending` bloqués (ms). */
  RECLAIM_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  /** Réveil des parcours endormis (bloc « Attente »). 60 s : c'est aussi la précision réelle d'un délai. */
  WORKFLOW_WAKE_SWEEP_INTERVAL_MS: z.coerce.number().default(60 * 1000),
  /** URL du pooler Supabase mode SESSION (port 5432). Sert à pg-boss (API + worker) ET, par défaut, au pool
   *  applicatif si APP_DATABASE_URL est vide. Les scripts CLI (db/migrate.ts, db/seed.ts, db/backfill-codes.ts)
   *  lisent CETTE var en direct (jamais APP_DATABASE_URL) -> DDL/seed toujours en session mode, c'est voulu. */
  DATABASE_URL: z.string().default(''),
  /**
   * URL du pooler Supabase mode TRANSACTION (port 6543) pour le POOL APPLICATIF (toutes les requêtes des stores,
   * API + worker). Vide -> repli sur DATABASE_URL (session mode) = comportement d'avant (dégradation SÛRE si oubli).
   * pg-boss reste IMPÉRATIVEMENT sur DATABASE_URL (session) : il maintient des connexions longues + une maintenance
   * qui ne survivent pas au transaction pooling (le pooler réassigne le backend entre transactions).
   * Bénéfice : sort les ~6 clients applicatifs (3 API + 3 worker) du budget SESSION (~15 partagé avec mm-hubspot),
   * faisant tomber le pire cas de ~18 à ~8, enfin sous le plafond. ⚠️ Sûr car mba est search_path-agnostique
   * (tables en public par défaut, mmhs TOUJOURS qualifié) et toutes ses transactions passent par un client dédié.
   */
  APP_DATABASE_URL: z.string().default(''),
  PGBOSS_SCHEMA: z.string().default('pgboss'),
  /**
   * Budget de connexions du pool APPLICATIF (tous les stores, API + worker), qui passe par le pooler en mode
   * TRANSACTION (`APP_DATABASE_URL`, port 6543). ⚠️ Ce n'est PLUS le budget des ~15 sessions partagé avec
   * mm-hubspot : ce budget-là ne concerne que pg-boss, resté en mode SESSION (`PGBOSS_MAX` ci-dessous). La
   * valeur de 3 datait d'avant la bascule en mode transaction et n'était qu'un pansement, que son propre
   * commentaire annonçait comme provisoire. Elle a survécu au correctif qu'elle attendait.
   *
   * Pourquoi 8 et pas plus, mesuré en production le 2026-08-25 : le pool est instancié PAR PROCESS (l'API et
   * le worker importent le même module), donc 2 x 8 = 16 clients simultanés vers le pooler, ce qui est
   * exactement la capacité observée (au-delà de 16 la latence double sans qu'aucune erreur ne remonte). Passer
   * au-dessus déplacerait la file d'attente de NOTRE pool vers celle de Supavisor, où elle est MUETTE :
   * `DB_CONN_TIMEOUT_MS` ne protégerait alors plus de rien, ce qui est l'inverse du but.
   *
   * Pourquoi le relever tout court : à 3, l'API ne pouvait tenir que 3 requêtes en vol, soit environ 250
   * requêtes/s à 11 ms d'aller-retour mesuré. C'était le plafond direct du polling de l'inbox. ⚠️ Le relever
   * ne CORRIGE pas ce polling, ça déplace seulement le goulot (cf. AUDIT-SCALE-2026-08-25.md, R7).
   */
  DB_POOL_MAX: z.coerce.number().default(8),
  /** Max de connexions du pool pg-boss, qui reste en mode SESSION : c'est LUI qui vit dans le budget de ~15
   *  sessions partagé avec mm-hubspot (2 process x 2 ici, + 2 x 2 chez lui). Ne pas le relever sans refaire
   *  l'arithmétique de ce budget-là. */
  PGBOSS_MAX: z.coerce.number().default(2),
  /**
   * Timeout d'ACQUISITION d'une connexion du pool (ms). Le défaut `pg` est une attente ILLIMITÉE : pool saturé
   * -> la requête HTTP ne répond jamais, sans erreur, sans trace. On préfère un échec net au bout du délai,
   * que le setErrorHandler journalise. 0 = attente illimitée (comportement pg d'origine, à éviter).
   */
  DB_CONN_TIMEOUT_MS: z.coerce.number().default(8000),
  /** Secret de la surface d'exploitation cross-tenant `/ops` (lecture seule). Vide -> /ops désactivé (401). */
  OPS_TOKEN: z.string().default(''),
  /** Alerte Telegram du worker (erreurs pg-boss, échecs de balayage). ENV-FIRST : le conteneur worker n'a PAS
   *  accès au config.json de l'hôte utilisé par les crons ops. Vide -> aucune alerte (no-op silencieux). */
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  /** Cadence du heartbeat worker (ms). Défaut 20 s : écriture négligeable pour le pooler, assez fine pour
   *  qu'un worker mort dépasse vite le seuil d'âge côté /ops. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(20_000),
  /** Rate limit de l'API publique /v1 : requêtes par clé et par fenêtre (en mémoire, par process). */
  API_KEY_RATE_LIMIT_MAX: z.coerce.number().default(60),
  API_KEY_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  /** Plafond de débit d'UN webhook entrant (menu Tools). Par webhook, pas par IP : c'est le budget d'une
   *  intégration, et l'IP d'un Zapier n'a aucune stabilité. */
  WEBHOOK_IN_RATE_LIMIT_MAX: z.coerce.number().default(120),
  WEBHOOK_IN_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  /** Jours de conservation du dernier payload d'un webhook entrant. Voir la note RGPD de la migration 0074. */
  WEBHOOK_PAYLOAD_RETENTION_DAYS: z.coerce.number().default(7),
  /**
   * Jours de conservation des ÉVÉNEMENTS Meta bruts (`webhook_events`), qui portent le texte des messages
   * entrants et le numéro de qui écrit. 30 jours : bien au-delà de la fenêtre d'idempotence (quelques
   * minutes) et de tout débogage d'incident réaliste, bien en deçà d'une conservation « pour toujours », qui
   * était l'état jusqu'au 2026-08-31. `0` désactive la purge, et c'est un choix qu'il faut assumer : la table
   * se remet alors à croître sans fin. Cf. migration 0093 et PLAN.md 5.2.
   */
  WEBHOOK_EVENTS_RETENTION_DAYS: z.coerce.number().default(30),
  /**
   * Jours de conservation des CONVERSATIONS (et, par cascade, de leurs messages et de leur analyse
   * qualitative). 365 par défaut.
   *
   * 🔴 Le chiffre est une DÉCISION, pas un réglage technique. Julien a donné un PLANCHER de 3 mois
   * (2026-08-31, motif RGPD) ; on prend quatre fois ce plancher, parce que la suppression est IRRÉVERSIBLE et
   * qu'un an est la durée qu'on défend sans hésiter devant une DSI. Descendre est sans danger, remonter ne
   * ressuscite rien.
   *
   * `0` désactive la purge. C'est un choix qu'il faut assumer : les conversations et leurs analyses (qui
   * portent un `topic` et une `justification` en texte libre produits à partir de ce que la personne a
   * raconté) sont alors gardées pour toujours.
   */
  CONVERSATION_RETENTION_DAYS: z.coerce.number().default(365),
  /**
   * Rétentions du lot 4 du programme II. Quatre tables qui grossissaient sans fin, et dont deux portent une
   * donnée personnelle. 0 = balayage désactivé pour cette table (comme les rétentions ci-dessus).
   *
   * 🔴 Les deux natures ne se règlent pas pareil, et c'est le point à comprendre avant de toucher ces valeurs :
   * les tables qui portent un `wa_id` (événements de blocs, parcours) ont une rétention COURTE parce que la
   * donnée personnelle n'a plus de raison d'être ; celles qui n'en portent aucune (clics, journal d'audit) ont
   * une rétention LONGUE parce qu'elles ne posent qu'une question de volume et qu'elles servent de mesure ou
   * de preuve.
   */
  /** ANONYMISATION (pas suppression) du `wa_id` des événements de blocs : les compteurs restent justes. */
  NODE_EVENTS_ANONYMISATION_DAYS: z.coerce.number().default(365),
  /** Suppression des parcours TERMINÉS (`done`, `inbox`). Les parcours vivants ne sont jamais touchés. */
  WORKFLOW_RUNS_RETENTION_DAYS: z.coerce.number().default(90),
  /** Suppression des CLICS tracés (jamais des liens : `/r/<code>` est une porte à sens unique). */
  TRACKED_CLICKS_RETENTION_DAYS: z.coerce.number().default(730),
  /** Suppression des entrées du journal d'audit. LONGUE : c'est la preuve qu'une purge a eu lieu. */
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().default(730),
  /**
   * Suppression des échecs d'avance de scénario (migration 0108). COURTE, à l'opposé du journal d'audit :
   * c'est de l'exploitation, on s'en sert dans les jours qui suivent la panne ou jamais.
   */
  AVANCE_ECHECS_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  /**
   * Suppression des agregats d'attente du pool (migration 0109). Courte : une ligne par minute et par process,
   * et on regarde une courbe de quelques heures, jamais de quelques mois.
   */
  POOL_ATTENTES_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  /**
   * Plafond d'envois par minute et PAR NUMÉRO, tous chemins confondus (campagne, scénario, automation,
   * réponse d'inbox). Lot 4 du programme, cf. `src/meta/arbitre-debit.ts`.
   *
   * 80 par défaut, et le chiffre n'est pas arbitraire : c'est le débit maximum qu'une campagne peut CHOISIR
   * dans l'écran (1 à 80/min). Le plafond du numéro ne bride donc jamais une campagne seule, il empêche
   * seulement DEUX campagnes du même numéro d'en faire 160, et fait payer les envois d'inbox et de scénario
   * sur le même budget. Le relever au-delà de ce que Meta tolère pour le palier du numéro ne rend rien plus
   * rapide : Meta répond alors 130429, et depuis le lot 1 la campagne se met en pause.
   *
   * `0` retire le frein. À n'utiliser que pour reproduire un incident.
   */
  PHONE_RATE_PER_MINUTE_MAX: z.coerce.number().default(80),
  /**
   * Durée maximale d'un run de campagne avant qu'il rende la main et se réenfile (lot 5). 2 minutes.
   *
   * Le but n'est pas d'aller plus vite, c'est de rendre la file ÉQUITABLE : sans découpage, un job traitait
   * sa campagne jusqu'à épuisement, soit 2 h 47 pour 5 000 destinataires à 30/min, pendant lesquelles les
   * campagnes des autres clients attendaient. Une DURÉE et non un nombre de destinataires : à 1/min un lot de
   * 100 durerait plus d'une heure, à 80/min une minute.
   *
   * Le prix : un aller-retour de file entre deux lots (la cadence de `campaign-run` est de 5 s), soit
   * quelques minutes ajoutées sur une campagne de plusieurs heures. `0` retire le découpage.
   */
  CAMPAIGN_RUN_MAX_MS: z.coerce.number().default(2 * 60 * 1000),
  /**
   * Plafond de destinataires d'une campagne (lot 3 du plan post-audit, 2026-09-02). Chiffre de Julien.
   *
   * Un garde-fou, pas un objectif : il empêche le serveur d'ACCEPTER PAR ACCIDENT ce qu'on a décidé de ne pas
   * faire. En configuration pour qu'il se relève sans redéploiement le jour d'un vrai gros client. La règle et
   * le message de refus vivent dans `src/campaign/plafond.ts`.
   */
  CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().int().min(1).default(PLAFOND_DESTINATAIRES_DEFAUT),
  /**
   * Nombre de runs de campagne traités EN PARALLÈLE par le worker, et plafond par ESPACE (lot 5).
   *
   * 🔴 La concurrence n'est sûre QUE parce que le lot 4 est en place : sans un frein partagé par numéro, deux
   * campagnes en parallèle doubleraient le débit réel du numéro. Ne pas relever l'un sans l'autre.
   *
   * Le plafond par espace reste à 1 : un client n'a qu'un numéro (décision produit du 2026-08-31), donc deux
   * de ses campagnes en parallèle ne gagneraient rien et se disputeraient le même budget. La concurrence sert
   * à ce qu'un client n'attende pas la campagne d'un AUTRE.
   */
  CAMPAIGN_RUN_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /**
   * Concurrence de la file des messages ENTRANTS (lot 3 du programme II). Elle valait 1, donc un seul message
   * entrant était traité à la fois, TOUS clients confondus : un envoi Meta lent, un appel HubSpot qui traîne,
   * et la réponse d'un autre client attendait derrière. C'est le « noisy neighbour » de l'audit.
   *
   * 🔴 Ce plafond n'est sûr QUE parce que l'enfilement pose une clé de groupe par contact et que `work`
   * plafonne à un job en vol par groupe : deux messages d'un même contact restent sérialisés. Relever l'un
   * sans l'autre remettrait le désordre que le groupe supprime.
   *
   * Pourquoi 3, et pas plus : le worker tient déjà 4 runs de campagne en parallèle, plus les accusés, les
   * automations et les tours d'agent. Le pool applicatif est de 8 connexions PAR PROCESS, valeur mesurée
   * comme la capacité réelle du pooler (cf. `DB_POOL_MAX`). Monter au-delà déplacerait l'attente de notre
   * pool vers celle de Supavisor, où elle est muette. Relever ce nombre demande donc de refaire cette
   * arithmétique-là, pas seulement de changer la variable.
   */
  WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  /**
   * TOURS D'AGENT EN VOL, et plafond par ESPACE (lot 6 du plan post-audit, 2026-09-02).
   *
   * 🔴 Le défaut de pg-boss est `localConcurrency: 1` (vérifié dans sa source). Cette file traitait donc UN
   * tour à la fois POUR LA FLOTTE ENTIÈRE, avec un plafond de 120 s par appel au modèle : à 25 clients, cela
   * faisait 30 tours par heure pour tout le monde, toutes conversations mêlées.
   *
   * Pourquoi 12 est sûr, et ce n'est pas une mesure mais une arithmétique : un tour passe l'essentiel de son
   * temps à ATTENDRE le modèle, et il ne tient AUCUNE connexion pendant cette attente (les stores font
   * `pool.query`, qui prend et rend la connexion par instruction). Douze tours en vol ne réservent donc pas
   * douze connexions du pool de 8 (`DB_POOL_MAX`). ⚠️ Cette phrase cesserait d'être vraie le jour où un tour
   * ouvrirait une transaction autour de l'appel au modèle : ce serait alors ce nombre-là qu'il faudrait revoir.
   *
   * Quatre par espace : trois clients actifs se partagent équitablement, et un client bavard ne prend pas les
   * douze places. ⚠️ Les deux vont ENSEMBLE : `groupConcurrency` est un no-op tant que `concurrency` vaut 1.
   *
   * Point de départ PRUDENT, pas une mesure. En configuration pour être ajusté après le lot 7 (la mesure de
   * l'attente du pool) sans redéployer de code.
   */
  AGENT_TURN_CONCURRENCY: z.coerce.number().int().min(1).default(12),
  AGENT_TURN_GROUP_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /**
   * Analyses de conversation en vol. Le plafond par espace est de 1, posé dans le worker.
   *
   * 🔴 Sur cette file, le GROUPE compte bien plus que le nombre. Passer de 1 à 3 ne change presque rien au
   * débit ; ce qui change tout, c'est qu'un client qui importe dix mille contacts déclenche dix mille analyses
   * et ne puisse plus les faire passer AVANT la première analyse de tous les autres.
   */
  ANALYZE_CONVERSATION_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  /**
   * Événements d'automation en vol. Même raison et même plafond par espace de 1 : une rafale d'un client
   * gelait tous les autres, cette file traitant un job à la fois pour la flotte entière.
   */
  AUTOMATION_EVENT_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  /** Clé API Resend pour le formulaire de support (phase 7). Vide -> support indisponible (503, pas de crash). */
  RESEND_API_KEY: z.string().default(''),
  /** Expéditeur des emails de support. `onboarding@resend.dev` marche sans domaine vérifié (mode test :
   *  n'envoie QU'à l'adresse du compte Resend). Domaine vérifié -> `support@messagingme.app`. */
  SUPPORT_FROM: z.string().default('onboarding@resend.dev'),
  /** Destinataire des messages du formulaire de support. Vide -> support indisponible (503). */
  SUPPORT_TO: z.string().default(''),
  /** Client OAuth Google (public) pour « se connecter avec Google ». Vide -> bouton Google masqué (pas de crash). */
  GOOGLE_CLIENT_ID: z.string().default(''),
  /**
   * URL publique du FRONT. Base des liens envoyés par e-mail (invitation `/invite/<jeton>`, réinitialisation
   * `/reset/<jeton>`), qui sont des pages de la console, pas des routes d'API.
   */
  APP_URL: z.string().default('https://mba.messagingme.app'),
  /**
   * URL publique de l'API, quand elle est servie sous SON PROPRE nom (bascule Vercel, cf.
   * `docs/PLAN-BASCULE-VERCEL-2026-09-03.md`).
   *
   * 🔴 POURQUOI CETTE VARIABLE EXISTE. `APP_URL` faisait DEUX métiers à la fois : la base des liens d'e-mail
   * (des pages du FRONT) et la base des adresses que le produit DISTRIBUE et qui sont servies par l'API, à
   * savoir les liens tracés `/r/<code>`, les visuels RCS `/m/<fichier>` et l'URL d'un webhook entrant
   * `/w/<code>`. Tant que le front et l'API vivaient sur le même hôte, une seule variable suffisait. Dès
   * qu'ils se séparent, en garder une seule casse forcément un des deux côtés : soit les e-mails envoient
   * les gens vers l'API, soit les liens tracés font un détour par le front.
   *
   * ⚠️ VIDE PAR DÉFAUT, ET C'EST LE POINT : tant qu'elle n'est pas posée, tout retombe sur `APP_URL` et le
   * comportement est celui d'avant, au caractère près. Une variable dont l'oubli casse la production serait
   * une mauvaise variable, surtout sur des adresses qui partent dans des messages qu'on ne peut plus corriger.
   */
  PUBLIC_API_URL: z.string().default(''),
  /**
   * Origines autorisées à appeler cette API depuis un NAVIGATEUR, séparées par des virgules.
   * Ex. `https://engageme.messagingme.app,https://mba.messagingme.app`.
   *
   * 🔴 VIDE = AUCUN CORS DU TOUT, et c'est le défaut voulu. Tant que le front est servi par le même hôte que
   * l'API (le proxy Next), le navigateur ne fait aucune requête d'origine croisée : poser des en-têtes CORS
   * n'apporterait rien et ouvrirait une porte pour rien. Ils n'apparaissent qu'à partir du moment où une
   * origine est explicitement inscrite ici.
   *
   * ⚠️ JAMAIS `*`, et la valeur est refusée si on l'essaie. Une liste blanche est le seul CORS qui protège :
   * l'étoile autorise n'importe quel site à faire faire des requêtes au navigateur d'un client connecté.
   *
   * ⚠️ ET JAMAIS `credentials: true` (cf. `src/server.ts`). La session de cette console voyage dans un en-tête
   * `Authorization`, jamais dans un cookie : il n'y a donc AUCUN CSRF possible aujourd'hui. Activer les
   * credentials en créerait un de toutes pièces, pour un besoin qui n'existe pas.
   */
  CORS_ORIGINS: z.string().default('').refine(
    (v) => !v.split(',').map((o) => o.trim()).includes('*'),
    { message: 'CORS_ORIGINS: `*` est refusé, il faut une liste blanche d’origines' },
  ),
  /** Durée de validité d'un lien d'invitation (ms). Défaut 7 jours. */
  INVITE_TOKEN_TTL_MS: z.coerce.number().default(7 * 24 * 60 * 60 * 1000),
  /** Durée de validité d'un lien de réinitialisation de mot de passe (ms). Défaut 1 h. */
  RESET_TOKEN_TTL_MS: z.coerce.number().default(60 * 60 * 1000),
  /** Analyse de conversation (Pièce 1) : INERTE par défaut. 'true' -> le worker analyse les conversations closes. */
  CONVERSATION_ANALYSIS_ENABLED: z.string().default('false'),
  /** Inactivité (ms) au-delà de laquelle une conversation est considérée close et analysable. Défaut 25 min. */
  CONVERSATION_INACTIVITY_MS: z.coerce.number().default(25 * 60 * 1000),
  /** Une conversation bloquée en `queued` plus vieille que ça est ramenée à `pending` (worker mort). Défaut 15 min. */
  CONVERSATION_ANALYSIS_STALE_MS: z.coerce.number().default(15 * 60 * 1000),
  /** Intervalle du balayage d'analyse (ms). Défaut 5 min. */
  CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  /** Nombre max de conversations réclamées par passage de balayage. */
  CONVERSATION_ANALYSIS_BATCH: z.coerce.number().default(20),
  /** Cadence du garde-fou qui rend la main au scénario quand plus personne ne s'occupe d'une conversation. */
  CONTROL_SWEEP_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  /** Cadence du balayage de statut/qualité des numéros Meta (item 4.10). Défaut 20 min : 2 GET Graph par numéro
   *  et par passage, large assez pour ne pas peser sur le rate-limit tant que le parc reste petit. */
  PHONE_STATUS_SWEEP_INTERVAL_MS: z.coerce.number().default(20 * 60 * 1000),
  /** Cadence du filet de sécurité du rattrapage HubSpot (F3-a) : relance le rattrapage des marques restées sur un
   *  numéro reconnecté. Défaut 10 min : action rare, lecture légère (distinct tenant_id), pas un chemin chaud. */
  HUBSPOT_CATCHUP_SWEEP_INTERVAL_MS: z.coerce.number().default(10 * 60 * 1000),
  /** Cadence du sweep d'auto-relance des échecs (F6). 15 min : assez fin pour la fenêtre matinale des 131049. */
  AUTO_RETRY_SWEEP_INTERVAL_MS: z.coerce.number().default(15 * 60 * 1000),
  /** Inactivité au bout de laquelle un fil tenu par un OPÉRATEUR revient au scénario. 2 h : assez long pour
   *  qu'une pause déjeuner ne coupe pas un échange en cours, assez court pour qu'un onglet fermé ne gèle pas
   *  le contact jusqu'au lendemain. Il n'existe AUCUN release automatique côté Meta : ce délai est notre
   *  seule soupape. 0 désactive la reprise (le contrôle reste alors humain indéfiniment, à vos risques). */
  CONTROL_HUMAN_TIMEOUT_MS: z.coerce.number().default(2 * 60 * 60 * 1000),
  /** Idem pour un fil tenu par MBA. Beaucoup plus long : l'agent est censé répondre seul, on ne le préempte
   *  qu'en cas de silence anormal. */
  CONTROL_MBA_TIMEOUT_MS: z.coerce.number().default(24 * 60 * 60 * 1000),
  /** Anti-rebond par défaut d'une automation (Lot E) : délai minimum entre deux déclenchements de la MÊME
   *  automation pour le MÊME contact, quand le client n'a rien réglé. 1 h : assez long pour absorber un client
   *  qui répète son mot-clé ou un scénario qui repose le tag déclencheur, assez court pour ne pas bloquer une
   *  vraie 2e demande dans la journée. Réglable par automation (0 = aucun garde-fou, à ses risques). */
  AUTOMATION_COOLDOWN_SECONDS: z.coerce.number().default(3600),
  /** Plafond PAR DÉFAUT de déclenchements par heure, pour une automation qui n'a pas son propre
   *  `maxFiresPerHour` : depuis ce lot, le runner lit d'abord le plafond PROPRE de l'automation
   *  (`AutomationRow.maxFiresPerHour`, `src/automation/runner.ts`) et ne retombe sur cette valeur globale que
   *  s'il est absent. Ce n'est donc plus LE plafond effectif de chaque automation, seulement le défaut de
   *  l'instance. L'anti-rebond est par (automation, CONTACT) et ne borne rien à l'échelle d'une population :
   *  un seul acte d'exploitation (une campagne directe qui rouvre l'analyse de tous ses destinataires) peut
   *  produire des milliers d'événements. 200/h laisse passer tout usage normal et transforme une erreur de
   *  configuration en incident borné plutôt qu'en facture. 0 = pas de plafond. */
  AUTOMATION_MAX_FIRES_PER_HOUR: z.coerce.number().default(200),
  /** Cadence du balayage des échéances (déclencheur « X avant la date d'un champ »). */
  AUTOMATION_DATE_SWEEP_INTERVAL_MS: z.coerce.number().default(60_000),
  /** Fenêtre de rattrapage APRÈS le moment prévu. Elle absorbe un redémarrage du worker, PAS un vrai retard :
   *  au-delà, on n'envoie rien (un rappel « 48 h avant » qui part 12 h avant dit quelque chose de faux). */
  AUTOMATION_DATE_TOLERANCE_MINUTES: z.coerce.number().default(60),
  /** Provider LLM de l'analyse. UNE seule implémentation existe. `z.enum` et non `z.string` : une valeur
   *  inconnue était acceptée par la config et TUAIT le conteneur worker au premier appel d'analyse, avec une
   *  erreur qui ne nommait pas la variable. Elle est maintenant refusée au boot. */
  LLM_PROVIDER: z.enum(['anthropic']).default('anthropic'),
  /** Clé API du provider LLM. Vide -> analyse non activable (fail-fast prod si ENABLED). */
  LLM_API_KEY: z.string().default(''),
  /** Id de modèle LLM (ex. claude-haiku-4-5 pour ce classifieur haut-volume, ou claude-opus-4-8 pour la qualité).
   *  À fixer au déploiement — JAMAIS d'id daté figé en dur. Vide -> analyse non activable. */
  LLM_MODEL: z.string().default(''),
  /**
   * Cle du Vercel AI Gateway, pour l agent IA et son assistant de construction. Vide -> la conversation de
   * construction repond 503 (indisponible), aucun crash : meme patron que RESEND_API_KEY.
   */
  AI_GATEWAY_API_KEY: z.string().default(''),
  /**
   * Modele de l IA de CONSTRUCTION, a ne pas confondre avec celui d un agent. Celle-ci tourne rarement
   * (reglage et optimisation) et joue le role le plus dur : elle merite un modele plus fort que le runtime.
   * Vide -> repli sur LLM_MODEL.
   */
  AGENT_SETUP_MODEL: z.string().default(''),
  /**
   * Modèle qui LIT LES IMAGES jointes à la conversation de construction.
   *
   * 🔴 SÉPARÉ de `AGENT_SETUP_MODEL`, et mesuré le 2026-08-31 : `zai/glm-4.7`, le modèle d'entretien de la
   * production, REFUSE une part `image_url` avec un 400 au corps vide. Réutiliser le modèle d'entretien aurait
   * donc livré une pièce jointe image morte, en rendant une erreur que personne n'aurait su lire. Ce sont deux
   * métiers différents : l'un mène un entretien en français sur des dizaines de tours, l'autre relève du texte
   * sur une image, une fois. Rien n'oblige le même modèle à être bon aux deux, ni à être choisi pour les deux.
   *
   * VIDE = les images sont refusées explicitement (les documents, eux, continuent de passer : ils n'ont besoin
   * d'aucun modèle). C'est un refus clair, pas une panne. Vérifié bon : `google/gemini-2.5-flash`.
   */
  AGENT_VISION_MODEL: z.string().default(''),
  /**
   * Modele donne a un agent NEUF, c est-a-dire celui qui tournera a chaque message d un contact.
   *
   * 🔴 IL NE DOIT PAS RETOMBER SUR `LLM_MODEL`, et c est pour ca que cette variable existe. `LLM_MODEL` est
   * le modele de l ANALYSE de conversation, servi en direct par Anthropic (`claude-haiku-4-5` en production).
   * L agent, lui, passe par le Vercel AI Gateway, dont les identifiants sont prefixes par leur fournisseur
   * (`zai/glm-4.7-flash`). Un agent cree avec l identifiant de l analyse porte donc un modele que le Gateway
   * ne connait pas, et CHAQUE tour echouerait, sans que rien ne l ait signale a la creation.
   *
   * Vide -> repli sur `LLM_MODEL`, qui est le comportement d avant et reste faux : a poser au deploiement.
   */
  AGENT_MODEL: z.string().default(''),
  /**
   * Le modele qui VECTORISE les fiches de connaissance et les questions (migration 0110).
   *
   * 🔴 Choisi PAR LA MESURE, en français : sur six questions posees avec les mots d un client contre six
   * fiches ecrites avec les mots d une entreprise, sans aucun mot commun, il place la bonne fiche en premier
   * 6 fois sur 6, la ou deux concurrents la placent deuxieme a 0,009 pres. Un premier rang a 0,009 pres est un
   * hasard, pas un choix.
   *
   * ⚠️ SA DIMENSION (1536) EST CELLE DE LA COLONNE. En changer oblige a recalculer les vecteurs de tous les
   * clients : c est un balayage, pas un drame, mais ce n est pas un reglage qu on bouge a la legere. Vide ->
   * aucune vectorisation, la recherche retombe sur le plein texte seul, comportement d avant.
   */
  AGENT_EMBED_MODEL: z.string().default('cohere/embed-v4.0'),
  /**
   * Le modele qui JUGE la pertinence des fiches candidates.
   *
   * 🔴 IL N EST PAS OPTIONNEL AU SENS DU PRODUIT : c est LUI qui porte la garde anti-hallucination une fois le
   * vectoriel branche. Mesure : aucun seuil n est posable sur un cosinus d embedding (une question hors sujet
   * remonte a 0,361 quand une vraie question descend a 0,299), alors que ce reranker place les vraies
   * questions au-dessus de 0,0817 et le hors-sujet en dessous de 0,0409.
   *
   * ⚠️ Ce n est PAS le modele le plus recent, et c est delibere : `cohere/rerank-v4-fast` laisse le hors-sujet
   * monter AU-DESSUS des vraies questions sur le meme corpus. Prendre la derniere version par reflexe aurait
   * reproduit le defaut qu on corrige.
   */
  AGENT_RERANK_MODEL: z.string().default('cohere/rerank-v3.5'),
  /**
   * Le seuil de pertinence du reranker. En dessous, la fiche n est PAS montree au modele.
   *
   * ⚠️ MESURE, pas devine, mais sur UN corpus de six fiches et dix questions : les vraies questions vont de
   * 0,0817 a 0,3662 et le hors-sujet plafonne a 0,0409. 0,06 est le milieu de cet intervalle. C est un point
   * de depart mesure, pas une loi, et il est en configuration pour etre re-mesure sur de vraies bases.
   */
  AGENT_RERANK_SEUIL: z.coerce.number().min(0).max(1).default(0.06),
  /**
   * Combien de fiches le RAPPEL remonte avant le verdict. Plus large que les 3 rendues au modele, et c est
   * tout l interet : on donne au reranker de quoi choisir. Trop large le ferait payer pour rien.
   */
  AGENT_RAPPEL_CANDIDATS: z.coerce.number().int().min(1).default(12),
  /**
   * Taux euros par dollar, pour convertir ce que le Gateway facture (en DOLLARS) vers nos compteurs, qui
   * sont tous en micro-euros. C est un parametre COMMERCIAL, pas un cours en temps reel : le client charge
   * et consomme des euros, et la marge absorbe tres largement la variation. Un taux a 0 retomberait sur 1
   * plutot que de rendre toute consommation gratuite (`src/agent/devise.ts`).
   */
  EUR_PER_USD: z.coerce.number().positive().default(0.92),
  /**
   * Notre commission sur le tarif des modèles, en POURCENT, telle qu'elle est ANNONCÉE au client dans la
   * liste déroulante de l'onglet Modèle (2026-09-09).
   *
   * 🔴 AFFICHAGE SEULEMENT, décision de Julien : la consommation réellement décomptée reste le coût BRUT du
   * Gateway. L'onglet Consommation montre donc environ 10 % de moins que le tarif annoncé, le temps que la
   * facturation Stripe existe. Le jour où elle arrivera, c'est le chemin d'écriture (`run-turn`) qu'il
   * faudra majorer, pas l'affichage, sinon les deux écrans se remettront à diverger dans l'autre sens.
   *
   * Paramètre COMMERCIAL, comme `EUR_PER_USD` juste au-dessus : il ne bouge que quand Julien le décide. 0 est
   * une valeur valide (aucune commission annoncée), d'où `nonnegative` et non `positive`.
   */
  COMMISSION_MODELE_PCT: z.coerce.number().nonnegative().default(10),
  /** max_tokens de la réponse d'analyse (petit JSON). */
  LLM_MAX_TOKENS: z.coerce.number().default(1024),
  /** URL du connecteur mm-hubspot (POST /ingest). Vide -> le push d'analyse est INERTE (aucun job enfilé). */
  CONNECTOR_PUSH_URL: z.string().default(''),
  /** Secret HMAC partagé avec le connecteur (== INGEST_SECRET). Signe le push. */
  CONNECTOR_PUSH_SECRET: z.string().default(''),
  /** URL du canal SERVICE du connecteur (mba interroge les listes HubSpot, ex. http://mm-hubspot-api:8096). Vide -> import HubSpot INERTE (routes non montées). */
  HUBSPOT_SERVICE_URL: z.string().default(''),
  /** Secret HMAC du canal service (== SERVICE_SECRET de mm-hubspot). Signe les appels /service/*. Sert aussi à signer
   *  le jeton d'install `/oauth/install?t=` (le tenant n'est plus passé en clair dans l'URL du lien HubSpot). */
  HUBSPOT_SERVICE_SECRET: z.string().default(''),
  /** Origine PUBLIQUE du connecteur (ex. https://mm-hubspot.messagingme.app), celle que le NAVIGATEUR ouvre pour
   *  l'install/re-consentement HubSpot. DISTINCTE de HUBSPOT_SERVICE_URL (URL interne Docker, injoignable du navigateur).
   *  Vide -> la route de lien d'install répond 503 (le front garde son bouton mais l'action indique l'indisponibilité). */
  HUBSPOT_CONNECTOR_PUBLIC_URL: z.string().default(''),
}).superRefine((c, ctx) => {
  /**
   * 🔴 UN PLAFOND PAR GROUPE PLUS GRAND QUE LE TOTAL NE PLAFONNE RIEN, et se relit comme une garantie.
   *
   * `groupConcurrency` borne le nombre de jobs en vol POUR UN MEME espace ; `concurrency` borne le total. Un
   * groupe >= total laisse donc un seul client prendre toutes les places, ce qui est exactement l'inverse de
   * ce que ces deux reglages existent pour empecher. Le piege est silencieux : pg-boss ne se plaint pas, la
   * ligne de configuration a l'air pensee, et l'equite a disparu.
   *
   * ⚠️ La contrainte est STRICTE (`>=` refuse) et pas seulement `>` : a egalite, un client peut deja occuper
   * toutes les places, donc le groupe ne sert a rien.
   */
  if (c.AGENT_TURN_GROUP_CONCURRENCY >= c.AGENT_TURN_CONCURRENCY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENT_TURN_GROUP_CONCURRENCY'],
      message: `le plafond par espace (${c.AGENT_TURN_GROUP_CONCURRENCY}) doit etre STRICTEMENT inferieur au total en vol (${c.AGENT_TURN_CONCURRENCY}), sinon un seul client peut prendre toutes les places`,
    });
  }

  /**
   * 🔴 LES DEUX CHAÎNES DE CONNEXION DOIVENT DÉSIGNER LA MÊME BASE.
   *
   * `DATABASE_URL` (session, DDL, pg-boss) et `APP_DATABASE_URL` (transaction, pool applicatif) sont deux
   * MODES d'accès à une seule base : en production, le même hôte Supabase sur deux ports. Si leurs hôtes
   * diffèrent, l'une des deux est fausse, et le processus tourne alors à cheval sur DEUX bases sans le dire.
   *
   * Ce n'est pas une hypothèse : c'est arrivé le 2026-09-02, en montant un banc de charge. Le worker a été
   * lancé avec `DATABASE_URL` sur une base jetable, mais `APP_DATABASE_URL` est resté sur la PRODUCTION par
   * héritage du fichier d'environnement. Ses files tapaient donc la base jetable pendant que ses balayages
   * lisaient et écrivaient en production. Aucun dégât ce jour-là, par chance : il n'y avait aucune campagne
   * vivante à reprendre. Avec une campagne en cours, le balayage de reprise l'aurait relancée en `DRY_RUN`
   * et aurait marqué de VRAIS destinataires comme envoyés, sans qu'aucun message ne parte.
   *
   * La garde est volontairement sur l'HÔTE seul : le port et le mode diffèrent légitimement (5432 session,
   * 6543 transaction), l'hôte jamais.
   */
  if (c.DATABASE_URL !== '' && c.APP_DATABASE_URL !== '') {
    const hote = (url: string): string | null => {
      try { return new URL(url).hostname; } catch { return null; }
    };
    const a = hote(c.DATABASE_URL);
    const b = hote(c.APP_DATABASE_URL);
    if (a !== null && b !== null && a !== b) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_DATABASE_URL'],
        message: `DATABASE_URL et APP_DATABASE_URL désignent des hôtes DIFFÉRENTS (${a} vs ${b}). Ce sont deux modes d'accès à UNE base : des hôtes différents veulent dire que le process tournerait à cheval sur deux bases, ses files d'un côté et ses balayages de l'autre.`,
      });
    }
  }

  // Fail-fast en PRODUCTION si le secret JWT est faible/par défaut : sinon un déploiement
  // qui oublie AUTH_SECRET démarre sur une constante publique -> JWT admin forgeables
  // cross-tenant. En dev/test on tolère le défaut pour l'ergonomie.
  if (process.env.NODE_ENV === 'production') {
    // Sans base, le service crashe plus loin sur un ECONNREFUSED localhost:5432 avec une stack `pg` opaque qui
    // ne nomme jamais la variable manquante. Fail-fast ici = le message dit quoi corriger.
    if (c.DATABASE_URL === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'DATABASE_URL requis en production' });
    }
    // Sans secret d'app, `verifySignature` renvoie false d'entrée : le service DÉMARRE, /health répond ok, et
    // 100 % des webhooks Meta partent en 403 indéfiniment, sans une trace. Panne totale et silencieuse.
    if (c.META_APP_SECRET === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['META_APP_SECRET'], message: 'META_APP_SECRET requis en production (sans lui, 100 % des webhooks Meta sont rejetés en 403)' });
    }
    if (c.AUTH_SECRET === 'dev-insecure-change-me' || Buffer.byteLength(c.AUTH_SECRET) < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SECRET'],
        message: 'AUTH_SECRET requis en production (>= 32 octets aléatoires, pas le placeholder)',
      });
    }
    // OPS_TOKEN reste OPTIONNEL (vide -> /ops désactivé). Mais s'il EST défini en prod, il doit être fort :
    // un token faible sur une surface cross-tenant = fuite de données inter-clients.
    if (c.OPS_TOKEN !== '' && Buffer.byteLength(c.OPS_TOKEN) < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPS_TOKEN'],
        message: 'OPS_TOKEN, si défini en production, doit faire >= 32 octets aléatoires',
      });
    }
    // L'analyse activée sans clé/modèle LLM appellerait le provider à vide -> échecs en boucle. Fail-fast au boot.
    if (c.CONVERSATION_ANALYSIS_ENABLED === 'true') {
      if (c.LLM_API_KEY === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['LLM_API_KEY'], message: 'LLM_API_KEY requis quand CONVERSATION_ANALYSIS_ENABLED=true' });
      }
      if (c.LLM_MODEL === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['LLM_MODEL'], message: 'LLM_MODEL requis quand CONVERSATION_ANALYSIS_ENABLED=true (ex. claude-haiku-4-5)' });
      }
    }
    /**
     * 🔴 LA CLÉ DU GATEWAY SANS MODÈLE D'AGENT EST UN PIÈGE SILENCIEUX, et c'est pour ça que le boot refuse.
     *
     * Sans ces deux variables, le code retombe sur `LLM_MODEL`, qui est l'identifiant de l'ANALYSE de
     * conversation servie EN DIRECT par Anthropic (`claude-haiku-4-5` en production). Le Gateway, lui,
     * attend des identifiants préfixés par leur fournisseur (`zai/glm-4.7-flash`) : il refuserait chaque
     * appel. Rien ne le signalerait à la création d'un agent ; ça se verrait au premier vrai contact, sur une
     * conversation WhatsApp en cours. Poser la clé et oublier les modèles est l'erreur exacte qu'on ferait au
     * déploiement, donc elle est refusée ici plutôt que découverte là-bas.
     */
    if (c.AI_GATEWAY_API_KEY !== '') {
      if (c.AGENT_MODEL === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AGENT_MODEL'], message: 'AGENT_MODEL requis quand AI_GATEWAY_API_KEY est defini (identifiant du Gateway, ex. zai/glm-4.7-flash)' });
      }
      if (c.AGENT_SETUP_MODEL === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AGENT_SETUP_MODEL'], message: 'AGENT_SETUP_MODEL requis quand AI_GATEWAY_API_KEY est defini (identifiant du Gateway, ex. zai/glm-4.7)' });
      }
    }
    // Le push connecteur activé (URL posée) sans secret signerait avec une clé vide -> le connecteur refuserait tout (401).
    if (c.CONNECTOR_PUSH_URL !== '' && c.CONNECTOR_PUSH_SECRET === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CONNECTOR_PUSH_SECRET'], message: 'CONNECTOR_PUSH_SECRET requis quand CONNECTOR_PUSH_URL est défini' });
    }
    // Idem canal service (import de listes) : URL posée sans secret -> le connecteur refuserait tout (401).
    if (c.HUBSPOT_SERVICE_URL !== '' && c.HUBSPOT_SERVICE_SECRET === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HUBSPOT_SERVICE_SECRET'], message: 'HUBSPOT_SERVICE_SECRET requis quand HUBSPOT_SERVICE_URL est défini' });
    }
    // Zadarma : les deux moitiés vont ENSEMBLE. Une seule posée signerait avec une clé vide et Zadarma
    // répondrait « 401 Not authorized », qu'on mettrait sur le dos de clés pourtant valides.
    if ((c.ZADARMA_API_KEY === '') !== (c.ZADARMA_API_SECRET === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ZADARMA_API_SECRET'], message: 'ZADARMA_API_KEY et ZADARMA_API_SECRET se posent ensemble (ou aucun des deux)' });
    }
    // Provider RCS smsmode sans sa clé de canal : chaque envoi partirait en 401/403. Fail-fast au boot,
    // comme pour META_APP_SECRET, plutôt qu'une panne silencieuse découverte au premier envoi client.
    if (c.RCS_PROVIDER === 'smsmode' && c.SMSMODE_RCS_API_KEY === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMSMODE_RCS_API_KEY'], message: 'SMSMODE_RCS_API_KEY requis quand RCS_PROVIDER=smsmode' });
    }
    // Embedded Signup activé sans clé de chiffrement = tokens business stockables en clair OU crash au premier
    // onboarding. Fail-fast au boot : 64 hex exigés.
    if (c.META_ES_CONFIG_ID !== '' && !/^[0-9a-fA-F]{64}$/.test(c.ENCRYPTION_KEY)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY (64 hex) requise quand META_ES_CONFIG_ID est défini' });
    }
  }
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

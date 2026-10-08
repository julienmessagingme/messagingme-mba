import { z } from 'zod';
import { PLAFOND_DESTINATAIRES_DEFAUT } from './campaign/plafond';
import { PLAFOND_API_DEFAUT } from './auth/plafond-espace';
import { QUOTAS_API_DEFAUT } from './api/quotas';

/** Exporté pour les tests : `config` est parsé à l'import, donc inutilisable pour vérifier les fail-fast ;
 *  le schéma, lui, se parse à la demande. */
export const schema = z.object({
  PORT: z.coerce.number().default(8095),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  /** Token d'accès Meta pour l'envoi outbound (worker campaign-run). */
  META_ACCESS_TOKEN: z.string().default(''),
  /** Version Graph API pour les appels d'envoi. */
  META_GRAPH_VERSION: z.string().default('v25.0'),
  /** App ID Meta (public) : endpoint du resumable upload `/{appId}/uploads` (en-têtes média du carrousel). */
  META_APP_ID: z.string().default('988129420727963'),
  /**
   * Router le marketing par MM Lite (`/marketing_messages`). Défaut 'false' : endpoint standard `/messages`.
   * MM Lite exige un onboarding Business Manager, sans lui Meta rend 131042.
   */
  META_MM_LITE: z.string().default('false'),
  /** Configuration Embedded Signup (Facebook Login for Business) : l'id de configuration du dashboard Meta.
   *  Vide -> bouton « Connecter » inactif au front et route de complétion en 503 (feature OFF). */
  META_ES_CONFIG_ID: z.string().default(''),
  /**
   * Id de la seconde configuration Facebook Login for Business, celle des publicités (compte publicitaire et
   * Page). Vide -> écran « Publicités » inactif, avec sa raison.
   * Séparée de l'inscription WhatsApp : sinon on demanderait l'accès aux comptes publicitaires d'un client au
   * moment où il branche son numéro.
   */
  META_ADS_CONFIG_ID: z.string().default(''),
  /** Clé AES-256-GCM (64 hex = 32 octets) du chiffrement au repos des tokens business ES. Requise si ES activé. */
  ENCRYPTION_KEY: z.string().default(''),
  /**
   * Fournisseur des numéros du pool (Zadarma) : il reçoit l'appel de vérification de Meta, dont on transcrit
   * l'enregistrement pour capter l'OTP. Vides -> capture inerte, l'embarquement retombe sur la saisie manuelle.
   */
  ZADARMA_API_KEY: z.string().default(''),
  ZADARMA_API_SECRET: z.string().default(''),
  /** Pays par défaut pour normaliser les numéros à l'import CSV. */
  DEFAULT_COUNTRY: z.string().default('FR'),
  /** Secret HMAC de signature des JWT de session (login console). */
  AUTH_SECRET: z.string().default('dev-insecure-change-me'),
  /** Mode démo : le worker n'appelle PAS Meta, il marque les envois `sent` (message-id synthétique). */
  DRY_RUN: z.string().default('false'),
  /**
   * Débit par défaut (messages/minute) d'une campagne sans `ratePerMinute` explicite : lisse le burst et
   * protège la réputation du numéro. 0 (ou vide) = aucun frein.
   * Doit rester >= au plancher de pacing.ts (30), sinon `expireInSeconds` est sous-dimensionné ; en dessous,
   * pacing résout le même défaut via `resolveRatePerMinute`, donc l'estimation reste alignée sur le débit réel.
   */
  CAMPAIGN_DEFAULT_RATE_PER_MINUTE: z.coerce.number().int().min(0).max(80).default(30),
  /**
   * Plafond de débit des routes authentifiées, par utilisateur et par minute (clé `userId`, posée dans
   * `makeRequireAuth`). 300 est très large pour un humain : on borne le coût qu'un compte peut infliger à
   * Postgres, on ne rationne pas l'usage normal.
   * 0 désactive : c'est le levier d'urgence si un mauvais calibrage coupe la console de tous les clients
   * (remettre à 0 puis `compose up -d --force-recreate` va plus vite qu'un déploiement).
   */
  RATE_LIMIT_USER_PAR_MINUTE: z.coerce.number().int().min(0).default(300),
  /**
   * Plafond des routes coûteuses (import CSV, action en masse, purge, export d'historique, lancement de
   * campagne), par espace et par minute, en plus du plafond général. Clé `tenantId` et non `userId` : on borne
   * la charge d'un espace sur Postgres, et un espace à dix comptes aurait sinon dix fois le plafond. Compté au
   * TOTAL des copies de l'API (compteur partagé, migration 0186), contrairement au plafond par utilisateur.
   * 0 désactive.
   */
  RATE_LIMIT_COUTEUX_PAR_MINUTE: z.coerce.number().int().min(0).default(10),
  /**
   * Les deux bornes réglables des champs personnalisés, très au-dessus de l'usage réel mesuré.
   * `API_MAX_CHAMPS_PAR_ESPACE` ne borne que le webhook entrant et la création à la main (l'API publique ne
   * crée aucun champ) ; 0 le désactive. `API_MAX_CLE_CHAMP` borne la forme d'un corps : pas de sens à 0.
   * Le nombre de champs par fiche est une constante du code (`MAX_PAR_FICHE*`, `src/api/contacts-upsert.ts`) :
   * la doc publique l'affiche, une variable le ferait mentir en silence.
   */
  API_MAX_CLE_CHAMP: z.coerce.number().int().min(1).default(64),
  API_MAX_CHAMPS_PAR_ESPACE: z.coerce.number().int().min(0).default(200),
  /**
   * Provider du canal RCS. `fake` = provider factice : le canal est complet de bout en bout (campagne, bloc de
   * scénario, joignabilité, opt-out) mais rien ne part vers un opérateur. `smsmode` = l'opérateur réel. Une
   * valeur inconnue est refusée au boot.
   */
  RCS_PROVIDER: z.enum(['fake', 'smsmode']).default('fake'),
  /** Clé du canal RCS smsmode (pas celle du compte : une clé est rattachée à un canal, et une clé de canal
   *  SMS répond 403 « Channel type mismatch » sur l'API RCS). Secret serveur. */
  SMSMODE_RCS_API_KEY: z.string().default(''),
  /** URL publique qui reçoit les rapports de livraison smsmode. Vide -> aucun rapport, donc la sortie
   *  « non joignable » du bloc reste muette. */
  SMSMODE_CALLBACK_STATUS_URL: z.string().default(''),
  /** URL publique qui reçoit les réponses entrantes (MO) smsmode. */
  SMSMODE_CALLBACK_MO_URL: z.string().default(''),
  /** URL du pooler Supabase mode session (port 5432). Sert au pg-boss du WORKER (l'API empile par son pool
   *  applicatif, cf. `PgBossQueue`) et, par défaut, au pool applicatif si APP_DATABASE_URL est vide. Les scripts
   *  CLI (db/migrate.ts, db/seed.ts) lisent cette variable en direct, jamais APP_DATABASE_URL : DDL et seed
   *  passent toujours en mode session. */
  DATABASE_URL: z.string().default(''),
  /**
   * URL du pooler Supabase mode transaction (port 6543) pour le pool applicatif (tous les stores, API +
   * worker), qu'elle sort du budget des sessions partagé avec mm-hubspot. Vide -> repli sur DATABASE_URL.
   * Le pg-boss du WORKER reste obligatoirement sur DATABASE_URL : son écoute, sa supervision et sa migration ne
   * survivent pas au transaction pooling (le pooler réassigne le backend entre transactions). Celui de l'API,
   * qui ne fait qu'empiler, passe par ce pool : ses instructions sont autonomes (un `insert`, ou un bloc
   * `BEGIN; ...; COMMIT;` envoyé d'un seul message). Sûr pour mba, indépendant du search_path (tables en public,
   * mmhs toujours qualifié) et dont les transactions passent par un client dédié.
   */
  APP_DATABASE_URL: z.string().default(''),
  PGBOSS_SCHEMA: z.string().default('pgboss'),
  /**
   * Taille du pool applicatif (mode transaction, `APP_DATABASE_URL`), instancié PAR PROCESS. 🔴 CHAQUE SERVICE
   * LA FIXE dans `docker-compose.yml`, et ce défaut n'est qu'un repli : la SOMME des pools de tous les
   * processus doit tenir dans le pool du pooler de Supabase, sans quoi l'attente passerait de notre pool, borné
   * par `DB_CONN_TIMEOUT_MS` et visible dans `/ops`, à celle de Supavisor, qui est muette (au-delà, la latence
   * double sans erreur). Ce budget, mesuré, et sa règle par copie : `tests/budget-pooler.test.ts`, qui refuse un
   * compose qui le dépasse. Ajouter une copie d'API se paie donc ici, AVANT de la lancer.
   * Côté API, ce pool porte AUSSI les enfilements (pg-boss l'emprunte), dont l'accusé des webhooks de Meta :
   * une attente ici est une attente de la réception, et `mesureAttentePool` la voit.
   */
  DB_POOL_MAX: z.coerce.number().default(8),
  /** Max de connexions du pool pg-boss du WORKER, resté en mode session : c'est lui qui vit dans le budget des
   *  sessions du pooler, partagé avec mm-hubspot (PGBOSS_MAX par worker plus l'écoute des notifications, plus
   *  les sessions de mm-hubspot ; le calcul et sa borne : `tests/budget-pooler.test.ts`). L'API ne le lit plus : elle n'ouvre aucun pool pg-boss,
   *  donc le nombre de ses copies ne compte pas dans ce budget.
   *  Ne pas le relever sans refaire l'arithmétique de ce budget. */
  PGBOSS_MAX: z.coerce.number().default(2),
  /**
   * Timeout d'acquisition d'une connexion du pool (ms). Le défaut `pg` est une attente illimitée : pool saturé,
   * la requête HTTP ne répond jamais, sans trace. On préfère un échec net que le setErrorHandler journalise.
   * 0 = attente illimitée (à éviter).
   */
  DB_CONN_TIMEOUT_MS: z.coerce.number().default(8000),
  /**
   * Les adresses qui ouvrent la surface d'exploitation `/ops`, séparées par des virgules. Chacune se connecte
   * avec son compte habituel ET son second facteur, et reçoit une session d'exploitation nominative
   * (`src/auth/routes.ts`). Vide = `/ops` fermé pour tous, le bon défaut. La liste est lue au DÉMARRAGE et
   * comparée à chaque requête de `/ops` : retirer une adresse demande un `--force-recreate`, puis coupe son accès
   * sans attendre la fin de sa session.
   * 🔴 Une entrée qui n'a pas la forme d'une adresse est refusée au chargement : une faute de frappe (un `;` à
   * la place d'une virgule) fermerait l'accès sans rien dire.
   */
  OPS_EMAILS: z.string().default('').refine(
    (v) => v.split(',').map((a) => a.trim()).filter((a) => a !== '').every((a) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(a)),
    { message: 'OPS_EMAILS : des adresses séparées par des virgules' },
  ),
  /** Alerte Telegram du worker (erreurs pg-boss, échecs de balayage). Lue dans l'environnement : le conteneur
   *  worker n'a pas accès au config.json de l'hôte utilisé par les crons ops. Vide -> aucune alerte. */
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  /**
   * LE ROLE DE CE WORKER : quelles files il consomme et quelles minuteries il programme
   * (`src/worker/roles.ts`). `all` est le DEFAUT et reproduit EXACTEMENT le comportement d un worker unique,
   * donc un deploiement qui ne pose pas cette variable ne change rien : on livre le code, puis on decoupe.
   * 🔴 CHAQUE ROLE TOURNE EN UN SEUL EXEMPLAIRE (min=1, max=1). `groupConcurrency` est local au processus
   * pg-boss : deux copies d un meme role doubleraient le plafond par espace et dedoubleraient les minuteries.
   */
  WORKER_ROLE: z.enum(['principal', 'analyse', 'all']).default('all'),
  /**
   * LE NOM DE CETTE COPIE DE L'API dans `/ops` (attentes de pool) et dans ses alertes Telegram. Vide (défaut) =
   * `api`, le nom d'une copie unique, donc rien ne change tant qu'on n'en lance pas une seconde ; renseigné =
   * `api-<copie>`. Sans lui, deux copies s'additionnent dans la même courbe d'attentes, et une alerte ne dit pas
   * de laquelle elle vient. Même rôle que `nomDuProcessus` pour les workers.
   */
  API_COPIE: z.string().regex(/^[a-z0-9-]{0,20}$/).default(''),
  /** Cadence du heartbeat worker (ms). Défaut 20 s : écriture négligeable pour le pooler, assez fine pour
   *  qu'un worker mort dépasse vite le seuil d'âge côté /ops. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(20_000),
  /**
   * Compteur par clé, qui ne sert plus qu'au relais du Meta Business Agent : requêtes par clé et par fenêtre
   * (en mémoire, par process). Les autres clés sont comptées par espace (`API_PLAFOND_*`). La fenêtre sert
   * aussi au budget spéculatif (`API_KEY_PREFILTRE_MAX`).
   */
  API_KEY_RATE_LIMIT_MAX: z.coerce.number().default(60),
  API_KEY_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  /**
   * Plafond de l'API publique par espace, commun à toutes ses clés, `/v1` et `/mcp` confondus : appels par
   * minute et par heure, les deux s'appliquent. Valeurs des espaces sans réglage propre
   * (`tenant_settings.api_plafond_*`, route `/ops/plafond-api/:tenantId`).
   * 0 désactive la fenêtre pour les espaces sans réglage (levier d'urgence) ; un réglage d'espace, toujours
   * > 0, reste appliqué. Compté au TOTAL des copies de l'API (compteur partagé, migration 0186). Il compte des appels,
   * le travail (fiches d'un lot, destinataires) est mesuré à part (`usage-guard.ts`).
   */
  API_PLAFOND_MINUTE: z.coerce.number().int().min(0).default(PLAFOND_API_DEFAUT.minute),
  API_PLAFOND_HEURE: z.coerce.number().int().min(0).default(PLAFOND_API_DEFAUT.heure),
  /**
   * Les quotas QUOTIDIENS par espace de l'API publique (décision de Julien du 2026-10-04, `src/api/quotas.ts`) : les
   * envois (destinataires et messages libres) et les fiches écrites, par jour civil de Paris. Un réglage d'espace
   * (`/ops/plafond-api`, migration 0208) l'emporte. `0` le désactive pour tous : le levier d'urgence, sans déployer.
   */
  API_QUOTA_ENVOIS_JOUR: z.coerce.number().int().min(0).default(QUOTAS_API_DEFAUT.envois),
  API_QUOTA_FICHES_JOUR: z.coerce.number().int().min(0).default(QUOTAS_API_DEFAUT.fiches),
  /**
   * Pré-filtre des clés d'API : ce qu'un porteur non résolu peut coûter, par minute.
   * Le plafond ci-dessus ne compte que des clés résolues : sans ce budget, chaque fausse clé coûte un SHA-256
   * et une requête Postgres sur le pool de la copie, partagé avec la console et la réception des webhooks.
   * Global et non par clé : un compteur par empreinte ne freine rien (trente fausses clés, trente compteurs
   * à 1). Une empreinte déjà résolue n'y est plus soumise, donc 30 est très large. 0 le désactive.
   */
  API_KEY_PREFILTRE_MAX: z.coerce.number().int().min(0).default(30),
  /**
   * Nombre d'opérations lourdes de l'API publique (lot de contacts, création d'envoi) en vol en même temps.
   * 0 désactive.
   * Un, et le chiffre se calcule : le pool de l'API (`DB_POOL_MAX` de `mba-api`) sert tout le process, et un lot
   * en prend jusqu'à `ECRITURES_EN_VOL`. Que le pool reste plus grand que ce qu'en prennent les opérations
   * lourdes est tenu par `tests/budget-pooler.test.ts`. Saturer le pool ferait attendre la console et la
   * réception des webhooks de Meta : le travail d'un intégrateur ne doit jamais prendre tout le pool.
   * La place est globale au process, tous clients confondus (un autre espace reçoit 429, `Retry-After: 2`) :
   * un plafond par espace ne protégerait pas un pool partagé.
   * Le limiteur de débit n'en protège pas (fenêtre fixe, 60 requêtes peuvent tomber dans la même
   * milliseconde). Relever ce nombre demande de refaire l'arithmétique du pool.
   */
  API_MAX_LOURDES_SIMULTANEES: z.coerce.number().int().min(0).default(1),
  /**
   * Jours de conservation des événements Meta bruts (`webhook_events`), qui portent le texte des messages
   * entrants et le numéro de qui écrit. 30 jours : bien au-delà de la fenêtre d'idempotence et du débogage
   * d'un incident. 0 désactive la purge, et la table croît alors sans fin.
   */
  WEBHOOK_EVENTS_RETENTION_DAYS: z.coerce.number().default(30),
  /**
   * Jours de conservation des conversations (et, par cascade, de leurs messages et de leur analyse).
   * Une décision, pas une règle RGPD : le RGPD ne fixe aucune durée (article 5.1.e, « pas plus longtemps que
   * nécessaire ») et le responsable de traitement est le client. Le stockage n'entre pas dans ce choix.
   * 🔴 La purge efface l'analyse en cascade : le worker écrit les agrégats `analyse_jour` avant de purger, et
   * la purge est suspendue tant qu'ils ne sont pas à jour. Sans eux, la Synthèse se viderait avec l'Inbox.
   * Réglable par espace (`tenant_settings.conversation_retention_days`) : ceci est le défaut de l'instance.
   * 0 désactive la purge : conversations et analyses (texte libre tiré de ce que la personne a raconté) sont
   * alors gardées pour toujours.
   */
  CONVERSATION_RETENTION_DAYS: z.coerce.number().default(90),
  /**
   * Rétentions de quatre tables qui grossissaient sans fin. 0 = balayage désactivé pour la table.
   * Celles qui portent un `wa_id` (événements de blocs, parcours) ont une rétention courte : la donnée
   * personnelle n'a plus de raison d'être. Les autres (clics, journal d'audit) ont une rétention longue :
   * elles ne posent qu'une question de volume et servent de mesure ou de preuve.
   */
  /** Anonymisation (pas suppression) du `wa_id` des événements de blocs : les compteurs restent justes. */
  NODE_EVENTS_ANONYMISATION_DAYS: z.coerce.number().default(365),
  /** Suppression des parcours terminés (`done`, `inbox`). Les parcours vivants ne sont jamais touchés. */
  WORKFLOW_RUNS_RETENTION_DAYS: z.coerce.number().default(90),
  /** Suppression des clics tracés (jamais des liens : `/r/<code>` est une porte à sens unique). */
  TRACKED_CLICKS_RETENTION_DAYS: z.coerce.number().default(730),
  /** Suppression des entrées du journal d'audit. Longue : c'est la preuve qu'une purge a eu lieu. */
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().default(730),
  /**
   * Suppression des échecs d'avance de scénario. Courte, à l'opposé du journal d'audit :
   * c'est de l'exploitation, on s'en sert dans les jours qui suivent la panne ou jamais.
   */
  AVANCE_ECHECS_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  /**
   * Suppression des agrégats d'attente du pool. Courte : une ligne par minute et par process,
   * et on regarde une courbe de quelques heures, jamais de quelques mois.
   */
  POOL_ATTENTES_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  /**
   * Plafond d'envois par minute et par numéro, tous chemins confondus (campagne, scénario, automation,
   * réponse d'inbox), cf. `src/meta/arbitre-debit.ts`. 80 = le débit maximum qu'une campagne peut choisir à
   * l'écran : il ne bride jamais une campagne seule, il empêche deux campagnes du même numéro d'en faire 160
   * et fait payer les envois d'inbox et de scénario sur le même budget.
   * WhatsApp seulement : le RCS a le sien (`RCS_RATE_PER_MINUTE_MAX`), choisi par `plafondDuCanal` ; lire
   * celui-ci pour brider autre chose qu'un numéro Meta serait faux. Au-delà de ce que Meta tolère pour le
   * palier du numéro, Meta répond 130429 et la campagne se met en pause.
   * 0 retire le frein, à n'utiliser que pour reproduire un incident.
   */
  PHONE_RATE_PER_MINUTE_MAX: z.coerce.number().default(80),
  /**
   * Plafond de débit du canal RCS, en messages par minute. 60 est un point de départ, pas une mesure :
   * smsmode ne publie aucun chiffre. En configuration pour se corriger sans déploiement, jamais recopié en
   * dur. Sans rapport avec PHONE_RATE_PER_MINUTE_MAX, qui vient de Meta.
   */
  RCS_RATE_PER_MINUTE_MAX: z.coerce.number().int().min(0).max(600).default(60),
  /**
   * Plafond de rappels smsmode par minute et par code d'URL (`/rcs/callback/:code`). 0 le désactive.
   * Calculé sur le débit d'envoi (écart tenu par un test) : jusqu'à trois accusés par message plus les
   * réponses, soit 1 800 rappels par minute au débit maximal (`RCS_RATE_PER_MINUTE_MAX` borné à 600) ;
   * 3 000 laisse la marge d'une rafale. Le calcul tient parce qu'un seul run de campagne tourne à la fois par
   * espace (`campaign-run` en `groupConcurrency: 1` par `tenantId`). Les envois RCS d'un scénario sont hors de
   * ce débit, absorbés par la marge. Un refus est un 429 que smsmode rejoue : un accusé retardé, pas perdu.
   */
  RCS_CALLBACK_PAR_MINUTE: z.coerce.number().int().min(0).default(3000),
  /**
   * Codes d'URL jamais vus que `/w/:code`, `/rcs/callback/:code` et `/widget/:code.js` acceptent d'aller lire en
   * base, par minute et par porte, tous appelants confondus. 0 le désactive.
   * Borne les codes inventés : chacun coûtait une lecture sur le pool partagé avec la console et la réception
   * des messages. Un code déjà résolu par ce process n'y est plus soumis (`ClesResolues`).
   * Prix assumé : un vrai code pas encore servi depuis le démarrage consomme ce budget, et attend la minute
   * suivante quand il est épuisé (429 avec `Retry-After` ; pour le widget, le script inerte sans cache, donc une
   * bulle absente), y compris hors attaque (plus de 120 codes réels différents juste après un redémarrage). Un
   * budget épuisé se journalise au plus une fois par minute : le relever si ce message apparaît hors attaque.
   * `/r/:code` et `/m/:code` n'ont pas ce frein : leurs codes réels sont très nombreux et cliqués en rafale
   * pendant une campagne, un tel budget y refuserait des clics réels.
   */
  CODES_INCONNUS_PAR_MINUTE: z.coerce.number().int().min(0).default(120),
  /**
   * Plafond de destinataires d'une campagne : un garde-fou contre l'envoi accidentel, pas un objectif. En
   * configuration pour se relever sans redéploiement. Règle et message : `src/campaign/plafond.ts`.
   */
  CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().int().min(1).default(PLAFOND_DESTINATAIRES_DEFAUT),
  /**
   * Tours d'agent en vol, et plafond par espace. Le défaut de pg-boss (`localConcurrency: 1`) traiterait un
   * tour à la fois pour toute la flotte.
   * 12 est sûr par arithmétique : un tour passe l'essentiel de son temps à attendre le modèle sans tenir de
   * connexion (`pool.query` prend et rend la connexion par instruction), donc douze tours ne réservent pas
   * douze connexions du pool de 8. Ce serait faux le jour où un tour ouvrirait une transaction autour de
   * l'appel au modèle.
   * Quatre par espace, pour qu'un client bavard ne prenne pas les douze places. Les deux vont ensemble :
   * `groupConcurrency` est un no-op tant que `concurrency` vaut 1. Point de départ prudent, en configuration.
   */
  AGENT_TURN_CONCURRENCY: z.coerce.number().int().min(1).default(12),
  AGENT_TURN_GROUP_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /** Clé API Resend pour le formulaire de support. Vide -> support indisponible (503, pas de crash). */
  RESEND_API_KEY: z.string().default(''),
  /** Expéditeur des emails de support. `onboarding@resend.dev` marche sans domaine vérifié (mode test :
   *  n'envoie qu'à l'adresse du compte Resend). Domaine vérifié -> `support@messagingme.app`. */
  SUPPORT_FROM: z.string().default('onboarding@resend.dev'),
  /** Destinataire des messages du formulaire de support. Vide -> support indisponible (503). */
  SUPPORT_TO: z.string().default(''),
  /** Client OAuth Google (public) pour « se connecter avec Google ». Vide -> bouton Google masqué (pas de crash). */
  GOOGLE_CLIENT_ID: z.string().default(''),
  /**
   * URL publique du front. Base des liens envoyés par e-mail (invitation `/invite/<jeton>`, réinitialisation
   * `/reset/<jeton>`), qui sont des pages de la console, pas des routes d'API.
   */
  APP_URL: z.string().default('https://mba.messagingme.app'),
  /**
   * URL publique de l'API quand elle est servie sous son propre nom. Base des adresses que le produit
   * distribue et que l'API sert : liens tracés `/r/<code>`, visuels RCS `/m/<fichier>`, webhook entrant
   * `/w/<code>`. `APP_URL` reste la base des liens d'e-mail (pages du front) : une seule variable pour les
   * deux enverrait soit les e-mails vers l'API, soit les liens tracés par le front.
   * Vide par défaut : tout retombe alors sur `APP_URL`, au caractère près, pour que son oubli ne casse pas
   * des adresses déjà parties dans des messages.
   */
  PUBLIC_API_URL: z.string().default(''),
  /**
   * Origines autorisées à appeler cette API depuis un navigateur, séparées par des virgules.
   * Ex. `https://engageme.messagingme.app,https://mba.messagingme.app`.
   * Vide = aucun en-tête CORS, le défaut voulu : ils n'apparaissent que pour une origine inscrite ici.
   * 🔴 Jamais `*` (refusé ici, au chargement) : l'étoile laisserait n'importe quel site faire faire des
   * requêtes au navigateur d'un client connecté. Pourquoi jamais `credentials` : `src/server.ts`.
   */
  CORS_ORIGINS: z.string().default('').refine(
    (v) => !v.split(',').map((o) => o.trim()).includes('*'),
    { message: 'CORS_ORIGINS: `*` est refusé, il faut une liste blanche d’origines' },
  ),
  /** Analyse de conversation : inerte par défaut. 'true' -> le worker analyse les conversations closes. */
  CONVERSATION_ANALYSIS_ENABLED: z.string().default('false'),
  /** Cadence du garde-fou qui rend la main au scénario quand plus personne ne s'occupe d'une conversation. */
  CONTROL_SWEEP_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  /** Cadence du balayage de statut/qualité des numéros Meta. Défaut 20 min : 2 GET Graph par numéro et par
   *  passage, assez large pour ne pas peser sur le rate-limit tant que le parc reste petit. */
  PHONE_STATUS_SWEEP_INTERVAL_MS: z.coerce.number().default(20 * 60 * 1000),
  /** Inactivité au bout de laquelle un fil tenu par un opérateur lui est repris (vers l'agent de Meta s'il
   *  est allumé, sinon vers le scénario). 2 h : une pause déjeuner ne coupe pas un échange, un onglet fermé ne
   *  gèle pas le contact jusqu'au lendemain. Meta n'a aucun release automatique : ce délai est notre seule
   *  soupape. 0 désactive la reprise. Réglable par client (`tenant_settings`), contrairement à
   *  `CONTROL_MBA_TIMEOUT_MS` et `CONTROL_WORKFLOW_TIMEOUT_MS` (constantes, en fin de fichier).
   *  C'est aussi le filet de la remise à l'agent de Meta : la fin d'un parcours laisse le fil en `app_human`
   *  en attendant l'accusé de son dernier envoi, et si l'accusé n'arrive jamais, ce délai rend le fil. À 0
   *  chez un client qui a l'agent allumé, ce rattrapage disparaît aussi. */
  CONTROL_HUMAN_TIMEOUT_MS: z.coerce.number().default(2 * 60 * 60 * 1000),
  /** Plafond par défaut de déclenchements par heure, pour une automation sans `maxFiresPerHour` propre
   *  (`src/automation/runner.ts` lit d'abord celui de l'automation). L'anti-rebond est par (automation,
   *  contact) et ne borne rien à l'échelle d'une population : une campagne qui rouvre l'analyse de tous ses
   *  destinataires peut produire des milliers d'événements. 200/h borne une erreur de configuration en
   *  incident plutôt qu'en facture. 0 = pas de plafond. */
  AUTOMATION_MAX_FIRES_PER_HOUR: z.coerce.number().default(200),
  /** Clé API du provider LLM. Vide -> analyse non activable (fail-fast prod si ENABLED). */
  LLM_API_KEY: z.string().default(''),
  /** Id de modèle LLM (ex. claude-haiku-4-5 pour ce classifieur haut-volume). À fixer au déploiement, jamais
   *  d'id daté figé en dur. Vide -> analyse non activable. */
  LLM_MODEL: z.string().default(''),
  /**
   * Cle du Vercel AI Gateway, pour l agent IA et son assistant de construction. Vide -> la conversation de
   * construction repond 503 (indisponible), aucun crash : meme patron que RESEND_API_KEY.
   */
  AI_GATEWAY_API_KEY: z.string().default(''),
  /**
   * Modèle de transcription des vocaux entrants. `whisper-1` : un quart de centime pour un vocal de 30 s, et
   * il détecte la langue seul. Vide -> la route de transcription rend 503.
   * Plafond en taille, pas en durée : la durée n'est connue qu'après avoir téléchargé et payé la
   * transcription, alors que Meta annonce la taille avant. 2 Mo couvrent largement trois minutes de vocal
   * (opus ~16 kbit/s) et bornent la mémoire (fichier entier en RAM, puis en base64).
   */
  TRANSCRIPTION_MODELE: z.string().default('openai/whisper-1'),
  /**
   * Plafond d'une pièce jointe reçue qu'on accepte de servir à la console, distinct de celui de la
   * transcription (Meta accepte 5 Mo par image, 16 Mo par vidéo, 100 Mo par document). 25 Mo couvrent
   * l'usage courant et bornent la mémoire : le fichier entre entier en RAM. Au-delà, l'écran le dit.
   */
  MEDIA_ENTRANT_TAILLE_MAX_KO: z.coerce.number().int().positive().default(25_600),
  /**
   * Jeton d'API Vercel autorisé à créer des clés AI Gateway, et l'équipe où les créer.
   * 🔴 Bien plus dangereux que `AI_GATEWAY_API_KEY`, qui ne sait que dépenser sous un plafond : celui-ci
   * fabrique des clés facturées à l'équipe. La parade est le plafond d'équipe posé chez Vercel, à poser
   * avant de renseigner cette variable.
   * Les deux vides -> provisionnement éteint, tout le monde sur la clé maison. Allumé, créer un agent exige
   * une clé : le bac à sable appelle vraiment le modèle, un client le mettrait sinon au point sur notre argent.
   */
  VERCEL_API_TOKEN: z.string().default(''),
  VERCEL_TEAM_ID: z.string().default(''),
  /**
   * Modèle de l'IA de construction, à ne pas confondre avec celui d'un agent. Celle-ci tourne rarement
   * (reglage et optimisation) et joue le role le plus dur : elle merite un modele plus fort que le runtime.
   * Vide -> repli sur LLM_MODEL.
   */
  AGENT_SETUP_MODEL: z.string().default(''),
  /**
   * Modèle du bot d'aide de la console. Séparé des deux autres : il répond à quelqu'un qui attend devant son
   * écran, sans outil, sur trois fiches courtes, donc un modèle rapide et bon marché suffit.
   * 🔴 Sur notre clé, pas sur le crédit du client : facturer quelqu'un pour apprendre le produit se retourne
   * contre nous. Vide -> la route d'aide répond 503, jamais un repli muet.
   */
  AGENT_AIDE_MODEL: z.string().default(''),
  /**
   * Modèle de traduction des conversations.
   * 🔴 Sur le crédit prépayé du client, contrairement au bot d'aide : la traduction sert ses conversations.
   * Le client de modèle est donc celui qui porte le résolveur de clé par espace (`gateway`), jamais
   * `gatewayAide`. Un modèle rapide suffit (jusqu'à quarante traductions par ouverture de fil).
   * Vide -> traduction éteinte : le fil sort en VO avec son drapeau et le bouton sortant refuse en 422.
   */
  TRADUCTION_MODELE: z.string().default(''),
  /**
   * Modèle qui lit les images jointes à la conversation de construction, séparé de `AGENT_SETUP_MODEL` :
   * `zai/glm-4.7`, le modèle d'entretien, refuse une part `image_url` avec un 400 au corps vide. Vide -> les
   * images sont refusées explicitement (les documents passent, ils n'ont besoin d'aucun modèle).
   * Vérifié bon : `google/gemini-2.5-flash`.
   */
  AGENT_VISION_MODEL: z.string().default(''),
  /**
   * Modèle donné à un agent neuf, celui qui tourne à chaque message d'un contact.
   * Il ne doit pas retomber sur `LLM_MODEL` : celui de l'analyse est servi en direct par Anthropic, alors que
   * l'agent passe par le Vercel AI Gateway, dont les identifiants sont préfixés par le fournisseur
   * (`zai/glm-4.7-flash`). Avec l'identifiant de l'analyse, chaque tour échouerait sans rien signaler à la
   * création. Vide -> repli sur `LLM_MODEL`, qui reste faux : à poser au déploiement.
   */
  AGENT_MODEL: z.string().default(''),
  /**
   * Modèle qui vectorise les fiches de connaissance et les questions, choisi par la mesure en français
   * (bonne fiche en premier 6 fois sur 6, sans mot commun entre la question et la fiche).
   * Sa dimension (1536) est celle de la colonne : en changer oblige à recalculer les vecteurs de tous les
   * clients. Vide -> aucune vectorisation, la recherche retombe sur le plein texte seul.
   */
  AGENT_EMBED_MODEL: z.string().default('cohere/embed-v4.0'),
  /**
   * Seuil de pertinence du reranker : en dessous, la fiche n'est pas montrée au modèle. 0,06 est le milieu de
   * l'écart mesuré sur un petit corpus (vraies questions de 0,0817 à 0,3662, hors-sujet plafonné à 0,0409) :
   * un point de départ, en configuration pour être re-mesuré sur de vraies bases.
   */
  AGENT_RERANK_SEUIL: z.coerce.number().min(0).max(1).default(0.06),
  /**
   * Taux euros par dollar, pour convertir ce que le Gateway facture (en dollars) vers nos compteurs en
   * micro-euros. Paramètre commercial, pas un cours en temps réel : la marge absorbe la variation. Un taux
   * à 0 retombe sur 1 plutôt que de rendre toute consommation gratuite (`src/agent/devise.ts`).
   */
  EUR_PER_USD: z.coerce.number().positive().default(0.92),
  /**
   * Ce que nous acceptons de dépenser par espace et par mois calendaire pour les assistants de configuration
   * (MBA et agents IA), en euros.
   * 🔴 C'est notre argent : les deux assistants passent par la clé maison, rien d'autre ne borne leur dépense.
   * Le plafond d'équipe Vercel n'est pas ce garde-fou : il coupe tous les projets du Gateway, bots clients en
   * production compris. Par espace et pas par assistant, sinon notre exposition suivrait le nombre d'agents,
   * que le client contrôle. Environ un centime le tour, une trentaine par setup : 2 € valent environ 200
   * tours par mois. 0 désactive le plafond (levier d'urgence).
   */
  ASSISTANT_PLAFOND_EUROS_MOIS: z.coerce.number().min(0).default(2),
  /**
   * Le crédit offert au PREMIER numéro WhatsApp d'un espace que Meta dit VÉRIFIÉ, en micro-euros (1 000 000 = 1 €, pour
   * toutes les origines depuis le lot 6, décision de Julien du 2026-10-07),
   * avec un mouvement `offert`. Aucune clé Vercel n'est ouverte à ce moment (elle s'ouvre au premier usage qui en a
   * besoin). 0 l'éteint.
   *
   * 🔴 LA PREUVE EST LA VÉRIFICATION DE META, ET LA BORNE EST EN BASE (décision de Julien du 2026-09-29). Offert à la
   * création d'un espace, sans preuve, il se récoltait par script : chaque espace ouvrait une clé facturée à NOTRE
   * équipe Vercel, et une vingtaine atteignaient le plafond d'équipe, qui coupe les bots de tous les clients.
   * ⚠️ RELIER un numéro ne prouve PAS sa vérification : la liaison se fait avant que Meta ne la confirme, et un numéro
   * `NOT_VERIFIED` se relie très bien (ce commentaire affirmait l'inverse, et l'offre partait à la liaison). La route
   * de l'inscription n'offre donc que si Meta dit le numéro vérifié ; sinon c'est l'activation, dès que Meta accepte
   * le code (`src/http/embedded-signup.ts`). `credits_offerts` n'offre qu'une fois par espace, et jamais deux fois
   * pour le même numéro, ni par son identifiant Meta (0191) ni par son numéro affiché (0193), même s'il change
   * d'espace. Les espaces qui avaient déjà un numéro sont marqués par la migration : pas rétroactif.
   */
  CREDIT_OFFERT_MICRO_EUR: z.coerce.number().int().min(0).default(1_000_000),
  /**
   * La recharge du crédit par Stripe (Checkout hébergé, puis webhook). Les quatre vides par défaut : la route de
   * paiement rend 503 et la console dit « recharge pas encore disponible », rien ne casse au démarrage.
   * 🔴 Côté serveur uniquement, jamais en `NEXT_PUBLIC_`. `STRIPE_SECRET_KEY` est une clé RESTREINTE (sessions
   * Checkout et clients en écriture ; prix et factures en lecture : la route relit le prix avant d'ouvrir un
   * paiement, et le lien « Facture » lit la facture d'un achat) ; son
   * préfixe dit le mode (`_test_` ou `_live_`), et le client Stripe d'un espace est gardé PAR MODE (migration 0191).
   * En mode test, seul un exploitant (`OPS_EMAILS`) peut ouvrir un paiement : une carte de test créditerait sinon de
   * vrais euros de modèle à n'importe quel client, et le webhook refuse un événement d'un autre mode que la clé.
   * `STRIPE_WEBHOOK_SECRET` est le secret de signature de la destination déclarée chez Stripe (`whsec_...`). En
   * production, la clé et le secret se posent ensemble ou pas du tout (garde plus bas).
   * Les deux prix sont les identifiants Stripe (`price_...`) des offres Refill 50 € et Refill 100 € HT : le crédit
   * accordé de chaque offre vit dans le code (`src/stripe/offres.ts`), jamais dans la requête du client.
   */
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PRIX_REFILL_50: z.string().default(''),
  STRIPE_PRIX_REFILL_100: z.string().default(''),
  /**
   * Le prix mensuel du numéro fourni (lot 3c, livraison B) : 3,50 EUR HT par mois, taxe en sus, relu chez Stripe avant
   * chaque paiement. Vide : l'abonnement n'est pas en vente (la route rend 503).
   */
  STRIPE_PRIX_NUMERO: z.string().default(''),
  /**
   * Les prix du Pro (lot 6, livraison B1) : 49 € HT par mois et 490 € HT par an, taxe en sus, relus chez Stripe avant
   * chaque paiement (`PRIX_PRO_HT_CENTIMES`, `src/offres/offres.ts`). Posés ensemble ou pas du tout (garde plus bas) ; vides :
   * le Pro n'est pas en vente, la route rend 503 et la page de l'offre renvoie au Support.
   */
  STRIPE_PRIX_PRO_MOIS: z.string().default(''),
  STRIPE_PRIX_PRO_AN: z.string().default(''),
  /**
   * Les numéros fournis (lot 3a, `src/otp/`). 🔴 Côté serveur uniquement.
   * `DIDWW_API_KEY` : la clé d'API DIDWW de PRODUCTION, limitée à l'adresse du VPS. Elle ne sert qu'à retrouver un
   * numéro et à le brancher sur le trunk de l'Asterisk (`DIDWW_TRUNK_OTP_ID`), jamais à acheter, bien qu'elle le
   * puisse : c'est Julien qui achète. Vide : déclarer un numéro dans /ops rend 503.
   * `OTP_PONT_SECRET` : le secret partagé avec le script de l'Asterisk, qui signe chaque enregistrement au format
   * `x-mm-service-signature` (`src/lib/signature.ts`). Vide : la route du pont n'est pas montée.
   */
  DIDWW_API_KEY: z.string().default(''),
  // Vide : la production. Une adresse posée doit être une URL (vide, `.url()` aurait refusé de démarrer l'API).
  DIDWW_API_URL: z.string().default('').transform((v) => v.trim() || 'https://api.didww.com/v3').pipe(z.string().url()),
  DIDWW_TRUNK_OTP_ID: z.string().default(''),
  OTP_PONT_SECRET: z.string().default(''),
  /**
   * Le numéro fourni côté client (lot 3b) : sous ce nombre de numéros libres dans la réserve, Julien est prévenu par
   * Telegram, au plus une fois par jour. 0 éteint l'alerte (aucun compte n'est sous zéro).
   */
  ALERTE_RESERVE_SEUIL: z.coerce.number().int().min(0).default(3),
  /** URL du connecteur mm-hubspot (POST /ingest). Vide -> le push d'analyse est inerte (aucun job enfilé). */
  CONNECTOR_PUSH_URL: z.string().default(''),
  /** Secret HMAC partagé avec le connecteur (== INGEST_SECRET). Signe le push. */
  CONNECTOR_PUSH_SECRET: z.string().default(''),
  /** URL du canal service du connecteur (mba interroge les listes HubSpot, ex. http://mm-hubspot-api:8096).
   *  Vide -> import HubSpot inerte (routes non montées). */
  HUBSPOT_SERVICE_URL: z.string().default(''),
  /** Secret HMAC du canal service (== SERVICE_SECRET de mm-hubspot). Signe les appels /service/* et le jeton
   *  d'install `/oauth/install?t=` (le tenant ne passe pas en clair dans l'URL du lien HubSpot). */
  HUBSPOT_SERVICE_SECRET: z.string().default(''),
  /** Origine publique du connecteur (ex. https://mm-hubspot.messagingme.app), celle que le navigateur ouvre
   *  pour l'install ou le re-consentement HubSpot, distincte de HUBSPOT_SERVICE_URL (URL interne Docker).
   *  Vide -> la route de lien d'install répond 503. */
  HUBSPOT_CONNECTOR_PUBLIC_URL: z.string().default(''),
  /**
   * L'app Salesforce : identifiant et secret de notre External Client App (Consumer Key et Consumer Secret,
   * lus dans le Dev Hub). Avec eux, Messaging Me demande un jeton à l'org d'un client, au nom de l'utilisateur
   * d'intégration désigné par son admin. Vides : intégration non montée. Les deux se posent ensemble, et
   * exigent `ENCRYPTION_KEY` (le secret de chaque org est chiffré).
   * 🔴 Jamais en `NEXT_PUBLIC_`, jamais dans le dépôt (public) ni dans le package.
   */
  SALESFORCE_CLIENT_ID: z.string().default(''),
  SALESFORCE_CLIENT_SECRET: z.string().default(''),
  /**
   * L'identifiant de la version publiée du package (`04t...`), qui fait les liens d'installation que la console
   * montre. Vide tant qu'aucune version n'est promue : la console le dit au lieu d'inventer un lien.
   */
  SALESFORCE_PACKAGE_VERSION: z.string().regex(/^(04t[0-9A-Za-z]{12}([0-9A-Za-z]{3})?)?$/, 'identifiant de version de package (04t...) attendu').default(''),
}).superRefine((c, ctx) => {
  /**
   * 🔴 Un plafond par groupe >= au total ne plafonne rien : `groupConcurrency` borne les jobs en vol pour un
   * même espace, `concurrency` le total, donc à égalité un seul client peut déjà prendre toutes les places.
   * pg-boss ne s'en plaint pas.
   */
  if (c.AGENT_TURN_GROUP_CONCURRENCY >= c.AGENT_TURN_CONCURRENCY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENT_TURN_GROUP_CONCURRENCY'],
      message: `le plafond par espace (${c.AGENT_TURN_GROUP_CONCURRENCY}) doit etre STRICTEMENT inferieur au total en vol (${c.AGENT_TURN_CONCURRENCY}), sinon un seul client peut prendre toutes les places`,
    });
  }

  /**
   * 🔴 Les deux chaînes de connexion doivent désigner la même base. `DATABASE_URL` (session, DDL, pg-boss) et
   * `APP_DATABASE_URL` (transaction, pool applicatif) sont deux modes d'accès à une seule base : des hôtes
   * différents veulent dire qu'une des deux est fausse et que le process tourne à cheval sur deux bases
   * (ses files d'un côté, ses balayages de l'autre, qui pourraient marquer de vrais destinataires envoyés
   * en `DRY_RUN`). La garde porte sur l'hôte seul : port et mode diffèrent légitimement (5432, 6543).
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

  // Fail-fast en production si le secret JWT est faible ou par défaut : sinon un déploiement qui oublie
  // AUTH_SECRET démarre sur une constante publique, et des JWT admin deviennent forgeables pour tout espace.
  if (process.env.NODE_ENV === 'production') {
    // Sans base, le service crashe plus loin sur un ECONNREFUSED localhost:5432 qui ne nomme jamais la
    // variable manquante. Fail-fast ici : le message dit quoi corriger.
    if (c.DATABASE_URL === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'DATABASE_URL requis en production' });
    }
    // Sans secret d'app, `verifySignature` renvoie false d'entrée : le service démarre, /health répond ok, et
    // 100 % des webhooks Meta partent en 403, sans une trace.
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
     * 🔴 La clé du Gateway sans modèle d'agent est un piège silencieux : le code retomberait sur `LLM_MODEL`,
     * l'identifiant de l'analyse servie en direct par Anthropic, que le Gateway (identifiants préfixés par
     * le fournisseur) refuserait à chaque appel, découvert au premier vrai contact. Refusé au boot.
     */
    if (c.AI_GATEWAY_API_KEY !== '') {
      if (c.AGENT_MODEL === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AGENT_MODEL'], message: 'AGENT_MODEL requis quand AI_GATEWAY_API_KEY est defini (identifiant du Gateway, ex. zai/glm-4.7-flash)' });
      }
      if (c.AGENT_SETUP_MODEL === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['AGENT_SETUP_MODEL'], message: 'AGENT_SETUP_MODEL requis quand AI_GATEWAY_API_KEY est defini (identifiant du Gateway, ex. zai/glm-4.7)' });
      }
    }
    /**
     * Le jeton et l'équipe Vercel vont par deux : `POST /v1/api-keys` exige le `teamId`, et avec le jeton seul
     * chaque provisionnement échouerait, donc plus aucune création d'agent (elle refuse quand il échoue).
     * La clé de chiffrement est exigée aussi : sans elle, la clé Gateway du client serait stockée en clair ou
     * le chiffrement échouerait à l'écriture.
     */
    const provisionnement = c.VERCEL_API_TOKEN !== '' || c.VERCEL_TEAM_ID !== '';
    if (provisionnement) {
      if (c.VERCEL_API_TOKEN === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['VERCEL_API_TOKEN'], message: 'VERCEL_API_TOKEN requis quand VERCEL_TEAM_ID est defini (les deux vont par paire)' });
      }
      if (c.VERCEL_TEAM_ID === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['VERCEL_TEAM_ID'], message: 'VERCEL_TEAM_ID requis quand VERCEL_API_TOKEN est defini (POST /v1/api-keys l exige en parametre)' });
      }
      if (!/^[0-9a-fA-F]{64}$/.test(c.ENCRYPTION_KEY)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY (64 hex) requise pour chiffrer les cles Gateway des espaces' });
      }
    }
    // La clé Stripe dit son mode par son préfixe, et le client Stripe d'un espace est gardé par mode : une clé posée
    // sans préfixe reconnaissable laisserait deviner le mode, donc mêler clients de test et clients réels.
    if (c.STRIPE_SECRET_KEY !== '' && !/^(sk|rk)_(live|test)_/.test(c.STRIPE_SECRET_KEY)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['STRIPE_SECRET_KEY'], message: 'STRIPE_SECRET_KEY doit commencer par sk_live_, rk_live_, sk_test_ ou rk_test_' });
    }
    // Stripe : les deux moitiés vont ensemble, comme le jeton et l'équipe Vercel. La clé seule laisse payer des
    // clients qu'aucun webhook ne créditera jamais (encaissé, jamais crédité) ; le secret seul monte un webhook qui
    // ne connaît pas le mode de la clé, donc ne peut pas refuser un événement de l'autre mode.
    if ((c.STRIPE_SECRET_KEY === '') !== (c.STRIPE_WEBHOOK_SECRET === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [c.STRIPE_SECRET_KEY === '' ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET'], message: 'STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET se posent ensemble (ou aucun des deux)' });
    }
    // Les deux prix du Pro vont ensemble : un seul ouvrirait une périodicité et laisserait l'autre en 503.
    if ((c.STRIPE_PRIX_PRO_MOIS === '') !== (c.STRIPE_PRIX_PRO_AN === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [c.STRIPE_PRIX_PRO_MOIS === '' ? 'STRIPE_PRIX_PRO_MOIS' : 'STRIPE_PRIX_PRO_AN'], message: 'STRIPE_PRIX_PRO_MOIS et STRIPE_PRIX_PRO_AN se posent ensemble (ou aucun des deux)' });
    }
    // Le pont du code : un secret court se devinerait. ⚠️ AUCUNE garde au démarrage sur la paire clé DIDWW et trunk :
    // `.env.prod` porte encore la ligne `DIDWW_API_KEY` d'une clé révoquée (mesuré le 2026-10-02), et la garde aurait
    // refusé de démarrer l'API au premier déploiement. Il manque l'une ou l'autre : la déclaration rend 503.
    if (c.OTP_PONT_SECRET !== '' && c.OTP_PONT_SECRET.length < 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OTP_PONT_SECRET'], message: 'OTP_PONT_SECRET doit faire au moins 32 caractères' });
    }
    // Le push connecteur activé (URL posée) sans secret signerait avec une clé vide -> le connecteur refuserait tout (401).
    if (c.CONNECTOR_PUSH_URL !== '' && c.CONNECTOR_PUSH_SECRET === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CONNECTOR_PUSH_SECRET'], message: 'CONNECTOR_PUSH_SECRET requis quand CONNECTOR_PUSH_URL est défini' });
    }
    // Idem canal service (import de listes) : URL posée sans secret -> le connecteur refuserait tout (401).
    if (c.HUBSPOT_SERVICE_URL !== '' && c.HUBSPOT_SERVICE_SECRET === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HUBSPOT_SERVICE_SECRET'], message: 'HUBSPOT_SERVICE_SECRET requis quand HUBSPOT_SERVICE_URL est défini' });
    }
    // Zadarma : les deux moitiés vont ensemble. Une seule posée signerait avec une clé vide et Zadarma
    // répondrait « 401 Not authorized », qu'on mettrait sur le dos de clés pourtant valides.
    if ((c.ZADARMA_API_KEY === '') !== (c.ZADARMA_API_SECRET === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ZADARMA_API_SECRET'], message: 'ZADARMA_API_KEY et ZADARMA_API_SECRET se posent ensemble (ou aucun des deux)' });
    }
    // Provider RCS smsmode sans sa clé de canal : chaque envoi partirait en 401/403. Fail-fast au boot,
    // comme pour META_APP_SECRET, plutôt qu'une panne silencieuse découverte au premier envoi client.
    if (c.RCS_PROVIDER === 'smsmode' && c.SMSMODE_RCS_API_KEY === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMSMODE_RCS_API_KEY'], message: 'SMSMODE_RCS_API_KEY requis quand RCS_PROVIDER=smsmode' });
    }
    // Embedded Signup activé sans clé de chiffrement = tokens business stockés en clair ou crash au premier
    // onboarding. Fail-fast au boot : 64 hex exigés.
    if (c.META_ES_CONFIG_ID !== '' && !/^[0-9a-fA-F]{64}$/.test(c.ENCRYPTION_KEY)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY (64 hex) requise quand META_ES_CONFIG_ID est défini' });
    }
    // Même raison pour les publicités : le jeton d'utilisateur système qu'elles rapportent permet de dépenser
    // l'argent du client chez Meta. Sans clé, il serait stocké en clair ou la connexion planterait.
    if (c.META_ADS_CONFIG_ID !== '' && !/^[0-9a-fA-F]{64}$/.test(c.ENCRYPTION_KEY)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY (64 hex) requise quand META_ADS_CONFIG_ID est défini' });
    }
    // Salesforce : la clé d'app se pose entière (une moitié demanderait des jetons refusés, mis sur le dos des
    // orgs des clients), et exige la clé de chiffrement (le secret de chaque org est gardé chiffré).
    if ((c.SALESFORCE_CLIENT_ID === '') !== (c.SALESFORCE_CLIENT_SECRET === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SALESFORCE_CLIENT_SECRET'], message: 'SALESFORCE_CLIENT_ID et SALESFORCE_CLIENT_SECRET se posent ensemble (ou aucun des deux)' });
    }
    if (c.SALESFORCE_CLIENT_ID !== '' && !/^[0-9a-fA-F]{64}$/.test(c.ENCRYPTION_KEY)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY (64 hex) requise quand SALESFORCE_CLIENT_ID est défini' });
    }
  }
});


/**
 * Réglages figés en constantes : aucun déploiement ne les posait dans l'environnement. Leur valeur est celle
 * de leur ancien défaut ; la changer demande un déploiement de code. Ils restent sous `config` pour que leurs
 * lecteurs n'aient pas bougé.
 */
const constantes = {
  /** Un destinataire `sending` plus vieux que ça est ramené à `pending` par le sweeper (ms). */
  STALE_SENDING_MS: 15 * 60 * 1000,
  /** Intervalle du sweeper de récupération des `sending` bloqués (ms). */
  RECLAIM_INTERVAL_MS: 5 * 60 * 1000,
  /** Réveil des parcours endormis (bloc « Attente »). 60 s : c'est aussi la précision réelle d'un délai. */
  WORKFLOW_WAKE_SWEEP_INTERVAL_MS: 60 * 1000,
  /** Plafond de débit d'un webhook entrant (menu Tools). Par webhook, pas par IP : c'est le budget d'une
   *  intégration, et l'IP d'un Zapier n'a aucune stabilité. */
  WEBHOOK_IN_RATE_LIMIT_MAX: 120,
  WEBHOOK_IN_RATE_LIMIT_WINDOW_MS: 60_000,
  /** Jours de conservation du dernier payload d'un webhook entrant. Voir la note RGPD de la migration 0074. */
  WEBHOOK_PAYLOAD_RETENTION_DAYS: 7,
  /**
   * Durée maximale d'un run de campagne avant qu'il rende la main et se réenfile, pour que la file reste
   * équitable : sans découpage, une campagne de 5 000 destinataires à 30/min occuperait la file près de 3 h.
   * Une durée et non un nombre de destinataires, parce que le débit varie de 1 à 80/min. Le prix : un
   * aller-retour de file entre deux lots (cadence de `campaign-run` : 5 s). 0 retire le découpage.
   */
  CAMPAIGN_RUN_MAX_MS: 2 * 60 * 1000,
  /**
   * Runs de campagne traités en parallèle par le worker, et plafond par espace.
   * La concurrence n'est sûre que grâce au frein de débit partagé par numéro (`src/meta/arbitre-debit.ts`) :
   * sans lui, deux campagnes en parallèle doubleraient le débit réel du numéro. Ne pas relever l'un sans
   * l'autre. Le plafond par espace reste à 1 : un client n'a qu'un numéro, deux de ses campagnes se
   * disputeraient le même budget. La concurrence sert à ce qu'un client n'attende pas la campagne d'un autre.
   */
  CAMPAIGN_RUN_CONCURRENCY: 4,
  /**
   * Concurrence de la file des messages entrants, pour qu'un envoi Meta lent chez un client ne fasse pas
   * attendre la réponse d'un autre.
   * Sûr seulement parce que l'enfilement pose une clé de groupe par contact et que `work` plafonne à un job
   * en vol par groupe : deux messages d'un même contact restent sérialisés. Ne pas relever l'un sans l'autre.
   * 3 et pas plus : le worker tient déjà 4 runs de campagne, les accusés, les automations et les tours
   * d'agent, sur le pool du worker principal (`DB_POOL_MAX` de `mba-worker`, `docker-compose.yml`). Relever ce
   * nombre demande de refaire cette arithmétique.
   */
  WEBHOOK_CONCURRENCY: 3,
  /**
   * Analyses de conversation en vol. Le plafond par espace est de 1, posé dans le worker : c'est le groupe
   * qui compte, pour qu'un client qui importe dix mille contacts ne passe pas avant la première analyse de
   * tous les autres.
   */
  ANALYZE_CONVERSATION_CONCURRENCY: 3,
  /**
   * Événements d'automation en vol, plafond par espace de 1 (même raison) : sans groupe, la rafale d'un
   * client gèlerait tous les autres.
   */
  AUTOMATION_EVENT_CONCURRENCY: 3,
  /** Durée de validité d'un lien d'invitation (ms). Défaut 7 jours. */
  INVITE_TOKEN_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  /** Durée de validité d'un lien de réinitialisation de mot de passe (ms). Défaut 1 h. */
  RESET_TOKEN_TTL_MS: 60 * 60 * 1000,
  /** Inactivité (ms) au-delà de laquelle une conversation est considérée close et analysable. Défaut 25 min. */
  CONVERSATION_INACTIVITY_MS: 25 * 60 * 1000,
  /** Une conversation bloquée en `queued` plus vieille que ça est ramenée à `pending` (worker mort). Défaut 15 min. */
  CONVERSATION_ANALYSIS_STALE_MS: 15 * 60 * 1000,
  /** Intervalle du balayage d'analyse (ms). Défaut 5 min. */
  CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS: 5 * 60 * 1000,
  /** Nombre max de conversations réclamées par passage de balayage. */
  CONVERSATION_ANALYSIS_BATCH: 20,
  /** Cadence du filet de sécurité du rattrapage HubSpot : relance le rattrapage des marques restées sur un
   *  numéro reconnecté. Défaut 10 min : action rare, lecture légère, pas un chemin chaud. */
  HUBSPOT_CATCHUP_SWEEP_INTERVAL_MS: 10 * 60 * 1000,
  /** Cadence du sweep d'auto-relance des échecs. 15 min : assez fin pour la fenêtre matinale des 131049. */
  AUTO_RETRY_SWEEP_INTERVAL_MS: 15 * 60 * 1000,
  /** Inactivité au bout de laquelle un fil tenu par MBA est repris (le pendant de `CONTROL_HUMAN_TIMEOUT_MS`).
   *  Beaucoup plus long : l'agent est censé répondre seul, on ne le préempte qu'en cas de silence anormal. */
  CONTROL_MBA_TIMEOUT_MS: 24 * 60 * 60 * 1000,
  /**
   * Inactivité au bout de laquelle un fil tenu par un scénario revient à l'agent de Meta : la soupape de la
   * reprise d'un parcours (le contact quitte la liste de l'agent). Un parcours abandonné (le contact ne répond
   * jamais, le run reste `waiting`) garderait sinon le fil à jamais. La fin normale d'un parcours le rend déjà (`releaseToMba`), en deux temps : le fil passe
   * en `app_human` jusqu'à l'accusé du dernier envoi, et relève alors de `CONTROL_HUMAN_TIMEOUT_MS`.
   * Fixe, jamais réglable par client : c'est un garde-fou technique, et c'est ce qui permet de le filtrer en
   * SQL sans saturer le lot du balayage. 24 h et pas 2 h : un scénario attend légitimement longtemps (une
   * relance le lendemain), le couper rendrait le fil à l'agent de Meta à la place du bloc suivant.
   * 0 désactive la reprise.
   */
  CONTROL_WORKFLOW_TIMEOUT_MS: 24 * 60 * 60 * 1000,
  /** Anti-rebond par défaut d'une automation : délai minimum entre deux déclenchements de la même automation
   *  pour le même contact, quand le client n'a rien réglé. 1 h : absorbe un mot-clé répété ou un tag reposé,
   *  sans bloquer une vraie 2e demande dans la journée. Réglable par automation (0 = aucun garde-fou). */
  AUTOMATION_COOLDOWN_SECONDS: 3600,
  /** Cadence du balayage des échéances (déclencheur « X avant la date d'un champ »). */
  AUTOMATION_DATE_SWEEP_INTERVAL_MS: 60_000,
  /** Fenêtre de rattrapage après le moment prévu. Elle absorbe un redémarrage du worker, pas un vrai retard :
   *  au-delà, on n'envoie rien (un rappel « 48 h avant » qui part 12 h avant dit quelque chose de faux). */
  AUTOMATION_DATE_TOLERANCE_MINUTES: 60,
  /** Plafond d'un vocal à transcrire, en Ko. Pourquoi une taille et pas une durée : voir `TRANSCRIPTION_MODELE`. */
  TRANSCRIPTION_TAILLE_MAX_KO: 2048,
  /**
   * Modèle qui juge la pertinence des fiches candidates. Il porte la garde anti-hallucination : aucun seuil
   * n'est posable sur un cosinus d'embedding (un hors-sujet remonte à 0,361, une vraie question descend à
   * 0,299), alors que ce reranker sépare les deux (au-dessus de 0,0817, en dessous de 0,0409).
   * Pas le plus récent : `cohere/rerank-v4-fast` laisse le hors-sujet monter au-dessus des vraies questions.
   */
  AGENT_RERANK_MODEL: 'cohere/rerank-v3.5',
  /**
   * Combien de fiches le rappel remonte avant le verdict : plus que les 3 rendues au modèle, pour donner au
   * reranker de quoi choisir ; trop large le ferait payer pour rien.
   */
  AGENT_RAPPEL_CANDIDATS: 12,
  /** max_tokens de la réponse d'analyse (petit JSON). */
  LLM_MAX_TOKENS: 1024,
};

export type Config = z.infer<typeof schema> & typeof constantes;

export const config: Config = { ...schema.parse(process.env), ...constantes };

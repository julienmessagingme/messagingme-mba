import { z } from 'zod';

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
  /** Pays par défaut pour normaliser les numéros à l'import CSV. */
  DEFAULT_COUNTRY: z.string().default('FR'),
  /** Secret HMAC de signature des JWT de session (login console). */
  AUTH_SECRET: z.string().default('dev-insecure-change-me'),
  /** Mode démo : le worker n'appelle PAS Meta, il marque les envois `sent` (message-id synthétique). */
  DRY_RUN: z.string().default('false'),
  /** Un destinataire `sending` plus vieux que ça est ramené à `pending` par le sweeper (ms). */
  STALE_SENDING_MS: z.coerce.number().default(15 * 60 * 1000),
  /** Intervalle du sweeper de récupération des `sending` bloqués (ms). */
  RECLAIM_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  DATABASE_URL: z.string().default(''),
  PGBOSS_SCHEMA: z.string().default('pgboss'),
  /**
   * Budget de connexions Postgres. Le pooler Supabase est en SESSION mode, plafonné à ~15 clients, et il est
   * PARTAGÉ avec mm-hubspot (qui borne déjà : 2 + 2 par process). Sans plafond ici, `pg` prend son défaut de 10
   * et pg-boss le sien : 2 process x (10 + 10) = 40 sessions demandées pour 15 disponibles -> EMAXCONNSESSION,
   * l'API se fige et le worker meurt. Arithmétique du défaut ci-dessous : mba 2 process x (3 + 2) = 10,
   * mm-hubspot 2 process x (2 + 2) = 8, soit 18 pour ~15 disponibles.
   * ⚠️ Le pire cas simultané DÉPASSE donc encore le plafond du pooler. Ce qui change n'est PAS qu'on tient le
   * budget : c'est que le dépassement devient borné, rare (les pools sont paresseux, ils n'ouvrent que sous
   * charge réelle) et diagnosticable (timeout net + log, au lieu d'un gel silencieux).
   * Le vrai correctif est le mode TRANSACTION pour l'API (bloc 4 du PLAN.md), pas un plafond plus fin.
   */
  DB_POOL_MAX: z.coerce.number().default(3),
  /** Max de connexions du pool pg-boss (même contrainte de pooler partagé). */
  PGBOSS_MAX: z.coerce.number().default(2),
  /**
   * Timeout d'ACQUISITION d'une connexion du pool (ms). Le défaut `pg` est une attente ILLIMITÉE : pool saturé
   * -> la requête HTTP ne répond jamais, sans erreur, sans trace. On préfère un échec net au bout du délai,
   * que le setErrorHandler journalise. 0 = attente illimitée (comportement pg d'origine, à éviter).
   */
  DB_CONN_TIMEOUT_MS: z.coerce.number().default(8000),
  /** Secret de la surface d'exploitation cross-tenant `/ops` (lecture seule). Vide -> /ops désactivé (401). */
  OPS_TOKEN: z.string().default(''),
  /** Rate limit de l'API publique /v1 : requêtes par clé et par fenêtre (en mémoire, par process). */
  API_KEY_RATE_LIMIT_MAX: z.coerce.number().default(60),
  API_KEY_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  /** Clé API Resend pour le formulaire de support (phase 7). Vide -> support indisponible (503, pas de crash). */
  RESEND_API_KEY: z.string().default(''),
  /** Expéditeur des emails de support. `onboarding@resend.dev` marche sans domaine vérifié (mode test :
   *  n'envoie QU'à l'adresse du compte Resend). Domaine vérifié -> `support@messagingme.app`. */
  SUPPORT_FROM: z.string().default('onboarding@resend.dev'),
  /** Destinataire des messages du formulaire de support. Vide -> support indisponible (503). */
  SUPPORT_TO: z.string().default(''),
  /** Client OAuth Google (public) pour « se connecter avec Google ». Vide -> bouton Google masqué (pas de crash). */
  GOOGLE_CLIENT_ID: z.string().default(''),
  /** URL publique du front (base des liens dans les emails invitation/reset), ex. https://mba.messagingme.app. */
  APP_URL: z.string().default('https://mba.messagingme.app'),
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
  /** Inactivité au bout de laquelle un fil tenu par un OPÉRATEUR revient au scénario. 2 h : assez long pour
   *  qu'une pause déjeuner ne coupe pas un échange en cours, assez court pour qu'un onglet fermé ne gèle pas
   *  le contact jusqu'au lendemain. Il n'existe AUCUN release automatique côté Meta : ce délai est notre
   *  seule soupape. 0 désactive la reprise (le contrôle reste alors humain indéfiniment, à vos risques). */
  CONTROL_HUMAN_TIMEOUT_MS: z.coerce.number().default(2 * 60 * 60 * 1000),
  /** Idem pour un fil tenu par MBA. Beaucoup plus long : l'agent est censé répondre seul, on ne le préempte
   *  qu'en cas de silence anormal. */
  CONTROL_MBA_TIMEOUT_MS: z.coerce.number().default(24 * 60 * 60 * 1000),
  /** Provider LLM de l'analyse. UNE seule implémentation existe. `z.enum` et non `z.string` : une valeur
   *  inconnue était acceptée par la config et TUAIT le conteneur worker au premier appel d'analyse, avec une
   *  erreur qui ne nommait pas la variable. Elle est maintenant refusée au boot. */
  LLM_PROVIDER: z.enum(['anthropic']).default('anthropic'),
  /** Clé API du provider LLM. Vide -> analyse non activable (fail-fast prod si ENABLED). */
  LLM_API_KEY: z.string().default(''),
  /** Id de modèle LLM (ex. claude-haiku-4-5 pour ce classifieur haut-volume, ou claude-opus-4-8 pour la qualité).
   *  À fixer au déploiement — JAMAIS d'id daté figé en dur. Vide -> analyse non activable. */
  LLM_MODEL: z.string().default(''),
  /** max_tokens de la réponse d'analyse (petit JSON). */
  LLM_MAX_TOKENS: z.coerce.number().default(1024),
  /** URL du connecteur mm-hubspot (POST /ingest). Vide -> le push d'analyse est INERTE (aucun job enfilé). */
  CONNECTOR_PUSH_URL: z.string().default(''),
  /** Secret HMAC partagé avec le connecteur (== INGEST_SECRET). Signe le push. */
  CONNECTOR_PUSH_SECRET: z.string().default(''),
  /** URL du canal SERVICE du connecteur (mba interroge les listes HubSpot, ex. http://mm-hubspot-api:8096). Vide -> import HubSpot INERTE (routes non montées). */
  HUBSPOT_SERVICE_URL: z.string().default(''),
  /** Secret HMAC du canal service (== SERVICE_SECRET de mm-hubspot). Signe les appels /service/*. */
  HUBSPOT_SERVICE_SECRET: z.string().default(''),
}).superRefine((c, ctx) => {
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
    // Le push connecteur activé (URL posée) sans secret signerait avec une clé vide -> le connecteur refuserait tout (401).
    if (c.CONNECTOR_PUSH_URL !== '' && c.CONNECTOR_PUSH_SECRET === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CONNECTOR_PUSH_SECRET'], message: 'CONNECTOR_PUSH_SECRET requis quand CONNECTOR_PUSH_URL est défini' });
    }
    // Idem canal service (import de listes) : URL posée sans secret -> le connecteur refuserait tout (401).
    if (c.HUBSPOT_SERVICE_URL !== '' && c.HUBSPOT_SERVICE_SECRET === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HUBSPOT_SERVICE_SECRET'], message: 'HUBSPOT_SERVICE_SECRET requis quand HUBSPOT_SERVICE_URL est défini' });
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

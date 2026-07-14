import { z } from 'zod';

const schema = z.object({
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
  /** Secret de la surface d'exploitation cross-tenant `/ops` (lecture seule). Vide -> /ops désactivé (401). */
  OPS_TOKEN: z.string().default(''),
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
  /** Provider LLM de l'analyse. 'anthropic' (défaut) = Claude. Factory `createLlmClient` (throw si inconnu). */
  LLM_PROVIDER: z.string().default('anthropic'),
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
}).superRefine((c, ctx) => {
  // Fail-fast en PRODUCTION si le secret JWT est faible/par défaut : sinon un déploiement
  // qui oublie AUTH_SECRET démarre sur une constante publique -> JWT admin forgeables
  // cross-tenant. En dev/test on tolère le défaut pour l'ergonomie.
  if (process.env.NODE_ENV === 'production') {
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
  }
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

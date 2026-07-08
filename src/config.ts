import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(8095),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  /** Token d'accès Meta pour l'envoi outbound (worker campaign-run). */
  META_ACCESS_TOKEN: z.string().default(''),
  /** Version Graph API pour les appels d'envoi. */
  META_GRAPH_VERSION: z.string().default('v25.0'),
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
  }
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

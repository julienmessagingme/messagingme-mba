import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(8095),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  /** Token d'accès Meta pour l'envoi outbound (worker campaign-run). */
  META_ACCESS_TOKEN: z.string().default(''),
  /** Version Graph API pour les appels d'envoi. */
  META_GRAPH_VERSION: z.string().default('v25.0'),
  /** Pays par défaut pour normaliser les numéros à l'import CSV. */
  DEFAULT_COUNTRY: z.string().default('FR'),
  /** Secret HMAC de signature des JWT de session (login console). */
  AUTH_SECRET: z.string().default('dev-insecure-change-me'),
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

import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(8095),
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  DATABASE_URL: z.string().default(''),
  PGBOSS_SCHEMA: z.string().default('pgboss'),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

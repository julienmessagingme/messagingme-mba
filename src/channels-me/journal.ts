import { texteDe } from '../lib/erreur';

/**
 * Ce qui sort d'un echec distant : l'espace, l'etape et le message de l'erreur levee par notre client. Jamais
 * le corps de la reponse du tiers (une page HTML entiere, ou des donnees d'un autre espace), jamais les
 * identifiants. `console.error` et non `req.log` : Fastify est construit en `logger: false`.
 */
export function journaliserDistantChannelsMe(tenant: string, etape: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    lvl: 'error', msg: 'channelsme_distant_ko', tenant, etape,
    err: texteDe(err),
  }));
}

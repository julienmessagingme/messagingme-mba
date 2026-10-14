import type { FastifyInstance } from 'fastify';
import { RateLimiter } from '../auth/rate-limit';
import { texteDe } from '../lib/erreur';
import { extraireRapports, type RapportCsp } from '../csp/rapports';

/**
 * LE COLLECTEUR DES RAPPORTS CSP DE LA CONSOLE (lot 6 du bilan des audits, B3) : `POST /csp-rapports`, désigné par la
 * directive `report-uri` de `web/next.config.mjs`. Les navigateurs y postent ce que la politique, en observation,
 * interdirait une fois bloquante ; on le lit dans `csp_rapports` avant de basculer.
 *
 * 🔴 PUBLIC PAR NATURE, DONC SANS RIEN À PRENDRE. Tout corps lu reçoit 204, vide : un rapport refusé, une page d'une
 * autre origine, un plafond atteint, une base en panne ne se distinguent pas d'un rapport retenu. Seul ce que Fastify
 * refuse avant de lire répond autrement (413 au-delà de 32 Ko, 415 pour un autre type). Un navigateur l'envoie en
 * `no-cors` et ignore la réponse : aucune origine à inscrire dans `CORS_ORIGINS`.
 */
export interface CspRapportsDeps {
  /** Les origines de la console dont un rapport compte (`CORS_ORIGINS`, `APP_URL` et la console du VPS, `src/index.ts`). */
  origines: readonly string[];
  noter(r: RapportCsp): Promise<void>;
}

/** Les deux types que les navigateurs emploient ; `application/json` passe par le lecteur ordinaire de Fastify. */
const TYPES_DE_RAPPORT = ['application/csp-report', 'application/reports+json'];
const LIMITE_CORPS = 32_000;

export function registerCspRapports(app: FastifyInstance, deps: CspRapportsDeps): void {
  /**
   * UN plafond pour toute la plateforme, compté par RAPPORT écrit (une requête en porte jusqu'à vingt) : sans
   * `trustProxy`, `req.ip` est le même pour tout le monde (cf. le formulaire de la vitrine). Au-delà, les rapports sont
   * lus sans être écrits : un trou dans la table n'est donc pas une absence de violation.
   */
  const plafond = new RateLimiter(600, 60_000);

  // Les lecteurs n'existent que dans cette portée : ailleurs, ces types restent refusés (415).
  void app.register(async (portee) => {
    for (const type of TYPES_DE_RAPPORT) {
      portee.addContentTypeParser(type, { parseAs: 'string', bodyLimit: LIMITE_CORPS }, (_req, corps, fait) => {
        try {
          fait(null, JSON.parse(String(corps)));
        } catch {
          fait(null, null);
        }
      });
    }

    portee.post('/csp-rapports', { bodyLimit: LIMITE_CORPS }, async (req, reply) => {
      for (const r of extraireRapports(req.body, deps.origines)) {
        if (!plafond.take('csp-rapports')) break;
        try {
          await deps.noter(r);
        } catch (err) {
          // Une panne de la base ne fait pas répondre autrement (le navigateur n'en saurait rien faire), et arrête la
          // requête : vingt attentes d'une base muette tiendraient la connexion ouverte des minutes.
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({ lvl: 'error', msg: 'csp_rapport_echec', err: texteDe(err) }));
          break;
        }
      }
      return reply.code(204).send();
    });
  });
}

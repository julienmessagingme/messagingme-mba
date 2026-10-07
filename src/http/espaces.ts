import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Guard, UserStateLoader } from '../auth/middleware';
import { markLogin, type ComptesAuthDep } from '../auth/routes';
import { echeanceSession, signSession } from '../auth/token';
import { espaceVerifie } from './scope';

/**
 * CHANGER D'ESPACE SANS SE DÉCONNECTER (RC3, plan `docs/superpowers/plans/2026-10-06-rc3-changer-d-espace.md`).
 *
 * Une identité (une adresse) a un compte par espace. La connexion le sait déjà : avec plusieurs comptes, elle propose
 * le choix (`suiteDeConnexion`, `src/auth/routes.ts`). Ces deux routes rejouent ce choix une fois connecté, SANS
 * redemander de preuve (décision de Julien) : la connexion propose déjà ces espaces-là avec cette preuve-là.
 *
 * 🔴 Ce qui tient la bascule, et qu'aucun type ne montre :
 *  - l'identité vient de la SESSION (`req.auth.userId`), jamais de l'URL ni du corps ;
 *  - la cible doit être dans la liste de l'identité, sinon 404 (un 403 confirmerait qu'un espace existe) ;
 *  - la session neuve garde l'ÉCHÉANCE de la présentée : basculer ne prolonge jamais une session, sinon deux
 *    bascules par jour la feraient vivre sans fin sans repasser par une preuve ;
 *  - une session d'observation (`/ops`) ne bascule pas : signée pour UN espace par un exploitant, elle ouvrirait les
 *    autres espaces de l'identité observée.
 *
 * Son autorité est celle de la connexion (`deps.auth` du serveur), d'où l'interface ci-dessous, que `AuthRouteDeps`
 * satisfait telle quelle.
 */
export interface EspacesRouteDeps {
  /** `AUTH_SECRET` : signer la session neuve, relire l'échéance de la présentée. */
  secret: string;
  /** L'adresse du compte de la session, puis tous les comptes de cette adresse. Absent : 503. */
  comptes?: Pick<ComptesAuthDep, 'getSessionUser' | 'getByEmail' | 'touchLastLogin'>;
  /**
   * Le chargeur d'état que `makeRequireAuth` relit à chaque requête. Un compte qu'il refuserait (révoqué, ou espace
   * suspendu) n'est ni listé ni ouvert : la session neuve y serait refusée à son premier appel, et la personne ne
   * pourrait même plus relire la liste pour revenir. Absent (tests sans base) : aucun filtre de plus, comme la garde.
   */
  getUserState?: UserStateLoader;
}

/** Un compte de l'identité, tel que la liste et la bascule le lisent. */
interface CompteDEspace { id: string; tenantId: string; tenantName: string; role: string }

const CorpsBascule = z.object({ tenantId: z.string().min(1).max(100) });

/** Le jeton présenté, que la garde vient de vérifier sur la même requête. */
function jetonPresente(req: FastifyRequest): string | null {
  const entete = req.headers.authorization;
  return entete?.startsWith('Bearer ') ? entete.slice(7) : null;
}

export function registerEspaces(app: FastifyInstance, deps: EspacesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /**
   * Les comptes que l'identité de la session peut ouvrir, avec son adresse. Les mêmes filtres que la connexion
   * Google (`/auth/google`) : tous les comptes de l'adresse, sauf les révoqués ; puis ceux que la garde accepterait
   * (`getUserState`, la condition exacte de `makeRequireAuth`). `null` : compte de la session introuvable.
   */
  async function comptesDeLIdentite(userId: string): Promise<{ email: string; comptes: CompteDEspace[] } | null> {
    const comptes = deps.comptes;
    if (!comptes?.getSessionUser || !comptes.getByEmail) return null;
    const moi = await comptes.getSessionUser(userId);
    if (!moi) return null;
    const actifs = (await comptes.getByEmail(moi.email)).filter((c) => !c.disabled);
    const etat = deps.getUserState;
    if (!etat) return { email: moi.email, comptes: actifs };
    const ouverts = await Promise.all(actifs.map(async (c) => {
      const e = await etat(c.id, c.tenantId);
      // Un membre en trop (lot 6, B2a) y serait refusé en 402 dès son premier appel, et enfermé sur la page suspendue.
      return e !== null && !e.disabled && e.tenantStatus !== 'locked' && !e.horsOffre;
    }));
    return { email: moi.email, comptes: actifs.filter((_c, i) => ouverts[i]) };
  }

  app.get('/tenants/:tenantId/espaces', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const auth = req.auth;
    if (!auth) return reply.code(401).send({ error: 'authentification requise' });
    // L'observation n'a pas d'identité à elle (`ops-observation` n'est pas un uuid, la lire lèverait) : rien à lister.
    if (auth.impersonated === true) return reply.code(200).send({ espaces: [] });
    if (!deps.comptes?.getSessionUser || !deps.comptes.getByEmail) return reply.code(503).send({ error: 'changement d’espace indisponible' });
    const lu = await comptesDeLIdentite(auth.userId);
    const espaces = (lu?.comptes ?? []).map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName, role: c.role, actuel: c.tenantId === tenant }));
    return reply.code(200).send({ espaces });
  });

  app.post('/tenants/:tenantId/changer-espace', opts, async (req, reply) => {
    espaceVerifie(req);
    const auth = req.auth;
    if (!auth) return reply.code(401).send({ error: 'authentification requise' });
    // 🔴 Avant tout : la garde refuse déjà toute écriture à l'observation, ce refus-ci ne dépend pas d'elle.
    if (auth.impersonated === true || auth.observateur !== undefined) {
      return reply.code(403).send({ error: 'session d’observation : elle ne change pas d’espace' });
    }
    const corps = CorpsBascule.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'tenantId requis' });
    if (!deps.comptes?.getSessionUser || !deps.comptes.getByEmail) return reply.code(503).send({ error: 'changement d’espace indisponible' });
    const jeton = jetonPresente(req);
    const echeance = jeton === null ? null : await echeanceSession(jeton, deps.secret);
    if (echeance === null) return reply.code(401).send({ error: 'token invalide ou expiré' });
    const lu = await comptesDeLIdentite(auth.userId);
    const cible = lu?.comptes.find((c) => c.tenantId === corps.data.tenantId);
    // 404 et pas 403 : un espace étranger et un espace inexistant répondent la même chose.
    if (!lu || !cible) return reply.code(404).send({ error: 'espace introuvable' });
    const token = await signSession({ userId: cible.id, tenantId: cible.tenantId, role: cible.role }, deps.secret, echeance);
    markLogin(deps.comptes, cible.id);
    // La forme exacte de `suiteDeConnexion` : la console l'enregistre comme une connexion.
    return reply.code(200).send({ token, user: { email: lu.email, role: cible.role, tenantId: cible.tenantId } });
  });
}

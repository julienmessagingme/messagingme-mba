import type { FastifyInstance } from 'fastify';
import { hashPasswordSync } from '../src/auth/password';
import type { AuthRouteDeps } from '../src/auth/routes';
import type { AuthUser } from '../src/auth/store';
import { MfaEnMemoire, UtilisateursFaux, comptesDe, passerLeSecondFacteur } from './mfa';

/**
 * L'ACCÈS À `/ops` DANS LES TESTS, PAR LE VRAI PARCOURS.
 *
 * 🔴 Même règle que `tests/mfa.ts` : aucun raccourci dans `src/`. Un test qui a besoin de `/ops` y entre comme en
 * production : `/auth/login` avec `ops: true`, puis le code de l'application, et la session d'exploitation qui en
 * sort. Aucune session d'exploitation n'est fabriquée à la main ici : un test qui la signerait lui-même ne verrait
 * pas une connexion qui cesserait de la rendre.
 *
 * L'exploitant est un simple `agent` de son espace, délibérément : l'accès à `/ops` ne tient qu'à la liste et au
 * second facteur, jamais au rôle dans un espace.
 */
export const ADRESSE_OPS = 'exploitant@exploitation.test';
export const SECRET_OPS = 'secret-des-tests-de-l-exploitation';
export const MOT_DE_PASSE_OPS = 'mot-de-passe-de-l-exploitant';
const HASH = hashPasswordSync(MOT_DE_PASSE_OPS);

export const EXPLOITANT: AuthUser = { id: 'u-exploitant', tenantId: 't-exploitation', email: ADRESSE_OPS, role: 'agent', passwordHash: HASH };

export interface AccesOps {
  /** Les dépendances d'authentification à passer à `buildServer` : la liste, le secret, le second facteur. */
  auth: AuthRouteDeps;
  mfa: MfaEnMemoire;
  /** La liste vivante : la muter après coup, c'est retirer quelqu'un de `OPS_EMAILS` en production. */
  liste: string[];
  /** La session d'exploitation, gagnée une fois par le vrai parcours sur `app`, puis réutilisée. */
  jeton(app: FastifyInstance): Promise<string>;
  /** Son en-tête `authorization`, prêt pour `inject` (un `payload` objet pose lui-même le `content-type`). */
  entetes(app: FastifyInstance): Promise<Record<string, string>>;
}

/**
 * Un exploitant (`EXPLOITANT`) dont le facteur est ACTIF, et la liste qui le nomme. `autres` ajoute des comptes
 * (un admin d'espace, par exemple) au même magasin, pour les tests qui montent aussi des routes d'espace.
 */
export function accesOps(options: { liste?: string[]; autres?: AuthUser[]; auth?: Partial<AuthRouteDeps> } = {}): AccesOps {
  const users = [EXPLOITANT, ...(options.autres ?? [])];
  const mfa = new MfaEnMemoire(comptesDe(users));
  mfa.poserFacteur(ADRESSE_OPS);
  const liste = options.liste ?? [ADRESSE_OPS];
  const auth: AuthRouteDeps = { users: new UtilisateursFaux(users, mfa), secret: SECRET_OPS, mfa, opsEmails: liste, ...options.auth };
  let memo: string | null = null;
  const jeton = async (app: FastifyInstance): Promise<string> => {
    if (memo !== null) return memo;
    const res = await app.inject({
      method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' },
      payload: { email: ADRESSE_OPS, password: MOT_DE_PASSE_OPS, ops: true },
    });
    const fin = await passerLeSecondFacteur(app, res, mfa, ADRESSE_OPS);
    const corps = fin.json<{ sessionOps?: unknown }>();
    if (fin.statusCode !== 200 || typeof corps.sessionOps !== 'string') {
      throw new Error(`aucune session d’exploitation : ${fin.statusCode} ${fin.body}`);
    }
    memo = corps.sessionOps;
    return memo;
  };
  return {
    auth, mfa, liste, jeton,
    entetes: async (app) => ({ authorization: `Bearer ${await jeton(app)}` }),
  };
}

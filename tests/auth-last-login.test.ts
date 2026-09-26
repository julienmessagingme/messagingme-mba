import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { hashPasswordSync } from '../src/auth/password';
import type { AuthUser } from '../src/auth/store';
import { MfaEnMemoire, UtilisateursFaux, comptesDe, connecter, passerLeSecondFacteur } from './mfa';

/**
 * Horodatage de la dernière connexion (colonne « Dernière connexion » de la page Équipe).
 *
 * Les deux invariants qui comptent, et qui ne sont PAS évidents à la lecture :
 *  1. l'écriture est en fire-and-forget : si elle échoue ou traîne, le login réussit quand même. Mettre une
 *     écriture Postgres sur le chemin critique de l'authentification transformerait un pool saturé en
 *     « identifiants refusés », ce qui est le pire message possible pour l'utilisateur.
 *  2. le dep est OPTIONNEL, et l'appel doit survivre à son absence. `deps.touchLastLogin?.(id).catch()` lève
 *     un TypeError quand le dep est absent : c'est le `?.` sur le RETOUR qui protège.
 */
const SECRET = 'test-secret-please-change';
const ADMIN: AuthUser = { id: 'u1', tenantId: 't1', email: 'a@b.co', role: 'admin', passwordHash: hashPasswordSync('pw') };

/**
 * ADMIN passe par le second facteur comme en production (`tests/mfa.ts`) : la « connexion » de ces tests est donc
 * le parcours ENTIER, mot de passe puis enrôlement, et c'est à son terme que la dernière connexion s'horodate.
 */
let mfa = new MfaEnMemoire();
/** Les faux de l'adresse, avec un magasin du second facteur NEUF à chaque serveur. */
function faux(): { users: UtilisateursFaux; mfa: MfaEnMemoire } {
  mfa = new MfaEnMemoire(comptesDe([ADMIN]));
  return { users: new UtilisateursFaux([ADMIN], mfa), mfa };
}

const login = (app: ReturnType<typeof buildServer>, password = 'pw') => connecter(app, mfa, 'a@b.co', password);

describe('dernière connexion', () => {
  it('login réussi -> horodate le BON compte', async () => {
    const touched: string[] = [];
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { ...faux(), secret: SECRET, touchLastLogin: async (id) => { touched.push(id); } },
    });
    expect((await login(app)).statusCode).toBe(200);
    expect(touched).toEqual(['u1']);
    await app.close();
  });

  it('🔴 l’étape du mot de passe n’horodate RIEN tant qu’un code est dû : seule la session ouverte compte', async () => {
    const touched: string[] = [];
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { ...faux(), secret: SECRET, touchLastLogin: async (id) => { touched.push(id); } },
    });
    const etape = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co', password: 'pw' } });
    expect(Object.keys(etape.json())).toEqual(['enrolToken']);
    expect(touched).toEqual([]);
    expect((await passerLeSecondFacteur(app, etape, mfa, 'a@b.co')).statusCode).toBe(200);
    expect(touched).toEqual(['u1']);
    await app.close();
  });

  it('login REFUSÉ -> n’horodate rien (sinon la colonne mentirait sur une tentative ratée)', async () => {
    const touched: string[] = [];
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { ...faux(), secret: SECRET, touchLastLogin: async (id) => { touched.push(id); } },
    });
    expect((await login(app, 'mauvais')).statusCode).toBe(401);
    expect(touched).toEqual([]);
    await app.close();
  });

  it('l’écriture ÉCHOUE -> le login réussit quand même (fire-and-forget, pas sur le chemin critique)', async () => {
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { ...faux(), secret: SECRET, touchLastLogin: async () => { throw new Error('pool saturé'); } },
    });
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ token: string }>().token).toBeTruthy();
    await app.close();
  });

  it('dep ABSENT -> le login réussit (le `?.` sur le retour évite le TypeError)', async () => {
    // C'est exactement la forme utilisée par les autres suites de tests : `auth: { users, secret }` seuls.
    const app = buildServer({ queue: new FakeQueue(), auth: { ...faux(), secret: SECRET } });
    expect((await login(app)).statusCode).toBe(200);
    await app.close();
  });

  it('l’écriture n’est pas ATTENDUE : la réponse part avant qu’elle se termine', async () => {
    // Initialisé à un no-op plutôt qu'à null : sinon TypeScript ne suit pas l'affectation faite dans
    // l'exécuteur de la Promise et narrow le type à `never`, rendant l'appel plus bas non appelable.
    let resolveWrite: () => void = () => {};
    const started = new Promise<void>((r) => { resolveWrite = r; });
    let finished = false;
    const app = buildServer({
      queue: new FakeQueue(),
      auth: {
        ...faux(),
        secret: SECRET,
        // Écriture qui ne se termine QUE lorsqu'on la débloque : si la route l'attendait, le login pendrait.
        touchLastLogin: async () => { await started; finished = true; },
      },
    });
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    expect(finished).toBe(false); // la réponse est partie sans attendre l'écriture
    resolveWrite();
    await app.close();
  });
});

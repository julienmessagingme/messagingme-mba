import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { hashPasswordSync } from '../src/auth/password';
import type { UserAuthStore, AuthUser } from '../src/auth/store';

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

class FakeUsers implements UserAuthStore {
  constructor(private readonly rows: AuthUser[]) {}
  async findByEmail(email: string): Promise<AuthUser | null> {
    return this.rows.find((u) => u.email === email) ?? null;
  }
}

const login = (app: ReturnType<typeof buildServer>, password = 'pw') =>
  app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co', password } });

describe('dernière connexion', () => {
  it('login réussi -> horodate le BON compte', async () => {
    const touched: string[] = [];
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { users: new FakeUsers([ADMIN]), secret: SECRET, touchLastLogin: async (id) => { touched.push(id); } },
    });
    expect((await login(app)).statusCode).toBe(200);
    expect(touched).toEqual(['u1']);
    await app.close();
  });

  it('login REFUSÉ -> n’horodate rien (sinon la colonne mentirait sur une tentative ratée)', async () => {
    const touched: string[] = [];
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { users: new FakeUsers([ADMIN]), secret: SECRET, touchLastLogin: async (id) => { touched.push(id); } },
    });
    expect((await login(app, 'mauvais')).statusCode).toBe(401);
    expect(touched).toEqual([]);
    await app.close();
  });

  it('l’écriture ÉCHOUE -> le login réussit quand même (fire-and-forget, pas sur le chemin critique)', async () => {
    const app = buildServer({
      queue: new FakeQueue(),
      auth: { users: new FakeUsers([ADMIN]), secret: SECRET, touchLastLogin: async () => { throw new Error('pool saturé'); } },
    });
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ token: string }>().token).toBeTruthy();
    await app.close();
  });

  it('dep ABSENT -> le login réussit (le `?.` sur le retour évite le TypeError)', async () => {
    // C'est exactement la forme utilisée par les autres suites de tests : `auth: { users, secret }` seuls.
    const app = buildServer({ queue: new FakeQueue(), auth: { users: new FakeUsers([ADMIN]), secret: SECRET } });
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
        users: new FakeUsers([ADMIN]),
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

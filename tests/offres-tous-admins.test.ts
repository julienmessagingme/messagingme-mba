import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { roleAdminEffectifSql, roleEffectif, type LimitesMembres } from '../src/offres/membres';
import { facteurExigeSql } from '../src/auth/facteur-exige';
import { DROITS, type Offre } from '../src/offres/offres';
import { PgUserStore } from '../src/user/store.pg';
import { autoriser, type DepsAutoriser } from '../src/oauth/autoriser';
import type { DemandeOauth } from '../src/auth/token';

/**
 * TOUS ADMINISTRATEURS EN PRO (spec du 2026-10-27, décision de Julien : « promus d'office », même un membre restreint d'un
 * Business qui redescend). Le rôle EFFECTIF est `admin` en Pro ; le rôle enregistré ne bouge pas et reprend effet si
 * l'espace remonte en Business.
 */
const RACINE = resolve(__dirname, '..');
const lire = (...p: string[]) => readFileSync(join(RACINE, ...p), 'utf8').split('\r\n').join('\n');

describe('le rôle effectif', () => {
  it('🔴 en Pro, tout membre est administrateur ; ailleurs, son rôle enregistré', () => {
    for (const role of ['agent', 'manager', 'admin']) expect(roleEffectif('pro', role)).toBe('admin');
    for (const o of ['base', 'business', 'entreprise'] as const) {
      expect(roleEffectif(o, 'agent')).toBe('agent');
      expect(roleEffectif(o, 'manager')).toBe('manager');
    }
  });

  it('🔴 sa jumelle SQL dit la même chose, sur l’offre calculée de l’espace', () => {
    expect(roleAdminEffectifSql('u')).toBe("(u.role = 'admin' or offre_de_l_espace(u.tenant_id) = 'pro')");
  });

  it('🔴 le Pro n’a plus de limite d’administrateurs à part : celle de ses utilisateurs suffit', () => {
    expect(DROITS.pro.limites.admins).toBeNull();
  });
});

/** Un faux pool : l'identité et le code se trouvent, l'insertion et la mise à jour se capturent. */
function fauxPool() {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      requetes.push({ sql, params: params ?? [] });
      if (/select public_code/i.test(sql)) return { rows: [{ public_code: 'k7m2p3' }], rowCount: 1 };
      if (/from identities/i.test(sql)) return { rows: [{ id: 'ident-1' }], rowCount: 1 };
      if (/count\(\*\)::int as membres/i.test(sql)) return { rows: [{ membres: 1, admins: 1 }], rowCount: 1 };
      if (/returning/i.test(sql)) return { rows: [{ id: 'x1', email: 'a@b.fr', name: null, role: params?.[2], created_at: new Date(0) }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, requetes };
}
const limites = (offre: Offre): (() => Promise<LimitesMembres>) => async () => ({
  utilisateurs: DROITS[offre].limites.utilisateurs, admins: DROITS[offre].limites.admins, offre,
});

describe('l’équipe d’un Pro', () => {
  it('🔴 une invitation en Pro enregistre un administrateur, quel que soit le rôle demandé', async () => {
    const pro = fauxPool();
    expect((await new PgUserStore(pro.pool, limites('pro')).createPending('t1', 'a@b.fr', 'agent')).role).toBe('admin');
    expect(pro.requetes.find((q) => /insert into users/i.test(q.sql))!.params[2]).toBe('admin');
    const business = fauxPool();
    expect((await new PgUserStore(business.pool, limites('business')).createPending('t1', 'a@b.fr', 'agent')).role).toBe('agent');
  });

  it('🔴 changer un rôle en Pro est refusé, sans rien écrire : les rôles se règlent en Business', async () => {
    const pro = fauxPool();
    expect(await new PgUserStore(pro.pool, limites('pro')).setRole('t1', 'u2', 'agent')).toBe('roles_en_business');
    expect(pro.requetes.filter((q) => /update users/i.test(q.sql))).toEqual([]);
  });
});

describe('autoriser une application (Claude) en Pro', () => {
  const DEMANDE = {
    clientId: 'claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'x'.repeat(43),
    scopes: ['mcp'], state: 'etat', resource: 'https://api.messagingme.app/mcp',
  } as DemandeOauth;
  const deps = (offre: Offre, role: string): DepsAutoriser => ({
    store: { creerAutorisation: async () => ({ autorisationId: 'aut-1' }) } as unknown as DepsAutoriser['store'],
    comptes: { getByEmail: async () => [{ id: 'u2', tenantId: 't1', tenantName: 'Démo', role, disabled: false }] },
    audit: async () => {},
    offreDe: async () => offre,
  });

  it('🔴 un agent d’un Pro autorise, comme tout administrateur ; en Business, non', async () => {
    expect((await autoriser(deps('pro', 'agent'), 'https://api.test', { email: 'a@b.fr' }, 't1', DEMANDE)).ok).toBe(true);
    const refuse = await autoriser(deps('business', 'agent'), 'https://api.test', { email: 'a@b.fr' }, 't1', DEMANDE);
    expect(refuse).toMatchObject({ ok: false, erreur: expect.stringMatching(/administrateur/) });
  });
});

describe('le rôle effectif est appliqué partout où le rôle se relit', () => {
  it('🔴 la session et le jeton OAuth de chaque requête', () => {
    const api = lire('src', 'index.ts');
    expect(api).toMatch(/return s && \{ \.\.\.s, role: roleEffectif\(o\.offre, s\.role\), horsOffre \};/);
    expect(api).toMatch(/offreDe: async \(tenant\) => \(await offresSansCache\.offreDe\(tenant\)\)\.offre,/);
  });

  it('🔴 la validité d’un jeton OAuth et les destinataires des e-mails du produit, en SQL', () => {
    expect(lire('src', 'oauth', 'store.pg.ts')).toContain("${roleAdminEffectifSql('u')}");
    expect(lire('src', 'emails-produit', 'store.pg.ts')).toContain("${roleAdminEffectifSql('u')}");
  });

  it('🔴 jaunes 2 et 3 de la relecture de A : le renouvellement d’un jeton OAuth et le second facteur exigé lisent le rôle effectif', () => {
    // Un membre « agent » d’un Pro autorise Claude : son renouvellement ne doit pas être refusé à chaque heure.
    expect(lire('src', 'oauth', 'store.pg.ts')).not.toMatch(/u\.role = 'admin'/);
    // Un administrateur effectif d’un Pro qui exige le second facteur y est tenu comme un administrateur enregistré.
    expect(facteurExigeSql('i.id')).toContain("offre_de_l_espace(a.tenant_id) = 'pro'");
  });
});

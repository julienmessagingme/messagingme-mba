import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerUsers } from '../src/http/users';
import { registerApiKeys } from '../src/http/api-keys';
import type { AuditSink } from '../src/audit/journal';
import type { PreHandler } from '../src/auth/middleware';

/**
 * LE JOURNAL D'AUDIT COUVRE LES ACCÈS (lot 1 du plan `2026-09-15-audit-des-actions-sensibles.md`).
 *
 * 🔴 CE QUE CE FICHIER GARDE, ET POURQUOI IL EXISTE. Le journal ne connaissait que sept actions, toutes sur
 * les PERSONNES, et aucune sur ce qui donne du POUVOIR : personne ne pouvait dire qui avait nommé un admin,
 * créé une clé d'API ou révoqué un compte. C'est la première question d'un questionnaire sécurité.
 *
 * 🔴 ET L'INVARIANT LE PLUS IMPORTANT N'EST PAS « une ligne est écrite », C'EST CE QU'ELLE CONTIENT. La table
 * `audit_log` n'est JAMAIS purgée par la rétention des contacts : une donnée personnelle écrite dedans
 * devient ineffaçable, et annulerait l'effacement qu'une autre ligne du même journal certifie (migration
 * 0061, « détail non identifiant, jamais de numéro »).
 */

interface Ligne { action: string; target: { kind: string; id: string }; detail: Record<string, unknown> }

function harnais() {
  const lignes: Ligne[] = [];
  const audit: AuditSink = async (_t, _actor, action, target, detail) => {
    lignes.push({ action, target, detail: detail ?? {} });
  };
  return { lignes, audit };
}

/**
 * La garde des tests : elle POSE l'identité au lieu de la vérifier.
 *
 * ⚠️ Elle ne vit QUE dans ce fichier de test, jamais dans `src/` : une garde ouverte importable par le
 * câblage de production serait exactement le défaut que `scopeTenant` a été durci pour fermer.
 */
const gardeQuiPose: PreHandler = async (req) => {
  (req as { auth?: unknown }).auth = { userId: 'moi', tenantId: 't1', role: 'admin' };
};

/** Une app montée avec cette garde : ce qu'on éprouve est le journal, pas l'authentification. */
async function appUsers(audit: AuditSink) {
  const app = Fastify();
  registerUsers(app, {
    audit,
    listUsers: async () => [],
    setUserRole: async () => 'ok',
    setUserDisabled: async () => 'ok',
    deleteUser: async () => 'ok',
    createPendingUser: async () => ({ id: 'u-neuf', email: 'x@y.z', role: 'agent', tenantId: 't1', disabled: false, name: null, createdAt: new Date().toISOString(), lastLoginAt: null }) as never,
    createInviteToken: async () => 'jeton',
  }, gardeQuiPose);
  await app.ready();
  return app;
}

describe('les actions sur les COMPTES laissent une trace', () => {
  it('🔴 un changement de rôle est journalisé, avec le rôle et RIEN d’autre', async () => {
    const h = harnais();
    const app = await appUsers(h.audit);
    const r = await app.inject({ method: 'PATCH', url: '/tenants/t1/users/u2/role', payload: { role: 'admin' } });
    expect(r.statusCode).toBe(200);
    expect(h.lignes).toHaveLength(1);
    expect(h.lignes[0]!.action).toBe('utilisateur.role_change');
    expect(h.lignes[0]!.target).toEqual({ kind: 'user', id: 'u2' });
    expect(h.lignes[0]!.detail).toEqual({ role: 'admin' });
    await app.close();
  });

  it('🔴 une révocation et une suppression aussi', async () => {
    const h = harnais();
    const app = await appUsers(h.audit);
    await app.inject({ method: 'PATCH', url: '/tenants/t1/users/u2/disabled', payload: { disabled: true } });
    await app.inject({ method: 'DELETE', url: '/tenants/t1/users/u2' });
    expect(h.lignes.map((l) => l.action)).toEqual(['utilisateur.desactive', 'utilisateur.retire']);
    await app.close();
  });

  it('🔴 une invitation est journalisée, et le détail ne porte PAS l’adresse', async () => {
    // L'adresse est une donnée personnelle, et cette table ne se purge jamais. L'identifiant du compte créé
    // suffit à retrouver qui, sans le graver pour toujours.
    const h = harnais();
    const app = await appUsers(h.audit);
    const r = await app.inject({ method: 'POST', url: '/tenants/t1/invitations', payload: { email: 'nouveau@client.fr', role: 'agent' } });
    expect(r.statusCode).toBe(201);
    expect(h.lignes[0]!.action).toBe('utilisateur.invite');
    expect(JSON.stringify(h.lignes[0]!.detail)).not.toContain('nouveau@client.fr');
    expect(h.lignes[0]!.detail.role).toBe('agent');
    await app.close();
  });

  it('🔴 un REFUS n’écrit rien : ce journal est un registre de changements, pas de tentatives', async () => {
    /**
     * La nuance décide de la lisibilité de l'écran. Une ligne « rôle changé » sur une requête refusée en 409
     * ferait croire à une modification qui n'a jamais eu lieu, et un journal dans lequel on ne peut pas
     * distinguer ce qui s'est produit de ce qui a été tenté ne sert plus à rien.
     */
    const h = harnais();
    const app = Fastify();
    registerUsers(app, {
      audit: h.audit,
      listUsers: async () => [],
      setUserRole: async () => 'last_admin',
      setUserDisabled: async () => 'not_found',
      deleteUser: async () => 'last_admin',
    }, gardeQuiPose);
    await app.ready();
    expect((await app.inject({ method: 'PATCH', url: '/tenants/t1/users/u2/role', payload: { role: 'agent' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: '/tenants/t1/users/u2/disabled', payload: { disabled: true } })).statusCode).toBe(404);
    expect(h.lignes).toEqual([]);
    await app.close();
  });
});

describe('les CLÉS D’API laissent une trace', () => {
  async function appCles(audit: AuditSink, revoqueOk = true) {
    const app = Fastify();
    registerApiKeys(app, {
      audit,
      createKey: async () => ({ id: 'k1', key: 'mm_secret_en_clair' }),
      listKeys: async () => [],
      revokeKey: async () => revoqueOk,
    }, gardeQuiPose);
    await app.ready();
    return app;
  }

  it('🔴 la création journalise les DROITS, jamais la clé', async () => {
    /**
     * 🔴 LA CLÉ EST MONTRÉE UNE SEULE FOIS À SON PORTEUR. L'écrire ici, même en empreinte, donnerait de quoi
     * la reconnaître bien après sa révocation, dans une table conçue pour ne jamais être modifiée ni purgée.
     * Ce qui compte pour l'exploitation, ce n'est pas la clé, c'est ce qu'elle a le droit de faire.
     */
    const h = harnais();
    const app = await appCles(h.audit);
    const r = await app.inject({ method: 'POST', url: '/tenants/t1/api-keys', payload: { name: 'zapier', scopes: ['contacts:write'] } });
    expect(r.statusCode).toBe(201);
    expect(h.lignes[0]!.action).toBe('cle_api.creee');
    expect(h.lignes[0]!.detail).toEqual({ scopes: ['contacts:write'] });
    expect(JSON.stringify(h.lignes[0])).not.toContain('mm_secret_en_clair');
    await app.close();
  });

  it('🔴 la révocation est journalisée, et seulement quand elle a eu lieu', async () => {
    const h = harnais();
    const ok = await appCles(h.audit, true);
    expect((await ok.inject({ method: 'DELETE', url: '/tenants/t1/api-keys/k1' })).statusCode).toBe(200);
    await ok.close();

    const rate = await appCles(h.audit, false);
    expect((await rate.inject({ method: 'DELETE', url: '/tenants/t1/api-keys/k1' })).statusCode).toBe(404);
    await rate.close();

    expect(h.lignes.map((l) => l.action)).toEqual(['cle_api.revoquee']);
  });
});

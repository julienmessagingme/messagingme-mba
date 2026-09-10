import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { OutilBibliotheque } from '../src/agent/catalog';
import { FakeQueue } from '../src/queue/fake';

/**
 * La bibliothèque d'outils d'un espace.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : le REFUS de supprimer une définition encore rattachée. La contrainte de la
 * migration 0127 est en `on delete cascade` : sans ce refus applicatif, la suppression emporterait en
 * silence le consentement d'agents qu'on ne regardait pas, et l'écran annoncerait un succès.
 */
const TENANT = 't1';
const OUTIL = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-secret';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

let adminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: TENANT, role: 'admin' }, SECRET);
});

/**
 * ⚠️ UN VRAI JETON, PAS UN MONTAGE SANS GARDE. `scopeTenant` ÉCHOUE FERMÉ depuis le 2026-09-03 : sans
 * `req.auth`, elle rend `null` et toute route répond 403. Monter ce module « nu » testerait donc uniquement
 * le refus, ce qui a l'air vert et ne prouve rien.
 *
 * ⚠️ ET C'EST UNE FONCTION, PAS UNE CONSTANTE : un objet figé au chargement du module capturerait `adminTok`
 * ALORS QU'IL EST ENCORE VIDE (il est signé dans `beforeAll`), et chaque appel partirait avec un
 * « Bearer  » vide, donc un 401 partout. Même forme que `tests/http-agent-tools.test.ts`.
 */
const h = (): { headers: Record<string, string> } => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok}` },
});

const BIB: OutilBibliotheque = {
  id: OUTIL, name: 'lire_commande', title: 'Lire', description: 'lit une commande',
  origin: 'mba', risk: 'read', sourceId: null,
  consommateurs: [
    { cle: `agent:${OUTIL}`, actif: true, agentId: OUTIL, agentLabel: 'Support' },
    { cle: 'mba:1234840649713976', actif: false, agentId: null, agentLabel: null },
  ],
};

function monter(verdict: 'ok' | 'rattachee' | 'introuvable') {
  const supprimes: string[][] = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    agentCatalogue: {
      listCatalogue: async () => [BIB],
      supprimerDefinition: async (t, id) => { supprimes.push([t, id]); return verdict; },
    },
  });
  return { app, supprimes };
}

describe('la bibliothèque d’outils', () => {
  it('rend les définitions de l’espace, avec QUI s’en sert', async () => {
    const { app } = monter('ok');
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().outils[0].consommateurs[0].agentLabel).toBe('Support');
  });

  it('🔴 le MBA apparaît comme consommateur, SANS étiquette d’agent', async () => {
    // Il n'a ni fiche, ni modèle, ni crédit : lui inventer un libellé d'agent laisserait croire qu'on peut
    // ouvrir sa fiche. L'écran doit afficher sa clé telle quelle.
    const { app } = monter('ok');
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools`, ...h() });
    const mba = res.json().outils[0].consommateurs[1];
    expect(mba.cle).toBe('mba:1234840649713976');
    expect(mba.agentId).toBeNull();
    expect(mba.agentLabel).toBeNull();
  });

  it('🔴 supprimer une définition encore rattachée rend 409, avec un message lisible', async () => {
    // 409 et pas 500 : Cloudflare remplace le corps de toute réponse 5xx, le message n'arriverait jamais.
    const { app } = monter('rattachee');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/encore utilisé/);
  });

  it('supprimer une définition libre rend 204', async () => {
    const { app, supprimes } = monter('ok');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}`, ...h() });
    expect(res.statusCode).toBe(204);
    expect(supprimes).toEqual([[TENANT, OUTIL]]);
  });

  it('une définition inconnue rend 404', async () => {
    const { app } = monter('introuvable');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}`, ...h() });
    expect(res.statusCode).toBe(404);
  });

  it('🔴 sans jeton, la route REFUSE : scopeTenant echoue ferme', async () => {
    // C'est LE contrôle d'isolation entre clients, pour 235 routes, et la RLS est contournée (pooler
    // superuser). Une route de ce module montée sans garde répondrait 403 partout : ce test dit que le
    // refus vient bien de l'absence de jeton, pas d'un montage bancal.
    const { app } = monter('ok');
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools` });
    expect(res.statusCode).toBe(401);
  });

  it('🔴 un identifiant qui n’est pas un UUID rend 404, sans toucher à la base', async () => {
    // Sans cette garde, Postgres lèverait sur le cast et l'erreur sortirait en 500, dont Cloudflare remplace
    // le corps : le client verrait une page d'erreur générique sur une simple faute de frappe.
    const { app, supprimes } = monter('ok');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/pas-un-uuid`, ...h() });
    expect(res.statusCode).toBe(404);
    expect(supprimes).toEqual([]);
  });
});

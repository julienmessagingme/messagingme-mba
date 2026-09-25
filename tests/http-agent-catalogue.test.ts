import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { OutilBibliotheque } from '../src/agent/catalog';
import { FakeQueue } from './fake-queue';

/**
 * La bibliothèque d'outils d'un espace : ce que les agents IA peuvent brancher.
 *
 * ⚠️ CE FICHIER NE PORTE PLUS QUE LA LECTURE (2026-09-21). Les routes propres à l'agent de Meta (exposer, créer,
 * corriger, supprimer) sont parties avec l'ancien onglet « Outils » du MBA ; leurs cas sont PORTÉS dans
 * `tests/http-mba-outils.test.ts` (titres marqués « porté »). Trois n'ont plus d'objet et sont retirés : cocher
 * rattache et active, décocher détache, un corps sans booléen rend 400. Un outil de l'agent de Meta naît exposé
 * et se retire par `DELETE /mba-outils/:id`.
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
 * `req.auth`, elle rend `null` et toute route répond 403. Et c'est une FONCTION, pas une constante : un objet
 * figé au chargement capturerait `adminTok` alors qu'il est encore vide.
 */
const h = (): { headers: Record<string, string> } => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok}` },
});

const BIB: OutilBibliotheque = {
  id: OUTIL, name: 'lire_commande', title: 'Lire', description: 'lit une commande', nePasUtiliser: 'jamais pour annuler',
  origin: 'http', risk: 'read', sourceId: 's1', mcpNonActivable: null, mcpIndisponibleLe: null,
  consommateurs: [
    { cle: `agent:${OUTIL}`, actif: true, agentId: OUTIL, agentLabel: 'Support' },
    { cle: 'mba:1234840649713976', actif: false, agentId: null, agentLabel: null },
  ],
};

function monter() {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    agentCatalogue: { listCatalogue: async () => [BIB] },
  });
}

describe('la bibliothèque d’outils', () => {
  it('rend les définitions de l’espace, avec QUI s’en sert', async () => {
    const res = await monter().inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().outils[0].consommateurs[0].agentLabel).toBe('Support');
  });

  it('🔴 le MBA apparaît comme consommateur, SANS étiquette d’agent', async () => {
    // Il n'a ni fiche, ni modèle, ni crédit : lui inventer un libellé d'agent laisserait croire qu'on peut
    // ouvrir sa fiche.
    const res = await monter().inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools`, ...h() });
    const mba = res.json().outils[0].consommateurs[1];
    expect(mba.cle).toBe('mba:1234840649713976');
    expect(mba.agentId).toBeNull();
    expect(mba.agentLabel).toBeNull();
  });

  it('🔴 sans jeton, la route REFUSE : scopeTenant échoue fermé', async () => {
    const res = await monter().inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools` });
    expect(res.statusCode).toBe(401);
  });

  it('🔴 les anciennes routes de l’agent de Meta N’EXISTENT PLUS ici', async () => {
    // Une route oubliée resterait joignable par l'API sans aucun écran pour la surveiller.
    const app = monter();
    const b = `/tenants/${TENANT}/agent-tools`;
    for (const [method, url] of [
      ['PUT', `${b}/${OUTIL}/mba`], ['POST', `${b}/connecteur-mba`], ['PATCH', `${b}/${OUTIL}`], ['DELETE', `${b}/${OUTIL}`],
    ] as const) {
      expect((await app.inject({ method, url, ...h(), payload: {} })).statusCode).toBe(404);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { MbaRelaisDeps } from '../src/http/mba-relais';
import type { AppelConnecteur } from '../src/agent/resolvers/http';
import type { JournalAppels } from '../src/agent/catalog';
import { cleApiDeTest } from './aide/cle-api';
import { CHEMIN_RELAIS } from '../src/mba/relais';
import { corpsOutilMeta } from '../src/mba/publication';

/**
 * La route du relais du Meta Business Agent (spec 2026-09-21-relais-mba-design.md).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : l'espace vient de la CLÉ, jamais de l'adresse ; seul un outil exposé à
 * l'agent de Meta de CET espace est appelable ; le contact est celui que Meta désigne par la macro, et une
 * variable du mini-CRM ne peut pas être imposée par le modèle.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly parEmpreinte = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  ajouter(brute: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.parEmpreinte.set(sha256Hex(brute), rec); return this; }
  async findActiveByHash(h: string) { return this.parEmpreinte.get(h) ?? null; }
  async touchLastUsed() {}
}

const CLE_RELAIS = cleApiDeTest('relais');
const CLE_CONTACTS = cleApiDeTest('contacts');
const CLE_AUTRE_ESPACE = cleApiDeTest('autre_espace');

const OUTIL = { id: 'o1', name: 'add_tag', origin: 'http' as const, requestId: 'rq1', timeoutMs: 5_000, maxBytes: 16_384 };

function monter(over: Partial<MbaRelaisDeps> = {}) {
  const appels: AppelConnecteur[] = [];
  const cles = new FakeApiKeys()
    .ajouter(CLE_RELAIS, { id: 'k1', tenantId: 't1', scopes: ['mba:relais'] })
    .ajouter(CLE_CONTACTS, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] })
    .ajouter(CLE_AUTRE_ESPACE, { id: 'k3', tenantId: 't2', scopes: ['mba:relais'] });
  const mbaRelais: MbaRelaisDeps = {
    numeroDuTenant: async (t) => (t === 't1' ? 'pn1' : 'pn2'),
    // Le faux REFUSE ce que le vrai refuse : il ne rend que les outils de l'espace ET du consommateur demandés.
    outilsActifs: async (t, c) => (t === 't1' && c === 'mba:pn1' ? [OUTIL] : []),
    requete: async (t, id) => (t === 't1' && id === 'rq1'
      ? {
          variables: [
            { nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true },
            { nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true },
          ],
        }
      : null),
    contact: async (t, waId) => (t === 't1' && waId === '33612345678' ? { nom: 'Julien', tags: [], champs: { tag_ns: 'vip' } } : null),
    appeler: async (p) => { appels.push(p); return { contenu: { reponse: { success: true } }, httpStatus: 200 }; },
    journal: { ouvrir: async () => 'l1', clore: async () => {} } as unknown as JournalAppels,
    ...over,
  };
  const app = buildServer({
    queue: new FakeQueue(),
    v1: {
      apiKeys: cles,
      contacts: { upsertContacts: async (_t, items) => items.map((_, i) => ({ index: i, status: 'created' as const, contactId: `c${i}` })) },
      mbaRelais,
    },
  });
  return { app, appels };
}

type App = ReturnType<typeof monter>['app'];
const poster = (app: App, cle: string, corps: unknown, entete: string | null = '+33612345678', outil = 'o1') =>
  app.inject({
    method: 'POST', url: `/mba/relais/outils/${outil}`,
    headers: {
      authorization: `Bearer ${cle}`, 'content-type': 'application/json',
      ...(entete === null ? {} : { 'x-contact-whatsapp': entete }),
    },
    payload: JSON.stringify(corps),
  });

describe('le relais du Meta Business Agent', () => {
  it('🔴 appelle le système du client pour le bon contact, avec les valeurs du modèle et le journal `mba`', async () => {
    const { app, appels } = monter();
    const res = await poster(app, CLE_RELAIS, { user: 'u1', tag: 'PIRATE' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: true, statut: 200, reponse: { success: true } });
    expect(appels).toHaveLength(1);
    expect(appels[0]!).toMatchObject({
      tenantId: 't1', waId: '33612345678', requestId: 'rq1', maxBytes: 16_384, args: { user: 'u1' },
      contact: { nom: 'Julien', tags: [], champs: { tag_ns: 'vip' } },
      lecture: { nature: 'entier' }, journal: { source: 'mba', nom: 'add_tag', sessionId: null, toolId: 'o1' },
    });
    // La valeur CHAMP ne vient jamais du modèle : le point de passage la lira dans le mini-CRM.
    expect(appels[0]!.args).not.toHaveProperty('tag');
  });

  it('🔴 sans clé, ou sans le droit `mba:relais`, rien ne part', async () => {
    const { app, appels } = monter();
    expect((await app.inject({ method: 'POST', url: '/mba/relais/outils/o1', payload: {} })).statusCode).toBe(401);
    expect((await poster(app, CLE_CONTACTS, { user: 'u1' })).statusCode).toBe(403);
    expect(appels).toHaveLength(0);
  });

  it('🔴 une clé d’un AUTRE espace n’atteint pas l’outil de celui-ci', async () => {
    const { app, appels } = monter();
    expect((await poster(app, CLE_AUTRE_ESPACE, { user: 'u1' })).json())
      .toEqual({ succes: false, erreur: 'cet outil n’est pas proposé à l’agent de Meta' });
    expect(appels).toHaveLength(0);
  });

  it('un outil non exposé, un numéro absent ou un contact inconnu : refus lisible, aucun appel', async () => {
    const { app, appels } = monter();
    expect((await poster(app, CLE_RELAIS, { user: 'u1' }, '+33612345678', 'autre')).json())
      .toEqual({ succes: false, erreur: 'cet outil n’est pas proposé à l’agent de Meta' });
    expect((await poster(app, CLE_RELAIS, { user: 'u1' }, null)).json())
      .toEqual({ succes: false, erreur: 'le client n’est pas identifié : son numéro WhatsApp manque' });
    expect((await poster(app, CLE_RELAIS, { user: 'u1' }, '+33700000000')).json())
      .toEqual({ succes: false, erreur: 'ce client est introuvable dans le carnet de contacts' });
    expect(appels).toHaveLength(0);
  });

  it('un espace sans numéro WhatsApp n’expose rien', async () => {
    const { app, appels } = monter({ numeroDuTenant: async () => null });
    expect((await poster(app, CLE_RELAIS, { user: 'u1' })).json().succes).toBe(false);
    expect(appels).toHaveLength(0);
  });

  it('une valeur du modèle invalide est refusée en la nommant', async () => {
    const { app, appels } = monter();
    expect((await poster(app, CLE_RELAIS, {})).json()).toEqual({ succes: false, erreur: 'valeur manquante ou invalide pour : user' });
    expect(appels).toHaveLength(0);
  });

  it('un échec du système du client revient en `succes: false`, avec le message sûr', async () => {
    const { app } = monter({
      appeler: async () => ({ ok: false, contenu: { erreur: 'le système du client est indisponible' }, erreur: 'indispo' }),
    });
    const res = await poster(app, CLE_RELAIS, { user: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: false, erreur: 'le système du client est indisponible' });
  });

  it('🔴 la forme de l’en-tête est mesurée, jamais sa valeur', async () => {
    const formes: string[] = [];
    const { app } = monter({ journaliserForme: (f) => { formes.push(f); } });
    await poster(app, CLE_RELAIS, { user: 'u1' });
    expect(formes).toEqual(['len=12 plus=true chiffres=true']);
  });

  it('🔴 la clé du relais n’ouvre PAS l’API publique', async () => {
    const { app } = monter();
    const res = await app.inject({
      method: 'POST', url: '/v1/contacts',
      headers: { authorization: `Bearer ${CLE_RELAIS}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ phone: '+33612345678', name: 'Marc' }),
    });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 un POST annoncé en JSON mais SANS corps passe : c’est le cas d’un outil sans variable du modèle', async () => {
    // Un outil dont toutes les valeurs viennent du mini-CRM est publié SANS corps chez Meta. Le lecteur de JSON
    // par défaut de Fastify refuse un corps vide en 400, avant la route : c'est celui du webhook Meta, monté
    // pour tout le serveur, qui le laisse passer. Ce test tombe le jour où l'on change de lecteur.
    const { app, appels } = monter({
      requete: async () => ({ variables: [{ nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true }] }),
    });
    for (const payload of [undefined, '']) {
      const res = await app.inject({
        method: 'POST', url: '/mba/relais/outils/o1',
        headers: { authorization: `Bearer ${CLE_RELAIS}`, 'content-type': 'application/json', 'x-contact-whatsapp': '+33612345678' },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().succes).toBe(true);
    }
    expect(appels).toHaveLength(2);
  });

  it('🔴 l’adresse PUBLIÉE chez Meta (base du connecteur + chemin de l’outil) tombe sur la route montée', async () => {
    // Trois morceaux dans trois fichiers : si l'un bouge seul, chaque appel de Meta part sur une 404.
    const chemin = corpsOutilMeta({ id: 'o1', name: 'add_tag', description: 'x', nePasUtiliser: '', variables: [] })
      .request_definition.path as string;
    const { app, appels } = monter();
    const res = await app.inject({
      method: 'POST', url: `${CHEMIN_RELAIS}${chemin}`,
      headers: { authorization: `Bearer ${CLE_RELAIS}`, 'content-type': 'application/json', 'x-contact-whatsapp': '+33612345678' },
      payload: JSON.stringify({ user: 'u1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(appels).toHaveLength(1);
  });
});

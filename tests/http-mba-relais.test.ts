import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { AntiRejeu } from '../src/mba/anti-rejeu';
import { FakeQueue } from '../src/queue/fake';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { MbaRelaisDeps } from '../src/http/mba-relais';
import type { AppelConnecteur } from '../src/agent/resolvers/http';
import type { JournalAppels } from '../src/agent/catalog';
import { cleApiDeTest } from './aide/cle-api';
import { baseDuRelais } from '../src/mba/relais';
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

const OUTIL = { id: 'o1', name: 'add_tag', origin: 'http' as const, requestId: 'rq1', timeoutMs: 5_000, maxBytes: 16_384, binding: {} };

function monter(over: Partial<MbaRelaisDeps> = {}) {
  const appels: AppelConnecteur[] = [];
  const gestes: string[] = [];
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
    maison: {
      poserTag: async (t, w, tag) => { gestes.push(`tag ${t} ${w} ${tag}`); },
      ecrireChamp: async (t, w, champ, valeur) => { gestes.push(`champ ${t} ${w} ${champ}=${valeur}`); },
      champExiste: async () => true,
      estBloque: async () => false, antiRejeu: new AntiRejeu(60_000),
      envoyerBloc: async (t, w, c) => { gestes.push(`bloc ${t} ${w} ${c.workflowId} ${c.code}`); return true; },
      lancerScenario: async (t, w, id) => { gestes.push(`scenario ${t} ${w} ${id}`); return true; },
    },
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
  return { app, appels, gestes };
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
    const base = baseDuRelais('https://api.messagingme.app/');
    const { app, appels } = monter();
    const res = await app.inject({
      method: 'POST', url: `${new URL(base!).pathname}${chemin}`,
      headers: { authorization: `Bearer ${CLE_RELAIS}`, 'content-type': 'application/json', 'x-contact-whatsapp': '+33612345678' },
      payload: JSON.stringify({ user: 'u1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(appels).toHaveLength(1);
  });

  it('🔴 un corps JSON ILLISIBLE est refusé, jamais pris pour un corps vide', async () => {
    // Le lecteur de JSON du serveur rend `{}` sur un JSON invalide : sans relire le corps brut, l'appel
    // partait sans ses valeurs facultatives, sans aucun signal.
    const { app, appels } = monter();
    const res = await app.inject({
      method: 'POST', url: '/mba/relais/outils/o1',
      headers: { authorization: `Bearer ${CLE_RELAIS}`, 'content-type': 'application/json', 'x-contact-whatsapp': '+33612345678' },
      payload: '{pas du json',
    });
    expect(res.json()).toEqual({ succes: false, erreur: 'le corps de la requête n’est pas du JSON lisible' });
    expect(appels).toHaveLength(0);
  });

  it('un outil qui ne lit AUCUN corps n’est pas refusé pour un corps illisible', async () => {
    // Toutes ses valeurs viennent du mini-CRM : le corps n'est pas lu, et ce que Meta envoie alors n'est pas
    // mesuré. Le refuser casserait l'outil pour un corps qu'on n'aurait de toute façon pas lu.
    const { app, appels } = monter({
      requete: async () => ({ variables: [{ nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true }] }),
    });
    const res = await app.inject({
      method: 'POST', url: '/mba/relais/outils/o1',
      headers: { authorization: `Bearer ${CLE_RELAIS}`, 'content-type': 'application/json', 'x-contact-whatsapp': '+33612345678' },
      payload: '{pas du json',
    });
    expect(res.json().succes).toBe(true);
    expect(appels).toHaveLength(1);
  });
});

/**
 * LES GESTES MAISON (spec 2026-09-21-outils-maison-mba) : le relais les exécute lui-même, sans appeler personne.
 * 🔴 Une action d'agent IA exposée au MBA par l'ancienne route a un handler inconnu ici : refusée, jamais jouée.
 */
const TAG = {
  id: 'o2', name: 'marquer_vip', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'tag_fixe', tag: 'vip' },
};
const CHAMP = {
  id: 'o3', name: 'noter_ville', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris', 'Lyon'] },
};
const ACTION_IA = {
  id: 'o4', name: 'mba_poser_tag', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'poser_tag' },
};

describe('les outils maison de l’agent de Meta', () => {
  const avec = (outils: unknown[], over: Partial<MbaRelaisDeps> = {}) => monter({
    outilsActifs: async (t, c) => (t === 't1' && c === 'mba:pn1' ? outils as never : []),
    ...over,
  });

  it('🔴 pose l’étiquette FIXÉE sur le contact de l’en-tête, sans rien appeler d’extérieur', async () => {
    const { app, appels, gestes } = avec([TAG]);
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: true, reponse: expect.stringContaining('fiche du client') });
    expect(gestes).toEqual(['tag t1 33612345678 vip']);
    expect(appels).toHaveLength(0);
  });

  it('écrit la valeur envoyée par Meta dans le champ fixé', async () => {
    const { app, gestes } = avec([CHAMP]);
    const res = await poster(app, CLE_RELAIS, { valeur: 'Lyon' }, '+33612345678', 'o3');
    expect(res.json().succes).toBe(true);
    expect(gestes).toEqual(['champ t1 33612345678 ville=Lyon']);
  });

  it('🔴 une valeur hors liste est refusée en 200, avec la liste, et RIEN n’est écrit', async () => {
    const { app, gestes } = avec([CHAMP]);
    const res = await poster(app, CLE_RELAIS, { valeur: 'Marseille' }, '+33612345678', 'o3');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: false, erreur: expect.stringContaining('Paris, Lyon') });
    expect(gestes).toEqual([]);
  });

  it('🔴 une action d’agent IA exposée au MBA n’est PAS exécutée (handler inconnu ici)', async () => {
    const { app, gestes } = avec([ACTION_IA]);
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o4');
    expect(res.json()).toEqual({ succes: false, erreur: 'cet outil n’est pas proposé à l’agent de Meta' });
    expect(gestes).toEqual([]);
  });

  it('🔴 sans contact identifié, aucun geste', async () => {
    const { app, gestes } = avec([TAG]);
    const res = await poster(app, CLE_RELAIS, {}, null, 'o2');
    expect(res.json().succes).toBe(false);
    expect(gestes).toEqual([]);
  });

  it('🔴 l’appel est journalisé sous l’appelant `mba`, sans aucune valeur du client', async () => {
    const ouverts: Array<Record<string, unknown>> = [];
    const clos: Array<Record<string, unknown>> = [];
    const { app } = avec([CHAMP], {
      journal: {
        ouvrir: async (e: Record<string, unknown>) => { ouverts.push(e); return 'l1'; },
        clore: async (e: Record<string, unknown>) => { clos.push(e); },
      } as unknown as JournalAppels,
    });
    await poster(app, CLE_RELAIS, { valeur: 'Lyon' }, '+33612345678', 'o3');
    expect(ouverts).toEqual([expect.objectContaining({ source: 'mba', origin: 'mba', toolId: 'o3', toolName: 'noter_ville', sessionId: null })]);
    expect(JSON.stringify(ouverts[0]?.argsRediges)).not.toContain('Lyon');
    expect(clos).toEqual([expect.objectContaining({ id: 'l1', status: 'ok' })]);
  });

  it('🔴 un geste qui plante est refusé proprement, et journalisé en échec', async () => {
    const clos: Array<Record<string, unknown>> = [];
    const { app } = avec([TAG], {
      maison: {
        poserTag: async () => { throw new Error('base indisponible'); }, ecrireChamp: async () => {}, champExiste: async () => true,
        estBloque: async () => false, antiRejeu: new AntiRejeu(60_000), envoyerBloc: async () => true, lancerScenario: async () => true,
      },
      journal: { ouvrir: async () => 'l1', clore: async (e: Record<string, unknown>) => { clos.push(e); } } as unknown as JournalAppels,
    });
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o2');
    expect(res.statusCode).toBe(200);
    expect(res.json().succes).toBe(false);
    expect(clos).toEqual([expect.objectContaining({ status: 'erreur_outil' })]);
  });
});

const WF = '11111111-1111-4111-8111-111111111111';
const CODE_BLOC = `nod_abc_${'A'.repeat(26)}`;
const BLOC = {
  id: 'o5', name: 'envoyer_brochure', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE_BLOC },
};
const SCENARIO = {
  id: 'o6', name: 'lancer_accueil', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'scenario_fixe', workflowId: WF },
};

describe('un bloc et un scénario, par le relais', () => {
  const avec = (outils: unknown[], over: Partial<MbaRelaisDeps> = {}) => monter({
    outilsActifs: async (t, c) => (t === 't1' && c === 'mba:pn1' ? outils as never : []),
    ...over,
  });

  it('🔴 envoie le bloc FIXÉ au contact de l’en-tête, et dit à l’agent de Meta de ne pas rappeler l’outil', async () => {
    const { app, appels, gestes } = avec([BLOC]);
    const res = await poster(app, CLE_RELAIS, { code: 'autre' }, '+33612345678', 'o5');
    expect(res.json()).toEqual({ succes: true, reponse: expect.stringContaining('Ne rappelle pas cet outil') });
    expect(gestes).toEqual([`bloc t1 33612345678 ${WF} ${CODE_BLOC}`]);
    expect(appels).toHaveLength(0);
  });

  it('🔴 sept appels du même outil pour le même client : un seul lancement (essai réel du 2026-09-22)', async () => {
    const { app, gestes } = avec([SCENARIO]);
    const reponses: string[] = [];
    for (let i = 0; i < 7; i += 1) reponses.push((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o6')).json().reponse);
    expect(gestes).toEqual([`scenario t1 33612345678 ${WF}`]);
    expect(reponses.slice(1).every((r) => r.includes('déjà d’être traitée'))).toBe(true);
  });

  it('🔴 sept appels SIMULTANÉS par le relais : un seul lancement (revue finale du 2026-09-22)', async () => {
    const lances: string[] = [];
    const { app } = avec([SCENARIO], {
      maison: {
        poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true,
        // Un contrôle du blocage qui PREND DU TEMPS, comme la base : c'est pendant cette attente que des appels
        // simultanés se rattrapent. Avec une réponse immédiate, les requêtes arrivent décalées et le test ne
        // prouve rien (mesuré : il passait sur le garde fautif).
        estBloque: () => new Promise((r) => { setTimeout(() => r(false), 20); }),
        antiRejeu: new AntiRejeu(60_000),
        envoyerBloc: async () => true,
        lancerScenario: async (t, w, id) => { lances.push(`scenario ${t} ${w} ${id}`); return true; },
      },
    });
    const res = await Promise.all(Array.from({ length: 7 }, () => poster(app, CLE_RELAIS, {}, '+33612345678', 'o6')));
    expect(res.every((r) => r.json().succes === true)).toBe(true);
    expect(lances).toEqual([`scenario t1 33612345678 ${WF}`]);
  });

  it('lance le scénario fixé', async () => {
    const { app, gestes } = avec([SCENARIO]);
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o6');
    expect(res.json().succes).toBe(true);
    expect(gestes).toEqual([`scenario t1 33612345678 ${WF}`]);
  });

  it('🔴 un refus est journalisé `refuse` avec sa raison, et rendu à l’agent de Meta en 200', async () => {
    const clos: Array<Record<string, unknown>> = [];
    const { app } = avec([BLOC], {
      maison: {
        poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true, estBloque: async () => false, antiRejeu: new AntiRejeu(60_000),
        envoyerBloc: async () => 'la fenêtre de 24 h est fermée : ce bloc ne peut pas partir', lancerScenario: async () => true,
      },
      journal: { ouvrir: async () => 'l1', clore: async (e: Record<string, unknown>) => { clos.push(e); } } as unknown as JournalAppels,
    });
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o5');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: false, erreur: 'la fenêtre de 24 h est fermée : ce bloc ne peut pas partir' });
    expect(clos).toEqual([expect.objectContaining({ status: 'refuse', erreur: expect.stringContaining('24 h') })]);
  });

  it('🔴 un envoi qui PLANTE ne s’invite pas à réessayer : le message est peut-être déjà parti', async () => {
    const clos: Array<Record<string, unknown>> = [];
    const { app } = avec([BLOC], {
      maison: {
        poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true, estBloque: async () => false, antiRejeu: new AntiRejeu(60_000),
        envoyerBloc: async () => { throw new Error('Meta API error (HTTP 400)'); }, lancerScenario: async () => true,
      },
      journal: { ouvrir: async () => 'l1', clore: async (e: Record<string, unknown>) => { clos.push(e); } } as unknown as JournalAppels,
    });
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o5');
    expect(res.statusCode).toBe(200);
    expect(res.json().erreur).toContain('ne relance pas');
    expect(res.json().erreur).not.toContain('réessayez');
    expect(clos).toEqual([expect.objectContaining({ status: 'erreur_outil' })]);
  });

  it('🔴 un contact bloqué ne reçoit rien', async () => {
    const envois: string[] = [];
    const { app } = avec([BLOC, SCENARIO], {
      maison: {
        poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true, estBloque: async () => true, antiRejeu: new AntiRejeu(60_000),
        envoyerBloc: async () => { envois.push('bloc'); return true; }, lancerScenario: async () => { envois.push('scenario'); return true; },
      },
    });
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o5')).json().succes).toBe(false);
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o6')).json().succes).toBe(false);
    expect(envois).toEqual([]);
  });
});

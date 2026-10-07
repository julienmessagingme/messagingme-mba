import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server';
import { contactsV1Muets } from './aide/contacts-v1';
import { verrousEnMemoire } from './verrous';
import { creerTravauxEnVol } from '../src/lib/en-vol';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { ATTENTE_GESTES_A_L_ARRET_MS, DELAI_REPONSE_ENVOI_MS, DELAI_REPONSE_MCP_MS, type MbaRelaisDeps } from '../src/http/mba-relais';
import { FIN_DE_TOUR_MAX_MS } from '../src/mba/fin-de-tour';
import { FILET_ARRET_MS } from '../src/shutdown';
import { REPONSE_EN_COURS, REPONSE_MAISON } from '../src/mba/outils-maison';
import type { AppelConnecteur } from '../src/agent/resolvers/http';
import type { JournalAppels, OutilDefini } from '../src/agent/catalog';
import type { EntreeResolveur } from '../src/agent/executor';
import { cleApiDeTest, aucunJetonOauth } from './aide/cle-api';
import { baseDuRelais } from '../src/mba/relais';
import { corpsOutilMeta } from '../src/mba/publication';
import { relaisMbaInerte } from './routes-inertes';

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

const OUTIL = {
  id: 'o1', name: 'add_tag', origin: 'http' as const, requestId: 'rq1', timeoutMs: 5_000, maxBytes: 16_384, binding: {},
  params: [], mcpNonActivable: null, mcpIndisponibleLe: null,
} as unknown as OutilDefini;

function monter(over: Partial<MbaRelaisDeps> = {}) {
  const appels: AppelConnecteur[] = [];
  const gestes: string[] = [];
  const cles = new FakeApiKeys()
    .ajouter(CLE_RELAIS, { id: 'k1', tenantId: 't1', scopes: ['mba:relais'] })
    .ajouter(CLE_CONTACTS, { id: 'k2', tenantId: 't1', scopes: ['contacts:write'] })
    .ajouter(CLE_AUTRE_ESPACE, { id: 'k3', tenantId: 't2', scopes: ['mba:relais'] });
  const mbaRelais: MbaRelaisDeps = {
    ...relaisMbaInerte,
    numeros: {
      getTenantPhoneNumberId: async (t) => (t === 't1' ? 'pn1' : 'pn2'),
    },
    catalogue: {
      // Le faux REFUSE ce que le vrai refuse : il ne rend que les outils de l'espace ET du consommateur demandés.
      listActifsConsommateur: async (t, c) => (t === 't1' && c === 'mba:pn1' ? [OUTIL] : []),
    },
    requetes: {
      parId: async (t, id) => (t === 't1' && id === 'rq1'
        ? {
            methode: 'POST',
            variables: [
              { nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true },
              { nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true },
            ],
          }
        : null),
    },
    contacts: {
      projectionPourTiers: async (t, waId) => (t === 't1' && waId === '33612345678' ? { nom: 'Julien', tags: [], champs: { tag_ns: 'vip' } } : null),
    },
    appeler: async (p) => { appels.push(p); return { contenu: { reponse: { success: true } }, httpStatus: 200 }; },
    journal: { ouvrir: async () => 'l1', clore: async () => {} } as unknown as JournalAppels,
    maison: {
      poserTag: async (t, w, tag) => { gestes.push(`tag ${t} ${w} ${tag}`); },
      ecrireChamp: async (t, w, champ, valeur) => { gestes.push(`champ ${t} ${w} ${champ}=${valeur}`); },
      champExiste: async () => true,
      contacts: { isBlockedByWaId: async () => false }, antiRejeu: verrousEnMemoire(),
      inbox: { dernierMessageDuClient: async () => 'm1' },
      envoyerBloc: async (t, w, c) => { gestes.push(`bloc ${t} ${w} ${c.workflowId} ${c.code}`); return true; },
      lancerScenario: async (t, w, id) => { gestes.push(`scenario ${t} ${w} ${id}`); return true; },
    },
    // Par défaut le délai ne s'écoule JAMAIS : chaque test lit l'issue réelle du geste, comme avant le délai.
    attendre: () => new Promise<void>(() => {}),
    signalerEchecTardif: async () => {},
    enVol: creerTravauxEnVol(),
    ...over,
  };
  const app = buildServer({
    queue: new FakeQueue(),
    v1: {
      apiKeys: cles,
      oauth: aucunJetonOauth,
      contacts: contactsV1Muets(),
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

  /**
   * Le bac à sable de Meta (`agent_test`) remplit la macro du numéro de 16 chiffres, qui ne désignent aucun client
   * (mesuré le 2026-10-07 sur l'outil de devis de Groupama). Un devis : un GET qui lit, au risque `read`, dont les
   * variables viennent du seul modèle.
   */
  const SANS_CLIENT = '1234567890123456';
  const DEVIS = { ...OUTIL, nature: 'integre', risk: 'read' } as OutilDefini;
  const requeteDevis = (over: Record<string, unknown> = {}) => ({
    methode: 'GET', variables: [{ nom: 'race', type: 'string', origine: { type: 'modele' }, requis: true }], ...over,
  });
  const monterDevis = (rq: Record<string, unknown> = requeteDevis(), outil: OutilDefini = DEVIS) => monter({
    catalogue: { listActifsConsommateur: async (t, c) => (t === 't1' && c === 'mba:pn1' ? [outil] : []) },
    requetes: { parId: async (t, id) => (t === 't1' && id === 'rq1' ? rq : null) } as MbaRelaisDeps['requetes'],
  });

  it('🔴 sans client identifié (bac à sable de Meta), un appel qui LIT sans rien savoir du contact part, sans contact', async () => {
    const { app, appels } = monterDevis();
    const res = await poster(app, CLE_RELAIS, { race: 'berger australien' }, SANS_CLIENT);
    expect(res.json()).toEqual({ succes: true, statut: 200, reponse: { success: true } });
    expect(appels).toHaveLength(1);
    expect(appels[0]!).toMatchObject({
      tenantId: 't1', waId: '', contact: null, requestId: 'rq1', args: { race: 'berger australien' },
      lecture: { nature: 'entier' }, journal: { source: 'mba', nom: 'add_tag', sessionId: null, toolId: 'o1' },
    });
    // Un numéro bien formé mais absent du carnet : même règle.
    expect((await poster(app, CLE_RELAIS, { race: 'labrador' }, '+33700000000')).json().succes).toBe(true);
    expect(appels).toHaveLength(2);
  });

  it('🔴 sans client identifié, un appel qui lit la fiche, qui écrit ou qui pousse reste refusé, sans rien appeler', async () => {
    const cas: Array<[string, ReturnType<typeof monterDevis>]> = [
      ['une variable de la fiche', monterDevis(requeteDevis({
        variables: [{ nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true }],
      }))],
      ['un POST', monterDevis(requeteDevis({ methode: 'POST' }))],
      ['un outil qui pousse', monterDevis(requeteDevis(), { ...DEVIS, nature: 'pousse' } as OutilDefini)],
      ['un risque d’écriture', monterDevis(requeteDevis(), { ...DEVIS, risk: 'write' } as OutilDefini)],
    ];
    for (const [quoi, { app, appels }] of cas) {
      expect((await poster(app, CLE_RELAIS, { race: 'x' }, SANS_CLIENT)).json(), quoi)
        .toEqual({ succes: false, erreur: 'le client n’est pas identifié : son numéro WhatsApp manque' });
      expect((await poster(app, CLE_RELAIS, { race: 'x' }, '+33700000000')).json(), quoi)
        .toEqual({ succes: false, erreur: 'ce client est introuvable dans le carnet de contacts' });
      expect(appels, quoi).toHaveLength(0);
    }
  });

  it('un espace sans numéro WhatsApp n’expose rien', async () => {
    const { app, appels } = monter({ numeros: { getTenantPhoneNumberId: async () => null } });
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
      requetes: {
        parId: async () => ({ methode: 'POST', variables: [{ nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true }] }),
      },
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
      requetes: {
        parId: async () => ({ methode: 'POST', variables: [{ nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true }] }),
      },
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
    catalogue: {
      listActifsConsommateur: async (t, c) => (t === 't1' && c === 'mba:pn1' ? outils as never : []),
    },
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
    // Les 16 chiffres du bac à sable de Meta non plus : un geste agit pour quelqu'un.
    expect((await poster(app, CLE_RELAIS, {}, '1234567890123456', 'o2')).json().succes).toBe(false);
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
        contacts: { isBlockedByWaId: async () => false }, antiRejeu: verrousEnMemoire(),
        inbox: { dernierMessageDuClient: async () => 'm1' },
        envoyerBloc: async () => true, lancerScenario: async () => true,
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
    catalogue: {
      listActifsConsommateur: async (t, c) => (t === 't1' && c === 'mba:pn1' ? outils as never : []),
    },
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
        contacts: {
          // Un contrôle du blocage qui PREND DU TEMPS, comme la base : c'est pendant cette attente que des appels
          // simultanés se rattrapent. Avec une réponse immédiate, les requêtes arrivent décalées et le test ne
          // prouve rien (mesuré : il passait sur le garde fautif).
          isBlockedByWaId: () => new Promise((r) => { setTimeout(() => r(false), 20); }),
        },
        antiRejeu: verrousEnMemoire(),
        inbox: { dernierMessageDuClient: async () => 'm1' },
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
        poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true,
        contacts: { isBlockedByWaId: async () => false }, antiRejeu: verrousEnMemoire(),
        inbox: { dernierMessageDuClient: async () => 'm1' },
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
        poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true,
        contacts: { isBlockedByWaId: async () => false }, antiRejeu: verrousEnMemoire(),
        inbox: { dernierMessageDuClient: async () => 'm1' },
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
        poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true,
        contacts: { isBlockedByWaId: async () => true }, antiRejeu: verrousEnMemoire(),
        inbox: { dernierMessageDuClient: async () => 'm1' },
        envoyerBloc: async () => { envois.push('bloc'); return true; }, lancerScenario: async () => { envois.push('scenario'); return true; },
      },
    });
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o5')).json().succes).toBe(false);
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o6')).json().succes).toBe(false);
    expect(envois).toEqual([]);
  });
});

/**
 * 🔴 UN ENVOI N'EST ATTENDU QUE `DELAI_REPONSE_ENVOI_MS` (essai réel du 2026-09-22) : un envoi de bloc de 3 005 ms a été
 * traité par Meta comme un échec, et son agent a annoncé au client qu'un humain reprenait la conversation.
 */
describe('le délai de réponse d’un envoi', () => {
  const maison = (o: Partial<MbaRelaisDeps['maison']>): MbaRelaisDeps['maison'] => ({
    poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true,
    contacts: { isBlockedByWaId: async () => false },
    antiRejeu: verrousEnMemoire(), inbox: { dernierMessageDuClient: async () => 'm1' },
    envoyerBloc: async () => true, lancerScenario: async () => true, ...o,
  });
  const journal = (clos: Array<Record<string, unknown>>) =>
    ({ ouvrir: async () => 'l1', clore: async (e: Record<string, unknown>) => { clos.push(e); } }) as unknown as JournalAppels;
  const avec = (outils: unknown[], over: Partial<MbaRelaisDeps>) => monter({
    catalogue: {
      listActifsConsommateur: async (t, c) => (t === 't1' && c === 'mba:pn1' ? outils as never : []),
    },
    ...over,
  });

  it('🔴 un envoi LENT : Meta lit « c’est parti » au délai, l’envoi continue, et le journal dit son issue réelle', async () => {
    let finir: (v: true | string) => void = () => {};
    const lent = new Promise<true | string>((r) => { finir = r; });
    const clos: Array<Record<string, unknown>> = [];
    const delais: number[] = [];
    const { app } = avec([SCENARIO], {
      maison: maison({ lancerScenario: () => lent }),
      journal: journal(clos),
      attendre: async (ms) => { delais.push(ms); },
    });
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o6');
    expect(res.json()).toEqual({ succes: true, reponse: REPONSE_EN_COURS.scenario_fixe });
    expect(delais).toEqual([DELAI_REPONSE_ENVOI_MS]);
    // Pas encore clos : l'envoi n'a pas fini. Il se clôt sur son issue RÉELLE, après la réponse à Meta.
    expect(clos).toEqual([]);
    finir(true);
    await vi.waitFor(() => { expect(clos).toEqual([expect.objectContaining({ status: 'ok' })]); });
  });

  it('🔴 un envoi lent qui finit en REFUS ou qui PLANTE après le délai : journalisé, jamais une promesse perdue', async () => {
    for (const fin of ['refus', 'panne'] as const) {
      let finir: () => void = () => {};
      const lent = new Promise<void>((r) => { finir = r; });
      const clos: Array<Record<string, unknown>> = [];
      const { app } = avec([BLOC], {
        maison: maison({
          envoyerBloc: async () => {
            await lent;
            if (fin === 'panne') throw new Error('Meta API error (HTTP 500)');
            return 'la fenêtre de 24 h est fermée';
          },
        }),
        journal: journal(clos),
        attendre: async () => {},
      });
      expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o5')).json()).toEqual({ succes: true, reponse: REPONSE_EN_COURS.bloc_fixe });
      finir();
      await vi.waitFor(() => {
        expect(clos).toEqual([expect.objectContaining({ status: fin === 'panne' ? 'erreur_outil' : 'refuse' })]);
      });
    }
  });

  it('🔴 un refus RAPIDE (avant tout appel à Meta) arrive dans le délai : l’agent de Meta le lit', async () => {
    const { app } = avec([BLOC], {
      maison: maison({ envoyerBloc: async () => 'ce bloc n’existe plus dans le scénario' }),
      attendre: () => new Promise<void>((r) => { setTimeout(r, 200); }),
    });
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o5')).json())
      .toEqual({ succes: false, erreur: 'ce bloc n’existe plus dans le scénario' });
  });

  it('🔴 un échec APRÈS « c’est parti » est dit à l’agent de Meta, avec sa raison (revue du 2026-09-22)', async () => {
    // Sans ça, l'agent (qui a lu « n'écris rien de plus » pour un scénario) restait muet, le client sans réponse.
    for (const fin of ['refus', 'panne'] as const) {
      let finir: () => void = () => {};
      const lent = new Promise<void>((r) => { finir = r; });
      const signales: Array<[string, string, string]> = [];
      const { app } = avec([SCENARIO], {
        maison: maison({
          lancerScenario: async () => {
            await lent;
            if (fin === 'panne') throw new Error('Meta API error (HTTP 500)');
            return 'le contact s’est désabonné';
          },
        }),
        attendre: async () => {},
        signalerEchecTardif: async (t, w, raison) => { signales.push([t, w, raison]); },
      });
      expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o6')).json()).toEqual({ succes: true, reponse: REPONSE_EN_COURS.scenario_fixe });
      expect(signales).toEqual([]);
      finir();
      await vi.waitFor(() => { expect(signales).toHaveLength(1); });
      expect(signales[0]!.slice(0, 2)).toEqual(['t1', '33612345678']);
      expect(signales[0]![2]).toContain(fin === 'panne' ? 'ne relance pas' : 'désabonné');
    }
  });

  it('🔴 un envoi lent qui RÉUSSIT, ou un refus lu à temps par Meta, ne signale rien', async () => {
    const signales: string[] = [];
    const lent = avec([SCENARIO], {
      maison: maison({ lancerScenario: () => new Promise<true>((r) => { setTimeout(() => r(true), 20); }) }),
      attendre: async () => {},
      signalerEchecTardif: async (_t, _w, raison) => { signales.push(raison); },
    });
    await poster(lent.app, CLE_RELAIS, {}, '+33612345678', 'o6');
    const rapide = avec([BLOC], {
      maison: maison({ envoyerBloc: async () => 'ce bloc n’existe plus dans le scénario' }),
      attendre: () => new Promise<void>((r) => { setTimeout(r, 200); }),
      signalerEchecTardif: async (_t, _w, raison) => { signales.push(raison); },
    });
    expect((await poster(rapide.app, CLE_RELAIS, {}, '+33612345678', 'o5')).json().succes).toBe(false);
    await new Promise((r) => { setTimeout(r, 60); });
    expect(signales).toEqual([]);
  });

  it('un signalement qui ÉCHOUE ne fait rien tomber : il est rattrapé, et le journal reste clos', async () => {
    let finir: () => void = () => {};
    const lent = new Promise<void>((r) => { finir = r; });
    const clos: Array<Record<string, unknown>> = [];
    const { app } = avec([BLOC], {
      maison: maison({ envoyerBloc: async () => { await lent; return 'la fenêtre de 24 h est fermée'; } }),
      journal: journal(clos),
      attendre: async () => {},
      signalerEchecTardif: async () => { throw new Error('Meta indisponible'); },
    });
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o5')).json().succes).toBe(true);
    finir();
    await vi.waitFor(() => { expect(clos).toEqual([expect.objectContaining({ status: 'refuse' })]); });
    await new Promise((r) => { setTimeout(r, 20); });
  });

  it('un tag, écriture locale, n’est PAS borné : il est attendu jusqu’au bout', async () => {
    const delais: number[] = [];
    const { app } = avec([TAG], {
      maison: maison({ poserTag: () => new Promise<void>((r) => { setTimeout(r, 30); }) }),
      attendre: async (ms) => { delais.push(ms); },
    });
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o2')).json()).toEqual({ succes: true, reponse: REPONSE_MAISON.tag_fixe });
    expect(delais).toEqual([]);
  });

  it('🔴 le délai reste nettement sous les trois secondes que Meta accorde (mesuré le 2026-09-22)', () => {
    // Le reste de la requête (outil, clé, journal, trajet) passe AVANT ce délai : il lui faut sa marge.
    expect(DELAI_REPONSE_ENVOI_MS).toBeLessThanOrEqual(2000);
  });

  it('« c’est parti » clôt le tour comme « c’est fait » : il interdit de rappeler l’outil', () => {
    for (const r of Object.values(REPONSE_EN_COURS)) {
      expect(r).toContain('Ne rappelle pas cet outil');
      // L'agent annonce l'envoi en UNE phrase : c'est cet écho qui clôt son tour (`src/mba/fin-de-tour.ts`).
      expect(r).toContain('en une phrase courte');
    }
    expect(REPONSE_EN_COURS.scenario_fixe).toContain('n’écris plus rien');
  });
});

/**
 * 🔴 L'API EN PLUSIEURS COPIES : un rappel de l'outil peut arriver sur une autre copie que le premier appel, et une
 * copie peut être arrêtée (réduction de l'autoscaler) pendant qu'un envoi continue après sa réponse.
 */
describe('le relais quand l’API tourne en plusieurs copies', () => {
  const avec = (outils: unknown[], over: Partial<MbaRelaisDeps>) => monter({
    catalogue: {
      listActifsConsommateur: async (t, c) => (t === 't1' && c === 'mba:pn1' ? outils as never : []),
    },
    ...over,
  });
  const maison = (o: Partial<MbaRelaisDeps['maison']>): MbaRelaisDeps['maison'] => ({
    poserTag: async () => {}, ecrireChamp: async () => {}, champExiste: async () => true,
    contacts: { isBlockedByWaId: async () => false },
    antiRejeu: verrousEnMemoire(), inbox: { dernierMessageDuClient: async () => 'm1' },
    envoyerBloc: async () => true, lancerScenario: async () => true, ...o,
  });

  it('🔴 le rappel servi par une AUTRE copie ne relance pas le scénario', async () => {
    const verrous = verrousEnMemoire();
    const lances: string[] = [];
    const lancer = async (t: string, w: string, id: string): Promise<true> => { lances.push(`${t} ${w} ${id}`); return true; };
    const copieA = avec([SCENARIO], { maison: maison({ antiRejeu: verrous, lancerScenario: lancer }) });
    const copieB = avec([SCENARIO], { maison: maison({ antiRejeu: verrous, lancerScenario: lancer }) });
    expect((await poster(copieA.app, CLE_RELAIS, {}, '+33612345678', 'o6')).json().succes).toBe(true);
    const rappel = (await poster(copieB.app, CLE_RELAIS, {}, '+33612345678', 'o6')).json();
    expect(rappel.reponse).toContain('déjà d’être traitée');
    expect(lances).toEqual([`t1 33612345678 ${WF}`]);
  });

  it('🔴 l’arrêt de la copie ATTEND un envoi qui continue après la réponse', async () => {
    let finir: () => void = () => {};
    const lent = new Promise<true>((r) => { finir = () => r(true); });
    const enVol = creerTravauxEnVol();
    const { app } = avec([SCENARIO], { maison: maison({ lancerScenario: () => lent }), attendre: async () => {}, enVol });
    expect((await poster(app, CLE_RELAIS, {}, '+33612345678', 'o6')).json()).toEqual({ succes: true, reponse: REPONSE_EN_COURS.scenario_fixe });
    let fini = false;
    const attente = enVol.attendre(5_000).then((n) => { fini = true; return n; });
    await new Promise((r) => { setTimeout(r, 50); });
    expect(fini, 'l’arrêt n’attend pas l’envoi : il fermerait le pool sous lui').toBe(false);
    finir();
    expect(await attente).toBe(0);
  });

  it('🔴 l’attente de l’arrêt couvre la fin de tour la plus longue, et laisse à la file et au pool de quoi se fermer', () => {
    expect(ATTENTE_GESTES_A_L_ARRET_MS).toBeGreaterThan(FIN_DE_TOUR_MAX_MS);
    expect(ATTENTE_GESTES_A_L_ARRET_MS).toBeLessThanOrEqual(FILET_ARRET_MS - 5_000);
  });
});

/**
 * 🔴 LES OUTILS MCP PAR LE RELAIS (route A, 2026-10-02). Meta parle HTTP à notre relais, nous parlons MCP au serveur du
 * client par le résolveur des agents IA. Ce qui compte : les paramètres cloués à la fiche du contact sont posés par
 * NOUS, jamais pris dans le corps que Meta envoie (sinon le modèle de Meta, donc le contact qui écrit, pourrait demander
 * la donnée d'un autre).
 */
describe('le relais et les outils MCP', () => {
  const MCP = {
    id: 'm1', name: 'notion_search', origin: 'mcp' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
    binding: { outilDistant: 'search' }, sourceId: 's1', mcpNonActivable: null, mcpIndisponibleLe: null,
    params: [
      { name: 'question', type: 'string', source: 'modele', required: true },
      { name: 'reference', type: 'string', source: 'champ', cle: 'tag_ns' },
    ],
  } as unknown as OutilDefini;
  const avecMcp = (outil: OutilDefini, resolveur: MbaRelaisDeps['resolveurMcp'], journal?: JournalAppels) => monter({
    catalogue: { listActifsConsommateur: async (t, c) => (t === 't1' && c === 'mba:pn1' ? [outil] : []) },
    resolveurMcp: resolveur,
    ...(journal ? { journal } : {}),
  });

  it('🔴 appelle le résolveur MCP avec les valeurs du modèle ET celles de la fiche, jamais celles du corps', async () => {
    const vus: EntreeResolveur[] = [];
    const { app } = avecMcp(MCP, async (e) => { vus.push(e); return { ok: true, contenu: { resultats: ['page 1'] } }; });
    const res = await poster(app, CLE_RELAIS, { question: 'horaires ?', reference: 'celle-d-un-autre' }, '+33612345678', 'm1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: true, reponse: { resultats: ['page 1'] } });
    expect(vus).toHaveLength(1);
    // La référence vient du champ `tag_ns` de la fiche (« vip »), pas du corps.
    expect(vus[0]!.args).toEqual({ question: 'horaires ?', reference: 'vip' });
    expect(vus[0]!.outil.id).toBe('m1');
    expect(vus[0]!.ctx.tenantId).toBe('t1');
    expect(vus[0]!.ctx.waId).toBe('33612345678');
  });

  it('🔴 sans client identifié (bac à sable de Meta), le serveur MCP n’est pas appelé', async () => {
    const vus: EntreeResolveur[] = [];
    const { app } = avecMcp(MCP, async (e) => { vus.push(e); return { ok: true, contenu: {} }; });
    const res = await poster(app, CLE_RELAIS, { question: 'horaires ?' }, '1234567890123456', 'm1');
    expect(res.json()).toEqual({ succes: false, erreur: 'le client n’est pas identifié : son numéro WhatsApp manque' });
    expect(vus).toHaveLength(0);
  });

  it('journalise l’appel sous l’origine `mcp` et l’appelant `mba`, avec les seuls arguments du modèle', async () => {
    const ouverts: unknown[] = [];
    const clos: unknown[] = [];
    const journal = { ouvrir: async (l: unknown) => { ouverts.push(l); return 'l9'; }, clore: async (l: unknown) => { clos.push(l); } } as unknown as JournalAppels;
    const { app } = avecMcp(MCP, async () => ({ ok: true, contenu: { ok: true } }), journal);
    await poster(app, CLE_RELAIS, { question: 'q' }, '+33612345678', 'm1');
    expect(ouverts[0]).toMatchObject({ tenantId: 't1', toolId: 'm1', origin: 'mcp', source: 'mba' });
    // `toEqual` et pas `toMatchObject` : celui-ci accepterait la valeur tirée de la fiche (`reference`) en plus.
    expect((ouverts[0] as { argsRediges: unknown }).argsRediges).toEqual({ question: 'q' });
    expect(clos[0]).toMatchObject({ id: 'l9', status: 'ok' });
  });

  it('🔴 un serveur MCP trop lent est coupé SOUS le délai de Meta : refus lisible, journal en `timeout`', async () => {
    const clos: Array<{ status?: string }> = [];
    const journal = { ouvrir: async () => 'l9', clore: async (l: { status?: string }) => { clos.push(l); } } as unknown as JournalAppels;
    const vus: Array<{ outil: { timeoutMs: number } }> = [];
    const { app } = avecMcp({ ...MCP, timeoutMs: 8000 }, (e) => { vus.push(e as never); return new Promise<never>(() => {}); }, journal);
    const debut = Date.now();
    const res = await poster(app, CLE_RELAIS, { question: 'q' }, '+33612345678', 'm1');
    expect(Date.now() - debut).toBeLessThan(DELAI_REPONSE_MCP_MS + 1000);
    expect(res.json()).toEqual({ succes: false, erreur: 'le serveur MCP n’a pas répondu à temps' });
    expect(clos[0]).toMatchObject({ status: 'timeout' });
    // La session MCP puise dans le délai du relais, pas dans les 8 s de l'outil.
    expect(vus[0]!.outil.timeoutMs).toBe(DELAI_REPONSE_MCP_MS);
  });

  it('un résolveur MCP qui lève est une erreur de l’OUTIL au journal, comme dans l’exécuteur', async () => {
    const clos: Array<{ status?: string }> = [];
    const journal = { ouvrir: async () => 'l9', clore: async (l: { status?: string }) => { clos.push(l); } } as unknown as JournalAppels;
    const { app } = avecMcp(MCP, async () => { throw new Error('boum'); }, journal);
    const res = await poster(app, CLE_RELAIS, { question: 'q' }, '+33612345678', 'm1');
    expect(res.json()).toMatchObject({ succes: false });
    expect(clos[0]).toMatchObject({ status: 'erreur_outil' });
  });

  it('un refus du serveur MCP part en `succes: false`, lisible par le modèle de Meta', async () => {
    const { app } = avecMcp(MCP, async () => ({ ok: false, contenu: { erreur: 'le serveur MCP est injoignable' }, erreur: 'le serveur MCP est injoignable' }));
    const res = await poster(app, CLE_RELAIS, { question: 'q' }, '+33612345678', 'm1');
    expect(res.json()).toEqual({ succes: false, erreur: 'le serveur MCP est injoignable' });
  });

  it('🔴 un paramètre requis du modèle qui manque : refusé AVANT tout appel au serveur', async () => {
    let appele = false;
    const { app } = avecMcp(MCP, async () => { appele = true; return { ok: true, contenu: {} }; });
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'm1');
    expect(res.json().succes).toBe(false);
    expect(appele).toBe(false);
  });

  it('🔴 un outil MCP non activable ou disparu n’est pas proposé, même s’il est encore activé', async () => {
    for (const casse of [{ mcpNonActivable: 'schéma imbriqué' }, { mcpIndisponibleLe: new Date() }]) {
      let appele = false;
      const { app } = avecMcp({ ...MCP, ...casse } as OutilDefini, async () => { appele = true; return { ok: true, contenu: {} }; });
      const res = await poster(app, CLE_RELAIS, { question: 'q' }, '+33612345678', 'm1');
      expect(res.json()).toEqual({ succes: false, erreur: 'cet outil n’est pas proposé à l’agent de Meta' });
      expect(appele).toBe(false);
    }
  });
});

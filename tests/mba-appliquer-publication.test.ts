import { describe, it, expect } from 'vitest';
import {
  creerAppliquerGeste, ErreurPublication, CTX_OUTILS, CTX_ACTEUR, type ClientConnecteurs,
} from '../src/mba/appliquer-publication';
import type { DepsCleRelais } from '../src/mba/cle-relais';
import { NOM_CONNECTEUR_RELAIS, corpsOutilMeta, type OutilAPublier } from '../src/mba/publication';

/**
 * Appliquer un geste du plan chez Meta (relais du MBA).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et la revue finale du 2026-09-21 l'a trouvé sans garde : le CÂBLAGE. L'ordre
 * de `poserCleNeuve` était testé, mais on pouvait débrancher son appel (ou celui d'`oublierCle`), envoyer
 * une autre clé que la neuve, ou confondre les identifiants d'outil, sans qu'aucun test ne tombe. Un seul
 * JOURNAL mêle ici ce qui part chez Meta et ce qui arrive à la clé, pour que l'ORDRE se lise aussi.
 */
const BASE = 'https://api.messagingme.app/mba/relais';
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Ajouter une étiquette.', nePasUtiliser: '',
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
};

function monter(over: { base?: string | null; connecteurs?: Array<{ id: string; name: string }>; outils?: OutilAPublier[] } = {}) {
  const journal: string[] = [];
  const corps: unknown[] = [];
  const acteurs: Array<string | null> = [];
  let lecturesOutils = 0;
  const client: ClientConnecteurs = {
    listConnectors: async () => over.connecteurs ?? [{ id: 'c1', name: NOM_CONNECTEUR_RELAIS }],
    createConnector: async (_pn, c) => { journal.push('meta createConnector'); corps.push(c); return { id: 'c1' }; },
    updateConnector: async (_pn, id, c) => { journal.push(`meta updateConnector ${id}`); corps.push(c); return {}; },
    deleteConnector: async (_pn, id) => { journal.push(`meta deleteConnector ${id}`); },
    createConnectorTool: async (_pn, cid, c) => { journal.push(`meta createConnectorTool ${cid}`); corps.push(c); return { id: 't1' }; },
    updateConnectorTool: async (_pn, cid, tid, c) => { journal.push(`meta updateConnectorTool ${cid} ${tid}`); corps.push(c); return {}; },
    deleteConnectorTool: async (_pn, cid, tid) => { journal.push(`meta deleteConnectorTool ${cid} ${tid}`); },
  };
  const cle = (acteur: string | null): DepsCleRelais => {
    acteurs.push(acteur);
    return {
      creerCle: async () => { journal.push('cle creer'); return { id: 'k1', key: 'mba_CLE_NEUVE' }; },
      revoquer: async (_t, id) => { journal.push(`cle revoquer ${id}`); return true; },
      cleRetenue: async () => 'k0',
      retenir: async (_t, id) => { journal.push(`cle retenir ${id}`); },
      estActive: async () => true,
      revoquerAutres: async (_t, garder) => { journal.push(`cle revoquerAutres sauf ${garder}`); },
    };
  };
  const appliquer = creerAppliquerGeste({
    client: async () => client,
    adresseDuRelais: () => (over.base === undefined ? BASE : over.base),
    outils: async () => { lecturesOutils += 1; return over.outils ?? [ADD_TAG]; },
    cle,
  });
  return { appliquer, journal, corps, acteurs, lectures: () => lecturesOutils };
}

const AUTH_NEUVE = { api_key: { headers: [{ field_name: 'Authorization', value: 'mba_CLE_NEUVE', prefix: 'Bearer ' }] } };

describe('appliquer un geste de publication', () => {
  it('🔴 créer le connecteur : une clé NEUVE part dans son corps, et n’est retenue qu’APRÈS Meta', async () => {
    const f = monter({ connecteurs: [] });
    await f.appliquer('t1', 'pn1', { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS }, new Map());
    expect(f.journal).toEqual(['cle creer', 'meta createConnector', 'cle retenir k1', 'cle revoquerAutres sauf k1']);
    expect(f.corps[0]).toMatchObject({ name: NOM_CONNECTEUR_RELAIS, base_url: BASE, auth_type: 'API_KEY', auth_config: AUTH_NEUVE });
  });

  it('🔴 modifier le connecteur porte AUSSI la clé neuve, sur le bon connecteur', async () => {
    // Le cas le plus dangereux : une autre clé que la neuve partirait chez Meta pendant que la neuve serait
    // retenue, et l'ancienne révoquée. Meta présenterait une clé morte, et rien ne la reposerait jamais.
    const f = monter();
    await f.appliquer('t1', 'pn1', { type: 'connecteur_modifier', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS }, new Map());
    expect(f.journal).toEqual(['cle creer', 'meta updateConnector c1', 'cle retenir k1', 'cle revoquerAutres sauf k1']);
    expect(f.corps[0]).toMatchObject({ auth_config: AUTH_NEUVE });
  });

  it('🔴 le relais qui part : supprimé CHEZ META d’abord, ses clés révoquées ensuite', async () => {
    // Dans l'autre ordre, un échec de Meta laisserait un connecteur vivant avec une clé morte.
    const f = monter();
    await f.appliquer('t1', 'pn1', { type: 'connecteur_supprimer', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS, oublierCle: true }, new Map());
    expect(f.journal).toEqual(['meta deleteConnector c1', 'cle revoquerAutres sauf null', 'cle retenir null']);
  });

  it('un ancien connecteur supprimé ne touche pas aux clés', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', { type: 'connecteur_supprimer', connecteurId: 'c0', nom: 'testUCHAT', oublierCle: false }, new Map());
    expect(f.journal).toEqual(['meta deleteConnector c0']);
  });

  it('créer un outil : son corps est celui du plan, sur le connecteur du relais', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, new Map());
    expect(f.journal).toEqual(['meta createConnectorTool c1']);
    expect(f.corps[0]).toEqual(corpsOutilMeta(ADD_TAG));
  });

  it('🔴 modifier un outil vise l’identifiant de META, pas le nôtre', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', { type: 'outil_modifier', outilMetaId: 'tMeta', outilId: 'o1', nom: 'add_tag' }, new Map());
    expect(f.journal).toEqual(['meta updateConnectorTool c1 tMeta']);
    expect(f.corps[0]).toEqual(corpsOutilMeta(ADD_TAG));
  });

  it('🔴 supprimer un outil part chez Meta, sur son connecteur', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', { type: 'outil_supprimer', connecteurId: 'c0', outilMetaId: 't0', nom: 'add_tag' }, new Map());
    expect(f.journal).toEqual(['meta deleteConnectorTool c0 t0']);
  });

  it('🔴 un refus de NOTRE côté lève `ErreurPublication`, jamais un « return » silencieux', async () => {
    const sansRelais = monter({ connecteurs: [] });
    await expect(sansRelais.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, new Map()))
      .rejects.toBeInstanceOf(ErreurPublication);
    const sansOutil = monter({ outils: [] });
    await expect(sansOutil.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, new Map()))
      .rejects.toBeInstanceOf(ErreurPublication);
    const sansAdresse = monter({ base: null });
    await expect(sansAdresse.appliquer('t1', 'pn1', { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS }, new Map()))
      .rejects.toBeInstanceOf(ErreurPublication);
    expect(sansAdresse.journal).toEqual([]);
  });

  it('🔴 les outils AMORCÉS par la route (ceux du plan) servent, sans relire la base', async () => {
    const f = monter();
    const autre: OutilAPublier = { ...ADD_TAG, description: 'Version du plan.' };
    await f.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, new Map<string, unknown>([[CTX_OUTILS, [autre]]]));
    expect(f.lectures()).toBe(0);
    expect(f.corps[0]).toEqual(corpsOutilMeta(autre));
  });

  it('à défaut d’amorce, les outils sont lus UNE fois pour toute la publication', async () => {
    const f = monter({ outils: [ADD_TAG, { ...ADD_TAG, id: 'o2', name: 'autre' }] });
    const ctx = new Map<string, unknown>();
    await f.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, ctx);
    await f.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o2', nom: 'autre' }, ctx);
    expect(f.lectures()).toBe(1);
  });

  it('🔴 l’administrateur qui publie est transmis aux gestes de la clé (l’audit le nomme)', async () => {
    const f = monter({ connecteurs: [] });
    await f.appliquer('t1', 'pn1', { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS }, new Map<string, unknown>([[CTX_ACTEUR, 'u-admin']]));
    expect(f.acteurs).toEqual(['u-admin']);
  });
});

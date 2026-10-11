import { describe, expect, it } from 'vitest';
import {
  creerAppliquerGeste, ErreurPublication, type ClientConnecteurs, type ContextePublication,
} from '../src/mba/appliquer-publication';
import type { DepsCleRelais } from '../src/mba/cle-relais';
import { NOM_CONNECTEUR_RELAIS, corpsOutilMeta, type OutilAPublier } from '../src/mba/publication';

/**
 * Appliquer un geste du plan chez Meta. Ces tests gardent le câblage : ordre de rotation de clé, identifiants Meta,
 * corps exact de l'outil et utilisation de l'instantané typé fourni par l'orchestrateur.
 */
const BASE = 'https://api.messagingme.app/mba/relais';
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Ajouter une étiquette.', nePasUtiliser: '',
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
};

function contexte(over: Partial<ContextePublication> = {}): ContextePublication {
  return { acteurId: null, outils: [ADD_TAG], ...over };
}

function monter(over: { base?: string | null; connecteurs?: Array<{ id: string; name: string }> } = {}) {
  const journal: string[] = [];
  const corps: unknown[] = [];
  const acteurs: Array<string | null> = [];
  let lecturesConnecteurs = 0;
  const client: ClientConnecteurs = {
    listConnectors: async () => {
      lecturesConnecteurs += 1;
      return over.connecteurs ?? [{ id: 'c1', name: NOM_CONNECTEUR_RELAIS }];
    },
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
    meta: { mbaClientForTenant: async () => client },
    adresseDuRelais: () => (over.base === undefined ? BASE : over.base),
    cle,
  });
  return { appliquer, journal, corps, acteurs, lecturesConnecteurs: () => lecturesConnecteurs };
}

const AUTH_NEUVE = { api_key: { headers: [{ field_name: 'Authorization', value: 'mba_CLE_NEUVE', prefix: 'Bearer ' }] } };

describe('appliquer un geste de publication', () => {
  it('crée le connecteur avec une clé neuve, retenue seulement après Meta', async () => {
    const f = monter({ connecteurs: [] });
    await f.appliquer('t1', 'pn1', { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS }, contexte());
    expect(f.journal).toEqual(['cle creer', 'meta createConnector', 'cle retenir k1', 'cle revoquerAutres sauf k1']);
    expect(f.corps[0]).toMatchObject({ name: NOM_CONNECTEUR_RELAIS, base_url: BASE, auth_type: 'API_KEY', auth_config: AUTH_NEUVE });
  });

  it('modifie le bon connecteur avec une clé neuve', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', { type: 'connecteur_modifier', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS }, contexte());
    expect(f.journal).toEqual(['cle creer', 'meta updateConnector c1', 'cle retenir k1', 'cle revoquerAutres sauf k1']);
    expect(f.corps[0]).toMatchObject({ auth_config: AUTH_NEUVE });
  });

  it('supprime le relais chez Meta avant de révoquer ses clés', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', {
      type: 'connecteur_supprimer', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS, oublierCle: true,
    }, contexte());
    expect(f.journal).toEqual(['meta deleteConnector c1', 'cle revoquerAutres sauf null', 'cle retenir null']);
  });

  it('supprime un ancien connecteur sans toucher aux clés', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', {
      type: 'connecteur_supprimer', connecteurId: 'c0', nom: 'testUCHAT', oublierCle: false,
    }, contexte());
    expect(f.journal).toEqual(['meta deleteConnector c0']);
  });

  it('crée un outil avec le corps exact de l’instantané du plan', async () => {
    const f = monter();
    const outilDuPlan = { ...ADD_TAG, description: 'Version du plan.' };
    await f.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, contexte({ outils: [outilDuPlan] }));
    expect(f.journal).toEqual(['meta createConnectorTool c1']);
    expect(f.corps[0]).toEqual(corpsOutilMeta(outilDuPlan));
  });

  it('modifie l’identifiant Meta de l’outil', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', {
      type: 'outil_modifier', outilMetaId: 'tMeta', outilId: 'o1', nom: 'add_tag',
    }, contexte());
    expect(f.journal).toEqual(['meta updateConnectorTool c1 tMeta']);
    expect(f.corps[0]).toEqual(corpsOutilMeta(ADD_TAG));
  });

  it('supprime l’outil sur le connecteur désigné par le plan', async () => {
    const f = monter();
    await f.appliquer('t1', 'pn1', {
      type: 'outil_supprimer', connecteurId: 'c0', outilMetaId: 't0', nom: 'add_tag',
    }, contexte());
    expect(f.journal).toEqual(['meta deleteConnectorTool c0 t0']);
  });

  it('lève un refus local explicite quand une dépendance du geste manque', async () => {
    const sansRelais = monter({ connecteurs: [] });
    await expect(sansRelais.appliquer(
      't1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, contexte(),
    )).rejects.toBeInstanceOf(ErreurPublication);
    const sansOutil = monter();
    await expect(sansOutil.appliquer(
      't1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, contexte({ outils: [] }),
    )).rejects.toBeInstanceOf(ErreurPublication);
    const sansAdresse = monter({ base: null });
    await expect(sansAdresse.appliquer(
      't1', 'pn1', { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS }, contexte(),
    )).rejects.toBeInstanceOf(ErreurPublication);
    expect(sansAdresse.journal).toEqual([]);
  });

  it('mémorise les connecteurs pendant toute la publication', async () => {
    const f = monter();
    const ctx = contexte({ outils: [ADD_TAG, { ...ADD_TAG, id: 'o2', name: 'autre' }] });
    await f.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, ctx);
    await f.appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o2', nom: 'autre' }, ctx);
    expect(f.lecturesConnecteurs()).toBe(1);
  });

  it('transmet l’administrateur aux gestes de clé', async () => {
    const f = monter({ connecteurs: [] });
    await f.appliquer(
      't1', 'pn1', { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS }, contexte({ acteurId: 'u-admin' }),
    );
    expect(f.acteurs).toEqual(['u-admin']);
  });
});

import { describe, it, expect } from 'vitest';
import { creerAppliquerGeste, ErreurPublication, type ClientConnecteurs } from '../src/mba/appliquer-publication';
import type { DepsCleRelais } from '../src/mba/cle-relais';
import { NOM_CONNECTEUR_RELAIS, corpsOutilMeta, type OutilAPublier } from '../src/mba/publication';

/**
 * Appliquer un geste du plan chez Meta (relais du MBA).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et la revue finale du 2026-09-21 l'a trouvé sans garde : le CÂBLAGE de la
 * clé. L'ordre de `poserCleNeuve` était testé, mais on pouvait débrancher son appel (ou celui d'`oublierCle`)
 * dans `appliquer` sans qu'aucun test ne tombe. On lit ici ce qui PART chez Meta et ce qui arrive à la clé.
 */
const BASE = 'https://api.messagingme.app/mba/relais';
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Ajouter une étiquette.', nePasUtiliser: '',
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
};

function monter(over: { base?: string | null; connecteurs?: Array<{ id: string; name: string }>; outils?: OutilAPublier[] } = {}) {
  const appels: Array<{ quoi: string; args: unknown[] }> = [];
  const cle: string[] = [];
  const client: ClientConnecteurs = {
    listConnectors: async () => over.connecteurs ?? [{ id: 'c1', name: NOM_CONNECTEUR_RELAIS }],
    createConnector: async (...args) => { appels.push({ quoi: 'createConnector', args }); return { id: 'c1' }; },
    updateConnector: async (...args) => { appels.push({ quoi: 'updateConnector', args }); return {}; },
    deleteConnector: async (...args) => { appels.push({ quoi: 'deleteConnector', args }); },
    createConnectorTool: async (...args) => { appels.push({ quoi: 'createConnectorTool', args }); return { id: 't1' }; },
    updateConnectorTool: async (...args) => { appels.push({ quoi: 'updateConnectorTool', args }); return {}; },
    deleteConnectorTool: async (...args) => { appels.push({ quoi: 'deleteConnectorTool', args }); },
  };
  const deps: DepsCleRelais = {
    creerCle: async () => { cle.push('creer'); return { id: 'k1', key: 'mba_CLE_NEUVE' }; },
    revoquer: async () => { cle.push('revoquer'); return true; },
    cleRetenue: async () => 'k0',
    retenir: async (_t, id) => { cle.push(`retenir ${id}`); },
    estActive: async () => true,
    revoquerAutres: async (_t, garder) => { cle.push(`revoquerAutres sauf ${garder}`); },
  };
  const appliquer = creerAppliquerGeste({
    client: async () => client,
    adresseDuRelais: () => (over.base === undefined ? BASE : over.base),
    outils: async () => over.outils ?? [ADD_TAG],
    cle: deps,
  });
  return { appliquer, appels, cle };
}

describe('appliquer un geste de publication', () => {
  it('🔴 créer le connecteur : une clé NEUVE part dans son corps, puis elle est retenue', async () => {
    const { appliquer, appels, cle } = monter({ connecteurs: [] });
    await appliquer('t1', 'pn1', { type: 'connecteur_creer', nom: NOM_CONNECTEUR_RELAIS }, new Map());
    expect(appels).toHaveLength(1);
    expect(appels[0]!.quoi).toBe('createConnector');
    expect(appels[0]!.args[1]).toMatchObject({
      name: NOM_CONNECTEUR_RELAIS, base_url: BASE, auth_type: 'API_KEY',
      auth_config: { api_key: { headers: [{ field_name: 'Authorization', value: 'mba_CLE_NEUVE', prefix: 'Bearer ' }] } },
    });
    expect(cle).toEqual(['creer', 'retenir k1', 'revoquerAutres sauf k1']);
  });

  it('🔴 modifier le connecteur pose AUSSI une clé neuve', async () => {
    const { appliquer, appels, cle } = monter();
    await appliquer('t1', 'pn1', { type: 'connecteur_modifier', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS }, new Map());
    expect(appels[0]!.quoi).toBe('updateConnector');
    expect(appels[0]!.args[1]).toBe('c1');
    expect(cle).toEqual(['creer', 'retenir k1', 'revoquerAutres sauf k1']);
  });

  it('🔴 le relais qui part emporte ses clés ; un autre connecteur supprimé n’y touche pas', async () => {
    const relais = monter();
    await relais.appliquer('t1', 'pn1', { type: 'connecteur_supprimer', connecteurId: 'c1', nom: NOM_CONNECTEUR_RELAIS, oublierCle: true }, new Map());
    expect(relais.cle).toEqual(['revoquerAutres sauf null', 'retenir null']);

    const ancien = monter();
    await ancien.appliquer('t1', 'pn1', { type: 'connecteur_supprimer', connecteurId: 'c0', nom: 'testUCHAT', oublierCle: false }, new Map());
    expect(ancien.appels.map((a) => a.quoi)).toEqual(['deleteConnector']);
    expect(ancien.cle).toEqual([]);
  });

  it('créer un outil : son corps est celui du plan, sur le connecteur du relais', async () => {
    const { appliquer, appels } = monter();
    await appliquer('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, new Map());
    expect(appels).toEqual([{ quoi: 'createConnectorTool', args: ['pn1', 'c1', corpsOutilMeta(ADD_TAG)] }]);
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
    expect(sansAdresse.appels).toEqual([]);
  });

  it('les outils exposés sont lus UNE fois par publication, pas une fois par geste', async () => {
    let lectures = 0;
    const ctx = new Map<string, unknown>();
    const appliquerCompte = creerAppliquerGeste({
      client: async () => ({ ...({} as ClientConnecteurs), listConnectors: async () => [{ id: 'c1', name: NOM_CONNECTEUR_RELAIS }], createConnectorTool: async () => ({}) } as ClientConnecteurs),
      adresseDuRelais: () => BASE,
      outils: async () => { lectures += 1; return [ADD_TAG, { ...ADD_TAG, id: 'o2', name: 'autre' }]; },
      cle: {} as DepsCleRelais,
    });
    await appliquerCompte('t1', 'pn1', { type: 'outil_creer', outilId: 'o1', nom: 'add_tag' }, ctx);
    await appliquerCompte('t1', 'pn1', { type: 'outil_creer', outilId: 'o2', nom: 'autre' }, ctx);
    expect(lectures).toBe(1);
  });
});

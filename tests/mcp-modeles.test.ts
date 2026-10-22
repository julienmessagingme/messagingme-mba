import { describe, it, expect } from 'vitest';
import { OUTILS, outilsPour, RefusOutil, type DepsMcp } from '../src/mcp/outils';
import { MetaApiError } from '../src/meta/errors';
import type { TemplateSummary } from '../src/meta/templates';

/**
 * CORRIGER ET SUPPRIMER UN MODÈLE DEPUIS CLAUDE (plan `docs/superpowers/plans/2026-10-22-mcp-marche-arriere.md`, tâche 3).
 * La Free n'a plus l'écran Modèles : un modèle refusé ne se corrigeait plus, et un modèle d'essai ne se supprimait plus.
 * Les outils passent par les VRAIES fonctions de l'écran (`modifierUnModele`, `supprimerUnModele`), montées ici sur un
 * faux compte WhatsApp ; ce fichier tient ce qu'ils ajoutent : le format de Meta, le plafond lourd, des refus lisibles.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;
const MOI = { userId: 'u1' };

const RESUME: TemplateSummary = {
  id: 'tpl-1', name: 'commande_prete', status: 'REJECTED', category: 'UTILITY', language: 'fr',
  body: 'Bonjour {{1}}, votre commande est prête.', headerFormat: null, editable: true,
} as TemplateSummary;

function deps(o: {
  resume?: Partial<TemplateSummary>;
  campagnes?: Array<{ id: string; name: string; status: string; templateLanguage: string }>;
  echecMeta?: MetaApiError;
  lourdAccepte?: boolean;
} = {}) {
  const editions: Array<{ id: string; input: Record<string, unknown> }> = [];
  const suppressions: string[] = [];
  let lourds = 0;
  const client = {
    list: async () => [{ ...RESUME, ...o.resume }],
    update: async (id: string, input: Record<string, unknown>) => {
      if (o.echecMeta) throw o.echecMeta;
      editions.push({ id, input });
      return { success: true };
    },
    remove: async (_waba: string, name: string) => {
      if (o.echecMeta) throw o.echecMeta;
      suppressions.push(name);
      return { success: true };
    },
  };
  const gestion = {
    meta: { templateClientForTenant: async () => client },
    repo: { getTenantWabaId: async () => 'waba-1', listActiveCampaignsForTemplate: async () => o.campagnes ?? [] },
    getPublishedFlow: async () => true,
    indices: { save: async () => {}, get: async () => [], removeByName: async () => {} },
    champsDeclares: async () => [],
    tracking: {
      allocate: async () => { throw new Error('aucun lien tracé dans ces modèles'); },
      liens: { confirm: async () => {}, deconfirmer: async () => {}, listByTemplates: async () => [] },
      lienDe: (code: string) => `https://api.exemple.test/r/${code}`,
      destinations: async () => new Map<string, string>(),
    },
  };
  const d = {
    // La liste du catalogue lit le même compte (`listerModeles`) : `update_template` y relit les boutons du modèle.
    modeles: { modeles: gestion, lister: async () => client.list() },
    couteux: { consommer: async () => { lourds += 1; return { accepte: o.lourdAccepte ?? true, attenteMs: 2000 }; } },
  } as unknown as DepsMcp;
  return { d, editions, suppressions, lourds: () => lourds };
}

const CORRIGE = {
  name: 'commande_prete', language: 'fr', category: 'UTILITY',
  components: [{ type: 'BODY', text: 'Bonjour {{1}}, votre commande vous attend en magasin.', example: { body_text: [['Marie']] } }],
};

describe('corriger et supprimer un modèle depuis Claude (marche arrière, tâche 3)', () => {
  it('🔴 les deux exigent une personne, dans toutes les offres : une clé d’API ne les voit pas', () => {
    for (const nom of ['update_template', 'delete_template']) {
      expect(outil(nom).exigePersonne).toBe(true);
      expect(outil(nom).fonction).toBeNull();
    }
    const parCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null } as never).map((o) => o.nom);
    expect(parCle).not.toContain('update_template');
    expect(parCle).not.toContain('delete_template');
  });

  it('corriger passe par l’édition de l’écran Modèles, au format de Meta, et repart en revue', async () => {
    const { d, editions, lourds } = deps();
    const r = await outil('update_template').executer(d, T, { template: CORRIGE }, MOI);
    expect(r).toEqual({ name: 'commande_prete', language: 'fr', status: 'pending' });
    expect(editions).toHaveLength(1);
    expect(editions[0]!.id).toBe('tpl-1');
    expect(JSON.stringify(editions[0]!.input)).toContain('votre commande vous attend en magasin');
    expect(lourds()).toBe(1);
  });

  it('🔴 le plafond des opérations lourdes passe AVANT Meta : refusé, rien ne part', async () => {
    const { d, editions, suppressions } = deps({ lourdAccepte: false });
    await expect(outil('update_template').executer(d, T, { template: CORRIGE }, MOI)).rejects.toBeInstanceOf(RefusOutil);
    await expect(outil('delete_template').executer(d, T, { name: 'commande_prete' }, MOI)).rejects.toBeInstanceOf(RefusOutil);
    expect(editions).toEqual([]);
    expect(suppressions).toEqual([]);
  });

  it('🔴 un en-tête image, vidéo ou document ne s’ajoute pas par une correction : refusé avant Meta', async () => {
    const { d, editions } = deps();
    const avecImage = {
      ...CORRIGE,
      components: [{ type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://exemple.test/a.jpg'] } }, ...CORRIGE.components],
    };
    await expect(outil('update_template').executer(d, T, { template: avecImage }, MOI)).rejects.toThrow(/en-tête/);
    expect(editions).toEqual([]);
  });

  it('🔴 un modèle à bouton Flow ne se corrige pas d’ici : la correction le supprimerait, rien ne part chez Meta', async () => {
    const { d, editions } = deps({ resume: { buttons: [{ type: 'FLOW', text: 'Prendre rendez-vous', flowId: 'flow-1' }] } });
    await expect(outil('update_template').executer(d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/bouton Flow/);
    expect(editions).toEqual([]);
    // Des boutons que le format sait renvoyer ne bloquent rien.
    const simple = deps({ resume: { buttons: [{ type: 'QUICK_REPLY', text: 'Merci' }] } });
    await outil('update_template').executer(simple.d, T, { template: CORRIGE }, MOI);
    expect(simple.editions).toHaveLength(1);
  });

  it('les refus de l’écran gardent leur phrase : campagne active, modèle non éditable', async () => {
    const enCampagne = deps({ campagnes: [{ id: 'c1', name: 'Rentrée', status: 'running', templateLanguage: 'fr' }] });
    await expect(outil('update_template').executer(enCampagne.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/Rentrée/);
    const avecImage = deps({ resume: { headerFormat: 'IMAGE', editable: false } });
    await expect(outil('update_template').executer(avecImage.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/édition non supportée/);
    expect([...enCampagne.editions, ...avecImage.editions]).toEqual([]);
  });

  it('🔴 un refus de Meta est un refus lisible, pas une panne', async () => {
    const meta = new MetaApiError(400, { message: 'Invalid parameter', code: 100, error_user_msg: 'Le corps ne peut pas commencer par une variable.' });
    await expect(outil('update_template').executer(deps({ echecMeta: meta }).d, T, { template: CORRIGE }, MOI))
      .rejects.toThrow(/Meta a refusé/);
    await expect(outil('delete_template').executer(deps({ echecMeta: meta }).d, T, { name: 'commande_prete' }, MOI))
      .rejects.toThrow(/Meta a refusé/);
  });

  it('un modèle au mauvais format est refusé avant tout appel', async () => {
    const { d, editions, lourds } = deps();
    await expect(outil('update_template').executer(d, T, { template: { name: 'commande_prete' } }, MOI)).rejects.toBeInstanceOf(RefusOutil);
    expect(editions).toEqual([]);
    expect(lourds()).toBe(0);
  });

  it('supprimer passe par la suppression de l’écran : toutes les langues du nom', async () => {
    const { d, suppressions, lourds } = deps();
    expect(await outil('delete_template').executer(d, T, { name: 'commande_prete' }, MOI)).toEqual({ supprime: true, name: 'commande_prete' });
    expect(suppressions).toEqual(['commande_prete']);
    expect(lourds()).toBe(1);
  });

  it('🔴 un modèle qu’une campagne active utilise n’est pas supprimé, et le refus nomme la campagne', async () => {
    const { d, suppressions } = deps({ campagnes: [{ id: 'c1', name: 'Rentrée', status: 'scheduled', templateLanguage: 'fr' }] });
    await expect(outil('delete_template').executer(d, T, { name: 'commande_prete' }, MOI)).rejects.toThrow(/Rentrée/);
    expect(suppressions).toEqual([]);
  });

  it('un nom qui n’est pas un nom de modèle est refusé sans rien appeler', async () => {
    const { d, suppressions, lourds } = deps();
    await expect(outil('delete_template').executer(d, T, { name: 'Commande Prête' }, MOI)).rejects.toBeInstanceOf(RefusOutil);
    expect(suppressions).toEqual([]);
    expect(lourds()).toBe(0);
  });
});

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
  /** Ce que rendrait la liste en CACHE (`lister`), quand elle diffère de ce que Meta rend maintenant. */
  listeEnCache?: TemplateSummary[];
  /** L'oubli de la liste en cache échoue (la base ne répond pas). */
  oubliEchoue?: boolean;
  /** Les codes de `tracked_links`, confirmés ou non, et l'espace de chacun (`getByCode`). */
  codes?: Record<string, string>;
  /** La lecture des codes échoue (la base ne répond pas). */
  codesIllisibles?: boolean;
} = {}) {
  const editions: Array<{ id: string; input: Record<string, unknown> }> = [];
  const suppressions: string[] = [];
  let lourds = 0;
  let oublis = 0;
  let lectures = 0;
  let lecturesDeCodes = 0;
  const client = {
    // Chaque lecture de la liste COMPLÈTE chez Meta (des pages entières pour un gros compte).
    list: async () => { lectures += 1; return [{ ...RESUME, ...o.resume }]; },
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
      liens: { confirm: async () => {}, deconfirmer: async () => {}, listByTemplates: async () => [],
        getByCode: async (code: string) => {
          lecturesDeCodes += 1;
          if (o.codesIllisibles) throw new Error('base injoignable');
          const espace = o.codes?.[code];
          return espace ? { tenantId: espace, destination: 'https://boutique.example' } : null;
        } },
      lienDe: (code: string) => `https://api.exemple.test/r/${code}`,
      destinations: async () => new Map<string, string>(),
    },
  };
  const d = {
    // La liste du catalogue, en cache une minute (`lister`), et son oubli après un changement fait par Claude.
    modeles: { modeles: gestion, lister: async () => o.listeEnCache ?? client.list(), oublier: async () => { oublis += 1; if (o.oubliEchoue) throw new Error('base injoignable'); } },
    couteux: { consommer: async () => { lourds += 1; return { accepte: o.lourdAccepte ?? true, attenteMs: 2000 }; } },
  } as unknown as DepsMcp;
  return { d, editions, suppressions, lourds: () => lourds, oublis: () => oublis, lectures: () => lectures, lecturesDeCodes: () => lecturesDeCodes };
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

  it('🔴 le bouton se relit chez Meta, pas dans le cache d’une minute de la liste (lot 3)', async () => {
    // La liste en cache ne montre pas encore le bouton Flow, ajouté dans la console il y a quelques secondes.
    const { d, editions } = deps({
      resume: { buttons: [{ type: 'FLOW', text: 'Prendre rendez-vous', flowId: 'flow-1' }] },
      listeEnCache: [RESUME],
    });
    await expect(outil('update_template').executer(d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/bouton Flow/);
    expect(editions).toEqual([]);
  });

  it('🔴 un lien qui prend une variable d’un scénario ou de Shopify ne se corrige pas d’ici ; nos liens tracés, si', async () => {
    const panier = deps({ resume: { buttons: [{ type: 'URL', text: 'Mon panier', url: 'https://boutique.example/panier/{{1}}' }] } });
    await expect(outil('update_template').executer(panier.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/prend une variable/);
    expect(panier.editions).toEqual([]);
    // Un lien tracé par nous (`/r/<code>/{{1}}`) se retrace à la correction : rien à refuser.
    const trace = deps({ resume: { buttons: [{ type: 'URL', text: 'Voir', url: 'https://api.exemple.test/r/abcdefgh2345/{{1}}' }] }, codes: { abcdefgh2345: T } });
    await outil('update_template').executer(trace.d, T, { template: CORRIGE }, MOI);
    expect(trace.editions).toHaveLength(1);
  });

  it('🔴 un lien tracé soumis sous un ancien nom de l’API reste l’un des nôtres : la correction passe (lot 4)', async () => {
    // Un modèle soumis quand l'API répondait sous `mba.` : son lien n'a pas l'hôte d'aujourd'hui (`lienDe`).
    const ancien = deps({ resume: { buttons: [{ type: 'URL', text: 'Voir', url: 'https://mba.messagingme.app/r/abcdefgh2345/{{1}}' }] }, codes: { abcdefgh2345: T } });
    await outil('update_template').executer(ancien.d, T, { template: CORRIGE }, MOI);
    expect(ancien.editions).toHaveLength(1);
  });

  it('🔴 une adresse du client qui a la forme d’un lien tracé, sans être l’un des nôtres pour CET espace, reste un lien à variable (lots 5 et 6)', async () => {
    const url = 'https://boutique.example/r/abcdefgh2345/{{1}}';
    // Un code inconnu, puis le code d'un AUTRE espace : refusé les deux fois.
    for (const codes of [{}, { abcdefgh2345: 'un-autre-espace' }] as Array<Record<string, string>>) {
      const client = deps({ resume: { buttons: [{ type: 'URL', text: 'Mon panier', url }] }, codes });
      await expect(outil('update_template').executer(client.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/prend une variable/);
      expect(client.editions).toEqual([]);
    }
  });

  it('🔴 un lien tracé de l’espace dont la ligne n’est pas confirmée reste l’un des nôtres (lot 6)', async () => {
    // Une confirmation ratée après la soumission, ou une restauration ratée après un refus : `getByCode` ne filtre pas
    // sur la confirmation, et le faux non plus.
    const nonConfirme = deps({ resume: { buttons: [{ type: 'URL', text: 'Voir', url: 'https://api.messagingme.app/r/abcdefgh2345/{{1}}' }] }, codes: { abcdefgh2345: T } });
    await outil('update_template').executer(nonConfirme.d, T, { template: CORRIGE }, MOI);
    expect(nonConfirme.editions).toHaveLength(1);
  });

  it('🔴 une base qui ne répond pas à la relecture d’un lien tracé est un refus lisible, pas un « lien à variable » (lot 6)', async () => {
    const panne = deps({ resume: { buttons: [{ type: 'URL', text: 'Voir', url: 'https://api.messagingme.app/r/abcdefgh2345/{{1}}' }] }, codesIllisibles: true });
    await expect(outil('update_template').executer(panne.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/réessayez/);
    expect(panne.editions).toEqual([]);
  });

  it('un modèle sans lien de la forme d’un lien tracé ne lit rien en base (lot 6)', async () => {
    const simple = deps({ resume: { buttons: [{ type: 'URL', text: 'Voir', url: 'https://boutique.example/aide' }] }, codesIllisibles: true });
    await outil('update_template').executer(simple.d, T, { template: CORRIGE }, MOI);
    expect(simple.editions).toHaveLength(1);
    expect(simple.lecturesDeCodes()).toBe(0);
  });

  it('🔴 le modèle se lit UNE fois chez Meta pour une correction (lot 4)', async () => {
    const { d, editions, lectures } = deps();
    await outil('update_template').executer(d, T, { template: CORRIGE }, MOI);
    expect(editions).toHaveLength(1);
    expect(lectures()).toBe(1);
  });

  it('la liste en cache s’oublie après une correction et une suppression : list_templates montre le nouvel état', async () => {
    const corrige = deps();
    await outil('update_template').executer(corrige.d, T, { template: CORRIGE }, MOI);
    expect(corrige.oublis()).toBe(1);
    const supprime = deps();
    await outil('delete_template').executer(supprime.d, T, { name: 'commande_prete' }, MOI);
    expect(supprime.oublis()).toBe(1);
    // Un refus ne change rien chez Meta : rien à oublier.
    const refuse = deps({ resume: { buttons: [{ type: 'FLOW', text: 'Rendez-vous', flowId: 'flow-1' }] } });
    await expect(outil('update_template').executer(refuse.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(RefusOutil);
    expect(refuse.oublis()).toBe(0);
  });

  it('un oubli raté ne fait pas croire à Claude que le geste a échoué : Meta a déjà changé le modèle', async () => {
    const corrige = deps({ oubliEchoue: true });
    expect(await outil('update_template').executer(corrige.d, T, { template: CORRIGE }, MOI)).toMatchObject({ status: 'pending' });
    expect(corrige.editions).toHaveLength(1);
    expect(corrige.oublis()).toBe(1);
    const supprime = deps({ oubliEchoue: true });
    expect(await outil('delete_template').executer(supprime.d, T, { name: 'commande_prete' }, MOI)).toEqual({ supprime: true, name: 'commande_prete' });
  });

  it('les refus de l’écran gardent leur phrase : campagne active, modèle non éditable', async () => {
    const enCampagne = deps({ campagnes: [{ id: 'c1', name: 'Rentrée', status: 'running', templateLanguage: 'fr' }] });
    await expect(outil('update_template').executer(enCampagne.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/Rentrée/);
    const avecImage = deps({ resume: { headerFormat: 'IMAGE', editable: false } });
    await expect(outil('update_template').executer(avecImage.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/édition non supportée/);
    expect([...enCampagne.editions, ...avecImage.editions]).toEqual([]);
    // Un modèle sans corps est aussi non éditable : le refus le dit, au lieu de parler d'un composant perdu (lot 6).
    const sansCorps = deps({ resume: { body: '', editable: false } });
    await expect(outil('update_template').executer(sansCorps.d, T, { template: CORRIGE }, MOI)).rejects.toThrow(/n'a pas de corps/);
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

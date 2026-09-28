import { describe, it, expect, vi, afterEach } from 'vitest';
import { creerLaPublicite, publierLaPublicite, PublicationRefusee, type ClientCreationPub, type DemandeCreation, type DepotCreationPub } from '../src/pubs/creation';
import type { FormulairePub } from '../src/meta/pubs-payloads';
import { MetaPubsCreationClient, type AudiencePub, type EtatVideo } from '../src/meta/pubs-creation';
import { ErreurGraph } from '../src/meta/graph';

/**
 * LA SÉQUENCE DE CRÉATION, ET SURTOUT SES CHEMINS D'ÉCHEC.
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT, ET POURQUOI ILS COMPTENT PLUS QUE LE CHEMIN NOMINAL. Cette séquence fait
 * cinq appels chez un tiers qui dépense l'argent du client. Le chemin nominal se vérifie à l'œil ; ce qui ne
 * se vérifie pas à l'œil, c'est ce qui reste chez Meta quand le troisième appel échoue. Ce fichier exécute
 * chacun de ces cas, y compris celui où le rattrapage lui-même échoue.
 *
 * ⚠️ ILS LISENT CE QUI PART, pas ce que la fonction rend : la liste des appels faits chez Meta, dans l'ordre,
 * et ce qui a été écrit chez nous. Une séquence qu'on peut débrancher sans qu'aucun test ne tombe n'est pas
 * une séquence, c'est du code que quelqu'un a écrit un jour.
 */

const formulaire: FormulairePub = {
  nom: 'Rentrée', texte: 'txt', titre: 'ttl', messagePreRempli: 'pré', accueil: 'acc',
  budgetTotal: 100, debut: '2026-10-01 00:00:00+02:00', fin: '2026-10-31 23:59:59+01:00',
  pays: ['FR'], villes: [], ageMin: 18, audiencesIncluses: [], audiencesExclues: [], bouton: 'WHATSAPP_MESSAGE',
};

const demande = (over: Partial<DemandeCreation> = {}): DemandeCreation => ({
  formulaire, visuel: { sorte: 'image', base64: 'AAAA' }, destination: 'scenario', workflowId: 'wf-1',
  tagQualification: 'devis', comptePubId: 'act_111', pageId: 'p-1', numeroWhatsApp: '33600000000',
  creePar: 'u-1', ...over,
});

/** Une audience telle que Meta la décrit, utilisable par défaut. */
const audience = (id: string, over: Partial<AudiencePub> = {}): AudiencePub => ({
  id, nom: `Audience ${id}`, sousType: 'CUSTOM', tailleMin: 1000, tailleMax: 1200, utilisable: true, raison: null, ...over,
});

interface OptionsFaux {
  /** Ce que Meta dit de la vidéo, ou l'erreur qu'il rend. Prête par défaut. */
  etatVideo?: EtatVideo | Error;
  /** Ce que Meta rend des audiences demandées, ou l'erreur. Toutes utilisables par défaut. */
  audiences?: Map<string, AudiencePub> | Error;
}

/** Un faux Meta qui RETIENT ses appels (et les charges utiles qui comptent), et qu'on fait échouer où l'on veut. */
function faux(
  echoueA?: 'image' | 'vignette' | 'campagne' | 'ensemble' | 'crea' | 'pub',
  echecSuppression = false,
  o: OptionsFaux = {},
) {
  const appels: string[] = [];
  const charges: { ensemble?: Record<string, unknown>; crea?: Record<string, unknown> } = {};
  const client: ClientCreationPub = {
    televerserImage: async () => { appels.push('image'); if (echoueA === 'image') throw new Error('image refusée'); return 'h-1'; },
    etatVideo: async (id) => {
      appels.push(`etat-video:${id}`);
      const e = o.etatVideo ?? { etat: 'prete', progression: 100 };
      if (e instanceof Error) throw e;
      return e;
    },
    vignetteVideo: async (id) => {
      appels.push(`vignette:${id}`);
      if (echoueA === 'vignette') throw new Error('vignette introuvable');
      return 'h-vignette';
    },
    etatAudiences: async (ids) => {
      appels.push(`audiences:${ids.join(',')}`);
      const a = o.audiences ?? new Map(ids.map((id) => [id, audience(id)]));
      if (a instanceof Error) throw a;
      return a;
    },
    creerCampagne: async () => { appels.push('campagne'); if (echoueA === 'campagne') throw new Error('campagne refusée'); return 'c-1'; },
    creerEnsemble: async (p) => {
      appels.push('ensemble'); charges.ensemble = p;
      if (echoueA === 'ensemble') throw new Error('ensemble refusé');
      return 'e-1';
    },
    creerCrea: async (p) => {
      appels.push('crea'); charges.crea = p;
      if (echoueA === 'crea') throw new Error('visuel refusé');
      return 'cr-1';
    },
    creerPub: async () => { appels.push('pub'); if (echoueA === 'pub') throw new Error('publicité refusée'); return 'ad-1'; },
    supprimerCampagne: async (id) => {
      appels.push(`supprime:${id}`);
      if (echecSuppression) throw new Error('suppression refusée');
    },
  };
  return { client, appels, charges };
}

/** Un faux dépôt qui RETIENT ce qui a été écrit, dans l'ordre. */
function fauxDepot(over: Partial<DepotCreationPub> = {}) {
  const ecrits: string[] = [];
  const depot: DepotCreationPub = {
    ouvrir: async (v) => { ecrits.push(`ouvre:${v.campagneId}:${v.destination}`); return 'pub-local-1'; },
    noterIds: async (_id, v) => { ecrits.push(`ids:${Object.keys(v).join(',')}=${Object.values(v).join(',')}`); },
    marquerEtat: async (_id, etat) => { ecrits.push(`etat:${etat}`); },
    memoriserPub: async (adId, campagneId) => { ecrits.push(`memorise:${adId}->${campagneId}`); },
    creerAutomation: async () => { ecrits.push('automation'); return 'auto-1'; },
    supprimerAutomation: async (id) => { ecrits.push(`automation-supprimee:${id}`); },
    ...over,
  };
  return { depot, ecrits };
}

describe('le chemin nominal', () => {
  it('crée dans l’ordre, range CHAQUE identifiant dès qu’il arrive, et finit en `prete`', async () => {
    const { client, appels } = faux();
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(demande(), client, depot);

    expect(issue).toEqual({ sorte: 'creee', publiciteId: 'pub-local-1', campagneId: 'c-1' });
    expect(appels).toEqual(['image', 'campagne', 'ensemble', 'crea', 'pub']);
    // 🔴 CHAQUE identifiant est rangé À SON TOUR, pas tous à la fin : un échec au milieu laisse quand même
    // de quoi retrouver ce qui existe chez Meta.
    expect(ecrits).toEqual([
      'ouvre:c-1:scenario',
      'ids:ensembleId=e-1',
      'ids:creaId=cr-1',
      'ids:pubId=ad-1',
      'memorise:ad-1->c-1',
      'automation',
      'etat:prete',
    ]);
  });

  it('🔴 le ROUTAGE connaît la publicité AVANT son premier lead', async () => {
    // Sans cette mémorisation, le premier prospect déclencherait un appel à Meta sur le chemin chaud d'un
    // message entrant, pour retrouver une correspondance qu'on venait d'établir soi-même.
    const { client } = faux();
    const { depot, ecrits } = fauxDepot();
    await creerLaPublicite(demande(), client, depot);
    expect(ecrits).toContain('memorise:ad-1->c-1');
  });

  it('destination « agent de Meta » : AUCUNE automation n’est créée', async () => {
    const { client } = faux();
    const { depot, ecrits } = fauxDepot();
    await creerLaPublicite(demande({ destination: 'agent_meta', workflowId: null }), client, depot);
    expect(ecrits).not.toContain('automation');
    expect(ecrits).toContain('etat:prete');
  });

  it('destination scénario SANS scénario : aucune automation non plus, et la création aboutit quand même', async () => {
    const { client } = faux();
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(demande({ workflowId: null }), client, depot);
    expect(issue.sorte).toBe('creee');
    expect(ecrits).not.toContain('automation');
  });
});

describe('les échecs AVANT que quoi que ce soit n’existe chez Meta', () => {
  it('le visuel refusé : rien n’est créé, rien n’est rangé, rien à défaire', async () => {
    const { client, appels } = faux('image');
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(demande(), client, depot);
    expect(issue).toEqual({ sorte: 'annulee', raison: 'image refusée', refusMeta: false });
    expect(appels).toEqual(['image']);
    expect(ecrits).toEqual([]);
  });

  it('la campagne refusée : rien à supprimer, et la raison de Meta remonte telle quelle', async () => {
    const { client, appels } = faux('campagne');
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(demande(), client, depot);
    expect(issue).toEqual({ sorte: 'annulee', raison: 'campagne refusée', refusMeta: false });
    expect(appels).toEqual(['image', 'campagne']);
    expect(ecrits).toEqual([]);
  });
});

describe('🔴 LE RATTRAPAGE : dès que la campagne existe, tout échec la supprime', () => {
  for (const etape of ['ensemble', 'crea', 'pub'] as const) {
    it(`échec sur « ${etape} » : la campagne est supprimée et la ligne dit « création échouée »`, async () => {
      const { client, appels } = faux(etape);
      const { depot, ecrits } = fauxDepot();
      const issue = await creerLaPublicite(demande(), client, depot);

      expect(issue.sorte).toBe('echec_creation');
      expect(issue.sorte === 'echec_creation' && issue.campagneId).toBe('c-1');
      expect(appels).toContain('supprime:c-1');
      expect(ecrits).toContain('etat:echec_creation');
      // La ligne EXISTE, et c'est ce qui la rend visible à l'écran : un objet créé chez Meta que le client
      // ne verrait pas ici, il le découvrirait dans le Gestionnaire sans savoir d'où il vient.
      expect(ecrits[0]).toBe('ouvre:c-1:scenario');
    });
  }

  it('🔴 la SUPPRESSION échoue aussi : la ligne reste, et le journal dit ce qui subsiste chez Meta', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, appels } = faux('crea', true);
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(demande(), client, depot);
    expect(spy).toHaveBeenCalled();
    // ⚠️ Le message DOIT dire que la campagne reste EN PAUSE : c'est ce qui distingue « il reste un objet »
    // de « il reste un objet qui dépense », et seule la seconde serait une urgence.
    expect(String(spy.mock.calls[0]?.[0])).toContain('EN PAUSE');
    spy.mockRestore();

    expect(issue.sorte).toBe('echec_creation');
    expect(appels).toContain('supprime:c-1');
    expect(ecrits).toContain('etat:echec_creation');
  });

  it('l’échec de l’AUTOMATION supprime la campagne comme les autres', async () => {
    // C'est le cas qu'on oublie : l'automation n'est pas un appel à Meta, mais sans elle la publicité serait
    // « proposée et inerte », ce que le produit s'interdit. Elle est donc dans le même filet.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, appels } = faux();
    const { depot } = fauxDepot({ creerAutomation: async () => { throw new Error('base indisponible'); } });
    const issue = await creerLaPublicite(demande(), client, depot);
    spy.mockRestore();
    expect(issue.sorte).toBe('echec_creation');
    expect(appels).toContain('supprime:c-1');
  });

  it('notre base tombe à l’OUVERTURE de la ligne : la campagne est supprimée, et rien ne subsiste', async () => {
    const { client, appels } = faux();
    const { depot } = fauxDepot({ ouvrir: async () => { throw new Error('base indisponible'); } });
    const issue = await creerLaPublicite(demande(), client, depot);
    expect(issue).toEqual({ sorte: 'annulee', raison: 'base indisponible', refusMeta: false });
    expect(appels).toContain('supprime:c-1');
  });
});

describe('elle ne lève JAMAIS', () => {
  it('quelle que soit l’étape qui échoue, tout sort par la valeur de retour', async () => {
    for (const etape of ['image', 'campagne', 'ensemble', 'crea', 'pub'] as const) {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client } = faux(etape);
      const { depot } = fauxDepot();
      await expect(creerLaPublicite(demande(), client, depot)).resolves.toBeTruthy();
      spy.mockRestore();
    }
  });
});

/**
 * UNE PUBLICITÉ VIDÉO : LA VIDÉO EST DÉJÀ CHEZ META, ET ELLE DOIT Y ÊTRE PRÊTE.
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT : aucune créa ne se lance sur une vidéo en traitement. Le refus se pose AVANT la
 * campagne, donc sans rien à défaire ; posé après, il laisserait une campagne à supprimer, et un échec de cette
 * suppression laisserait un objet chez Meta pour une raison que le client aurait pu attendre dix secondes.
 */
describe('une publicité VIDÉO', () => {
  const video = demande({ visuel: { sorte: 'video', videoId: 'v-9' } });

  it('vérifie que la vidéo est prête, redépose sa vignette, et crée une créa `video_data`', async () => {
    const { client, appels, charges } = faux();
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(video, client, depot);
    expect(issue).toEqual({ sorte: 'creee', publiciteId: 'pub-local-1', campagneId: 'c-1' });
    expect(appels).toEqual(['etat-video:v-9', 'vignette:v-9', 'campagne', 'ensemble', 'crea', 'pub']);
    const spec = (charges.crea as { object_story_spec: Record<string, { video_id?: string; image_hash?: string }> }).object_story_spec;
    expect(spec.video_data?.video_id).toBe('v-9');
    expect(spec.video_data?.image_hash).toBe('h-vignette');
    expect(spec).not.toHaveProperty('link_data');
    expect(ecrits.at(-1)).toBe('etat:prete');
  });

  for (const [cas, etat] of [
    ['en traitement', { etat: 'traitement', progression: 40 }],
    ['en erreur chez Meta', { etat: 'erreur', progression: null }],
  ] as const) {
    it(`🔴 vidéo ${cas} : refusée AVANT la campagne, rien n’est créé ni rangé`, async () => {
      const { client, appels } = faux(undefined, false, { etatVideo: etat });
      const { depot, ecrits } = fauxDepot();
      const issue = await creerLaPublicite(video, client, depot);
      expect(issue.sorte).toBe('refusee');
      expect(issue.sorte === 'refusee' && issue.code).toBe('video_pas_prete');
      // CE QUI PART compte : ni vignette, ni campagne, ni ligne chez nous.
      expect(appels).toEqual(['etat-video:v-9']);
      expect(ecrits).toEqual([]);
    });
  }

  it('⚠️ l’état illisible (Meta ne répond pas) ne vaut pas « prête » : refusée aussi', async () => {
    const { client, appels } = faux(undefined, false, { etatVideo: new Error('Graph 500 : erreur') });
    const issue = await creerLaPublicite(video, client, fauxDepot().depot);
    expect(issue.sorte).toBe('refusee');
    expect(appels).toEqual(['etat-video:v-9']);
  });

  it('la vignette introuvable : annulée, rien n’existe chez Meta', async () => {
    const { client, appels } = faux('vignette');
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(video, client, depot);
    expect(issue).toEqual({ sorte: 'annulee', raison: 'vignette introuvable', refusMeta: false });
    expect(appels).not.toContain('campagne');
    expect(ecrits).toEqual([]);
  });

  for (const etape of ['ensemble', 'crea', 'pub'] as const) {
    it(`🔴 le rattrapage est IDENTIQUE en vidéo : échec sur « ${etape} », campagne supprimée`, async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client, appels } = faux(etape);
      const { depot, ecrits } = fauxDepot();
      const issue = await creerLaPublicite(video, client, depot);
      spy.mockRestore();
      expect(issue.sorte).toBe('echec_creation');
      expect(appels).toContain('supprime:c-1');
      expect(ecrits).toContain('etat:echec_creation');
    });
  }

  it('⚠️ une publicité IMAGE ne demande jamais l’état d’une vidéo', async () => {
    const { client, appels } = faux();
    await creerLaPublicite(demande(), client, fauxDepot().depot);
    expect(appels.some((a) => a.startsWith('etat-video') || a.startsWith('vignette'))).toBe(false);
  });
});

/**
 * LES AUDIENCES : RELUES CHEZ META AVANT DE CRÉER QUOI QUE CE SOIT.
 *
 * 🔴 Une audience inutilisable (trop petite, en calcul, supprimée) ferait diffuser une publicité qui ne touche
 * personne, ou dont l'EXCLUSION ne vaut rien : le client paierait pour toucher ceux qu'il voulait écarter.
 */
describe('les audiences', () => {
  const avec = (incluses: string[], exclues: string[]) =>
    demande({ formulaire: { ...formulaire, audiencesIncluses: incluses, audiencesExclues: exclues } });

  it('toutes utilisables : la création part, et l’ensemble les porte chacune sous SA clé', async () => {
    const { client, appels, charges } = faux();
    const issue = await creerLaPublicite(avec(['111'], ['222']), client, fauxDepot().depot);
    expect(issue.sorte).toBe('creee');
    expect(appels[0]).toBe('audiences:111,222');
    const t = (charges.ensemble as { targeting: Record<string, unknown> }).targeting;
    expect(t.custom_audiences).toEqual([{ id: '111' }]);
    expect(t.excluded_custom_audiences).toEqual([{ id: '222' }]);
    expect(t.targeting_automation).toEqual({ advantage_audience: 1 });
  });

  it('🔴 une audience inutilisable : refusée AVANT la campagne, avec le mot de Meta', async () => {
    const { client, appels } = faux(undefined, false, {
      audiences: new Map([['111', audience('111')], ['222', audience('222', { utilisable: false, raison: 'Audience trop petite' })]]),
    });
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(avec(['111'], ['222']), client, depot);
    expect(issue.sorte).toBe('refusee');
    expect(issue.sorte === 'refusee' && issue.code).toBe('audience_inutilisable');
    expect(issue.sorte === 'refusee' && issue.raison).toContain('Audience trop petite');
    expect(appels).toEqual(['audiences:111,222']);
    expect(ecrits).toEqual([]);
  });

  it('🔴 une audience que Meta ne rend pas : refusée aussi, et nommée', async () => {
    const { client } = faux(undefined, false, { audiences: new Map([['111', audience('111')]]) });
    const issue = await creerLaPublicite(avec(['111', '999'], []), client, fauxDepot().depot);
    expect(issue.sorte === 'refusee' && issue.raison).toContain('999');
  });

  it('⚠️ sans audience, Meta n’est pas interrogé pour rien', async () => {
    const { client, appels } = faux();
    await creerLaPublicite(demande(), client, fauxDepot().depot);
    expect(appels.some((a) => a.startsWith('audiences'))).toBe(false);
  });

});

/**
 * LES AUDIENCES QUE LE COMPTE PEUT CIBLER, LUES PAR LE VRAI CLIENT, BRANCHÉ COMME LE CÂBLAGE LE FAIT.
 *
 * 🔴 CE QUE CES CAS DÉFENDENT : une audience PARTAGÉE avec le compte de l'espace (celles qu'une agence ou un groupe
 * prépare) porte l'`account_id` de son PROPRIÉTAIRE. Une garde qui l'exigeait égal au compte de l'espace la refusait,
 * alors que Meta la liste bien sur l'arête du compte (possédées ET partagées) et l'accepte. C'est cette LISTE qui
 * tranche, page après page ; seul `fetch` est simulé, le client et la séquence sont les vrais.
 */
describe('les audiences ciblables par le compte, lues par le vrai client', () => {
  const vrai = globalThis.fetch;
  afterEach(() => { globalThis.fetch = vrai; });

  const ligne = (id: string, compte: string) => ({
    id, account_id: compte, name: `Audience ${id}`, subtype: 'CUSTOM',
    approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200, delivery_status: { code: 200 },
  });

  /** Un faux Meta qui rend les pages de l'arête dans l'ordre, et retient les adresses demandées. */
  const pages = (reponses: unknown[]): string[] => {
    const urls: string[] = [];
    let i = 0;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      const body = reponses[Math.min(i++, reponses.length - 1)];
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    return urls;
  };

  /** Le client de la séquence, dont `etatAudiences` est le VRAI, lié au compte de l'espace comme dans `src/index.ts`. */
  const branche = (d: DemandeCreation): ClientCreationPub => {
    const meta = new MetaPubsCreationClient('app', 'secret', 'v25.0');
    return { ...faux().client, etatAudiences: (ids) => meta.etatAudiences(d.comptePubId, ids, 'JETON') };
  };

  const avec = (incluses: string[], exclues: string[]): DemandeCreation =>
    demande({ formulaire: { ...formulaire, audiencesIncluses: incluses, audiencesExclues: exclues } });

  it('🔴 une audience PARTAGÉE (propriétaire : un autre compte) est acceptée, et lue sur l’arête du compte', async () => {
    const urls = pages([{ data: [ligne('111', '111'), ligne('222', '999')] }]);
    const d = avec(['111'], ['222']);
    const issue = await creerLaPublicite(d, branche(d), fauxDepot().depot);
    expect(issue.sorte).toBe('creee');
    expect(urls[0]).toMatch(/^https:\/\/graph\.facebook\.com\/v25\.0\/act_111\/customaudiences\?/);
  });

  it('🔴 une audience ABSENTE de la liste du compte est refusée AVANT la campagne, et nommée', async () => {
    pages([{ data: [ligne('111', '111')] }]);
    const d = avec(['111', '333'], []);
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(d, branche(d), depot);
    expect(issue.sorte === 'refusee' && issue.code).toBe('audience_inutilisable');
    expect(issue.sorte === 'refusee' && issue.raison).toContain('333 (introuvable pour ce compte publicitaire)');
    expect(ecrits).toEqual([]);
  });

  it('🔴 une audience de la PAGE 2 n’est pas refusée : la page suivante se demande par son curseur', async () => {
    const urls = pages([
      { data: [ligne('111', '111')], paging: { cursors: { after: 'CURSEUR' }, next: 'https://ailleurs.example/suite?access_token=X' } },
      { data: [ligne('444', '999')] },
    ]);
    const d = avec(['444'], []);
    const issue = await creerLaPublicite(d, branche(d), fauxDepot().depot);
    expect(issue.sorte).toBe('creee');
    expect(urls).toHaveLength(2);
    // La suite se demande sur NOTRE adresse, avec le curseur : l'adresse `next` rendue par Meta n'est pas suivie.
    expect(urls[1]).toMatch(/^https:\/\/graph\.facebook\.com\/v25\.0\/act_111\/customaudiences\?.*after=CURSEUR/);
  });
});

/**
 * UN REFUS DE META SE DISTINGUE D'UNE PANNE, et la route en fait un 422 lisible (`src/http/pubs.ts`).
 *
 * 🔴 Seul un 4xx de Meta porte un message écrit pour le client ; une panne (réseau, 5xx, notre base) porte un message
 * interne, qui ne doit pas sortir. La distinction naît ici, sur l'erreur elle-même, pas sur le texte de son message.
 */
describe('refus de Meta ou panne', () => {
  const refus = new ErreurGraph(400, 100, 'Graph 400 (#100) : Invalid call_to_action type');

  it('🔴 Meta refuse la campagne : annulée, et marquée REFUS DE META', async () => {
    const { client } = faux();
    client.creerCampagne = async () => { throw refus; };
    const issue = await creerLaPublicite(demande(), client, fauxDepot().depot);
    expect(issue).toEqual({ sorte: 'annulee', raison: refus.message, refusMeta: true });
  });

  it('🔴 Meta refuse la créa : création incomplète, marquée REFUS DE META, campagne supprimée', async () => {
    const { client, appels } = faux();
    client.creerCrea = async () => { throw refus; };
    const issue = await creerLaPublicite(demande(), client, fauxDepot().depot);
    expect(issue).toMatchObject({ sorte: 'echec_creation', raison: refus.message, refusMeta: true });
    expect(appels).toContain('supprime:c-1');
  });

  it('un 5xx de Meta, ou notre base, n’est PAS un refus', async () => {
    const { client } = faux();
    client.creerCampagne = async () => { throw new ErreurGraph(500, 1, 'Graph 500 (#1) : An unknown error occurred'); };
    expect(await creerLaPublicite(demande(), client, fauxDepot().depot)).toMatchObject({ refusMeta: false });
    const { depot } = fauxDepot({ ouvrir: async () => { throw new Error('connexion à la base perdue'); } });
    expect(await creerLaPublicite(demande(), faux().client, depot)).toMatchObject({ refusMeta: false });
  });
});

/**
 * LA PUBLICATION : L'AUTOMATION D'ABORD, META ENSUITE.
 *
 * 🔴 C'EST LE SEUL ENDROIT DU LOT OÙ L'ORDRE DÉCIDE D'UN EURO DÉPENSÉ POUR RIEN. Inversé, un échec côté
 * automation laisserait une publicité qui diffuse et dont chaque clic payé tombe dans le vide, sans erreur
 * visible : on ne s'en apercevrait qu'en lisant les conversations, des heures plus tard.
 */
describe('publier', () => {
  const capte = () => {
    const ordre: string[] = [];
    return {
      ordre,
      client: { allumer: async (id: string) => { ordre.push(`meta:${id}`); } },
      depot: {
        allumerAutomation: async () => { ordre.push('automation'); return true; },
        marquerPubliee: async () => { ordre.push('publiee'); },
      },
    };
  };

  it('🔴 l’automation est allumée AVANT le premier appel à Meta', async () => {
    const { ordre, client, depot } = capte();
    await publierLaPublicite('p1', { campagneId: 'c-1', ensembleId: 'e-1', pubId: 'ad-1', etat: 'prete' as const, destination: 'scenario' as const }, client, depot);
    expect(ordre[0]).toBe('automation');
  });

  it('🔴 LA CAMPAGNE EN DERNIER : c’est elle l’interrupteur, rien ne diffuse tant qu’elle est éteinte', async () => {
    // Meta est explicite : une campagne en pause met en pause tout ce qu'elle contient. Comme on a TOUT créé
    // en pause, allumer la seule campagne ne diffuserait rien ; et l'allumer en premier ferait diffuser dès
    // que l'ensemble suivrait, avant que la publicité ne soit prête.
    const { ordre, client, depot } = capte();
    await publierLaPublicite('p1', { campagneId: 'c-1', ensembleId: 'e-1', pubId: 'ad-1', etat: 'prete' as const, destination: 'scenario' as const }, client, depot);
    expect(ordre).toEqual(['automation', 'meta:ad-1', 'meta:e-1', 'meta:c-1', 'publiee']);
  });

  it('les trois niveaux sont allumés, pas seulement la campagne', async () => {
    const { ordre, client, depot } = capte();
    await publierLaPublicite('p1', { campagneId: 'c-1', ensembleId: 'e-1', pubId: 'ad-1', etat: 'prete' as const, destination: 'scenario' as const }, client, depot);
    expect(ordre.filter((o) => o.startsWith('meta:'))).toHaveLength(3);
  });

  it('une création incomplète (pas d’ensemble, pas de pub) n’allume que ce qui existe', async () => {
    const { ordre, client, depot } = capte();
    await publierLaPublicite('p1', { campagneId: 'c-1', ensembleId: null, pubId: null, etat: 'prete' as const, destination: 'agent_meta' as const }, client, depot);
    expect(ordre).toEqual(['automation', 'meta:c-1', 'publiee']);
  });

  it('🔴 Meta refuse : on ne marque PAS la publicité comme publiée', async () => {
    const ordre: string[] = [];
    await expect(publierLaPublicite(
      'p1', { campagneId: 'c-1', ensembleId: null, pubId: null, etat: 'prete' as const, destination: 'agent_meta' as const },
      { allumer: async () => { throw new Error('compte suspendu'); } },
      {
        allumerAutomation: async () => { ordre.push('automation'); return true; },
        marquerPubliee: async () => { ordre.push('publiee'); },
      },
    )).rejects.toThrow('compte suspendu');
    // L'automation reste allumée, et c'est le bon sens du compromis : elle n'a simplement rien à faire tant
    // que rien ne diffuse. Ce qui compte est qu'on n'annonce pas « publiée » une publicité qui ne l'est pas.
    expect(ordre).toEqual(['automation']);
  });
});

/**
 * LES DEUX REFUS DE PUBLICATION, POSÉS AVANT LE PREMIER APPEL À META.
 *
 * 🔴 TOUS DEUX NÉS D'UNE RELECTURE À FROID. Le premier ferme le cas où l'on publierait une publicité dont
 * Meta n'a qu'une campagne (rien ne diffuserait, et elle sortirait du balayage du suivi en étant marquée
 * `publiee`). Le second ferme celui où l'automation n'aurait pas pu être allumée : la règle « un échec ne
 * laisse jamais une pub active sans routage » ne tenait que par l'ORDRE des appels, donc pas du tout.
 */
describe('publier : ce qui est REFUSÉ, avant tout appel à Meta', () => {
  const rien = { allumer: async () => { throw new Error('Meta ne devrait pas être appelé'); } };
  const depotOk = { allumerAutomation: async () => true, marquerPubliee: async () => {} };

  for (const etat of ['creation', 'echec_creation', 'publiee'] as const) {
    it(`🔴 état « ${etat} » : refusé, et META N'EST PAS APPELÉ`, async () => {
      await expect(publierLaPublicite(
        'p1', { campagneId: 'c-1', ensembleId: null, pubId: null, etat, destination: 'agent_meta' },
        rien, depotOk,
      )).rejects.toBeInstanceOf(PublicationRefusee);
    });
  }

  it('🔴 destination « scénario » dont l’automation ne s’allume PAS : refusé, et Meta n’est pas appelé', async () => {
    // Sans ce refus, Meta diffuserait et chaque clic payé tomberait dans le vide, sans erreur visible : on
    // ne s'en apercevrait qu'en lisant les conversations, des heures plus tard.
    await expect(publierLaPublicite(
      'p1', { campagneId: 'c-1', ensembleId: 'e-1', pubId: 'ad-1', etat: 'prete', destination: 'scenario' },
      rien, { allumerAutomation: async () => false, marquerPubliee: async () => {} },
    )).rejects.toBeInstanceOf(PublicationRefusee);
  });

  it('⚠️ une destination « agent de Meta » SANS automation se publie : elle n’en a pas besoin', async () => {
    const allumes: string[] = [];
    await publierLaPublicite(
      'p1', { campagneId: 'c-1', ensembleId: null, pubId: null, etat: 'prete', destination: 'agent_meta' },
      { allumer: async (id) => { allumes.push(id); } },
      { allumerAutomation: async () => false, marquerPubliee: async () => {} },
    );
    expect(allumes).toEqual(['c-1']);
  });
});

describe('le rattrapage défait AUSSI l’automation', () => {
  it('🔴 une automation créée puis une création qui échoue : elle est supprimée', async () => {
    // Sans ce retrait, elle survivrait à sa publicité : possédée, donc invisible de l'écran Automations, et
    // intouchable par un propriétaire qui vient de disparaître.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = faux();
    const { depot, ecrits } = fauxDepot({ marquerEtat: async (_id, etat) => {
      if (etat === 'prete') throw new Error('base indisponible');
    } });
    await creerLaPublicite(demande(), client, depot);
    spy.mockRestore();
    expect(ecrits).toContain('automation-supprimee:auto-1');
  });

  it('⚠️ aucune automation créée : rien à défaire, et on ne le tente pas', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = faux('ensemble');
    const { depot, ecrits } = fauxDepot();
    await creerLaPublicite(demande(), client, depot);
    spy.mockRestore();
    expect(ecrits.some((e) => e.startsWith('automation-supprimee'))).toBe(false);
  });
});

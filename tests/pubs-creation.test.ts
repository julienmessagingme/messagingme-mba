import { describe, it, expect, vi } from 'vitest';
import { creerLaPublicite, publierLaPublicite, PublicationRefusee, type ClientCreationPub, type DemandeCreation, type DepotCreationPub } from '../src/pubs/creation';
import type { FormulairePub } from '../src/meta/pubs-payloads';

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
  pays: ['FR'], villes: [], ageMin: 18, ageMax: 65,
};

const demande = (over: Partial<DemandeCreation> = {}): DemandeCreation => ({
  formulaire, imageBase64: 'AAAA', destination: 'scenario', workflowId: 'wf-1',
  tagQualification: 'devis', comptePubId: 'act-1', pageId: 'p-1', numeroWhatsApp: '33600000000',
  creePar: 'u-1', ...over,
});

/** Un faux Meta qui RETIENT ses appels, et qu'on peut faire échouer à l'étape de son choix. */
function faux(echoueA?: 'image' | 'campagne' | 'ensemble' | 'crea' | 'pub', echecSuppression = false) {
  const appels: string[] = [];
  const client: ClientCreationPub = {
    televerserImage: async () => { appels.push('image'); if (echoueA === 'image') throw new Error('image refusée'); return 'h-1'; },
    creerCampagne: async () => { appels.push('campagne'); if (echoueA === 'campagne') throw new Error('campagne refusée'); return 'c-1'; },
    creerEnsemble: async () => { appels.push('ensemble'); if (echoueA === 'ensemble') throw new Error('ensemble refusé'); return 'e-1'; },
    creerCrea: async () => { appels.push('crea'); if (echoueA === 'crea') throw new Error('visuel refusé'); return 'cr-1'; },
    creerPub: async () => { appels.push('pub'); if (echoueA === 'pub') throw new Error('publicité refusée'); return 'ad-1'; },
    supprimerCampagne: async (id) => {
      appels.push(`supprime:${id}`);
      if (echecSuppression) throw new Error('suppression refusée');
    },
  };
  return { client, appels };
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
    expect(issue).toEqual({ sorte: 'annulee', raison: 'image refusée' });
    expect(appels).toEqual(['image']);
    expect(ecrits).toEqual([]);
  });

  it('la campagne refusée : rien à supprimer, et la raison de Meta remonte telle quelle', async () => {
    const { client, appels } = faux('campagne');
    const { depot, ecrits } = fauxDepot();
    const issue = await creerLaPublicite(demande(), client, depot);
    expect(issue).toEqual({ sorte: 'annulee', raison: 'campagne refusée' });
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
    expect(issue).toEqual({ sorte: 'annulee', raison: 'base indisponible' });
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

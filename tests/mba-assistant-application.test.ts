import { describe, it, expect } from 'vitest';
import { appliquer, elementDe, libelleDe, operationDe, raisonLisible, type ApplicationDeps, type ClientMbaEcriture } from '../src/mba/assistant/application';
import type { Operation } from '../src/mba/assistant/proposition';
import type { LigneHistorique } from '../src/reglages/historique';

/**
 * APPLIQUER UN DIFF CHEZ META.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : Meta n'offre AUCUNE transaction. « Tout annuler » voudrait dire défaire à la
 * main ce qui est déjà passé, ce qui peut échouer à son tour. Un arrêt net avec un compte rendu exact est la
 * seule chose qu'on puisse tenir, et c'est ce qui se vérifie ici.
 */
const FAQ_A: Operation = { type: 'faq.ajouter', question: 'Horaires ?', reponse: '9h-18h' };
const SITE: Operation = { type: 'site.ajouter', url: 'https://exemple.fr' };
const SKILL: Operation = { type: 'competence.ajouter', nom: 'RDV', instruction: 'Prendre un rendez-vous' };
const SUPPR: Operation = { type: 'faq.supprimer', cible: 'f1', libelle: 'Horaires du dimanche' };

function monter(sur: Partial<ClientMbaEcriture> = {}, opts: { numero?: string | null } = {}) {
  const journal: LigneHistorique[] = [];
  const faits: string[] = [];
  // Des réglages qui gardent ce qu'on y écrit, comme Meta : la mise en service relit l'audience qu'elle vient de poser.
  let reglages: unknown = { locale: 'fr' };
  const client = {
    listFaqs: async () => [{ id: 'f1', question: 'Horaires du dimanche', answer: 'Fermé' }],
    createFaq: async () => { faits.push('createFaq'); },
    updateFaq: async () => { faits.push('updateFaq'); },
    deleteFaq: async () => { faits.push('deleteFaq'); },
    listSkills: async () => [],
    createSkill: async () => { faits.push('createSkill'); },
    updateSkill: async () => {}, deleteSkill: async () => {},
    listWebsites: async () => [],
    createWebsite: async () => { faits.push('createWebsite'); },
    deleteWebsite: async () => {},
    listFiles: async () => [], uploadFile: async () => {}, deleteFile: async () => {},
    getBusinessInfo: async () => ({ business_description: 'Un garage', address: 'Lyon' }),
    putBusinessInfo: async (_p: string, info: unknown) => { faits.push(`put:${JSON.stringify(info)}`); },
    getSettings: async () => reglages,
    putSettings: async (_p: string, s: unknown) => { reglages = s; faits.push(`settings:${JSON.stringify(s)}`); },
    ...sur,
  } as ClientMbaEcriture;
  const deps: ApplicationDeps = {
    numeros: {
      getTenantPhoneNumberId: async () => (opts.numero === undefined ? '123' : opts.numero),
    },
    meta: {
      mbaClientForTenant: async () => client,
    },
    historique: {
      ecrire: async (_t, l) => { journal.push(l); },
    },
    acteur: { id: 'u1', email: 'julien@messagingme.fr' },
    // Notre drapeau, dans le même journal que Meta : la mise en service l'écrit APRÈS Meta.
    drapeau: { setMbaEnabled: async (_t, enabled) => { faits.push(`drapeau:${enabled}`); } },
    attendre: async () => {},
  };
  return { deps, journal, faits };
}

describe('l’ordre et l’arrêt', () => {
  it('applique dans l’ordre quand tout passe', async () => {
    const m = monter();
    const r = await appliquer(m.deps, 't1', 'ag1', [FAQ_A, SKILL, SITE]);
    expect(r.echec).toBeNull();
    expect(r.passees).toHaveLength(3);
    expect(m.faits).toEqual(['createFaq', 'createSkill', 'createWebsite']);
  });

  it('🔴 s’arrête à la PREMIÈRE erreur et dit ce qui n’a pas été tenté', async () => {
    const m = monter({ createSkill: async () => { throw new Error('skill blocked by review'); } });
    const r = await appliquer(m.deps, 't1', 'ag1', [FAQ_A, SKILL, SITE]);
    expect(r.passees).toEqual([FAQ_A]);
    expect(r.echec?.operation).toBe(SKILL);
    expect(r.nonTentees).toEqual([SITE]);
    // ⚠️ Et le site n'a PAS été créé : on s'arrête, on ne « continue pour voir ».
    expect(m.faits).not.toContain('createWebsite');
  });

  it('🔴 le message rendu est en FRANÇAIS, le brut de Meta reste dans les journaux', async () => {
    const m = monter({ createSkill: async () => { throw new Error('skill blocked by review'); } });
    const r = await appliquer(m.deps, 't1', 'ag1', [SKILL]);
    expect(r.echec?.message).toMatch(/refusé ce contenu/i);
    expect(r.echec?.message).not.toMatch(/blocked/);
  });

  it('⚠️ sans numéro rattaché, rien n’est tenté et la raison le dit', async () => {
    const m = monter({}, { numero: null });
    const r = await appliquer(m.deps, 't1', 'ag1', [FAQ_A, SITE]);
    expect(r.passees).toEqual([]);
    expect(r.echec?.message).toMatch(/numéro WhatsApp/i);
    expect(r.nonTentees).toEqual([SITE]);
  });
});

describe('l’historique', () => {
  it('journalise CHAQUE opération passée', async () => {
    const m = monter();
    await appliquer(m.deps, 't1', 'ag1', [FAQ_A, SITE]);
    expect(m.journal).toHaveLength(2);
    expect(m.journal[0]).toMatchObject({ surface: 'mba', surfaceId: null, element: 'faq', operation: 'ajout', origine: 'assistant' });
    expect(m.journal[0]?.acteurEmail).toBe('julien@messagingme.fr');
  });

  it('🔴 ne journalise RIEN pour une opération qui a échoué', async () => {
    // Une ligne d'historique sur un geste qui n'a pas eu lieu ferait chercher une cause qui n'existe pas,
    // sur le seul journal que le client consulte.
    const m = monter({ createFaq: async () => { throw new Error('refus'); } });
    await appliquer(m.deps, 't1', 'ag1', [FAQ_A]);
    expect(m.journal).toHaveLength(0);
  });

  it('🔴 une suppression emporte le CONTENU EFFACÉ, lu AVANT de supprimer', async () => {
    // C'est tout l'intérêt de l'historique : Meta ne rend plus un objet parti, cette ligne en est le seul
    // exemplaire. Le lire après coup serait trop tard.
    const m = monter();
    await appliquer(m.deps, 't1', 'ag1', [SUPPR]);
    expect(m.journal[0]?.operation).toBe('suppression');
    expect(m.journal[0]?.avant).toMatchObject({ id: 'f1', question: 'Horaires du dimanche', answer: 'Fermé' });
  });

  it('⚠️ une suppression dont la cible a déjà disparu garde au moins son identifiant', async () => {
    // Quelqu'un a supprimé au formulaire entre-temps : on ne peut plus lire le contenu, mais une ligne sans
    // `avant` serait refusée par le schéma, et surtout ne dirait rien.
    const m = monter({ listFaqs: async () => [] });
    await appliquer(m.deps, 't1', 'ag1', [SUPPR]);
    expect(m.journal[0]?.avant).toEqual({ id: 'f1' });
  });
});

describe('les pièges de l’API Meta', () => {
  it('🔴 modifier UN champ de la fiche ne doit pas effacer les autres', async () => {
    // `putBusinessInfo` REMPLACE : envoyer le seul champ modifié effacerait la description de l'activité,
    // sur un geste annoncé comme « changer les horaires ».
    const m = monter();
    await appliquer(m.deps, 't1', 'ag1', [{ type: 'business.modifier', champ: 'horaires', valeur: '9h-19h' }]);
    const envoye = m.faits.find((f) => f.startsWith('put:'))!;
    expect(envoye).toContain('business_description');
    expect(envoye).toContain('Lyon');
    expect(envoye).toContain('9h-19h');
  });

  it('⚠️ nos noms de champs ne sont pas ceux de Meta', async () => {
    const m = monter();
    await appliquer(m.deps, 't1', 'ag1', [{ type: 'business.modifier', champ: 'description', valeur: 'Un garage à Lyon' }]);
    expect(m.faits.find((f) => f.startsWith('put:'))).toContain('business_description');
  });

  it('🔴 la mise en service ne remplace pas les autres réglages, et allume dans l’ordre de Meta', async () => {
    const m = monter();
    const r = await appliquer(m.deps, 't1', 'ag1', [{ type: 'activation.mettreEnService' }]);
    expect(r.echec).toBeNull();
    // L'audience d'abord (la liste, sans allumer), une relecture, puis l'allumage.
    const [audience, allumage] = m.faits.filter((f) => f.startsWith('settings:')).map((f) => JSON.parse(f.slice('settings:'.length)) as Record<string, unknown>);
    expect(audience).toEqual({ locale: 'fr', ai_audience: 'ALLOWLISTED_ONLY' });
    expect(allumage).toEqual({ locale: 'fr', ai_audience: 'ALLOWLISTED_ONLY', rollout: { enabled: true } });
  });

  it('🔴 la mise en service écrit aussi notre drapeau, APRÈS Meta', async () => {
    // Toute la mécanique de la liste lit `tenant_settings.mba_enabled` : allumé chez Meta et éteint pour nous, les
    // réponses rangées en `standby` n'arrivaient à personne. Vérifié dans les deux sens : l'écriture du drapeau
    // retirée de `executer`, ce cas échoue (aucun `drapeau:true`).
    const m = monter();
    await appliquer(m.deps, 't1', 'ag1', [{ type: 'activation.mettreEnService' }]);
    expect(m.faits.filter((f) => f.startsWith('settings:') || f.startsWith('drapeau:')).map((f) => f.split(':')[0])).toEqual(['settings', 'settings', 'drapeau']);
    expect(m.faits.at(-1)).toBe('drapeau:true');
  });

  it('⚠️ Meta refuse la mise en service : notre drapeau ne bouge pas', async () => {
    const m = monter({ putSettings: async () => { throw new Error('refusé par Meta'); } });
    const r = await appliquer(m.deps, 't1', 'ag1', [{ type: 'activation.mettreEnService' }]);
    expect(r.echec).not.toBeNull();
    expect(m.faits.some((f) => f.startsWith('drapeau:'))).toBe(false);
  });
});

describe('les libellés et les raisons', () => {
  it('un libellé NOMME ce qu’il touche', () => {
    expect(libelleDe(SUPPR)).toBe('FAQ : Horaires du dimanche');
    expect(libelleDe(SITE)).toBe('Site : https://exemple.fr');
  });

  it('une erreur de débit se distingue d’un refus de contenu', () => {
    expect(raisonLisible(new Error('429 Too Many Requests'))).toMatch(/ralentir/i);
    expect(raisonLisible(new Error('not found'))).toMatch(/n’existe plus/i);
    expect(raisonLisible(new Error('inattendu'))).toMatch(/refusé cette modification/i);
  });
});

/**
 * 🔴 UN JOURNAL MUET NE DOIT PAS TUER UN GESTE QUI A EU LIEU (revue globale du 2026-09-15).
 *
 * `journaliser` était appelé DANS le `try` de la boucle, après que Meta ait accepté l'écriture. Une panne de
 * NOTRE base produisait donc trois choses fausses d'un coup : l'opération apparaissait sous « Fait » ET sous
 * « Arrêté sur », le message accusait META d'un défaut venu de chez nous, et les opérations suivantes étaient
 * abandonnées.
 */
describe('quand le journal est indisponible', () => {
  const clientMuet = () => ({
    listFaqs: async () => [], createFaq: async () => ({}), updateFaq: async () => ({}), deleteFaq: async () => {},
    listSkills: async () => [], createSkill: async () => ({}), updateSkill: async () => ({}), deleteSkill: async () => {},
    listWebsites: async () => [], createWebsite: async () => ({}), deleteWebsite: async () => {},
    listFiles: async () => [], uploadFile: async () => ({}), deleteFile: async () => {},
    getBusinessInfo: async () => ({}), putBusinessInfo: async () => ({}),
    getSettings: async () => ({}), putSettings: async () => ({}),
  } as never);

  const deps = (): ApplicationDeps => ({
    numeros: {
      getTenantPhoneNumberId: async () => '123',
    },
    meta: {
      mbaClientForTenant: async () => clientMuet(),
    },
    historique: {
      ecrire: async () => { throw new Error('base indisponible'); },
    },
    acteur: { id: 'u1', email: null },
    drapeau: { setMbaEnabled: async () => {} },
    attendre: async () => {},
  });

  it('🔴 les opérations passent quand même, et la SUITE est appliquée', async () => {
    const r = await appliquer(deps(), 't1', 'ag-1', [
      { type: 'faq.ajouter', question: 'Horaires ?', reponse: '9h-18h' },
      { type: 'faq.ajouter', question: 'Livraison ?', reponse: 'Sous 48 h' },
    ]);
    expect(r.echec).toBeNull();
    expect(r.passees).toHaveLength(2);
    expect(r.nonTentees).toEqual([]);
  });

  it('🔴 et JAMAIS la même opération sous « fait » et sous « arrêté sur »', async () => {
    const r = await appliquer(deps(), 't1', 'ag-1', [{ type: 'faq.ajouter', question: 'Q', reponse: 'R' }]);
    const arretee = r.echec?.operation;
    expect(arretee === undefined || !r.passees.includes(arretee)).toBe(true);
  });

  it('🔴 et on n’accuse pas Meta d’une panne qui vient de chez nous', async () => {
    const r = await appliquer(deps(), 't1', 'ag-1', [{ type: 'faq.ajouter', question: 'Q', reponse: 'R' }]);
    expect(r.echec?.message ?? '').not.toMatch(/Meta/);
  });
});

/**
 * CE QUE LA LIGNE D'HISTORIQUE DIT DE L'OPÉRATION.
 *
 * 🔴 DEUX FONCTIONS PURES QUI N'AVAIENT AUCUN TEST, et une seule de leurs huit sorties était exercée
 * indirectement (`faq.ajouter`). Elles décident de ce qu'un client lit dans un journal à rétention
 * ILLIMITÉE : une opération rangée sous le mauvais élément y reste pour toujours.
 */
describe('l’élément et l’opération d’une ligne', () => {
  const cas: Array<[Operation, string, string]> = [
    [{ type: 'faq.ajouter', question: 'Q', reponse: 'R' }, 'faq', 'ajout'],
    [{ type: 'faq.modifier', cible: 'f1', question: 'Q', reponse: 'R' }, 'faq', 'modification'],
    [{ type: 'faq.supprimer', cible: 'f1', libelle: 'A' }, 'faq', 'suppression'],
    [{ type: 'competence.ajouter', nom: 'n', instruction: 'i' }, 'competence', 'ajout'],
    [{ type: 'site.supprimer', cible: 's1', libelle: 'S' }, 'site', 'suppression'],
    [{ type: 'fichier.supprimer', cible: 'd1', libelle: 'd.pdf' }, 'fichier', 'suppression'],
    // ⚠️ La famille s'appelle `business`, l'élément `business_info` : la table de correspondance n'est pas
    // l'identité, et c'est exactement le genre de mapping qu'on recopie de travers.
    [{ type: 'business.modifier', champ: 'horaires', valeur: '9h-18h' }, 'business_info', 'modification'],
    // 🔴 Mettre en service est un AJOUT, pas une modification : sans la clause explicite, le suffixe de son
    // type (`.mettreEnService`) le rangerait en « modification ».
    [{ type: 'activation.mettreEnService' }, 'activation', 'ajout'],
  ];

  it('🔴 chaque opération tombe sur le bon élément et la bonne nature', () => {
    for (const [o, element, operation] of cas) {
      expect(`${o.type} -> ${elementDe(o)}/${operationDe(o)}`).toBe(`${o.type} -> ${element}/${operation}`);
    }
  });
});

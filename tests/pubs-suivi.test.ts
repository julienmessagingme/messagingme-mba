import { describe, it, expect, vi } from 'vitest';
import { balayerLesPubs, type SuiviPubsDeps } from '../src/pubs/suivi';
import type { DepensePub, EtatCampagneMeta } from '../src/meta/pubs-creation';

/**
 * LE BALAYAGE DU SUIVI DES PUBLICITÉS.
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT, ET QUI NE SE VOIT PAS À LA RELECTURE : le balayage sert une FLOTTE. Chaque
 * cas ci-dessous est une façon pour un seul client de priver tous les autres de leurs chiffres, et aucune ne
 * produit d'erreur visible : un jeton mort, un Meta muet sur une des deux lectures, une campagne qui n'a
 * encore rien diffusé. Ce sont les cas nominaux d'un pilote, pas des cas rares.
 */

const etat = (statut: string): EtatCampagneMeta => ({ statut, motifRefus: null, debut: null, fin: null, budgetTotal: null });
const depense = (d: number, c: number): DepensePub => ({ depense: d, clics: c });

interface Traces {
  notes: Array<{ tenant: string; campagne: string; statut: string | null; depense: number | null }>;
  rejetes: string[];
  alertes: string[];
  appelsMeta: string[];
}

function monter(over: Partial<SuiviPubsDeps> = {}): { deps: SuiviPubsDeps; t: Traces } {
  const t: Traces = { notes: [], rejetes: [], alertes: [], appelsMeta: [] };
  const deps: SuiviPubsDeps = {
    espacesASuivre: async () => ['t1'],
    campagnesASuivre: async () => ['c-1', 'c-2'],
    jeton: async () => 'jeton-clair',
    lireCampagnes: async (ids) => {
      t.appelsMeta.push(`statuts:${ids.join(',')}`);
      return new Map(ids.map((id) => [id, etat('ACTIVE')]));
    },
    lireDepenses: async (ids) => {
      t.appelsMeta.push(`depenses:${ids.join(',')}`);
      return new Map(ids.map((id) => [id, depense(12.5, 40)]));
    },
    noterSuivi: async (tenant, campagne, v) => {
      t.notes.push({ tenant, campagne, statut: v.etat?.statut ?? null, depense: v.depense?.depense ?? null });
    },
    marquerJetonRejete: async (tenant) => { t.rejetes.push(tenant); },
    estJetonRefuse: (err) => err instanceof Error && err.message === 'jeton mort',
    alerter: (sujet) => { t.alertes.push(sujet); },
    ...over,
  };
  return { deps, t };
}

describe('le chemin nominal', () => {
  it('relit les deux choses et note chaque campagne', async () => {
    const { deps, t } = monter();
    const bilan = await balayerLesPubs(deps);
    expect(bilan).toEqual({ espaces: 1, campagnes: 2, jetonsRejetes: 0 });
    expect(t.notes).toEqual([
      { tenant: 't1', campagne: 'c-1', statut: 'ACTIVE', depense: 12.5 },
      { tenant: 't1', campagne: 'c-2', statut: 'ACTIVE', depense: 12.5 },
    ]);
  });

  it('🔴 DEUX APPELS PAR COMPTE, pas deux par campagne : c’est ce qui rend le balayage tenable', async () => {
    // Un appel par campagne ferait, pour un client à vingt publicités, quarante appels toutes les quinze
    // minutes. Le niveau « Limited » de l'API Marketing ne le supporterait pas, et le compte serait bridé
    // pour TOUT le reste, création comprise.
    const { deps, t } = monter();
    await balayerLesPubs(deps);
    expect(t.appelsMeta).toEqual(['statuts:c-1,c-2', 'depenses:c-1,c-2']);
  });
});

describe('les économies d’appels', () => {
  it('🔴 aucun espace à suivre : AUCUN appel à Meta', async () => {
    const { deps, t } = monter({ espacesASuivre: async () => [] });
    expect(await balayerLesPubs(deps)).toEqual({ espaces: 0, campagnes: 0, jetonsRejetes: 0 });
    expect(t.appelsMeta).toEqual([]);
  });

  it('🔴 un espace connecté SANS publicité publiée ne coûte aucun appel', async () => {
    // Sans ce retour, un client connecté et sans campagne consommerait deux appels toutes les quinze
    // minutes pour confirmer qu'il n'y a rien à faire.
    const { deps, t } = monter({ campagnesASuivre: async () => [] });
    await balayerLesPubs(deps);
    expect(t.appelsMeta).toEqual([]);
  });

  it('un espace déconnecté entre-temps est sauté, sans appel et sans erreur', async () => {
    const { deps, t } = monter({ jeton: async () => null });
    expect((await balayerLesPubs(deps)).espaces).toBe(0);
    expect(t.appelsMeta).toEqual([]);
  });
});

describe('🔴 LE JETON REJETÉ', () => {
  it('est marqué UNE fois, alerte UNE fois, et le balayage passe à l’espace suivant', async () => {
    const { deps, t } = monter({
      espacesASuivre: async () => ['t1', 't2'],
      lireCampagnes: async () => { throw new Error('jeton mort'); },
      lireDepenses: async () => { throw new Error('jeton mort'); },
    });
    const bilan = await balayerLesPubs(deps);
    // Les DEUX lectures échouent ensemble quand le jeton est mort. Marquer et alerter dans chacune
    // produirait deux alertes identiques toutes les quinze minutes, ce qui est le meilleur moyen de faire
    // ignorer la seule qui compte.
    expect(t.rejetes).toEqual(['t1', 't2']);
    expect(t.alertes).toEqual(['pubs-jeton', 'pubs-jeton']);
    expect(bilan.jetonsRejetes).toBe(2);
    // Rien n'est noté : on n'écrit pas de chiffres qu'on n'a pas lus.
    expect(t.notes).toEqual([]);
  });

  it('⚠️ L’ALERTE DIT QUE LE ROUTAGE CONTINUE : sans ça, on croirait les leads perdus', async () => {
    const messages: string[] = [];
    const { deps } = monter({
      lireCampagnes: async () => { throw new Error('jeton mort'); },
      lireDepenses: async () => { throw new Error('jeton mort'); },
      alerter: (_s, m) => { messages.push(m); },
    });
    await balayerLesPubs(deps);
    expect(messages[0]).toContain('routage des leads continue');
  });
});

describe('🔴 LES DEUX LECTURES SONT INDÉPENDANTES', () => {
  it('la dépense échoue, le statut passe quand même', async () => {
    // C'est le cas NORMAL d'une campagne qui vient d'être publiée : Meta a un statut et pas encore de
    // statistiques. Les enchaîner dans un seul `try` ferait perdre le statut de toutes les campagnes.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, t } = monter({ lireDepenses: async () => { throw new Error('insights indisponibles'); } });
    await balayerLesPubs(deps);
    spy.mockRestore();
    expect(t.notes).toEqual([
      { tenant: 't1', campagne: 'c-1', statut: 'ACTIVE', depense: null },
      { tenant: 't1', campagne: 'c-2', statut: 'ACTIVE', depense: null },
    ]);
    expect(t.rejetes).toEqual([]);
  });

  it('le statut échoue, la dépense passe quand même', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, t } = monter({ lireCampagnes: async () => { throw new Error('graph 500'); } });
    await balayerLesPubs(deps);
    spy.mockRestore();
    expect(t.notes[0]).toEqual({ tenant: 't1', campagne: 'c-1', statut: null, depense: 12.5 });
  });

  it('⚠️ une panne PASSAGÈRE ne marque PAS le jeton rejeté : « réessayez » n’est pas « reconnectez-vous »', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, t } = monter({
      lireCampagnes: async () => { throw new Error('graph 500'); },
      lireDepenses: async () => { throw new Error('graph 500'); },
    });
    await balayerLesPubs(deps);
    spy.mockRestore();
    expect(t.rejetes).toEqual([]);
    expect(t.alertes).toEqual([]);
  });
});

describe('une campagne dont Meta ne dit rien', () => {
  it('est quand même notée, pour que `lu_le` avance', async () => {
    // Sans cette écriture, le balayage suivant recommencerait par la même campagne (l'ordre est « la moins
    // fraîche d'abord »), et l'écran dirait « jamais lu » au lieu de « relu il y a 3 minutes, Meta n'a
    // encore rien ».
    const { deps, t } = monter({
      lireCampagnes: async () => new Map(),
      lireDepenses: async () => new Map(),
    });
    await balayerLesPubs(deps);
    expect(t.notes).toEqual([
      { tenant: 't1', campagne: 'c-1', statut: null, depense: null },
      { tenant: 't1', campagne: 'c-2', statut: null, depense: null },
    ]);
  });
});

describe('🔴 ISOLATION PAR ESPACE : un client ne prive pas les autres', () => {
  it('un espace qui lève est sauté, les suivants sont relus', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, t } = monter({
      espacesASuivre: async () => ['ko', 'ok'],
      campagnesASuivre: async (tenant) => {
        if (tenant === 'ko') throw new Error('base indisponible');
        return ['c-9'];
      },
    });
    const bilan = await balayerLesPubs(deps);
    spy.mockRestore();
    expect(bilan.espaces).toBe(1);
    expect(t.notes.map((n) => n.tenant)).toEqual(['ok']);
  });

  it('⚠️ il ne lève JAMAIS : son appelant est un `setInterval`, et une exception tuerait le balayage', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = monter({ espacesASuivre: async () => { throw new Error('base morte'); } });
    await expect(balayerLesPubs(deps)).resolves.toEqual({ espaces: 0, campagnes: 0, jetonsRejetes: 0 });
    spy.mockRestore();
  });
});

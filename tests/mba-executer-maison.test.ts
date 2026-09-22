import { describe, it, expect } from 'vitest';
import { CHAMP_DISPARU, CONTACT_BLOQUE, erreurDePanne, executerOutilMaison, type DepsMaison } from '../src/mba/executer-maison';

/**
 * Exécuter un geste de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : la cible FIXÉE par l'administrateur. Le corps envoyé par Meta ne choisit ni
 * l'étiquette ni le champ, quoi qu'il contienne ; il ne fournit que la valeur d'un champ.
 */
function faux(champs: string[] = ['ville'], o: { bloque?: boolean; issue?: true | string } = {}) {
  const gestes: string[] = [];
  const deps: DepsMaison = {
    poserTag: async (t, w, tag) => { gestes.push(`tag ${t} ${w} ${tag}`); },
    ecrireChamp: async (t, w, champ, valeur) => { gestes.push(`champ ${t} ${w} ${champ}=${valeur}`); },
    champExiste: async (_t, champ) => champs.includes(champ),
    estBloque: async () => o.bloque === true,
    envoyerBloc: async (t, w, c) => { gestes.push(`bloc ${t} ${w} ${c.workflowId} ${c.code}`); return o.issue ?? true; },
    lancerScenario: async (t, w, id) => { gestes.push(`scenario ${t} ${w} ${id}`); return o.issue ?? true; },
  };
  return { deps, gestes };
}

describe('exécuter un geste de l’agent de Meta', () => {
  it('🔴 pose l’étiquette FIXÉE, pour le contact de l’en-tête', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: '33612345678', cible: { handler: 'tag_fixe', tag: 'vip' }, corps: { tag: 'autre' },
    });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('fiche du client') });
    // Le corps ne choisit PAS l'étiquette : c'est tout l'arbitrage « fixé d'avance ».
    expect(f.gestes).toEqual(['tag t1 33612345678 vip']);
  });

  it('écrit la valeur fournie dans le champ FIXÉ', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: [] }, corps: { valeur: 'Lyon', champ: 'autre' },
    });
    expect(r.ok).toBe(true);
    expect(f.gestes).toEqual(['champ t1 w ville=Lyon']);
  });

  it('🔴 un champ SUPPRIMÉ du mini-CRM n’est pas écrit : l’agent de Meta lit pourquoi', async () => {
    // L'onglet Outils affiche alors « ce champ n'existe plus » : écrire quand même rangerait la valeur sous une
    // clé qu'aucun écran ne montre, et la ligne rouge mentirait.
    const f = faux([]);
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: [] }, corps: { valeur: 'Lyon' },
    });
    expect(r).toEqual({ ok: false, erreur: CHAMP_DISPARU });
    expect(f.gestes).toEqual([]);
  });

  it('🔴 une valeur refusée n’écrit RIEN', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris'] }, corps: { valeur: 'Lyon' },
    });
    expect(r.ok).toBe(false);
    expect(f.gestes).toEqual([]);
  });
});

describe('envoyer un bloc, lancer un scénario', () => {
  const BLOC = { handler: 'bloc_fixe' as const, workflowId: '11111111-1111-4111-8111-111111111111', code: `nod_abc_${'A'.repeat(26)}` };
  const SCEN = { handler: 'scenario_fixe' as const, workflowId: '11111111-1111-4111-8111-111111111111' };

  it('🔴 envoie le bloc FIXÉ, quoi que dise le corps, et répond « n’ajoute rien »', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: BLOC, corps: { code: 'autre' } });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('N’ajoute rien') });
    expect(f.gestes).toEqual([`bloc t1 w ${BLOC.workflowId} ${BLOC.code}`]);
  });

  it('lance le scénario fixé', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: SCEN, corps: {} });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('la conversation te reviendra') });
    expect(f.gestes).toEqual([`scenario t1 w ${SCEN.workflowId}`]);
  });

  it('🔴 un contact BLOQUÉ ne reçoit rien, et l’agent de Meta le sait', async () => {
    for (const cible of [BLOC, SCEN]) {
      const f = faux(['ville'], { bloque: true });
      expect(await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible, corps: {} }))
        .toEqual({ ok: false, erreur: CONTACT_BLOQUE });
      expect(f.gestes).toEqual([]);
    }
  });

  it('🔴 la raison d’un refus remonte telle quelle à l’agent de Meta', async () => {
    const f = faux(['ville'], { issue: 'la fenêtre de 24 h est fermée' });
    expect(await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: BLOC, corps: {} }))
      .toEqual({ ok: false, erreur: 'la fenêtre de 24 h est fermée' });
  });
});

describe('une panne, dite à l’agent de Meta', () => {
  it('🔴 un envoi en panne ne s’invite PAS à réessayer : le message est peut-être déjà parti', () => {
    const WF = '11111111-1111-4111-8111-111111111111';
    expect(erreurDePanne({ handler: 'bloc_fixe', workflowId: WF, code: `nod_abc_${'A'.repeat(26)}` })).toContain('ne relance pas');
    expect(erreurDePanne({ handler: 'scenario_fixe', workflowId: WF })).toContain('ne relance pas');
    expect(erreurDePanne({ handler: 'tag_fixe', tag: 'vip' })).toContain('réessayez');
  });
});

import { describe, it, expect } from 'vitest';
import { CHAMP_DISPARU, CONTACT_BLOQUE, REPONSE_DEJA_TRAITE, erreurDePanne, executerOutilMaison, type DepsMaison } from '../src/mba/executer-maison';
import { AntiRejeu } from '../src/mba/anti-rejeu';

/**
 * Exécuter un geste de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : la cible FIXÉE par l'administrateur. Le corps envoyé par Meta ne choisit ni
 * l'étiquette ni le champ, quoi qu'il contienne ; il ne fournit que la valeur d'un champ.
 */
function faux(champs: string[] = ['ville'], o: { bloque?: boolean; issue?: true | string; leve?: boolean } = {}) {
  const gestes: string[] = [];
  const deps: DepsMaison = {
    poserTag: async (t, w, tag) => { gestes.push(`tag ${t} ${w} ${tag}`); },
    ecrireChamp: async (t, w, champ, valeur) => { gestes.push(`champ ${t} ${w} ${champ}=${valeur}`); },
    champExiste: async (_t, champ) => champs.includes(champ),
    estBloque: async () => o.bloque === true,
    envoyerBloc: async (t, w, c) => { gestes.push(`bloc ${t} ${w} ${c.workflowId} ${c.code}`); return o.issue ?? true; },
    lancerScenario: async (t, w, id) => {
      gestes.push(`scenario ${t} ${w} ${id}`);
      if (o.leve) throw new Error('panne de base au journal');
      return o.issue ?? true;
    },
    antiRejeu: new AntiRejeu(60_000),
  };
  return { deps, gestes };
}

describe('exécuter un geste de l’agent de Meta', () => {
  it('🔴 pose l’étiquette FIXÉE, pour le contact de l’en-tête', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', outilId: 'o1', waId: '33612345678', cible: { handler: 'tag_fixe', tag: 'vip' }, corps: { tag: 'autre' },
    });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('fiche du client') });
    // Le corps ne choisit PAS l'étiquette : c'est tout l'arbitrage « fixé d'avance ».
    expect(f.gestes).toEqual(['tag t1 33612345678 vip']);
  });

  it('écrit la valeur fournie dans le champ FIXÉ', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', outilId: 'o1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: [] }, corps: { valeur: 'Lyon', champ: 'autre' },
    });
    expect(r.ok).toBe(true);
    expect(f.gestes).toEqual(['champ t1 w ville=Lyon']);
  });

  it('🔴 un champ SUPPRIMÉ du mini-CRM n’est pas écrit : l’agent de Meta lit pourquoi', async () => {
    // L'onglet Outils affiche alors « ce champ n'existe plus » : écrire quand même rangerait la valeur sous une
    // clé qu'aucun écran ne montre, et la ligne rouge mentirait.
    const f = faux([]);
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', outilId: 'o1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: [] }, corps: { valeur: 'Lyon' },
    });
    expect(r).toEqual({ ok: false, erreur: CHAMP_DISPARU });
    expect(f.gestes).toEqual([]);
  });

  it('🔴 une valeur refusée n’écrit RIEN', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, {
      tenantId: 't1', outilId: 'o1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris'] }, corps: { valeur: 'Lyon' },
    });
    expect(r.ok).toBe(false);
    expect(f.gestes).toEqual([]);
  });
});

describe('envoyer un bloc, lancer un scénario', () => {
  const BLOC = { handler: 'bloc_fixe' as const, workflowId: '11111111-1111-4111-8111-111111111111', code: `nod_abc_${'A'.repeat(26)}` };
  const SCEN = { handler: 'scenario_fixe' as const, workflowId: '11111111-1111-4111-8111-111111111111' };

  it('🔴 envoie le bloc FIXÉ, quoi que dise le corps, et répond « ne rappelle pas cet outil »', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: BLOC, corps: { code: 'autre' } });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('Ne rappelle pas cet outil') });
    expect(f.gestes).toEqual([`bloc t1 w ${BLOC.workflowId} ${BLOC.code}`]);
  });

  it('lance le scénario fixé', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('la conversation te reviendra') });
    expect(f.gestes).toEqual([`scenario t1 w ${SCEN.workflowId}`]);
  });

  it('🔴 un contact BLOQUÉ ne reçoit rien, et l’agent de Meta le sait', async () => {
    for (const cible of [BLOC, SCEN]) {
      const f = faux(['ville'], { bloque: true });
      expect(await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible, corps: {} }))
        .toEqual({ ok: false, erreur: CONTACT_BLOQUE });
      expect(f.gestes).toEqual([]);
    }
  });

  it('🔴 la raison d’un refus remonte telle quelle à l’agent de Meta', async () => {
    const f = faux(['ville'], { issue: 'la fenêtre de 24 h est fermée' });
    expect(await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: BLOC, corps: {} }))
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

describe('un envoi ne se rejoue pas pour le même client', () => {
  const SCEN = { handler: 'scenario_fixe' as const, workflowId: '11111111-1111-4111-8111-111111111111' };

  it('🔴 sept appels du même outil pour le même client : UN seul lancement (essai réel du 2026-09-22)', async () => {
    const f = faux();
    const issues = [];
    for (let i = 0; i < 7; i += 1) {
      issues.push(await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} }));
    }
    expect(f.gestes).toEqual([`scenario t1 w ${SCEN.workflowId}`]);
    // Les rappels répondent « déjà traitée », ce qui clôt le tour de l'agent de Meta au lieu d'un refus.
    expect(issues.slice(1).every((r) => r.ok && r.reponse === REPONSE_DEJA_TRAITE.scenario_fixe)).toBe(true);
  });

  it('🔴 sept appels SIMULTANÉS : un seul lancement (revue finale du 2026-09-22)', async () => {
    // Le premier garde vérifiait, ATTENDAIT le contrôle du blocage, puis retenait : sept appels lancés ensemble
    // passaient tous la vérification avant que le premier ne retienne, et partaient tous (7 sur 7, mesuré).
    const f = faux();
    const issues = await Promise.all(Array.from({ length: 7 }, () =>
      executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} })));
    expect(f.gestes).toEqual([`scenario t1 w ${SCEN.workflowId}`]);
    expect(issues.filter((r) => r.ok && r.reponse === REPONSE_DEJA_TRAITE.scenario_fixe)).toHaveLength(6);
  });

  it('🔴 une EXCEPTION garde la clé : le message a pu partir, le rappel ne le renvoie pas', async () => {
    const f = faux(['ville'], { leve: true });
    await expect(executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} })).rejects.toThrow();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} });
    expect(f.gestes).toHaveLength(1);
    expect(r).toEqual({ ok: true, reponse: REPONSE_DEJA_TRAITE.scenario_fixe });
  });

  it('🔴 le rappel n’affirme JAMAIS que le client a reçu : l’agent de Meta le lui répéterait', () => {
    // Revue finale du 2026-09-22 : « le client a bien reçu le message » était faux après une exception, ou quand
    // le premier appel finissait en refus. Le rappel dit ce qui est sûr : la demande a déjà été prise en charge.
    for (const r of Object.values(REPONSE_DEJA_TRAITE)) {
      expect(r).not.toMatch(/reçu/);
      expect(r).toContain('ne rappelle plus cet outil');
    }
    // Pour un scénario, la consigne qui fait attendre la fin du parcours ne se perd pas au rappel.
    expect(REPONSE_DEJA_TRAITE.scenario_fixe).toContain('la conversation te reviendra');
  });

  it('un AUTRE client, ou un AUTRE outil, n’est pas concerné', async () => {
    const f = faux();
    await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} });
    await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'autre', cible: SCEN, corps: {} });
    await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o2', waId: 'w', cible: SCEN, corps: {} });
    expect(f.gestes).toHaveLength(3);
  });

  it('🔴 un REFUS n’est pas retenu : rien n’est parti, le client peut redemander', async () => {
    const f = faux(['ville'], { issue: 'la fenêtre de 24 h est fermée' });
    await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} });
    await executerOutilMaison(f.deps, { tenantId: 't1', outilId: 'o1', waId: 'w', cible: SCEN, corps: {} });
    expect(f.gestes).toHaveLength(2);
  });

  it('au-delà de la durée, le même geste repart', () => {
    let t = 0;
    const a = new AntiRejeu(1000, () => t);
    expect(a.prendre('k')).toBe(true);
    expect(a.prendre('k')).toBe(false);
    t = 999;
    expect(a.prendre('k')).toBe(false);
    t = 1000;
    expect(a.prendre('k')).toBe(true);
  });
});

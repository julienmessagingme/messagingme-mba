import { describe, it, expect } from 'vitest';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { empreinteEtat, type EtatConfirme, type IssueReclamation } from '../src/campaign/confirmation';

/**
 * `launch_campaign` (plan « Campagnes depuis Claude », tâche 8) : lance la campagne préparée, par le MÊME chemin que le
 * bouton de la console (`lancerCampagne`), et seulement avec le code de son récapitulatif. 🔴 Le code est réclamé avant
 * le lancement (usage unique) et rendu si le lancement est refusé ; une campagne datée est PROGRAMMÉE à sa date, jamais
 * envoyée tout de suite.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ID = '55555555-5555-4555-8555-555555555555';
const PERSONNE = { userId: 'u1' };
const outil = OUTILS.find((o) => o.nom === 'launch_campaign')!;

const ETAT: EtatConfirme = {
  templateName: 'retard_livraison', templateLanguage: 'fr', category: 'utility', prevueLe: null,
  paramMapping: [], recipientCount: 38, status: 'draft',
};

function deps(o: { etat?: EtatConfirme | null; reclamation?: IssueReclamation; programmable?: boolean; appartient?: boolean } = {}) {
  const trace: string[] = [];
  const reclames: Array<{ code: string; etat: string }> = [];
  const etat = o.etat === undefined ? ETAT : o.etat;
  const d = {
    couteux: { consommer: async () => { trace.push('plafond'); return { accepte: true, attenteMs: 0 }; } },
    campagnes: {
      route: {
        repo: {
          etatPourConfirmation: async (t: string) => (t === T ? etat : null),
          campaignBelongsTo: async (_id: string, t: string) => (o.appartient ?? true) && t === T,
          scheduleCampaign: async (_id: string, _t: string, quand: Date) => { trace.push(`programme:${quand.toISOString()}`); return o.programmable ?? true; },
          resumeCampaign: async () => { trace.push('reprend'); return true; },
          pauseCampaign: async () => true,
          getRunSizing: async () => ({ ratePerMinute: null, pendingCount: 38 }),
        },
        queue: { enqueue: async (name: string, data: unknown) => { trace.push(`enfile:${name}:${JSON.stringify(data)}`); } },
        modelesDuLancement: async () => null,
        defaultRatePerMinute: 0,
        plafondLePlusBas: 80,
      },
      confirmations: {
        reclamer: async (_t: string, _id: string, code: string, e: string) => { trace.push('reclame'); reclames.push({ code, etat: e }); return o.reclamation ?? 'ok'; },
        rendre: async () => { trace.push('rend'); },
      },
    },
  } as unknown as DepsMcp;
  return { d, trace, reclames };
}

describe('launch_campaign', () => {
  it('🔴 une écriture qui envoie, au nom d’une personne, qui exige le code', () => {
    expect(outil.fonction).toBe('console');
    expect(outil.exigePersonne).toBe(true);
    expect(outil.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(outil.entree.required).toEqual(['campaign_id', 'confirmation_code']);
  });

  it('le bon code, sur l’état RELU en base : lancé par le chemin de la console', async () => {
    const { d, trace, reclames } = deps();
    expect(await outil.executer(d, T, { campaign_id: ID, confirmation_code: 'k7m2qp' }, PERSONNE)).toMatchObject({ campaign_id: ID, status: 'sending' });
    expect(reclames).toEqual([{ code: 'k7m2qp', etat: empreinteEtat(ETAT) }]);
    expect(trace).toEqual(['plafond', 'reclame', 'reprend', `enfile:campaign-run:${JSON.stringify({ campaignId: ID })}`]);
  });

  it('🔴 une campagne datée est PROGRAMMÉE à sa date, rien n’est enfilé', async () => {
    const { d, trace } = deps({ etat: { ...ETAT, prevueLe: '2027-10-31T09:00:00.000Z' } });
    const r = await outil.executer(d, T, { campaign_id: ID, confirmation_code: 'K7M2QP' }, PERSONNE);
    expect(r).toMatchObject({ status: 'scheduled', scheduled_for: { iso: '2027-10-31T09:00:00.000Z', paris: 'dimanche 31 octobre 2027 à 10 h' } });
    expect(trace).toContain('programme:2027-10-31T09:00:00.000Z');
    expect(trace.some((t) => t.startsWith('enfile'))).toBe(false);
  });

  it('🔴 code faux, expiré, déjà utilisé, ou campagne changée depuis le récapitulatif : refusé, rien ne part', async () => {
    for (const reclamation of ['invalide', 'expire', 'utilise', 'modifie'] as const) {
      const { d, trace } = deps({ reclamation });
      await expect(outil.executer(d, T, { campaign_id: ID, confirmation_code: 'K7M2QP' }, PERSONNE), reclamation).rejects.toThrow(RefusOutil);
      expect(trace.some((t) => t.startsWith('enfile') || t.startsWith('programme') || t === 'reprend'), reclamation).toBe(false);
    }
  });

  it('🔴 la campagne d’un autre espace : « inconnue », aucun code réclamé', async () => {
    const { d, trace } = deps();
    await expect(outil.executer(d, 'ffffffff-e5f6-4a7b-8c9d-0e1f2a3b4c5d', { campaign_id: ID, confirmation_code: 'K7M2QP' }, PERSONNE)).rejects.toThrow(/inconnue/);
    expect(trace).not.toContain('reclame');
  });

  it('une date devenue passée : refus « préparez à nouveau », et le code est rendu', async () => {
    const { d, trace } = deps({ etat: { ...ETAT, prevueLe: '2020-01-01T09:00:00.000Z' } });
    await expect(outil.executer(d, T, { campaign_id: ID, confirmation_code: 'K7M2QP' }, PERSONNE)).rejects.toThrow(/prepare_campaign/);
    expect(trace).toEqual(['plafond', 'reclame', 'rend']);
  });

  it('une campagne que la base ne programme plus : refusée, le code rendu', async () => {
    const { d, trace } = deps({ etat: { ...ETAT, prevueLe: '2027-10-31T09:00:00.000Z' }, programmable: false });
    await expect(outil.executer(d, T, { campaign_id: ID, confirmation_code: 'K7M2QP' }, PERSONNE)).rejects.toThrow(RefusOutil);
    expect(trace[trace.length - 1]).toBe('rend');
  });

  it('🔴 la reprise d’une campagne en pause (code de control_campaign) repart TOUT DE SUITE : sa date passée ne la fait pas refuser', async () => {
    const enPause: EtatConfirme = { ...ETAT, status: 'paused', recipientCount: 2, prevueLe: '2020-01-01T09:00:00.000Z' };
    const { d, trace } = deps({ etat: enPause });
    expect(await outil.executer(d, T, { campaign_id: ID, confirmation_code: 'R4P2XQ' }, PERSONNE)).toEqual({ campaign_id: ID, status: 'sending', recipients: 2 });
    expect(trace).toEqual(['plafond', 'reclame', 'reprend', `enfile:campaign-run:${JSON.stringify({ campaignId: ID })}`]);
  });

  it('🔴 un code de reprise refusé ne renvoie JAMAIS vers prepare_campaign, qui renverrait à tous les destinataires', async () => {
    const enPause: EtatConfirme = { ...ETAT, status: 'paused', recipientCount: 2 };
    for (const reclamation of ['invalide', 'expire', 'utilise', 'modifie'] as const) {
      const { d } = deps({ etat: enPause, reclamation });
      const refus = await outil.executer(d, T, { campaign_id: ID, confirmation_code: 'R4P2XQ' }, PERSONNE).catch((e: Error) => e.message);
      expect(refus, reclamation).not.toMatch(/prepare_campaign/);
      if (reclamation !== 'utilise') expect(refus, reclamation).toMatch(/prepare_resume/);
    }
  });

  it('identifiant mal formé ou sans personne : refusé avant toute lecture', async () => {
    const { d, trace } = deps();
    await expect(outil.executer(d, T, { campaign_id: 'pas-un-uuid', confirmation_code: 'K7M2QP' }, PERSONNE)).rejects.toThrow(RefusOutil);
    await expect(outil.executer(d, T, { campaign_id: ID, confirmation_code: 'K7M2QP' }, null)).rejects.toThrow(RefusOutil);
    expect(trace).toEqual([]);
  });
});

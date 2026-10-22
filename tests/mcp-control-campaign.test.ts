import { describe, it, expect } from 'vitest';
import { OUTILS, outilsPour, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { empreinteEtat, type EtatConfirme } from '../src/campaign/confirmation';

/**
 * `control_campaign` (plan `docs/superpowers/plans/2026-10-22-mcp-marche-arriere.md`, tâche 5) : les freins d'une campagne
 * lancée depuis Claude, et le chemin du retour. La pause et la déprogrammation sont les gestes de la console
 * (`pauseCampaign`, `cancelSchedule`), sans confirmation parce qu'ils arrêtent ; la reprise, elle, fait repartir des
 * messages : elle passe par un récapitulatif et un code, puis par `launch_campaign`, le seul outil qui envoie en masse.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ID = '55555555-5555-4555-8555-555555555555';
const PERSONNE = { userId: 'u1' };
const outil = OUTILS.find((o) => o.nom === 'control_campaign')!;

const EN_PAUSE: EtatConfirme = {
  templateName: 'promo_ete', templateLanguage: 'fr', category: 'marketing', prevueLe: '2026-10-20T08:00:00.000Z',
  paramMapping: [], recipientCount: 2, status: 'paused',
};

function deps(o: { etat?: EtatConfirme; appartient?: boolean; suspendable?: boolean; programmee?: boolean } = {}) {
  const trace: string[] = [];
  const poses: string[] = [];
  const d = {
    campagnes: {
      route: {
        repo: {
          campaignBelongsTo: async (id: string, t: string) => (o.appartient ?? true) && t === T && id === ID,
          pauseCampaign: async () => { trace.push('pause'); return o.suspendable ?? true; },
          cancelSchedule: async () => { trace.push('deprogramme'); return o.programmee ?? true; },
          etatPourConfirmation: async (t: string) => (t === T ? (o.etat ?? EN_PAUSE) : null),
        },
      },
      confirmations: {
        poser: async (_t: string, _id: string, etat: string) => { poses.push(etat); return { code: 'R4P2XQ', expireLe: new Date('2026-10-22T16:30:00.000Z') }; },
      },
    },
  } as unknown as DepsMcp;
  return { d, trace, poses };
}

describe('control_campaign : les freins et la reprise (marche arrière, tâche 5)', () => {
  it('🔴 dans l’offre des campagnes (console, le Pro), au nom d’une personne : une clé d’API ne le voit pas', () => {
    expect(outil.fonction).toBe('console');
    expect(outil.exigePersonne).toBe(true);
    const parCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null } as never).map((x) => x.nom);
    expect(parCle).not.toContain('control_campaign');
  });

  it('pause : le geste d’urgence de la console, sans code', async () => {
    const { d, trace } = deps();
    expect(await outil.executer(d, T, { campaign_id: ID, action: 'pause' }, PERSONNE)).toEqual({ campaign_id: ID, status: 'paused' });
    expect(trace).toEqual(['pause']);
  });

  it('une campagne qui n’envoie pas ne se met pas en pause : refus lisible', async () => {
    const { d } = deps({ suspendable: false });
    await expect(outil.executer(d, T, { campaign_id: ID, action: 'pause' }, PERSONNE)).rejects.toThrow(/en cours d’envoi/);
  });

  it('unschedule : la campagne programmée redevient un brouillon, rien ne part', async () => {
    const { d, trace } = deps();
    expect(await outil.executer(d, T, { campaign_id: ID, action: 'unschedule' }, PERSONNE)).toEqual({ campaign_id: ID, status: 'draft' });
    expect(trace).toEqual(['deprogramme']);
    const pasProgrammee = deps({ programmee: false });
    await expect(outil.executer(pasProgrammee.d, T, { campaign_id: ID, action: 'unschedule' }, PERSONNE)).rejects.toThrow(/programmée/);
  });

  it('🔴 prepare_resume rend le récapitulatif des destinataires restants et un code lié à l’état en pause, sans rien envoyer', async () => {
    const { d, trace, poses } = deps();
    const r = await outil.executer(d, T, { campaign_id: ID, action: 'prepare_resume' }, PERSONNE) as Record<string, unknown>;
    expect(r).toMatchObject({ campaign_id: ID, status: 'paused', recipients_waiting: 2, confirmation_code: 'R4P2XQ' });
    expect(poses).toEqual([empreinteEtat(EN_PAUSE)]);
    expect(trace).toEqual([]);
  });

  it('🔴 seule une campagne en pause se reprend : aucun code pour une autre', async () => {
    for (const status of ['running', 'draft', 'completed']) {
      const { d, poses } = deps({ etat: { ...EN_PAUSE, status } });
      await expect(outil.executer(d, T, { campaign_id: ID, action: 'prepare_resume' }, PERSONNE), status).rejects.toThrow(/en pause/);
      expect(poses, status).toEqual([]);
    }
  });

  it('🔴 la campagne d’un autre espace n’existe pas : aucun geste', async () => {
    for (const action of ['pause', 'unschedule', 'prepare_resume']) {
      const { d, trace, poses } = deps({ appartient: false });
      await expect(outil.executer(d, T, { campaign_id: ID, action }, PERSONNE), action).rejects.toThrow(/inconnue/);
      expect([...trace, ...poses], action).toEqual([]);
    }
  });

  it('une action inconnue, un identifiant mal formé ou pas de personne : refusés avant toute lecture', async () => {
    const { d, trace } = deps();
    await expect(outil.executer(d, T, { campaign_id: ID, action: 'resume' }, PERSONNE)).rejects.toThrow(RefusOutil);
    await expect(outil.executer(d, T, { campaign_id: 'pas-un-uuid', action: 'pause' }, PERSONNE)).rejects.toThrow(RefusOutil);
    await expect(outil.executer(d, T, { campaign_id: ID, action: 'pause' }, null)).rejects.toThrow(RefusOutil);
    expect(trace).toEqual([]);
  });
});

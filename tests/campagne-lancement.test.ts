import { describe, it, expect } from 'vitest';
import { lancerCampagne, type DepsLancement } from '../src/campaign/lancement';

/**
 * LE LANCEMENT PARTAGÉ (plan « Campagnes depuis Claude », tâche 2) : le bouton « Lancer » de la console et l'outil
 * `launch_campaign` passent par la même fonction. Une seconde copie dériverait, et sur le chemin d'envoi de masse ce
 * serait un assistant qui lance avec d'autres garde-fous.
 */
function deps(o: {
  appartient?: boolean;
  programmable?: boolean;
  modeles?: { max: number; reste: number; demandes: number } | null;
  credit?: { montantMicroEur: number; soldeMicroEur: number; manqueMicroEur: number } | null;
  enfilementCasse?: boolean;
} = {}) {
  const appels: string[] = [];
  const enfiles: Array<{ name: string; data: unknown; opts?: { expireInSeconds?: number; groupId?: string } }> = [];
  const d: DepsLancement = {
    repo: {
      campaignBelongsTo: async (id, t) => { appels.push(`appartient:${id}:${t}`); return o.appartient ?? true; },
      scheduleCampaign: async (id, t, quand) => { appels.push(`programme:${id}:${t}:${quand.toISOString()}`); return o.programmable ?? true; },
      resumeCampaign: async (id, t) => { appels.push(`reprend:${id}:${t}`); return true; },
      pauseCampaign: async (id, t) => { appels.push(`suspend:${id}:${t}`); return true; },
      getRunSizing: async () => ({ ratePerMinute: null, pendingCount: 0 }),
    },
    queue: {
      enqueue: async (name, data, opts) => {
        if (o.enfilementCasse) throw new Error('file en panne');
        enfiles.push({ name, data, ...(opts ? { opts } : {}) });
      },
    },
    modelesDuLancement: async () => o.modeles ?? null,
    creditDuLancement: async (t, id) => { appels.push(`credit:${t}:${id}`); return o.credit ?? null; },
    defaultRatePerMinute: 0,
    plafondLePlusBas: 80,
  };
  return { d, appels, enfiles };
}

const DEMAIN = new Date(Date.now() + 24 * 3600 * 1000);

describe('lancerCampagne', () => {
  it('🔴 la campagne d’un autre espace : « inconnue », rien de programmé ni d’enfilé', async () => {
    const { d, appels, enfiles } = deps({ appartient: false });
    expect(await lancerCampagne(d, 't-b', 'c-a', null)).toEqual({ ok: false, raison: 'inconnue' });
    expect(appels).toEqual(['appartient:c-a:t-b']);
    expect(enfiles).toHaveLength(0);
  });

  it('une date passée est refusée, jamais un lancement immédiat déguisé', async () => {
    const { d, appels, enfiles } = deps();
    expect(await lancerCampagne(d, 't', 'c', new Date('2020-01-01T10:00:00Z'))).toEqual({ ok: false, raison: 'date_passee' });
    expect(appels.some((a) => a.startsWith('programme'))).toBe(false);
    expect(enfiles).toHaveLength(0);
  });

  it('une date future programme et n’enfile rien', async () => {
    const { d, appels, enfiles } = deps();
    expect(await lancerCampagne(d, 't', 'c', DEMAIN)).toEqual({ ok: true, programmee: DEMAIN });
    expect(appels).toContain(`programme:c:t:${DEMAIN.toISOString()}`);
    expect(enfiles).toHaveLength(0);
  });

  it('une campagne que la base refuse de programmer : « non_programmable »', async () => {
    const { d } = deps({ programmable: false });
    expect(await lancerCampagne(d, 't', 'c', DEMAIN)).toEqual({ ok: false, raison: 'non_programmable' });
  });

  it('lancement immédiat : la pause est levée PUIS le run enfilé dans le groupe de l’espace', async () => {
    const { d, appels, enfiles } = deps();
    expect(await lancerCampagne(d, 't', 'c', null)).toEqual({ ok: true, enfilee: true });
    // Le crédit se lit AVANT la levée de pause : un refus ne doit rien avoir repris.
    expect(appels).toEqual(['appartient:c:t', 'credit:t:c', 'reprend:c:t']);
    expect(enfiles).toEqual([{ name: 'campaign-run', data: { campaignId: 'c' }, opts: { expireInSeconds: 900, groupId: 't' } }]);
  });

  it('plus de modèles demandés qu’il n’en reste ce mois-ci : « limite », rien de repris ni d’enfilé', async () => {
    const { d, appels, enfiles } = deps({ modeles: { max: 1000, reste: 100, demandes: 120 } });
    expect(await lancerCampagne(d, 't', 'c', null)).toEqual({ ok: false, raison: 'limite', max: 1000, reste: 100, demandes: 120 });
    expect(appels).toEqual(['appartient:c:t']);
    expect(enfiles).toHaveLength(0);
  });

  it('🔴 l’enfilement échoue : la pause est rétablie et l’erreur remonte', async () => {
    const { d, appels } = deps({ enfilementCasse: true });
    await expect(lancerCampagne(d, 't', 'c', null)).rejects.toThrow('file en panne');
    expect(appels).toEqual(['appartient:c:t', 'credit:t:c', 'reprend:c:t', 'suspend:c:t']);
  });

  it('🔴 il manque du Crédit WhatsApp : refusé avec ce qui manque, avant toute levée de pause ni enfilement', async () => {
    const { d, appels, enfiles } = deps({ credit: { montantMicroEur: 2_480_000, soldeMicroEur: 1_000_000, manqueMicroEur: 1_480_000 } });
    expect(await lancerCampagne(d, 't', 'c', null)).toEqual({ ok: false, raison: 'credit_whatsapp', manqueMicroEur: 1_480_000, montantMicroEur: 2_480_000 });
    expect(appels).toEqual(['appartient:c:t', 'credit:t:c']);
    expect(enfiles).toHaveLength(0);
  });

  it('le solde couvre l’estimation, ou l’espace est hors de la ligne : la campagne part', async () => {
    for (const credit of [{ montantMicroEur: 2_480_000, soldeMicroEur: 3_000_000, manqueMicroEur: 0 }, null]) {
      const { d, enfiles } = deps({ credit });
      expect(await lancerCampagne(d, 't', 'c', null)).toEqual({ ok: true, enfilee: true });
      expect(enfiles).toHaveLength(1);
    }
  });

  it('une campagne programmée ne se chiffre pas à la programmation : le balayage le fait à son départ', async () => {
    const { d, appels } = deps({ credit: { montantMicroEur: 2_480_000, soldeMicroEur: 0, manqueMicroEur: 2_480_000 } });
    expect(await lancerCampagne(d, 't', 'c', DEMAIN)).toEqual({ ok: true, programmee: DEMAIN });
    expect(appels.some((a) => a.startsWith('credit'))).toBe(false);
  });
});


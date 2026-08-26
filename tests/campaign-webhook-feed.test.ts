import { describe, it, expect } from 'vitest';
import { alimenterCampagnesWebhook, motifEcart, type WebhookFeedDeps } from '../src/campaign/webhook-feed';
import type { BuildContact } from '../src/campaign/build';
import type { Campaign } from '../src/campaign/types';

/**
 * Campagne AU FIL DE L'EAU : un contact arrive par un webhook, il devient destinataire des campagnes vivantes
 * qui s'en nourrissent, et le run part.
 *
 * Ce que ces tests verrouillent, et pourquoi : l'alimentation ne doit RIEN réécrire des règles d'envoi
 * (l'opt-in marketing et la résolution des variables restent celles de `buildRecipients`), elle ne doit jamais
 * envoyer deux fois à la même personne, et elle ne doit jamais faire DISPARAÎTRE un arrivant écarté.
 */
const campagne: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'utility',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'running',
  workflowId: null, ratePerMinute: null, startNodeId: null, webhookId: 'wh1',
};

const contact: BuildContact = {
  id: 'ct1', phone_e164: '+33611223344', bsuid: null, profile_name: 'Alice',
  fields: { prenom: 'Alice' }, optInStatus: 'opted_in',
};

interface Pose {
  campaignId: string;
  contactId: string;
  toE164: string;
  resolvedParams: string[];
  statut: 'pending' | 'skipped';
  motif?: string;
}

function deps(over: Partial<WebhookFeedDeps> & { poses?: Pose[]; runs?: string[] } = {}): WebhookFeedDeps & { poses: Pose[]; runs: string[] } {
  const poses = over.poses ?? [];
  const runs = over.runs ?? [];
  const base: WebhookFeedDeps = {
    listRunning: async () => [campagne],
    contact: async () => contact,
    insertRecipient: async (campaignId, r) => { poses.push({ campaignId, ...r }); return true; },
    enqueueRun: async (c) => { runs.push(c.id); },
    now: () => new Date('2026-08-26T10:00:00Z'),
    ...over,
  };
  return Object.assign(base, { poses, runs });
}

describe("alimenterCampagnesWebhook", () => {
  it("inscrit l'arrivant en attente et enfile le run", async () => {
    const d = deps();
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r).toEqual({ inscrits: 1, ecartes: 0, deja: 0 });
    expect(d.poses).toEqual([{ campaignId: 'c1', contactId: 'ct1', toE164: '+33611223344', resolvedParams: [], statut: 'pending' }]);
    expect(d.runs).toEqual(['c1']);
  });

  it("🔴 le contact DÉJÀ destinataire ne repart pas : ni inscription, ni run", async () => {
    // C'est le contrat d'unicité `(campaign_id, contact_id)` qui le dit, et il faut le CROIRE : enfiler un run
    // « au cas où » referait tourner la campagne pour rien à chaque repassage du même lead.
    const d = deps({ insertRecipient: async () => false });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r).toEqual({ inscrits: 0, ecartes: 0, deja: 1 });
    expect(d.runs).toEqual([]);
  });

  it("🔴 marketing sans consentement : l'arrivant est INSCRIT écarté, avec son motif, et rien ne part", async () => {
    // Le faire disparaître donnerait une campagne à zéro destinataire sans que personne ne sache que des gens
    // sont bien arrivés : exactement la panne muette que ce lot refuse.
    const d = deps({
      listRunning: async () => [{ ...campagne, category: 'marketing' as const }],
      contact: async () => ({ ...contact, optInStatus: 'unknown' as const }),
    });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r).toEqual({ inscrits: 0, ecartes: 1, deja: 0 });
    expect(d.poses[0]).toMatchObject({ statut: 'skipped', motif: motifEcart('not_opted_in') });
    expect(d.runs).toEqual([]);
  });

  it("🔴 variable de template sans valeur sur la fiche : écarté avec SON motif, pas celui du consentement", async () => {
    const d = deps({
      listRunning: async () => [{ ...campagne, paramMapping: [{ position: 1, source: { type: 'field', key: 'ville' } }] }],
    });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r.ecartes).toBe(1);
    expect(d.poses[0]).toMatchObject({ statut: 'skipped', motif: motifEcart('missing_variable') });
  });

  it('résout les variables du template sur la fiche de CET arrivant', async () => {
    const d = deps({
      listRunning: async () => [{ ...campagne, paramMapping: [{ position: 1, source: { type: 'field', key: 'prenom' } }] }],
    });
    await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(d.poses[0]).toMatchObject({ statut: 'pending', resolvedParams: ['Alice'] });
  });

  it('sert TOUTES les campagnes nourries par la même adresse, en ne relisant le contact qu’une fois', async () => {
    let lectures = 0;
    const d = deps({
      listRunning: async () => [campagne, { ...campagne, id: 'c2' }],
      contact: async () => { lectures += 1; return contact; },
    });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r.inscrits).toBe(2);
    expect(d.runs).toEqual(['c1', 'c2']);
    expect(lectures).toBe(1);
  });

  it("une campagne en échec n'empêche pas les autres d'être servies (le lead n'arrive qu'une fois)", async () => {
    const d = deps({
      listRunning: async () => [campagne, { ...campagne, id: 'c2' }],
      insertRecipient: async (campaignId, r) => {
        if (campaignId === 'c1') throw new Error('db down');
        d.poses.push({ campaignId, ...r });
        return true;
      },
    });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r.inscrits).toBe(1);
    expect(d.runs).toEqual(['c2']);
  });

  it('aucune campagne vivante sur cette adresse -> le contact n’est même pas relu', async () => {
    let lectures = 0;
    const d = deps({ listRunning: async () => [], contact: async () => { lectures += 1; return contact; } });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r).toEqual({ inscrits: 0, ecartes: 0, deja: 0 });
    expect(lectures).toBe(0);
  });

  it('contact inconnu ou bloqué -> rien, et surtout aucune inscription fantôme', async () => {
    const d = deps({ contact: async () => null });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33699999999', d);
    expect(r).toEqual({ inscrits: 0, ecartes: 0, deja: 0 });
    expect(d.poses).toEqual([]);
  });

  it("le contact en OPT-OUT est écarté même sur une campagne utility (un refus vaut pour tout)", async () => {
    const d = deps({ contact: async () => ({ ...contact, optInStatus: 'opted_out' as const }) });
    const r = await alimenterCampagnesWebhook('t1', 'wh1', '33611223344', d);
    expect(r.ecartes).toBe(1);
    expect(d.runs).toEqual([]);
  });
});

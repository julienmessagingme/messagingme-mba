import { describe, it, expect } from 'vitest';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { DROITS } from '../src/offres/offres';
import { empreinteEtat, type EtatConfirme } from '../src/campaign/confirmation';
import type { LectureModele } from '../src/api/modele-envoi';
import type { BulkTarget, ContactFilters } from '../src/crm/contact-store.pg';
import type { CreateCampaignInput } from '../src/campaign/store.pg';
import type { BuildContact, BuiltRecipient } from '../src/campaign/build';

/**
 * `prepare_campaign` (plan « Campagnes depuis Claude », tâche 7) : la campagne complète NON lancée, par le chemin de la
 * console (`preparerCampagne` puis `createCampaignWithRecipients`), le modèle lu chez Meta comme `POST /v1/sends`, et un
 * récapitulatif avec son code. 🔴 Rien ne part ici ; la cible n'est jamais vide ; un brouillon d'ailleurs, ou de la
 * console, ou déjà lancé, n'est jamais remplacé.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const AUTRE = 'ffffffff-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const ANCIEN = '44444444-4444-4444-8444-444444444444';
const NEUF = '55555555-5555-4555-8555-555555555555';
const C3 = '33333333-3333-4333-8333-333333333333';
const PERSONNE = { userId: 'u1' };
const outil = OUTILS.find((o) => o.nom === 'prepare_campaign')!;

const contact = (id: string, opt: 'opted_in' | 'unknown', nom: string): BuildContact =>
  ({ id, phone_e164: `+3360000${id.slice(-4)}`, profile_name: nom, optInStatus: opt, fields: {} } as unknown as BuildContact);

function deps(o: {
  modele?: LectureModele;
  ancien?: { tenant: string; confirme: boolean; status: string };
  numeros?: string[];
  /** Les numéros de l'espace tels que la console les liste (constat 3 de la relecture). */
  numerosListe?: Array<{ id: string; displayPhoneNumber: string | null; verifiedName: string | null }>;
  modeles?: { max: number; reste: number; demandes: number } | null;
  /** Un contact de la cible que la création écarte (bloqué ou supprimé) : il doit apparaître dans « other ». */
  avecBloque?: boolean;
} = {}) {
  const trace: string[] = [];
  const crees: CreateCampaignInput[] = [];
  const supprimes: string[] = [];
  const poses: Array<{ campaignId: string; etat: string }> = [];
  const etats = new Map<string, EtatConfirme>();
  const repo = {
    phoneNumberBelongsToTenant: async (pn: string, t: string) => t === T && (o.numeros ?? (o.numerosListe ?? []).map((n) => n.id).concat(['pn-1'])).includes(pn),
    listPhoneNumbers: async () => o.numerosListe ?? [{ id: 'pn-1', displayPhoneNumber: '+33 5 25 68 02 47', verifiedName: 'Démo' }],
    getTenantPhoneNumberId: async () => (o.numeros ?? ['pn-1'])[0] ?? null,
    listContactsForBuild: async () => { throw new Error('jamais « tous les contacts »'); },
    listContactsForBuildByIds: async (_t: string, ids: string[]) =>
      [contact(C1, 'opted_in', 'Léa'), contact(C2, 'unknown', 'Hugo')].filter((c) => ids.includes(c.id)),
    createWithRecipients: async (input: CreateCampaignInput, recipients: BuiltRecipient[]) => {
      trace.push('creation'); crees.push(input);
      etats.set(NEUF, {
        templateName: input.templateName, templateLanguage: input.templateLanguage, category: input.category,
        prevueLe: input.prevueLe ? input.prevueLe.toISOString() : null, paramMapping: input.paramMapping, recipientCount: recipients.length, status: 'draft',
      });
      return { campaignId: NEUF, recipientCount: recipients.length };
    },
    deleteDraftCampaign: async (id: string, t: string) => {
      trace.push('suppression'); supprimes.push(id);
      return o.ancien !== undefined && t === o.ancien.tenant && o.ancien.status === 'draft';
    },
    etatPourConfirmation: async (t: string, id: string) => {
      if (id === ANCIEN && o.ancien && t === o.ancien.tenant) return { ...etats.get(NEUF)!, status: o.ancien.status } as EtatConfirme;
      return t === T ? etats.get(id) ?? null : null;
    },
    apercuDestinataires: async () => ['Léa'],
    desabonnesParmiLesDestinataires: async () => 0,
  };
  const d = {
    offres: { offreDe: async () => ({ droits: { fonctions: DROITS.pro.fonctions } }) },
    couteux: { consommer: async () => { trace.push('plafond'); return { accepte: true, attenteMs: 0 }; } },
    inbox: { contactIdsDesConversations: async () => [] },
    contacts: { contactIdsForTarget: async (_t: string, cible: BulkTarget) => ('ids' in cible ? cible.ids : []) },
    campagnes: {
      route: {
        repo,
        contacts: { contactIdsForTarget: async (_t: string, cible: BulkTarget) => ('ids' in cible ? cible.ids : (cible.filters as ContactFilters).tags?.includes('retard') ? [C1, C2, ...(o.avecBloque ? [C3] : [])] : []) },
        modelesDuLancement: async () => o.modeles ?? null,
        identifiantsDeTousLesContacts: async () => { throw new Error('jamais « tous les contacts »'); },
        plafondDestinataires: 10_000,
        rcs: { belongsToTenant: async () => false },
        emailTemplateBelongsToTenant: async () => false,
        webhookUsableByTenant: async () => false,
        getWorkflowGraph: async () => null,
        offres: { offreDe: async () => ({ droits: { fonctions: DROITS.pro.fonctions } }) },
      },
      modeles: {
        lireModele: async (): Promise<LectureModele> => o.modele ?? { statut: 'approuve', categorie: 'utility', variables: 1 },
        repo,
      },
      confirmations: {
        existe: async (t: string, id: string) => id === ANCIEN && o.ancien !== undefined && t === o.ancien.tenant && o.ancien.confirme,
        poser: async (_t: string, campaignId: string, etat: string) => { trace.push('code'); poses.push({ campaignId, etat }); return { code: 'K7M2QP', expireLe: new Date('2027-10-30T08:30:00Z') }; },
      },
    },
  } as unknown as DepsMcp;
  return { d, trace, crees, supprimes, poses, etats };
}

const VARIABLES = [{ position: 1, source: { type: 'attribute', key: 'name' } }];
const BASE = { tags: ['retard'], template_name: 'retard_livraison', template_language: 'fr', variables: VARIABLES };

describe('prepare_campaign', () => {
  it('🔴 une écriture de l’offre console, au nom d’une personne, qui n’envoie rien', () => {
    expect(outil.fonction).toBe('console');
    expect(outil.exigePersonne).toBe(true);
    expect(outil.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  });

  it('crée le brouillon par le chemin de la console et rend le récapitulatif avec son code', async () => {
    const { d, crees, poses, etats, trace } = deps();
    const r = (await outil.executer(d, T, BASE, PERSONNE)) as Record<string, unknown>;
    expect(crees[0]).toMatchObject({ tenantId: T, phoneNumberId: 'pn-1', templateName: 'retard_livraison', templateLanguage: 'fr', category: 'utility', contactIds: [C1, C2], prevueLe: null });
    expect(r).toMatchObject({
      campaign_id: NEUF, template: 'retard_livraison (fr)', category: 'utility', scheduled_for: null,
      targeted: 2, will_send: 2, excluded: { not_opted_in: 0, missing_variable: 0, unsubscribed: 0 }, sample: ['Léa'],
      billable_messages_up_to: 2, confirmation_code: 'K7M2QP', code_expires_at: '2027-10-30T08:30:00.000Z',
    });
    // Le code est lié à l'état RELU en base après la création.
    expect(poses).toEqual([{ campaignId: NEUF, etat: empreinteEtat(etats.get(NEUF)!) }]);
    expect(trace).toEqual(['plafond', 'creation', 'code']);
  });

  it('🔴 la catégorie vient du modèle chez Meta : un MARKETING n’atteint que les contacts qui ont consenti', async () => {
    const { d, crees } = deps({ modele: { statut: 'approuve', categorie: 'marketing', variables: 1 } });
    const r = (await outil.executer(d, T, BASE, PERSONNE)) as { will_send: number; excluded: { not_opted_in: number } };
    expect(crees[0]!.category).toBe('marketing');
    expect(r.will_send).toBe(1);
    expect(r.excluded.not_opted_in).toBe(1);
  });

  it('un modèle absent, non approuvé, ou dont les variables ne collent pas : refusé, rien n’est créé', async () => {
    for (const modele of [{ statut: 'absent' }, { statut: 'non_envoyable', raison: 'en-tête sans média' }, { statut: 'approuve', categorie: 'utility', variables: 2 }] as LectureModele[]) {
      const { d, crees } = deps({ modele });
      await expect(outil.executer(d, T, BASE, PERSONNE), modele.statut).rejects.toThrow(RefusOutil);
      expect(crees).toHaveLength(0);
    }
  });

  it('🔴 la date : avec son fuseau, dans le futur, rendue en heure de Paris, passage à l’heure d’hiver compris', async () => {
    const { d, crees } = deps();
    const r = (await outil.executer(d, T, { ...BASE, scheduled_for: '2027-10-31T10:00:00+01:00' }, PERSONNE)) as { scheduled_for: { iso: string; paris: string } };
    expect(crees[0]!.prevueLe).toEqual(new Date('2027-10-31T09:00:00.000Z'));
    expect(r.scheduled_for).toEqual({ iso: '2027-10-31T09:00:00.000Z', paris: 'dimanche 31 octobre 2027 à 10 h' });
    const ete = (await outil.executer(deps().d, T, { ...BASE, scheduled_for: '2027-10-30T10:30:00+02:00' }, PERSONNE)) as { scheduled_for: { paris: string } };
    expect(ete.scheduled_for.paris).toBe('samedi 30 octobre 2027 à 10 h 30');
    for (const quand of ['2027-10-31T10:00:00', '2020-01-01T10:00:00Z']) {
      const v = deps();
      await expect(outil.executer(v.d, T, { ...BASE, scheduled_for: quand }, PERSONNE), quand).rejects.toThrow(RefusOutil);
      expect(v.crees).toHaveLength(0);
    }
  });

  it('🔴 une cible qui ne désigne personne, ou sans critère : refusé, jamais « tous les contacts »', async () => {
    for (const cible of [{ tags: ['inconnue'] }, {}]) {
      const { d, crees } = deps();
      await expect(outil.executer(d, T, { ...BASE, tags: undefined, ...cible }, PERSONNE)).rejects.toThrow(RefusOutil);
      expect(crees).toHaveLength(0);
    }
  });

  it('re-préparer remplace le brouillon de l’assistant : le nouveau d’abord, l’ancien ensuite', async () => {
    const { d, trace, supprimes } = deps({ ancien: { tenant: T, confirme: true, status: 'draft' } });
    const r = (await outil.executer(d, T, { ...BASE, replaces: ANCIEN }, PERSONNE)) as { replaced: { campaign_id: string; deleted: boolean } };
    expect(supprimes).toEqual([ANCIEN]);
    expect(trace).toEqual(['plafond', 'creation', 'suppression', 'code']);
    expect(r.replaced).toEqual({ campaign_id: ANCIEN, deleted: true });
  });

  it('🔴 jamais remplacé : le brouillon d’un autre espace, celui de la console, ou une campagne déjà lancée', async () => {
    for (const ancien of [{ tenant: AUTRE, confirme: true, status: 'draft' }, { tenant: T, confirme: false, status: 'draft' }, { tenant: T, confirme: true, status: 'running' }]) {
      const { d, crees, supprimes } = deps({ ancien });
      await expect(outil.executer(d, T, { ...BASE, replaces: ANCIEN }, PERSONNE), JSON.stringify(ancien)).rejects.toThrow(RefusOutil);
      expect(crees).toHaveLength(0);
      expect(supprimes).toHaveLength(0);
    }
  });

  it('sans personne : refusé, rien n’est lu ni créé', async () => {
    const { d, trace } = deps();
    await expect(outil.executer(d, T, BASE, null)).rejects.toThrow(RefusOutil);
    expect(trace).toEqual([]);
  });

  it('🔴 un espace à plusieurs numéros sans phone_number_id : refusé avec la liste, rien n’est créé (constat 3)', async () => {
    const numerosListe = [
      { id: 'pn-a', displayPhoneNumber: '+33 5 25 68 02 47', verifiedName: 'Démo' },
      { id: 'pn-b', displayPhoneNumber: '+33 5 25 68 02 50', verifiedName: 'Sandbox' },
    ];
    const v = deps({ numerosListe });
    await expect(outil.executer(v.d, T, BASE, PERSONNE)).rejects.toThrow(/pn-a.*pn-b/);
    expect(v.crees).toHaveLength(0);
    const ok = deps({ numerosListe });
    const r = (await outil.executer(ok.d, T, { ...BASE, phone_number_id: 'pn-b' }, PERSONNE)) as { phone_number: string };
    expect(ok.crees[0]!.phoneNumberId).toBe('pn-b');
    expect(r.phone_number).toBe('+33 5 25 68 02 50');
  });

  it('le récapitulatif boucle : les écartés sans motif sont comptés, la marge des modèles du mois est dite (constat 4)', async () => {
    const { d } = deps({ avecBloque: true, modeles: { max: 1000, reste: 900, demandes: 2 } });
    const r = (await outil.executer(d, T, BASE, PERSONNE)) as { targeted: number; will_send: number; excluded: { other: number }; monthly_templates: unknown };
    expect(r.targeted).toBe(3);
    expect(r.will_send).toBe(2);
    expect(r.excluded.other).toBe(1);
    expect(r.monthly_templates).toEqual({ limit: 1000, remaining: 900, needed: 2 });
  });

  it('🔴 un brouillon sans aucun destinataire : supprimé et refusé avec ses motifs, sans code (constat 6)', async () => {
    const { d, supprimes, poses } = deps({ modele: { statut: 'approuve', categorie: 'marketing', variables: 1 } });
    await expect(outil.executer(d, T, { ...BASE, tags: undefined, contact_ids: [C2] }, PERSONNE)).rejects.toThrow(/consentement/);
    expect(supprimes).toEqual([NEUF]);
    expect(poses).toHaveLength(0);
  });

  it('l’ancien brouillon qui n’a pas pu être supprimé : la réponse le dit (constat 5)', async () => {
    const { d } = deps({ ancien: { tenant: T, confirme: true, status: 'draft' } });
    // La suppression échoue : l'ancien a été lancé entre la vérification et la suppression.
    (d.campagnes.route.repo as unknown as { deleteDraftCampaign: () => Promise<boolean> }).deleteDraftCampaign = async () => false;
    const r = (await outil.executer(d, T, { ...BASE, replaces: ANCIEN }, PERSONNE)) as { replaced: { deleted: boolean }; warning?: string };
    expect(r.replaced.deleted).toBe(false);
    expect(r.warning).toMatch(/previous draft/i);
  });
});

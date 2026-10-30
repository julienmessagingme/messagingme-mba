import { describe, it, expect } from 'vitest';
import { creerAjustementCredit, type AccuseCredit, type DepsAjustementCredit } from '../src/credit-whatsapp/ajustement';
import { processStatuses } from '../src/webhooks/delivery';
import { handleWebhookJob } from '../src/webhooks/handler';
import type { WebhookEvent } from '../src/webhooks/parse';
import type { TarifMeta } from '../src/webhooks/tarif-meta';
import type { CategorieMeta, GrilleMeta } from '../src/credit-whatsapp/grille';
import type { LigneCredit } from '../src/credit-whatsapp/lignes.pg';
import { aucunTarif, aucunEchecLibre, aucunSignalAccuse } from './webhook-fixtures';

/**
 * L'AJUSTEMENT À L'ACCUSÉ (plan du Crédit WhatsApp, tâche 7) : ce que Meta dit d'un message après l'envoi corrige sa
 * provision. Deux étages : l'ajustement seul, sur une provision en mémoire aux mêmes règles que la base (rendue une
 * fois, corrigée une fois, livrée une fois) ; puis le branchement sur chaque accusé, par les deux files qui en voient.
 */
const GRILLE: GrilleMeta = {
  id: 'g', enVigueurLe: '2026-10-01',
  tarifs: [
    { marche: 'FR', categorie: 'marketing', palier: 0, prixMicroEur: 71_200 },
    { marche: 'FR', categorie: 'utility', palier: 0, prixMicroEur: 24_800 },
    { marche: 'FR', categorie: 'service', palier: 0, prixMicroEur: 24_800 },
    { marche: 'FR', categorie: 'authentication', palier: 0, prixMicroEur: 24_800 },
    { marche: 'FR', categorie: 'authentication_international', palier: 0, prixMicroEur: 90_000 },
    { marche: 'other', categorie: 'marketing', palier: 0, prixMicroEur: 55_800 },
  ],
};
const LIGNE: LigneCredit = { id: 'l1', tenantId: 't1', phoneNumberId: 'pn1', wabaId: 'w1', origine: 'ops', depuis: '2026-10-30T00:00:00Z', arreteeLe: null };

interface Provision { categorie: CategorieMeta; pays: string | null; montantMicroEur: number; etat: 'provisionne' | 'rendu' | 'ajuste'; livreLe: Date | null }

/** Une provision en mémoire, aux règles de `PgCreditWhatsappStore` ; `solde` suit chaque mouvement. */
function monter(p: Partial<Provision> | null, o: { ligne?: LigneCredit | null; grille?: GrilleMeta | null; commissionPct?: number } = {}) {
  const etat = {
    solde: 0,
    lectures: 0,
    provision: p === null ? null : { categorie: 'utility', pays: 'FR', montantMicroEur: 27_280, etat: 'provisionne', livreLe: null, ...p } as Provision,
  };
  const credit: DepsAjustementCredit['credit'] = {
    provisionDuWamid: async () => {
      etat.lectures += 1;
      return etat.provision === null ? null : { ...etat.provision };
    },
    rendreParWamid: async () => {
      const q = etat.provision;
      if (q && q.etat !== 'rendu') { q.etat = 'rendu'; etat.solde += q.montantMicroEur; }
    },
    corrigerParWamid: async (_t, _w, categorie, montant) => {
      const q = etat.provision;
      if (q && q.etat === 'provisionne') { etat.solde -= montant - q.montantMicroEur; q.categorie = categorie; q.montantMicroEur = montant; q.etat = 'ajuste'; }
    },
    marquerLivre: async (_t, _w, le) => {
      const q = etat.provision;
      if (q && q.livreLe === null) q.livreLe = le;
    },
  };
  const ajustement = creerAjustementCredit({
    lignes: { ligneDuNumero: async () => (o.ligne === undefined ? LIGNE : o.ligne) },
    credit,
    grille: async () => (o.grille === undefined ? GRILLE : o.grille),
    conditions: async () => ({ openBar: false, commissionPct: o.commissionPct ?? 10 }),
  });
  return { etat, ajustement };
}

const tarif = (o: Partial<TarifMeta> = {}): TarifMeta => ({ messageId: 'wamid.1', type: 'regular', categorie: 'utility', facturable: true, modele: 'PMP', ...o });
const accuse = (statut: string | null, t: TarifMeta | null = null, livreLe: string | null = null): AccuseCredit => ({ wamid: 'wamid.1', tarif: t, statut, livreLe });

describe('l’ajustement à l’accusé', () => {
  it('un numéro hors de la ligne ne lit aucune provision', async () => {
    const { etat, ajustement } = monter({}, { ligne: null });
    await ajustement.ajuster('pn9', accuse('failed'));
    expect(etat.lectures).toBe(0);
    expect(etat.provision?.etat).toBe('provisionne');
  });

  it('un message qui n’a rien provisionné ne bouge rien', async () => {
    const { etat, ajustement } = monter(null);
    await ajustement.ajuster('pn1', accuse('failed', tarif({ categorie: 'marketing' }), '2026-10-30T10:00:00.000Z'));
    expect(etat.solde).toBe(0);
  });

  it('🔴 un échec rend la provision, une seule fois', async () => {
    const { etat, ajustement } = monter({});
    await ajustement.ajuster('pn1', accuse('failed'));
    await ajustement.ajuster('pn1', accuse('failed'));
    expect(etat.solde).toBe(27_280);
    expect(etat.provision?.etat).toBe('rendu');
  });

  it('🔴 un message offert par Meta (fenêtre d’une publicité) est rendu', async () => {
    const { etat, ajustement } = monter({});
    await ajustement.ajuster('pn1', accuse('sent', tarif({ type: 'free_entry_point', categorie: 'referral_conversion', facturable: false })));
    expect(etat.solde).toBe(27_280);
    expect(etat.provision?.etat).toBe('rendu');
  });

  it('un type gratuit sans « billable » est rendu aussi', async () => {
    const { etat, ajustement } = monter({});
    await ajustement.ajuster('pn1', accuse('sent', tarif({ type: 'free_customer_service', facturable: null })));
    expect(etat.provision?.etat).toBe('rendu');
  });

  it('un service compté dans la franchise reste compté quand Meta le dit offert', async () => {
    const { etat, ajustement } = monter({ categorie: 'service', montantMicroEur: 0 });
    await ajustement.ajuster('pn1', accuse('sent', tarif({ type: 'free_customer_service', categorie: 'service', facturable: false })));
    expect(etat.provision?.etat).toBe('provisionne');
    expect(etat.solde).toBe(0);
  });

  it('🔴 un modèle reclassé en marketing est corrigé au prix de la grille, une seule fois', async () => {
    const { etat, ajustement } = monter({});
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'marketing' })));
    await ajustement.ajuster('pn1', accuse('delivered', tarif({ categorie: 'marketing' })));
    expect(etat.provision).toMatchObject({ categorie: 'marketing', montantMicroEur: 78_320, etat: 'ajuste' });
    expect(etat.solde).toBe(-(78_320 - 27_280));
  });

  it('la correction prend la commission de l’espace', async () => {
    const { etat, ajustement } = monter({}, { commissionPct: 5 });
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'marketing' })));
    expect(etat.provision?.montantMicroEur).toBe(74_760);
  });

  it('un pays hors de la grille se corrige au marché « Autres »', async () => {
    const { etat, ajustement } = monter({ pays: 'BR' });
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'marketing' })));
    expect(etat.provision?.montantMicroEur).toBe(61_380);
  });

  it('🔴 un service que nous avions compté dans la franchise et que Meta facture est corrigé', async () => {
    const { etat, ajustement } = monter({ categorie: 'service', montantMicroEur: 0 });
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'service' })));
    expect(etat.provision).toMatchObject({ categorie: 'service', montantMicroEur: 27_280, etat: 'ajuste' });
    expect(etat.solde).toBe(-27_280);
  });

  it('facturé dans la catégorie provisionnée : rien ne bouge, « marketing_lite » se lisant marketing', async () => {
    const utilite = monter({});
    await utilite.ajustement.ajuster('pn1', accuse('sent', tarif()));
    expect(utilite.etat.provision?.etat).toBe('provisionne');
    const lite = monter({ categorie: 'marketing', montantMicroEur: 78_320 });
    await lite.ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'marketing_lite' })));
    expect(lite.etat.provision?.etat).toBe('provisionne');
  });

  it('sans grille, aucune correction : la régularisation tranchera', async () => {
    const { etat, ajustement } = monter({}, { grille: null });
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'marketing' })));
    expect(etat.provision?.etat).toBe('provisionne');
  });

  it('🔴 la livraison est datée, une seule fois', async () => {
    const { etat, ajustement } = monter({});
    await ajustement.ajuster('pn1', accuse('delivered', null, '2026-10-30T10:00:00.000Z'));
    await ajustement.ajuster('pn1', accuse('delivered', null, '2026-10-30T11:00:00.000Z'));
    expect(etat.provision?.livreLe?.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('un échec après une correction rend le montant corrigé : le solde revient au départ, provision comprise', async () => {
    const { etat, ajustement } = monter({});
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'marketing' })));
    await ajustement.ajuster('pn1', accuse('failed'));
    expect(etat.solde).toBe(27_280);
    expect(etat.provision?.etat).toBe('rendu');
  });

  it('🔴 une authentification provisionnée au plus cher des deux tarifs se corrige au tarif que Meta a facturé', async () => {
    const { etat, ajustement } = monter({ categorie: 'authentication', montantMicroEur: 99_000 });
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'authentication' })));
    expect(etat.provision).toMatchObject({ categorie: 'authentication', montantMicroEur: 27_280, etat: 'ajuste' });
    expect(etat.solde).toBe(99_000 - 27_280);
  });

  it('🔴 une catégorie illisible, provisionnée au plus cher et enregistrée marketing, se corrige au prix exact du marketing', async () => {
    const { etat, ajustement } = monter({ categorie: 'marketing', montantMicroEur: 99_000 });
    await ajustement.ajuster('pn1', accuse('sent', tarif({ categorie: 'marketing' })));
    expect(etat.provision).toMatchObject({ categorie: 'marketing', montantMicroEur: 78_320, etat: 'ajuste' });
    expect(etat.solde).toBe(99_000 - 78_320);
  });

  it('une provision rendue ne bouge plus, même livrée et facturée', async () => {
    const { etat, ajustement } = monter({ etat: 'rendu' });
    await ajustement.ajuster('pn1', accuse('delivered', tarif({ categorie: 'marketing' }), '2026-10-30T10:00:00.000Z'));
    expect(etat.provision).toMatchObject({ categorie: 'utility', montantMicroEur: 27_280, etat: 'rendu', livreLe: null });
  });
});

const statut = (data: Record<string, unknown>, phoneNumberId: string | null = 'pn1'): WebhookEvent => ({
  source: 'statuses',
  dedupKey: `status:${String(data['id'])}:${String(data['status'])}`,
  data,
  ...(phoneNumberId ? { phoneNumberId } : {}),
});
const livraison = () => {
  const appels: string[] = [];
  return { appels, store: { updateDeliveryByMessageId: async (id: string, s: string) => { appels.push(`${id}:${s}`); return 1; } } };
};

describe('le branchement sur chaque accusé', () => {
  it('🔴 chaque accusé d’un numéro passe à l’ajustement, avec son tarif, son statut et son instant', async () => {
    const vus: Array<{ pn: string; a: AccuseCredit }> = [];
    await processStatuses([
      statut({ id: 'wamid.1', status: 'delivered', timestamp: '1790000000', pricing: { type: 'regular', category: 'utility', billable: true } }),
      statut({ id: 'wamid.2', status: 'failed', errors: [{ code: 131026 }] }),
    ], livraison().store, {
      tarifs: aucunTarif, echecsLibres: aucunEchecLibre,
      ajustementCredit: { ajuster: async (pn, a) => { vus.push({ pn, a }); } },
    });
    expect(vus).toEqual([
      {
        pn: 'pn1',
        a: {
          wamid: 'wamid.1', statut: 'delivered', livreLe: new Date(1790000000 * 1000).toISOString(),
          tarif: { messageId: 'wamid.1', type: 'regular', categorie: 'utility', facturable: true, modele: null },
        },
      },
      { pn: 'pn1', a: { wamid: 'wamid.2', statut: 'failed', livreLe: null, tarif: null } },
    ]);
  });

  it('un accusé sans numéro ne s’ajuste pas : rien ne le rattache à une ligne', async () => {
    const vus: string[] = [];
    await processStatuses([statut({ id: 'wamid.1', status: 'failed' }, null)], livraison().store, {
      tarifs: aucunTarif, echecsLibres: aucunEchecLibre,
      ajustementCredit: { ajuster: async (_pn, a) => { vus.push(a.wamid); } },
    });
    expect(vus).toEqual([]);
  });

  it('🔴 un ajustement en panne n’arrête ni la livraison ni le job', async () => {
    const l = livraison();
    await expect(processStatuses([statut({ id: 'wamid.1', status: 'delivered' })], l.store, {
      tarifs: aucunTarif, echecsLibres: aucunEchecLibre,
      ajustementCredit: { ajuster: async () => { throw new Error('base indisponible'); } },
    })).resolves.toBeUndefined();
    expect(l.appels).toEqual(['wamid.1:delivered']);
  });

  it('🔴 le job des accusés transmet l’ajustement, numéro de l’enveloppe compris', async () => {
    const vus: string[] = [];
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'wamid.9', status: 'failed' }] } }] }],
    }, {
      store: { insertEvent: async () => true }, delivery: livraison().store,
      tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre, signauxAccuse: aucunSignalAccuse,
      ajustementCredit: { ajuster: async (pn, a) => { vus.push(`${pn}:${a.wamid}:${String(a.statut)}`); } },
    });
    expect(vus).toEqual(['PN1:wamid.9:failed']);
  });
});

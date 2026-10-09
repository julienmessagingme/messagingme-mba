import { describe, it, expect } from 'vitest';
import { parseWebhook } from '../src/webhooks/parse';
import { processStatutsModeles, type StatutsModelesDeps } from '../src/webhooks/statuts-modeles';
import { distribuerEvenementEspace, type DepsDistributionEspace, type LigneEnvoi } from '../src/evenements/distribution';
import { CHAMPS_DU_TYPE, TYPES_ABONNABLES, TYPES_DECOCHES_PAR_DEFAUT } from '../src/evenements/types';

/**
 * L'ÉVÉNEMENT DE VALIDATION D'UN MODÈLE (lot 13, domaine 3, livraison C) : Meta envoie le champ
 * `message_template_status_update` au niveau du COMPTE WhatsApp (pas d'un numéro) ; l'espace se retrouve par son compte,
 * et l'événement `template.status_changed` part vers les adresses qui l'ont coché.
 */
const statut = (o: Record<string, unknown> = {}, time: number | undefined = 1_791_000_000) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    ...(time === undefined ? {} : { time }),
    changes: [{
      field: 'message_template_status_update',
      value: { event: 'APPROVED', message_template_id: 1489201163476524, message_template_name: 'commande_prete', message_template_language: 'fr', reason: 'NONE', ...o },
    }],
  }],
});

describe('le découpage du webhook', () => {
  it('🔴 un statut de modèle devient un événement, avec son compte et son instant, et une clé propre au changement', () => {
    const [ev, ...reste] = parseWebhook(statut());
    expect(reste).toHaveLength(0);
    expect(ev).toMatchObject({ source: 'template_status', dedupKey: 'tpl:1489201163476524:APPROVED:1791000000' });
    expect(ev!.data).toMatchObject({ waba_id: 'waba-1', le: 1_791_000_000, message_template_name: 'commande_prete' });
    expect(ev!.phoneNumberId).toBeUndefined();
    // Un modèle repassé APPROVED plus tard (après une pause) n'est pas pris pour une redélivrance.
    expect(parseWebhook(statut({}, 1_791_000_900))[0]!.dedupKey).not.toBe(ev!.dedupKey);
  });

  it('les autres champs de compte (qualité, catégorie) restent ignorés, comme avant', () => {
    expect(parseWebhook({ entry: [{ id: 'waba-1', changes: [{ field: 'message_template_quality_update', value: { new_quality_score: 'RED' } }] }] })).toEqual([]);
  });
});

describe('l’étape des statuts de modèles', () => {
  function monter(espace: string | null = 't1') {
    const envoyes: Array<{ tenantId: string; ev: { id: string; type: string; le: string; data: Record<string, unknown> } }> = [];
    const deps: StatutsModelesDeps = {
      espaceDuCompte: async (waba) => (waba === 'waba-1' ? espace : null),
      distribuer: async (tenantId, ev) => { envoyes.push({ tenantId, ev }); },
    };
    return { deps, envoyes };
  }

  it('🔴 l’espace du compte reçoit template.status_changed : le modèle, le statut en minuscules, le motif d’un refus', async () => {
    const { deps, envoyes } = monter();
    await processStatutsModeles(parseWebhook(statut({ event: 'REJECTED', reason: 'INVALID_FORMAT' })), deps);
    expect(envoyes).toHaveLength(1);
    expect(envoyes[0]).toMatchObject({
      tenantId: 't1',
      ev: {
        type: 'template.status_changed', le: new Date(1_791_000_000_000).toISOString(),
        data: { template: { id: '1489201163476524', name: 'commande_prete', language: 'fr' }, status: 'rejected', reason: 'INVALID_FORMAT' },
      },
    });
    expect(envoyes[0]!.ev.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(Object.keys(envoyes[0]!.ev.data)).toEqual([...CHAMPS_DU_TYPE['template.status_changed']]);
  });

  it('🔴 le même changement redélivré garde le même identifiant d’événement : l’application ne le reçoit qu’une fois', async () => {
    const { deps, envoyes } = monter();
    await processStatutsModeles(parseWebhook(statut()), deps);
    await processStatutsModeles(parseWebhook(statut()), deps);
    expect(envoyes[0]!.ev.id).toBe(envoyes[1]!.ev.id);
    expect(envoyes[0]!.ev.data).toMatchObject({ status: 'approved', reason: null });
  });

  it('un compte qu’aucun espace ne porte, ou un statut illisible : rien ne part, rien ne lève', async () => {
    const sans = monter(null);
    await processStatutsModeles(parseWebhook(statut()), sans.deps);
    expect(sans.envoyes).toHaveLength(0);
    const illisible = monter();
    await processStatutsModeles(parseWebhook(statut({ message_template_name: undefined })), illisible.deps);
    expect(illisible.envoyes).toHaveLength(0);
  });
});

describe('la distribution d’un événement d’espace (sans contact)', () => {
  function deps(o: { verrouille?: boolean; limite?: number | null } = {}) {
    const lignes: LigneEnvoi[] = [];
    const enfiles: string[] = [];
    const d: DepsDistributionEspace = {
      adresses: async () => [
        { id: 'a1', types: ['template.status_changed', 'message.received'] },
        { id: 'a2', types: ['message.received'] },
        { id: 'a3', types: ['template.status_changed'] },
      ],
      limiteAdresses: async () => (o.limite === undefined ? null : o.limite),
      espaceVerrouille: async () => o.verrouille === true,
      creerEnvois: async (ls) => { lignes.push(...ls); return ls.map((l, i) => ({ id: `e${i}`, type: l.type })); },
      enfiler: async (job) => { enfiles.push(job.envoiId); },
    };
    return { d, lignes, enfiles };
  }
  const EV = { id: 'evt_0123456789abcdef0123456789abcdef', type: 'template.status_changed' as const, le: '2026-10-09T12:00:00.000Z', data: { status: 'approved' } };

  it('🔴 seules les adresses qui ont coché le type le reçoivent, sans contact, dans la limite de l’offre', async () => {
    const tout = deps();
    await distribuerEvenementEspace(tout.d, 't1', EV);
    expect(tout.lignes.map((l) => [l.adresseId, l.contactId])).toEqual([['a1', null], ['a3', null]]);
    expect(JSON.parse(tout.lignes[0]!.corps)).toEqual({ id: EV.id, type: EV.type, created_at: EV.le, workspace_id: 't1', data: EV.data });
    expect(tout.enfiles).toHaveLength(2);
    const limite = deps({ limite: 1 });
    await distribuerEvenementEspace(limite.d, 't1', EV);
    expect(limite.lignes.map((l) => l.adresseId)).toEqual(['a1']);
  });

  it('🔴 un espace verrouillé ne reçoit rien', async () => {
    const v = deps({ verrouille: true });
    await distribuerEvenementEspace(v.d, 't1', EV);
    expect(v.lignes).toHaveLength(0);
  });

  it('le type s’abonne, et il est coché par défaut à la création d’une adresse', () => {
    expect(TYPES_ABONNABLES).toContain('template.status_changed');
    expect(TYPES_DECOCHES_PAR_DEFAUT.has('template.status_changed')).toBe(false);
  });
});

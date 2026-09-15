import { describe, it, expect } from 'vitest';
import { ownerFromHandover, waIdFromHandover, processHandovers } from '../src/webhooks/handover';

/**
 * La bascule de contrôle du fil, sur le payload RÉEL de Meta.
 *
 * 🔴 CE FICHIER FERME UN MODULE QUI A VÉCU DES SEMAINES SUR UNE FORME DEVINÉE, et qui se trompait sur les
 * TROIS points qu'il devinait. `messaging_handovers` n'était jamais arrivé (zéro occurrence sur 58 payloads)
 * pour une raison qu'on ignorait : **il ne se déclenche que si `handoff` est configuré chez Meta**, et ce
 * bloc valait `null` sur notre numéro. En l'activant le 2026-09-10 au soir, on a enfin vu la vraie forme.
 *
 * ⚠️ Le payload ci-dessous est recopié TEL QUEL de la file de travail de production, pas reconstitué.
 */
const HANDOVER_REEL = {
  entry: [{
    id: '1695646181671929',
    changes: [{
      field: 'messaging_handovers',
      value: {
        type: 'control_passed',
        sender: { phone_number: '33633921577' },
        recipient: { phone_number_id: '1234840649713976', display_phone_number: '33525680250' },
        timestamp: '1789056499',
        control_passed: {
          metadata: 'customer_request',
          previous_owner_app_id: '1143680903703001',
          previous_owner_app_role: 'meta_business_agent',
        },
        messaging_product: 'whatsapp',
      },
    }],
  }],
  object: 'whatsapp_business_account',
};

const VALEUR = HANDOVER_REEL.entry[0]!.changes[0]!.value as unknown as Record<string, unknown>;

describe('ownerFromHandover', () => {
  it('🔴 le MBA nous PASSE le fil : le nouveau détenteur, c’est NOUS', () => {
    /**
     * Le code d'avant retombait sur « le texte contient business_agent, donc le MBA détient » et rendait
     * `mba` : exactement l'INVERSE. `previous_owner_app_role` nomme le détenteur PRÉCÉDENT.
     *
     * 🔴 ET « NOUS » S'ÉCRIT `app_human`, PAS `app_workflow` (corrigé le 2026-09-15). Les deux valeurs
     * veulent dire « nous », mais pas le même nous : `app_workflow` veut dire « un SCÉNARIO gère ce fil »,
     * et c'est la SEULE valeur que le dossier « À traiter » exclut. Or ce webhook arrive précisément quand
     * l'agent de Meta vient de dire au client « un membre de l'équipe va vous répondre ».
     */
    expect(ownerFromHandover(VALEUR)).toBe('app_human');
  });

  it('🔴 ne reconnaît PAS un rôle précédent inconnu', () => {
    // Une autre app qui passerait le fil à l'agent produirait le même `type` avec un rôle différent, et le
    // nouveau détenteur ne serait alors pas nous. Rien dans le payload ne permet de trancher : on rend
    // `null`, et la trace garde le payload entier pour qu'on l'apprenne le jour où ça arrive.
    expect(ownerFromHandover({ ...VALEUR, control_passed: { previous_owner_app_role: 'autre_app' } })).toBeNull();
  });

  it('ignore un type qu’on n’a jamais vu', () => {
    expect(ownerFromHandover({ ...VALEUR, type: 'control_taken' })).toBeNull();
    expect(ownerFromHandover({})).toBeNull();
  });
});

describe('waIdFromHandover', () => {
  it('🔴 le client est dans `sender`, PAS dans `recipient`', () => {
    // `recipient` est un OBJET qui décrit le numéro BUSINESS. Le lire comme une chaîne rendait `undefined`,
    // donc la garde `if (waId && owner)` ne passait jamais et le module n'écrivait rien, jamais.
    expect(waIdFromHandover(VALEUR)).toBe('33633921577');
  });
});

describe('processHandovers sur la bascule réelle', () => {
  it('🔴 écrit enfin le détenteur, ce qu’il n’a jamais fait', async () => {
    // Trois défauts empilés l'en empêchaient, et chacun seul suffisait : le numéro business lu au mauvais
    // endroit, le client lu au mauvais endroit, et le détenteur déduit à l'envers.
    const poses: Array<[string, string, string]> = [];
    await processHandovers(HANDOVER_REEL, {
      phoneNumberTenant: async (pn) => (pn === '1234840649713976' ? 'tenant-1' : null),
      setControlOwner: async (t, w, o) => { poses.push([t, w, o]); return true; },
    });
    expect(poses).toEqual([['tenant-1', '33633921577', 'app_human']]);
  });

  it('🔴 le numéro BUSINESS se lit dans `recipient` quand il n’y a pas de `metadata`', async () => {
    // Le troisième défaut, et le plus sournois : la fonction sortait en `handover_sans_numero` AVANT même de
    // regarder le reste. Les deux autres correctifs n'auraient donc rien changé sans celui-ci.
    let vu: string | null = null;
    await processHandovers(HANDOVER_REEL, {
      phoneNumberTenant: async (pn) => { vu = pn; return null; },
      setControlOwner: async () => true,
    });
    expect(vu).toBe('1234840649713976');
  });

  it('un numéro inconnu de nous n’écrit rien', async () => {
    const poses: string[] = [];
    await processHandovers(HANDOVER_REEL, {
      phoneNumberTenant: async () => null,
      setControlOwner: async (_t, w) => { poses.push(w); return true; },
    });
    expect(poses).toEqual([]);
  });
});

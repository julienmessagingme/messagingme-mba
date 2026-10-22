import { describe, it, expect } from 'vitest';
import { endormirLesComptes } from '../src/application/sommeil';
import { avisDeCoupure } from '../src/application/avis';
import type { CompteApplication, StatutCompte } from '../src/application/comptes';
import type { ClientApplication } from '../src/application/client';
import type { Emission } from '../src/emails-produit/emission';

/**
 * LES GARDES DE LA FILIÈRE APPLICATION (plan 2026-10-22, tâche 7) : la mise en sommeil d'un compte sans message depuis
 * 30 jours, et les courriels qui préviennent le développeur d'une coupure. Le refus du Pro vit dans
 * `tests/stripe-pro.test.ts`, celui des outils sans objet dans `tests/mcp-serveur.test.ts`.
 */
const T = 'bbbbbbbb-0000-4000-8000-000000000002';
const compte = (id: string, statut: StatutCompte = 'relie'): CompteApplication => ({
  id, tenantId: T, numero: '447700900000', jid: '447700900000:3@s.whatsapp.net', statut, fourniId: null,
  relieLe: new Date('2026-09-01T10:00:00Z'), dernierMessageLe: null, statutChangeLe: new Date(0),
});

function client(sommeils: string[], issue: Awaited<ReturnType<ClientApplication['sommeil']>> = { ok: true }): ClientApplication {
  const non = async () => ({ ok: false as const, raison: 'refuse' as const });
  return { relier: non, qr: non, envoyer: non, retirer: non, sommeil: async (id) => { sommeils.push(id); return issue; } };
}

describe('la mise en sommeil', () => {
  it('🔴 un compte sans message depuis le délai s’endort, et un courriel le dit', async () => {
    const sommeils: string[] = [];
    const emis: Emission[] = [];
    const lus: number[] = [];
    const n = await endormirLesComptes({
      comptes: { endormables: async (jours) => { lus.push(jours); return [compte('c1')]; } },
      client: client(sommeils),
      emettre: async (e) => { emis.push(e); },
    }, 30, new Date('2026-10-22T10:00:00Z'));
    expect(n).toBe(1);
    expect(lus).toEqual([30]);
    expect(sommeils).toEqual(['c1']);
    expect(emis).toEqual([{
      cle: 'application_en_sommeil', tenantId: T, occasion: 'sommeil:c1:2026-10-22', a: 'admins',
      valeurs: { numero: '+447700900000', jours: '30' },
    }]);
  });

  it('un service qui refuse n’endort rien et ne prévient personne', async () => {
    const emis: Emission[] = [];
    const n = await endormirLesComptes({
      comptes: { endormables: async () => [compte('c1')] }, client: client([], { ok: false, raison: 'service_injoignable' }),
      emettre: async (e) => { emis.push(e); },
    }, 30, new Date());
    expect([n, emis]).toEqual([0, []]);
  });

  it('sans service de connexions, la filière est fermée : rien à endormir', async () => {
    const lus: number[] = [];
    expect(await endormirLesComptes({
      comptes: { endormables: async (j) => { lus.push(j); return [compte('c1')]; } }, client: null, emettre: async () => {},
    }, 30, new Date())).toBe(0);
    expect(lus).toEqual([]);
  });
});

describe('le courriel d’une coupure', () => {
  it('🔴 un numéro banni et un appareil retiré préviennent les admins, une fois par coupure', async () => {
    const emis: Emission[] = [];
    const prevenir = avisDeCoupure(async (e) => { emis.push(e); });
    await prevenir(compte('c1', 'banni'), 'banni');
    await prevenir(compte('c1', 'deconnecte'), 'deconnecte');
    expect(emis.map((e) => [e.cle, e.occasion, e.a, e.valeurs.numero])).toEqual([
      ['application_numero_coupe', 'banni:c1:2026-09-01T10:00:00.000Z', 'admins', '+447700900000'],
      ['application_appareil_retire', 'deconnecte:c1:2026-09-01T10:00:00.000Z', 'admins', '+447700900000'],
    ]);
  });
});

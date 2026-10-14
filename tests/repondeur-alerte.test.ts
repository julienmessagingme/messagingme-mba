import { describe, it, expect, vi, afterEach } from 'vitest';
import { creerAlerteCreditEpuise, jourDans } from '../src/repondeur/alerte-credit';
import { creerEmetteurEmails, type JobEmail } from '../src/emails-produit/emission';
import { capturerJournal } from './journal';

/**
 * L'ALERTE DE CRÉDIT ÉPUISÉ (lot 5, A8 ; par les e-mails du produit depuis le lot 7). 🔴 Le « une par jour » est tenu
 * par la BASE : l'occasion est le jour, et le journal (migration 0234, contrainte unique) n'en réserve qu'une par admin.
 * Plusieurs copies de l'API et des workers voient passer les messages d'un espace à sec. Ce que fait vraiment
 * l'`on conflict` : `tests/integration/emails-produit.integration.test.ts`, en CI.
 */

afterEach(() => { vi.restoreAllMocks(); });

/** Le journal partagé par plusieurs « copies » : la contrainte unique (espace, modèle, personne, occasion). */
function journalPartage() {
  const lignes = new Set<string>();
  const jobs: JobEmail[] = [];
  return {
    lignes,
    jobs,
    reserver: async (e: { tenantId: string; cle: string; occasion: string; identites: string[] }) => {
      const ids: string[] = [];
      for (const i of e.identites) {
        const k = `${e.tenantId}/${e.cle}/${i}/${e.occasion}`;
        if (lignes.has(k)) continue;
        lignes.add(k);
        ids.push(`00000000-0000-4000-8000-${String(lignes.size).padStart(12, '0')}`);
      }
      return ids;
    },
  };
}

function alerte(o: { journal?: ReturnType<typeof journalPartage>; admins?: string[]; maintenant?: string; fuseau?: string } = {}) {
  const j = o.journal ?? journalPartage();
  const emetteur = creerEmetteurEmails({
    adminsConnectes: async () => o.admins ?? ['id-admin-a', 'id-admin-b'],
    reserver: j.reserver,
    fuseau: async () => o.fuseau ?? 'Europe/Paris',
    enfiler: async (job) => { j.jobs.push(job); },
  });
  const a = creerAlerteCreditEpuise({
    fuseau: async () => o.fuseau ?? 'Europe/Paris',
    emettre: (e) => emetteur.emettre(e),
    pageCredit: 'https://console.exemple.test/parametres/credit',
    now: () => new Date(o.maintenant ?? '2026-10-05T10:00:00.000Z'),
  });
  return { a, j };
}

describe('l’alerte de crédit épuisé', () => {
  it('🔴 deux copies, le même jour : UNE réservation par admin, UN job chacune ; le lendemain, de nouveau', async () => {
    const commun = journalPartage();
    const copieA = alerte({ journal: commun });
    const copieB = alerte({ journal: commun });
    await Promise.all([copieA.a.alerter('t1'), copieB.a.alerter('t1'), copieA.a.alerter('t1')]);
    expect(commun.jobs).toHaveLength(2);
    expect([...commun.lignes].sort()).toEqual([
      't1/credit_epuise/id-admin-a/jour:2026-10-05', 't1/credit_epuise/id-admin-b/jour:2026-10-05',
    ]);
    await alerte({ journal: commun, maintenant: '2026-10-06T10:00:00.000Z' }).a.alerter('t1');
    expect(commun.jobs).toHaveLength(4);
    // Un autre espace a sa propre journée.
    await alerte({ journal: commun }).a.alerter('t2');
    expect(commun.jobs).toHaveLength(6);
  });

  it('le jour est celui du FUSEAU de l’espace : 23 h 30 à Paris le 5, c’est déjà le 6 à Tokyo', async () => {
    const instant = new Date('2026-10-05T21:30:00.000Z');
    expect(jourDans('Europe/Paris', instant)).toBe('2026-10-05');
    expect(jourDans('Asia/Tokyo', instant)).toBe('2026-10-06');
    // Un fuseau illisible retombe sur celui du serveur, sans lever.
    expect(jourDans('Pas/Un_Fuseau', instant)).toBe('2026-10-05');
    const { a, j } = alerte({ fuseau: 'Asia/Tokyo', maintenant: '2026-10-05T21:30:00.000Z' });
    await a.alerter('t1');
    expect([...j.lignes][0]).toMatch(/jour:2026-10-06$/);
  });

  it('🔴 la réservation porte le lien de recharge et le fuseau, et rien d’autre : aucune donnée de contact', async () => {
    const vues: Array<Record<string, string>> = [];
    const emetteur = creerEmetteurEmails({
      adminsConnectes: async () => ['id-admin-a'],
      reserver: async (e) => { vues.push(e.valeurs); return ['00000000-0000-4000-8000-000000000001']; },
      fuseau: async () => 'Europe/Paris',
      enfiler: async () => {},
    });
    await creerAlerteCreditEpuise({ fuseau: async () => 'Europe/Paris', emettre: (e) => emetteur.emettre(e), pageCredit: 'https://x.test/credit' }).alerter('t1');
    expect(vues).toEqual([{ lien_credit: 'https://x.test/credit', _fuseau: 'Europe/Paris' }]);
  });

  it('🔴 personne à prévenir : journalisé, rien de réservé, et rien n’échoue', async () => {
    const { a, j } = alerte({ admins: [] });
    const { resultat, lignes } = await capturerJournal(() => a.alerter('t1'));
    expect(resultat).toBeUndefined();
    expect(j.lignes.size).toBe(0);
    expect(lignes.some((l) => l.msg === 'email_produit_sans_destinataire')).toBe(true);
  });

  it('une mise en file ratée laisse la réservation au balayage, et une base en panne ne fait rien tomber', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const commun = journalPartage();
    const emetteur = creerEmetteurEmails({
      adminsConnectes: async () => ['id-admin-a'], reserver: commun.reserver, fuseau: async () => 'Europe/Paris',
      enfiler: async () => { throw new Error('file injoignable'); },
    });
    await expect(creerAlerteCreditEpuise({ fuseau: async () => 'Europe/Paris', emettre: (e) => emetteur.emettre(e), pageCredit: 'x' }).alerter('t1'))
      .resolves.toBeUndefined();
    expect(commun.lignes.size, 'la réservation est faite : le balayage la reprendra').toBe(1);
    const enPanne = creerAlerteCreditEpuise({
      fuseau: async () => { throw new Error('pooler injoignable'); }, emettre: async () => ({ destinataires: 0, reserves: 0 }), pageCredit: 'x',
    });
    await expect(enPanne.alerter('t1')).resolves.toBeUndefined();
  });
});

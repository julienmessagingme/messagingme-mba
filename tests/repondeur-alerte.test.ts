import { describe, it, expect, vi, afterEach } from 'vitest';
import { creerAlerteCreditEpuise, jourDans, messageAlerte, type DepsAlerteCredit } from '../src/repondeur/alerte-credit';
import { capturerJournal } from './journal';

/**
 * L'ALERTE DE CRÉDIT ÉPUISÉ (lot 5, A8). 🔴 Le « une par jour » est tenu par la BASE (la clé primaire de
 * `repondeur_alertes_credit`), pas par la mémoire : plusieurs copies de l'API et des workers voient passer les messages
 * d'un espace à sec. Seule l'insertion qui a PRIS la ligne du jour envoie. Ce que fait vraiment l'`on conflict` :
 * `tests/integration/repondeur.integration.test.ts`, en CI (cas 5 de la revue).
 */

afterEach(() => { vi.restoreAllMocks(); });

/** Une mémoire partagée par plusieurs « copies » : la table, avec sa clé primaire (espace, jour). */
function base() {
  const lignes = new Set<string>();
  return { lignes, marquerLeJour: async (t: string, jour: string) => { const k = `${t}/${jour}`; if (lignes.has(k)) return false; lignes.add(k); return true; } };
}

function alerte(o: { base?: ReturnType<typeof base>; envoyer?: DepsAlerteCredit['envoyer'] | 'aucun'; admins?: string[]; maintenant?: string; fuseau?: string } = {}) {
  const envois: Array<{ to: string; subject: string; text: string }> = [];
  const b = o.base ?? base();
  const a = creerAlerteCreditEpuise({
    marquerLeJour: b.marquerLeJour,
    fuseau: async () => o.fuseau ?? 'Europe/Paris',
    admins: async () => o.admins ?? ['a@exemple.test', 'b@exemple.test'],
    envoyer: o.envoyer === 'aucun' ? null : (o.envoyer ?? (async (m) => { envois.push(m); })),
    pageCredit: 'https://console.exemple.test/parametres/credit',
    now: () => new Date(o.maintenant ?? '2026-10-05T10:00:00.000Z'),
  });
  return { a, envois, b };
}

describe('l’alerte de crédit épuisé', () => {
  it('🔴 deux copies, le même jour : UNE insertion prend, UN envoi par admin ; le lendemain, de nouveau', async () => {
    const commune = base();
    const copieA = alerte({ base: commune });
    const copieB = alerte({ base: commune });
    await Promise.all([copieA.a.alerter('t1'), copieB.a.alerter('t1'), copieA.a.alerter('t1')]);
    expect([...copieA.envois, ...copieB.envois].map((e) => e.to).sort()).toEqual(['a@exemple.test', 'b@exemple.test']);
    const lendemain = alerte({ base: commune, maintenant: '2026-10-06T10:00:00.000Z' });
    await lendemain.a.alerter('t1');
    expect(lendemain.envois).toHaveLength(2);
    // Un autre espace a sa propre journée.
    const autre = alerte({ base: commune });
    await autre.a.alerter('t2');
    expect(autre.envois).toHaveLength(2);
  });

  it('le jour est celui du FUSEAU de l’espace : 23 h 30 à Paris le 5, c’est déjà le 6 à Tokyo', () => {
    const instant = new Date('2026-10-05T21:30:00.000Z');
    expect(jourDans('Europe/Paris', instant)).toBe('2026-10-05');
    expect(jourDans('Asia/Tokyo', instant)).toBe('2026-10-06');
    // Un fuseau illisible retombe sur celui du serveur, sans lever.
    expect(jourDans('Pas/Un_Fuseau', instant)).toBe('2026-10-05');
  });

  it('🔴 sans Resend : journalisé, rien d’envoyé, et rien n’échoue', async () => {
    const { a, b } = alerte({ envoyer: 'aucun' });
    const { resultat, lignes } = await capturerJournal(() => a.alerter('t1'));
    expect(resultat).toBeUndefined();
    expect(b.lignes.size, 'la journée est prise : le journal ne se répète pas à chaque message').toBe(1);
    expect(lignes.some((l) => l.msg === 'alerte_credit_sans_resend')).toBe(true);
  });

  it('un envoi refusé n’empêche pas les autres admins, et une base en panne ne fait rien tomber', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const recus: string[] = [];
    const { a } = alerte({ envoyer: async (m) => { if (m.to.startsWith('a@')) throw new Error('adresse refusée'); recus.push(m.to); } });
    await a.alerter('t1');
    expect(recus).toEqual(['b@exemple.test']);
    const enPanne = creerAlerteCreditEpuise({
      marquerLeJour: async () => { throw new Error('pooler injoignable'); }, fuseau: async () => 'Europe/Paris',
      admins: async () => [], envoyer: null, pageCredit: 'x',
    });
    await expect(enPanne.alerter('t1')).resolves.toBeUndefined();
  });

  it('le message dit quoi faire, avec le lien de recharge, et aucune donnée de contact', () => {
    const m = messageAlerte('https://console.exemple.test/parametres/credit');
    expect(m.subject).toMatch(/Crédit IA épuisé/);
    expect(m.text).toContain('https://console.exemple.test/parametres/credit');
    expect(m.html).toContain('href="https://console.exemple.test/parametres/credit"');
    expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/[\u2013\u2014]/);
  });
});

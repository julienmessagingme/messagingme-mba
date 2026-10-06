import { describe, it, expect } from 'vitest';
import { balayerAbonnements, type DepsBalayageAbonnements } from '../src/numero/balayage-abonnements';
import { TACHES_PAR_ROLE } from '../src/worker/roles';
import type { EtatDeLEspace } from '../src/stripe/abonnements.pg';
import type { IssueLiberation } from '../src/numero/liberation.pg';

/**
 * LE BALAYAGE DES ABONNEMENTS DU NUMÉRO (lot 4, livraisons A et B). L'état se calcule sur des dates : le balayage ne
 * fait que les GESTES, chacun une seule fois, et un geste raté se rejoue au tour suivant :
 *  - à la suspension, l'alerte à Julien et l'e-mail aux admins ;
 *  - 2 jours avant la libération, le rappel aux admins ;
 *  - à J+7 après la fin, la libération, puis l'alerte et l'e-mail de libération ;
 *  - la levée des pauses `numero_suspendu` d'un espace qui n'est plus suspendu.
 */
const FINI = new Date('2026-10-06T15:14:51Z');
const LIBERATION = new Date('2026-10-13T15:14:51Z');
const JOUR = 24 * 3_600_000;
const etat = (e: Partial<EtatDeLEspace>): EtatDeLEspace => ({
  abonnementId: 'sub_1', etat: 'actif', finPrevueLe: null, liberationLe: null, coupureLe: null, finiLe: null, libereLe: null, ...e,
});
const finiSuspendu = (e: Partial<EtatDeLEspace> = {}) => etat({ etat: 'suspendu', finiLe: FINI, liberationLe: LIBERATION, ...e });

function monter(o: {
  etats: Record<string, EtatDeLEspace | null>; aSurveiller?: string[]; enPause?: string[]; maintenant?: Date;
  liberer?: (t: string) => Promise<IssueLiberation>; alerteEnPanne?: boolean;
}) {
  const avis = new Set<string>();
  const alertes: string[] = [];
  const mails: string[] = [];
  const reprises: string[] = [];
  const liberes: string[] = [];
  const servis: string[] = [];
  const d: DepsBalayageAbonnements = {
    aSurveiller: async () => o.aSurveiller ?? Object.keys(o.etats),
    etat: async (t) => o.etats[t] ?? null,
    avisDejaParti: async (id, a) => avis.has(`${id}:${a}`),
    noterAvis: async (id, a) => { const k = `${id}:${a}`; if (avis.has(k)) return false; avis.add(k); return true; },
    alerter: async (texte) => { if (o.alerteEnPanne) return false; alertes.push(texte); return true; },
    mails: {
      envoyer: async (t, e, a) => {
        if (avis.has(`${e.abonnementId}:${a}`)) return 'deja';
        mails.push(`${t}:${a}`);
        avis.add(`${e.abonnementId}:${a}`);
        return 'parti';
      },
    },
    liberer: async (t, abonnementId) => {
      liberes.push(`${t}:${abonnementId}`);
      const r = o.liberer ? await o.liberer(t) : { fait: 'resilie', numero: '441259797311', retire: true } as const;
      if (r.fait !== 'rien') o.etats[t] = { ...o.etats[t]!, etat: 'libere', libereLe: o.maintenant ?? new Date() };
      return r;
    },
    servirAbonneEnAttente: async (sauf) => { servis.push(sauf); },
    espacesEnPauseSuspension: async () => o.enPause ?? [],
    leverPausesSuspension: async (t) => { reprises.push(t); return 1; },
    maintenant: () => o.maintenant ?? new Date(FINI.getTime() + JOUR),
  };
  return { d, alertes, mails, reprises, liberes, servis, avis };
}

describe('balayerAbonnements : la suspension', () => {
  it('🔴 suspendu (fini) : Julien prévenu UNE fois, les admins aussi, pas au tour suivant', async () => {
    const m = monter({ etats: { t1: finiSuspendu() } });
    await balayerAbonnements(m.d);
    await balayerAbonnements(m.d);
    expect(m.alertes).toHaveLength(1);
    expect(m.alertes[0]).toMatch(/t1/);
    expect(m.alertes[0]).toMatch(/2026-10-13/);
    expect(m.mails).toEqual(['t1:suspension_mail']);
  });

  it('🔴 une alerte qui ne part pas (Telegram rend false) ne se note pas : elle se rejoue (jaune 6 de A)', async () => {
    const m = monter({ etats: { t1: finiSuspendu() }, alerteEnPanne: true });
    await balayerAbonnements(m.d);
    expect(m.avis.has('sub_1:suspension_telegram')).toBe(false);
    m.d.alerter = async (texte) => { m.alertes.push(texte); return true; };
    await balayerAbonnements(m.d);
    expect(m.alertes).toHaveLength(1);
    expect(m.avis.has('sub_1:suspension_telegram')).toBe(true);
  });

  it('un impayé suspendu le dit ; en retard ou actif : rien ; jamais de rappel de libération sans fin', async () => {
    const m = monter({ etats: { t1: etat({ etat: 'suspendu' }), t2: etat({ abonnementId: 'sub_2', etat: 'en_retard' }), t3: etat({ abonnementId: 'sub_3' }) } });
    await balayerAbonnements(m.d);
    expect(m.alertes).toHaveLength(1);
    expect(m.alertes[0]).toMatch(/impayé/);
    expect(m.mails).toEqual(['t1:suspension_mail']);
    expect(m.liberes).toEqual([]);
  });

  it('🔴 le rappel part 2 jours avant la libération, pas avant', async () => {
    const tot = monter({ etats: { t1: finiSuspendu() }, maintenant: new Date(LIBERATION.getTime() - 3 * JOUR) });
    await balayerAbonnements(tot.d);
    expect(tot.mails).toEqual(['t1:suspension_mail']);
    const juste = monter({ etats: { t1: finiSuspendu() }, maintenant: new Date(LIBERATION.getTime() - 2 * JOUR) });
    await balayerAbonnements(juste.d);
    expect(juste.mails).toEqual(['t1:suspension_mail', 't1:rappel_liberation_mail']);
    expect(juste.liberes).toEqual([]);
  });
});

describe('balayerAbonnements : la libération', () => {
  it('🔴 à J+7 : libéré, Julien et les admins prévenus une fois, rien au tour suivant', async () => {
    const m = monter({ etats: { t1: finiSuspendu() }, maintenant: new Date(LIBERATION.getTime() + 60_000) });
    await balayerAbonnements(m.d);
    expect(m.liberes).toEqual(['t1:sub_1']);
    expect(m.alertes.filter((a) => /libéré/.test(a))).toHaveLength(1);
    expect(m.alertes.find((a) => /libéré/.test(a))).toMatch(/441259797311.*DIDWW/);
    expect(m.mails).toContain('t1:liberation_mail');
    await balayerAbonnements(m.d);
    expect(m.alertes.filter((a) => /libéré/.test(a))).toHaveLength(1);
    expect(m.mails.filter((x) => x === 't1:liberation_mail')).toHaveLength(1);
  });

  it('jamais vu de Meta : rendu à la réserve, et le numéro sert d’abord un abonné qui attend', async () => {
    const m = monter({
      etats: { t1: finiSuspendu() }, maintenant: new Date(LIBERATION.getTime() + 60_000),
      liberer: async () => ({ fait: 'libre', numero: '441259797311' }),
    });
    await balayerAbonnements(m.d);
    expect(m.servis).toEqual(['t1']);
    expect(m.alertes.find((a) => /libéré/.test(a))).toMatch(/réserve/);
  });

  it('🔴 DIDWW échoue : Julien est prévenu de l’échec, aucun e-mail de libération, et les autres espaces passent', async () => {
    const m = monter({
      etats: { t1: finiSuspendu(), t2: finiSuspendu({ abonnementId: 'sub_2' }) }, maintenant: new Date(LIBERATION.getTime() + 60_000),
      liberer: async (t) => { if (t === 't1') throw new Error('DIDWW a refusé (403)'); return { fait: 'resilie', numero: '441259797322', retire: true }; },
    });
    await balayerAbonnements(m.d);
    expect(m.alertes.find((a) => /t1/.test(a) && /échec/.test(a))).toMatch(/403/);
    expect(m.mails).not.toContain('t1:liberation_mail');
    expect(m.mails).toContain('t2:liberation_mail');
  });

  it('fini sans numéro (rendu par « Abandonner ») : la date se pose, personne n’est prévenu', async () => {
    const m = monter({
      etats: { t1: etat({ etat: 'libere', finiLe: FINI, liberationLe: LIBERATION }) }, maintenant: new Date(LIBERATION.getTime() + 60_000),
      liberer: async () => ({ fait: 'sans_numero' }),
    });
    await balayerAbonnements(m.d);
    expect(m.liberes).toEqual(['t1:sub_1']);
    expect(m.alertes).toEqual([]);
    expect(m.mails).toEqual([]);
  });

  it('pas encore dû, ou déjà libéré : liberer n’est pas appelé', async () => {
    const m = monter({ etats: { t1: finiSuspendu(), t2: finiSuspendu({ abonnementId: 'sub_2', etat: 'libere', libereLe: LIBERATION }) }, maintenant: new Date(LIBERATION.getTime() - 60_000) });
    await balayerAbonnements(m.d);
    expect(m.liberes).toEqual([]);
  });
});

describe('balayerAbonnements : les pauses', () => {
  it('🔴 une pause `numero_suspendu` d’un espace qui n’est PLUS suspendu est levée ; celle d’un espace suspendu reste', async () => {
    const m = monter({ etats: { payé: etat({}), suspendu: etat({ abonnementId: 'sub_2', etat: 'suspendu' }) }, aSurveiller: [], enPause: ['payé', 'suspendu'] });
    await balayerAbonnements(m.d);
    expect(m.reprises).toEqual(['payé']);
  });

  it('une alerte qui lève n’arrête pas le balayage des autres espaces', async () => {
    const m = monter({ etats: { t1: etat({ etat: 'suspendu' }), t2: etat({ abonnementId: 'sub_2', etat: 'suspendu' }) } });
    let premier = true;
    m.d.alerter = async (texte) => { if (premier) { premier = false; throw new Error('telegram'); } m.alertes.push(texte); return true; };
    await balayerAbonnements(m.d);
    expect(m.alertes).toHaveLength(1);
  });

  it('la tâche est déclarée pour le rôle principal (un seul processus la joue)', () => {
    expect(TACHES_PAR_ROLE['abonnements-numero']).toBe('principal');
  });
});

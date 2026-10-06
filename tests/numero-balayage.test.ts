import { describe, it, expect } from 'vitest';
import { balayerAbonnements, type DepsBalayageAbonnements } from '../src/numero/balayage-abonnements';
import { TACHES_PAR_ROLE } from '../src/worker/roles';
import type { EtatDeLEspace } from '../src/stripe/abonnements.pg';

/**
 * LE BALAYAGE DES ABONNEMENTS DU NUMÉRO (lot 4, livraison A). L'état se calcule sur des dates : le balayage ne fait
 * que les GESTES. Ici, l'alerte de suspension à Julien (une seule fois par abonnement), et la levée des pauses
 * `numero_suspendu` d'un espace qui n'est plus suspendu (un paiement tombé dans la fenêtre du cache de la garde).
 */
const etat = (e: Partial<EtatDeLEspace>): EtatDeLEspace => ({
  abonnementId: 'sub_1', etat: 'actif', finPrevueLe: null, liberationLe: null, coupureLe: null, finiLe: null, ...e,
});

function monter(o: { etats: Record<string, EtatDeLEspace | null>; aSurveiller?: string[]; enPause?: string[] }) {
  const avis = new Set<string>();
  const alertes: string[] = [];
  const reprises: string[] = [];
  const d: DepsBalayageAbonnements = {
    aSurveiller: async () => o.aSurveiller ?? Object.keys(o.etats),
    etat: async (t) => o.etats[t] ?? null,
    noterAvis: async (abonnementId, a) => { const k = `${abonnementId}:${a}`; if (avis.has(k)) return false; avis.add(k); return true; },
    alerter: async (texte) => { alertes.push(texte); },
    espacesEnPauseSuspension: async () => o.enPause ?? [],
    leverPausesSuspension: async (t) => { reprises.push(t); return 1; },
  };
  return { d, alertes, reprises, avis };
}

describe('balayerAbonnements', () => {
  it('🔴 suspendu : Julien est prévenu UNE fois, pas au tour suivant', async () => {
    const m = monter({ etats: { t1: etat({ etat: 'suspendu', finiLe: new Date('2026-10-06T15:14:51Z'), liberationLe: new Date('2026-10-13T15:14:51Z') }) } });
    await balayerAbonnements(m.d);
    await balayerAbonnements(m.d);
    expect(m.alertes).toHaveLength(1);
    expect(m.alertes[0]).toMatch(/t1/);
    expect(m.alertes[0]).toMatch(/2026-10-13/);
  });

  it('un impayé suspendu le dit aussi ; en retard ou actif : aucune alerte', async () => {
    const m = monter({ etats: { t1: etat({ etat: 'suspendu' }), t2: etat({ abonnementId: 'sub_2', etat: 'en_retard' }), t3: etat({ abonnementId: 'sub_3' }) } });
    await balayerAbonnements(m.d);
    expect(m.alertes).toHaveLength(1);
    expect(m.alertes[0]).toMatch(/impayé/);
  });

  it('🔴 une pause `numero_suspendu` d’un espace qui n’est PLUS suspendu est levée ; celle d’un espace suspendu reste', async () => {
    const m = monter({ etats: { payé: etat({}), suspendu: etat({ abonnementId: 'sub_2', etat: 'suspendu' }) }, aSurveiller: [], enPause: ['payé', 'suspendu'] });
    await balayerAbonnements(m.d);
    expect(m.reprises).toEqual(['payé']);
  });

  it('une alerte qui échoue n’arrête pas le balayage des autres espaces', async () => {
    const m = monter({ etats: { t1: etat({ etat: 'suspendu' }), t2: etat({ abonnementId: 'sub_2', etat: 'suspendu' }) } });
    let premier = true;
    m.d.alerter = async (texte) => { if (premier) { premier = false; throw new Error('telegram'); } m.alertes.push(texte); };
    await balayerAbonnements(m.d);
    expect(m.alertes).toHaveLength(1);
  });

  it('la tâche est déclarée pour le rôle principal (un seul processus la joue)', () => {
    expect(TACHES_PAR_ROLE['abonnements-numero']).toBe('principal');
  });
});

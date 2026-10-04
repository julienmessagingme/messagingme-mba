import { describe, it, expect } from 'vitest';
import {
  creerSurveillanceWorkers, SEUIL_SILENCE_WORKER_S, RAPPEL_SILENCE_WORKER_MS, SEUIL_BOUCLE_DEMARRAGES, FENETRE_BOUCLE_MS,
} from '../src/ops/surveillance-workers';
import type { WorkerHeartbeatRow } from '../src/ops/heartbeat-store.pg';
import { verrousEnMemoire } from './verrous';

/**
 * L'alerte quand un worker se tait ou redémarre en boucle (`src/ops/surveillance-workers.ts`). Deux « copies » de
 * l'API partagent le même double de verrous, comme deux copies partagent la base.
 */
function banc() {
  let t = Date.parse('2026-10-04T12:00:00.000Z');
  const verrous = verrousEnMemoire(() => t);
  const lignes = new Map<string, WorkerHeartbeatRow>();
  const envois: string[] = [];
  let telegramOk = true;
  const copie = () => creerSurveillanceWorkers({
    lister: async () => [...lignes.values()],
    verrous,
    envoyer: async (texte) => { if (telegramOk) envois.push(texte); return telegramOk; },
    maintenant: () => t,
  });
  const iso = (ms: number) => new Date(ms).toISOString();
  const battement = (role: string, ageSeconds: number, bootedAt: string | null = null) => {
    lignes.set(role, { role, ageSeconds, beatAt: iso(t - ageSeconds * 1000), bootedAt, instance: null });
  };
  return {
    copie, battement, envois, iso,
    maintenant: () => t,
    avancer: (ms: number) => { t += ms; },
    effacer: (role: string) => { lignes.delete(role); },
    telegram: (ok: boolean) => { telegramOk = ok; },
  };
}

describe('surveillance des workers : le silence', () => {
  it('🔴 un rôle silencieux au-delà du seuil déclenche UNE alerte, qui dit la conséquence', async () => {
    const b = banc();
    const surveiller = b.copie();
    b.battement('principal', SEUIL_SILENCE_WORKER_S + 1);
    b.battement('analyse', 10);
    await surveiller();
    await surveiller();
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0]).toMatch(/worker « principal » silencieux depuis 3 min/);
    expect(b.envois[0]).toMatch(/messages entrants/);
  });

  it('au seuil exact, rien : la limite est stricte', async () => {
    const b = banc();
    b.battement('principal', SEUIL_SILENCE_WORKER_S);
    await b.copie()();
    expect(b.envois).toEqual([]);
  });

  it('🔴 deux copies de l’API, une seule alerte', async () => {
    const b = banc();
    const a = b.copie();
    const c = b.copie();
    b.battement('analyse', 600);
    await Promise.all([a(), c()]);
    expect(b.envois).toHaveLength(1);
  });

  it('le silence qui dure est rappelé au bout d’une heure, pas avant', async () => {
    const b = banc();
    const surveiller = b.copie();
    b.battement('principal', 600);
    const dernier = b.maintenant() - 600_000;
    await surveiller();
    // Le dernier battement ne bouge pas pendant le silence : même épisode, même clé.
    const silence = (age: number) => b.battement('principal', age);
    b.avancer(RAPPEL_SILENCE_WORKER_MS - 60_000);
    silence((b.maintenant() - dernier) / 1000);
    await surveiller();
    expect(b.envois).toHaveLength(1);
    b.avancer(60_000);
    silence((b.maintenant() - dernier) / 1000);
    await surveiller();
    expect(b.envois).toHaveLength(2);
  });

  it('🔴 le retour est annoncé une fois, et un nouveau silence juste après réalerte aussitôt', async () => {
    const b = banc();
    const surveiller = b.copie();
    b.battement('principal', 600);
    await surveiller();
    b.avancer(60_000);
    b.battement('principal', 5, b.iso(b.maintenant() - 5_000));
    await surveiller();
    await surveiller();
    expect(b.envois).toHaveLength(2);
    expect(b.envois[1]).toMatch(/worker « principal » reparti .* redémarré \d\d:\d\d UTC/);
    b.avancer(5 * 60_000);
    b.battement('principal', 400);
    await surveiller();
    expect(b.envois).toHaveLength(3);
    expect(b.envois[2]).toMatch(/silencieux/);
  });

  it('🔴 une copie de l’API redémarrée pendant la panne annonce un SECOND silence sans attendre l’heure', async () => {
    const b = banc();
    b.battement('principal', 600);
    await b.copie()();
    // L'API redémarre (nouvelle copie, mémoire vide) ; le worker revient, puis se retait dix minutes plus tard.
    const neuve = b.copie();
    b.avancer(60_000);
    b.battement('principal', 5, b.iso(b.maintenant()));
    await neuve();
    b.avancer(10 * 60_000);
    b.battement('principal', 400);
    await neuve();
    expect(b.envois).toHaveLength(2);
    expect(b.envois[1]).toMatch(/silencieux/);
  });

  it('un worker figé puis reparti SANS redémarrer : le retour ne donne pas une vieille heure de démarrage', async () => {
    const b = banc();
    const surveiller = b.copie();
    const demarrage = b.iso(b.maintenant() - 3_600_000);
    b.battement('analyse', 600, demarrage);
    await surveiller();
    b.avancer(60_000);
    b.battement('analyse', 5, demarrage);
    await surveiller();
    expect(b.envois[1]).toMatch(/reparti .*sans redémarrage/);
  });

  it('une copie qui n’a pas annoncé le silence n’annonce pas son retour', async () => {
    const b = banc();
    b.battement('principal', 600);
    await b.copie()();
    const autre = b.copie();
    b.avancer(60_000);
    b.battement('principal', 5, b.iso(b.maintenant()));
    await autre();
    expect(b.envois).toHaveLength(1);
  });

  it('Telegram qui ne prend pas le message : la minute suivante réessaie, l’alerte comme le retour', async () => {
    const b = banc();
    const surveiller = b.copie();
    b.battement('analyse', 600);
    b.telegram(false);
    await surveiller();
    expect(b.envois).toEqual([]);
    b.telegram(true);
    b.avancer(60_000);
    b.battement('analyse', 660);
    await surveiller();
    expect(b.envois).toHaveLength(1);
    b.telegram(false);
    b.battement('analyse', 5, b.iso(b.maintenant()));
    await surveiller();
    b.telegram(true);
    await surveiller();
    expect(b.envois).toHaveLength(2);
    expect(b.envois[1]).toMatch(/reparti/);
  });

  it('un rôle effacé de la table n’a plus de retour à annoncer', async () => {
    const b = banc();
    const surveiller = b.copie();
    b.battement('all', 600);
    await surveiller();
    b.effacer('all');
    await surveiller();
    b.battement('all', 5, b.iso(b.maintenant()));
    await surveiller();
    expect(b.envois).toHaveLength(1);
  });

  it('un rôle vivant ne produit rien, et une lecture en échec remonte à l’appelant', async () => {
    const b = banc();
    b.battement('principal', 15);
    b.battement('analyse', 25);
    await b.copie()();
    expect(b.envois).toEqual([]);
    const panne = creerSurveillanceWorkers({
      lister: async () => { throw new Error('base indisponible'); },
      verrous: verrousEnMemoire(),
      envoyer: async () => true,
    });
    await expect(panne()).rejects.toThrow('base indisponible');
  });
});

describe('surveillance des workers : la boucle de redémarrages', () => {
  /** Un démarrage par minute, le battement toujours frais : ce que voit l'API d'un worker relancé par Docker. */
  async function demarrer(b: ReturnType<typeof banc>, surveiller: () => Promise<void>, fois: number, ecartMs = 60_000) {
    for (let i = 0; i < fois; i += 1) {
      b.battement('principal', 5, b.iso(b.maintenant()));
      await surveiller();
      b.avancer(ecartMs);
    }
  }

  it('🔴 un worker qui bat entre deux plantages est signalé : la boucle, pas le silence', async () => {
    const b = banc();
    const surveiller = b.copie();
    await demarrer(b, surveiller, SEUIL_BOUCLE_DEMARRAGES);
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0]).toMatch(/worker « principal » redémarre en boucle : 5 démarrages en 15 min/);
    await demarrer(b, surveiller, 3);
    expect(b.envois).toHaveLength(1); // une alerte par heure, pas une par démarrage
  });

  it('des déploiements rapprochés ne sont pas une boucle', async () => {
    const b = banc();
    const surveiller = b.copie();
    await demarrer(b, surveiller, SEUIL_BOUCLE_DEMARRAGES - 1, 3 * 60_000);
    expect(b.envois).toEqual([]);
  });

  it('des démarrages étalés au-delà de la fenêtre ne s’additionnent pas', async () => {
    const b = banc();
    const surveiller = b.copie();
    await demarrer(b, surveiller, SEUIL_BOUCLE_DEMARRAGES + 2, FENETRE_BOUCLE_MS / 3);
    expect(b.envois).toEqual([]);
  });

  it('le même démarrage vu à chaque minute n’en compte qu’un', async () => {
    const b = banc();
    const surveiller = b.copie();
    const boot = b.iso(b.maintenant());
    for (let i = 0; i < 10; i += 1) {
      b.battement('principal', 5, boot);
      await surveiller();
      b.avancer(60_000);
    }
    expect(b.envois).toEqual([]);
  });
});

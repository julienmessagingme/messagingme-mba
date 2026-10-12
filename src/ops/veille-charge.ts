import { centile } from './latence-http';
import { fenetreDe } from './latence-http.pg';
import type { PointAttente } from './pool-attentes.pg';
import type { LigneCompteur } from '../db/debit';
import { dlqName } from '../queue/names';
import { journaliser } from '../lib/journal';
import { CLE_REFUS_GLOBAL } from '../auth/plafond-global';

/**
 * La veille de charge (lot 14, décision de Julien du 2026-10-12) : prévenir AVANT que ça casse, sur des mesures qui
 * existaient déjà en base et que seul l'écran `/ops` lisait, quand quelqu'un l'ouvrait. Quatre alertes Telegram,
 * chacune au plus une fois par clé toutes les 30 minutes (un problème qui dure se redit, une rafale ne se répète pas) :
 * - une FILE EN RETARD : le plus vieux job prêt qui attend (créé ou à rejouer, `start_after` passé ; un job en cours
 *   n'attend pas, un run de campagne peut durer) depuis plus de 60 s sur les files de réception, 5 min ailleurs ;
 * - la RÉCEPTION DE META LENTE : p95 de `POST /webhooks/meta` au-delà de 2 s sur la dernière fenêtre de 5 minutes
 *   complète, d'au moins 20 requêtes (`http_latences`) ;
 * - la BASE SATURÉE : sur une minute d'un processus, au moins 5 % des prises de connexion ont attendu un pool plein,
 *   et la plus longue au-delà de 200 ms. `pool_attentes` ne garde ni p95 ni histogramme (presque toutes les prises
 *   valent zéro, `attente-pool.ts`) : 5 % d'attentes dont une de plus de 200 ms est ce qui s'en approche ;
 * - le PLAFOND GLOBAL ATTEINT (`plafond-global.ts`) : au moins un refus ces deux dernières minutes, Free et payants.
 * Une lecture qui échoue n'empêche pas les autres : elle se journalise, et la veille suivante relit.
 */

export const RELANCE_ALERTE_MS = 30 * 60_000;

/** Les files dont un retard se voit chez le client : un message reçu attend son traitement. */
const FILES_DE_RECEPTION = new Set(['webhook', 'webhook-status']);
const RETARD_RECEPTION_S = 60;
const RETARD_AUTRES_S = 5 * 60;

const RECEPTION_P95_MS = 2_000;
const RECEPTION_MIN_REQUETES = 20;

const POOL_PART_ATTENTES = 0.05;
const POOL_ATTENTE_MS = 200;
const POOL_MIN_ECHANTILLONS = 20;

const FENETRE_LATENCES_MS = 5 * 60_000;

export interface LecturesCharge {
  /** Le plus vieux job prêt qui ATTEND, par file de base (`PgOpsStore.agesDAttente`). */
  agesDAttente(): Promise<Array<{ file: string; ageSecondes: number }>>;
  /** Les tranches de `POST /webhooks/meta` sur une fenêtre de 5 minutes, toutes copies et codes confondus. */
  latencesReceptionMeta(fenetre: Date): Promise<{ seaux: readonly number[]; maxMs: number }>;
  /** Les dernières minutes de l'attente du pool, par processus. */
  attentesPool(): Promise<PointAttente[]>;
  /** Les refus du plafond global des deux dernières minutes (`compteurs_debit`). */
  refusPlafondGlobal(): Promise<LigneCompteur[]>;
}

export function creerVeilleCharge(deps: {
  lire: LecturesCharge;
  alerter: (cle: string, texte: string) => void;
  maintenant?: () => number;
}): () => Promise<void> {
  const maintenant = deps.maintenant ?? (() => Date.now());
  const derniere = new Map<string, number>();
  const alerter = (cle: string, texte: string): void => {
    const t = maintenant();
    const avant = derniere.get(cle);
    if (avant !== undefined && t - avant < RELANCE_ALERTE_MS) return;
    derniere.set(cle, t);
    deps.alerter(cle, texte);
  };
  const lire = async <T>(quoi: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (err) {
      journaliser('warn', 'veille_charge_lecture_impossible', { quoi, err });
      return null;
    }
  };

  return async function veilleCharge(): Promise<void> {
    const [ages, latences, attentes, refus] = await Promise.all([
      lire('files', () => deps.lire.agesDAttente()),
      lire('reception-meta', () => deps.lire.latencesReceptionMeta(fenetreDe(new Date(maintenant() - FENETRE_LATENCES_MS)))),
      lire('pool', () => deps.lire.attentesPool()),
      lire('plafond-global', () => deps.lire.refusPlafondGlobal()),
    ]);

    for (const { file, ageSecondes } of ages ?? []) {
      if (file.endsWith(dlqName(''))) continue;
      const seuil = FILES_DE_RECEPTION.has(file) ? RETARD_RECEPTION_S : RETARD_AUTRES_S;
      if (ageSecondes > seuil) {
        alerter(`veille:file:${file}`, `file ${file} en retard : le plus vieux job prêt attend depuis ${ageSecondes} s (seuil ${seuil} s).`);
      }
    }

    if (latences) {
      const requetes = latences.seaux.reduce((s, n) => s + n, 0);
      const p95 = centile(latences.seaux, 0.95, latences.maxMs);
      if (requetes >= RECEPTION_MIN_REQUETES && p95 !== null && p95 > RECEPTION_P95_MS) {
        alerter('veille:reception-meta', `réception de Meta lente : p95 de ${p95} ms sur ${requetes} requêtes en 5 min (seuil ${RECEPTION_P95_MS} ms).`);
      }
    }

    for (const p of attentes ?? []) {
      if (p.echantillons < POOL_MIN_ECHANTILLONS) continue;
      const part = p.attentes / p.echantillons;
      if (part >= POOL_PART_ATTENTES && p.maxAttenteMs > POOL_ATTENTE_MS) {
        alerter(`veille:pool:${p.process}`, `base saturée (${p.process}) : ${Math.round(part * 100)} % des prises de connexion ont attendu en une minute, la plus longue ${Math.round(p.maxAttenteMs)} ms.`);
      }
    }

    if (refus) {
      const parSorte = (s: string) => refus.filter((l) => l.cle === `${CLE_REFUS_GLOBAL}${s}`).reduce((n, l) => n + l.n, 0);
      const free = parSorte('free');
      const payant = parSorte('payant');
      if (free + payant > 0) {
        alerter('veille:plafond-global', `plafond global de l’API atteint : ${free + payant} refus en deux minutes (${free} Free, ${payant} payants).`);
      }
    }
  };
}

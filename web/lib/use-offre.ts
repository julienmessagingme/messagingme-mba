'use client';

import { useEffect, useState } from 'react';
import { lireOffre } from './api/offre';
import { OFFRE_REFUSEE_EVENT, type FonctionOffre, type VueOffre } from './offre';

/**
 * L'OFFRE DE L'ESPACE, LUE UNE FOIS PAR MINUTE AU PLUS (lot 6). La coquille se remonte à chaque page : sans mémoire,
 * chaque clic de menu relirait l'offre. Le serveur garde la sienne 30 s ; une minute ici ne fait qu'afficher un menu
 * grisé ou ouvert un peu plus longtemps, la barrière restant le 402 du serveur.
 *
 * 🔴 UN REFUS D'OFFRE VIDE LA MÉMOIRE : l'espace vient peut-être de changer d'offre (ramené en Base par l'exploitation),
 * et la page suivante doit le voir.
 */
const VIE_MS = 60_000;
let memo: { tenantId: string; at: number; vue: Promise<VueOffre | null> } | null = null;

export function oublierOffre(): void {
  memo = null;
}

export function offreEnMemoire(tenantId: string, maintenant = Date.now()): Promise<VueOffre | null> {
  if (memo && memo.tenantId === tenantId && maintenant - memo.at < VIE_MS) return memo.vue;
  const vue = lireOffre(tenantId).catch(() => {
    // Une panne n'est pas gardée : la prochaine page relira.
    memo = null;
    return null;
  });
  memo = { tenantId, at: maintenant, vue };
  return vue;
}

/**
 * L'offre si elle FERME cette fonction, `null` si elle l'ouvre ou si elle est inconnue (donc ouverte), `undefined` tant
 * qu'elle n'est pas lue. Un écran ouvert à la Base qui lit au chargement l'état d'une fonction payante (le canal RCS de
 * l'accueil) attend ce verdict : il ne lit que sur `null`, et montre « Inclus dans l'offre Pro » sur une vue.
 */
export function useFermeture(tenantId: string | null, f: FonctionOffre): VueOffre | null | undefined {
  const vue = useOffre(tenantId);
  if (vue === undefined) return undefined;
  return vue !== null && !vue.fonctions.has(f) ? vue : null;
}

/** `undefined` tant qu'elle n'est pas lue, `null` si elle est inconnue (tout ouvert), la vue sinon. */
export function useOffre(tenantId: string | null): VueOffre | null | undefined {
  const [vue, setVue] = useState<VueOffre | null | undefined>(undefined);
  useEffect(() => {
    if (!tenantId) return;
    let vivant = true;
    const lire = () => { void offreEnMemoire(tenantId).then((v) => { if (vivant) setVue(v); }); };
    lire();
    const refusee = () => { oublierOffre(); lire(); };
    window.addEventListener(OFFRE_REFUSEE_EVENT, refusee);
    return () => { vivant = false; window.removeEventListener(OFFRE_REFUSEE_EVENT, refusee); };
  }, [tenantId]);
  return vue;
}

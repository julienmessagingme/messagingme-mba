'use client';

import type { Locale } from './locale';

/**
 * LIRE LES MESSAGES REÇUS DANS SA LANGUE : le réglage, et ce que chaque bulle doit montrer.
 *
 * 🔴 LA CIBLE EST LA LANGUE DE LA CONSOLE, JAMAIS UNE QUESTION DE PLUS. On sait déjà dans quelle
 * langue la personne lit son produit : lui redemander sa langue de lecture serait un réglage de plus
 * pour une information qu'on possède, et deux réglages finissent par se contredire.
 *
 * ⚠️ CE MODULE NE TOUCHE À AUCUN RÉSEAU, et c'est pour ça qu'il existe : `web/vitest.config.ts` borne
 * les tests unitaires du front à `lib/`, donc ce qui vit ici se vérifie sans navigateur. Le reste (le
 * rechargement du fil, la remise à zéro du curseur) ne se prouve qu'en e2e.
 */

/**
 * Clé de persistance du réglage, PAR NAVIGATEUR comme le choix de langue (décision de Julien du
 * 2026-09-12 : « ok pour localStorage et tout traduire à l'ouverture »).
 *
 * ⚠️ Un réglage rangé côté SERVEUR serait partagé par toute l'équipe : deux collègues lisent le même
 * fil, l'un en français, l'autre en anglais, et c'est exactement le cas qui a fait naître ce lot.
 */
export const TRADUCTION_STORAGE_KEY = 'mba_traduire_recus';

/**
 * Ce qu'on demande au serveur, ou `undefined` quand on ne traduit pas.
 *
 * 🔴 `undefined` ET PAS UNE CHAÎNE VIDE : sans `?traduire`, la réponse du fil est mot pour mot celle
 * d'avant ce lot (aucun `affiche`, aucun `traductionIndisponible`, aucun appel de modèle payé). C'est
 * ce qui rend l'extinction du réglage réellement gratuite.
 */
export function cibleDeLecture(actif: boolean, locale: Locale): Locale | undefined {
  return actif ? locale : undefined;
}

/**
 * LES TROIS ÉTATS D'UNE BULLE, ET LES DEUX DERNIERS NE SE CONFONDENT PAS.
 *
 * `traduit` = la bulle porte notre lecture. `echec` = la traduction a été TENTÉE et n'est pas revenue,
 * donc la bulle porte l'original et le dit. `aucune` = rien n'a été tenté (au-delà du plafond de 40,
 * ou réglage éteint), donc la bulle porte l'original et NE DIT RIEN.
 *
 * 🔴 Confondre les deux derniers ferait annoncer une panne qui n'existe pas, sur des messages anciens
 * que personne n'a demandé à traduire, et l'opérateur chercherait une cause qu'il ne trouverait jamais.
 */
export type MarqueTraduction = 'aucune' | 'traduit' | 'echec';

export function marqueTraduction(m: { traduit?: boolean; traductionEchouee?: boolean }): MarqueTraduction {
  if (m.traduit === true) return 'traduit';
  if (m.traductionEchouee === true) return 'echec';
  return 'aucune';
}

/**
 * Le texte de la bulle : notre lecture quand il y en a une, l'original sinon.
 *
 * 🔴 UNE CHAÎNE VIDE COMPTE POUR ABSENTE, et ce n'est pas de la coquetterie. Le serveur rend
 * `affiche: ''` pour un message SANS corps (un autocollant, une image sans légende) parce que son
 * original est `null` : le prendre au mot effacerait le repli `[image]` que l'écran affiche depuis
 * toujours, et la bulle deviendrait vide le jour où l'on allume la traduction.
 *
 * ⚠️ `affiche` est absent de toute réponse demandée SANS `traduire` : le repli sur `body` n'est donc
 * pas un cas limite, c'est le chemin ordinaire quand le réglage est éteint.
 */
export function texteDeBulle(m: { affiche?: string; body: string | null }): string | null {
  const a = m.affiche;
  if (typeof a === 'string' && a !== '') return a;
  return m.body;
}

/**
 * Ce qu'un VOCAL affiche sous son lecteur : sa transcription, ou notre lecture de sa transcription.
 *
 * 🔴 LA GARDE EST `transcription`, PAS `traduit`, et elle attrape un piège réel : un vocal avec une
 * LÉGENDE mais sans transcription est traduit lui aussi (c'est sa légende qui part au modèle), donc il
 * porte `traduit: true` et un `affiche` qui n'a jamais été une transcription. L'afficher sous
 * l'étiquette « transcription » ferait passer une légende pour ce qui a été DIT.
 *
 * ⚠️ Un vocal jamais transcrit rend `null` : il n'y a rien à montrer, et surtout rien n'est téléchargé
 * au rendu (les octets ne partent qu'au clic).
 */
export function texteDuVocal(
  m: { transcription?: string | null; affiche?: string; traduit?: boolean },
): { texte: string | null; traduit: boolean } {
  const transcription = m.transcription ?? null;
  if (transcription === null) return { texte: null, traduit: false };
  if (m.traduit === true && typeof m.affiche === 'string' && m.affiche !== '') {
    return { texte: m.affiche, traduit: true };
  }
  return { texte: transcription, traduit: false };
}

/**
 * Le réglage tel qu'il est rangé dans CE navigateur. Absent ou illisible = éteint.
 *
 * ⚠️ `localStorage` peut LEVER (navigation privée, stockage bloqué par le navigateur) : un réglage de
 * confort n'est jamais une raison de casser l'écran le plus utilisé du produit.
 */
export function lireTraductionActive(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(TRADUCTION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Range le réglage. Un échec d'écriture ne fait rien perdre d'autre que sa persistance. */
export function ecrireTraductionActive(actif: boolean): void {
  try {
    window.localStorage.setItem(TRADUCTION_STORAGE_KEY, actif ? '1' : '0');
  } catch {
    /* stockage indisponible : le réglage vaut pour la session en cours, et c'est tout */
  }
}

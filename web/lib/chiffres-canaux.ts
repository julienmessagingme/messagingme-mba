import type { Locale } from './locale';
import { fmtNum } from './format';

/**
 * LES CHIFFRES DES CARTES DE L'ACCUEIL (demande de Julien du 2026-09-25), en décisions pures.
 *
 * Trois chiffres : envoyés et reçus sur WhatsApp, les mêmes en RCS (route `GET /accueil/volumes`), le nombre de
 * publications de la chaîne ; plus un quatrième dans le cadre de l'agent de Meta, les messages qu'il a écrits
 * (route `GET /mba/:pn/messages`, déjà affichée dans MBA > Paramètres).
 *
 * 🔴 PAS DE CHIFFRE PLUTÔT QU'UN ZÉRO INVENTÉ, partout ici. Vercel publie la console au `git push`, l'API attend
 * son déploiement : pendant cette fenêtre la route rend un 404, et le support e2e rend `{}` à tout ce qu'il ne
 * connaît pas. Chaque lecture rend donc `null` sur une forme inattendue, et chaque phrase rend `null` sur
 * `null`. Un « 0 envoyé » dirait que le numéro n'a servi à rien, ce que personne n'a mesuré.
 */

export interface Volume {
  envoyes: number;
  recus: number;
}

export interface VolumesCanaux {
  jours: number;
  /** `null` = ce canal manque ou a une forme inattendue dans la réponse : sa carte n'affiche pas de chiffre. */
  whatsapp: Volume | null;
  rcs: Volume | null;
}

const entierPositif = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function lireVolume(v: unknown): Volume | null {
  if (v === null || typeof v !== 'object') return null;
  const { envoyes, recus } = v as { envoyes?: unknown; recus?: unknown };
  return entierPositif(envoyes) && entierPositif(recus) ? { envoyes, recus } : null;
}

/**
 * La réponse de `GET /accueil/volumes`, ou `null`. Chaque canal est lu SÉPARÉMENT : un canal mal formé ne
 * retire pas le chiffre de l'autre. Sans fenêtre lisible, rien n'est lu, parce que la phrase la cite.
 */
export function lireVolumesCanaux(r: unknown): VolumesCanaux | null {
  if (r === null || typeof r !== 'object') return null;
  const { jours, whatsapp, rcs } = r as { jours?: unknown; whatsapp?: unknown; rcs?: unknown };
  if (!entierPositif(jours) || jours === 0) return null;
  const v = { jours, whatsapp: lireVolume(whatsapp), rcs: lireVolume(rcs) };
  return v.whatsapp === null && v.rcs === null ? null : v;
}

/** Le pluriel français : 0 et 1 au singulier, à partir de 2 au pluriel. */
const accord = (n: number, singulier: string, pluriel: string): string => (n >= 2 ? pluriel : singulier);

/** « 1 234 envoyés · 567 reçus (30 j) », ou `null` quand on ne sait pas. */
export function phraseVolume(v: Volume | null, jours: number, locale: Locale): string | null {
  if (v === null) return null;
  const e = fmtNum(v.envoyes, locale);
  const r = fmtNum(v.recus, locale);
  return locale === 'en'
    ? `${e} sent · ${r} received (${jours} d)`
    : `${e} ${accord(v.envoyes, 'envoyé', 'envoyés')} · ${r} ${accord(v.recus, 'reçu', 'reçus')} (${jours} j)`;
}

/**
 * « 3 publications au total », ou `null` quand on ne sait pas. « Au total », et pas « (30 j) » comme ses
 * voisines : `GET /channels-me/posts` rend TOUTES les publications de l'espace, sans fenêtre ni plafond.
 */
export function phrasePublications(n: number | null, locale: Locale): string | null {
  if (n === null) return null;
  const x = fmtNum(n, locale);
  return locale === 'en'
    ? `${x} ${n === 1 ? 'post' : 'posts'} in total`
    : `${x} ${accord(n, 'publication', 'publications')} au total`;
}

/**
 * L'agent de Meta RÉPOND-il, d'après ce que META a rendu (`GET /mba/:pn/status`) ? C'est la condition du
 * chiffre sous son cadre. 🔴 JAMAIS notre drapeau `mbaEnabled`, qui ne commande que le bloc MBA des scénarios :
 * c'est exactement la confusion corrigée sur l'Accueil le 2026-09-10. Statut non lu : `false`.
 */
export function agentMetaRepond(s: { eligible?: unknown; settings?: { rollout?: { enabled?: unknown } } | null } | null): boolean {
  return s !== null && s.eligible === true && s.settings?.rollout?.enabled === true;
}

/** Les messages des conversations qu'un agent IA a tenues, et la fenêtre sur laquelle le SERVEUR les a comptés. */
export interface MessagesTenus {
  messages: number;
  jours: number;
}

/**
 * Les messages ÉCRITS par l'agent de Meta, depuis toujours (Julien, 2026-09-25) : ni les réponses du client, ni
 * l'équipe, ni les campagnes, et aucune fenêtre. `mba: true` le distingue de `MessagesTenus` pour
 * `ChiffreMessagesTenus`, qui affiche les deux sous des libellés différents.
 */
export interface MessagesEcritsMba {
  mba: true;
  messages: number;
}

/** La réponse de `GET /mba/:pn/messages`, ou `null` : la route peut rendre `messages: null`, ou manquer. Jamais 0 inventé. */
export function lireMessagesMba(r: unknown): MessagesEcritsMba | null {
  if (r === null || typeof r !== 'object') return null;
  const { messages } = r as { messages?: unknown };
  return entierPositif(messages) ? { mba: true, messages } : null;
}

/**
 * La réponse de `GET /agents/:id/messages` (un agent IA), ou `null` : la route peut rendre `messages: null`, ou
 * manquer.
 *
 * 🔴 LA FENÊTRE EST LUE AVEC LE CHIFFRE, et sans fenêtre lisible rien n'est lu (relecture du 2026-09-25). La
 * légende (`ChiffreMessagesTenus`) écrivait « sur 30 jours » en dur alors que la réponse porte `jours` : changer
 * la fenêtre au serveur aurait laissé l'écran annoncer 30 jours sur un chiffre compté autrement.
 */
export function lireMessagesTenus(r: unknown): MessagesTenus | null {
  if (r === null || typeof r !== 'object') return null;
  const { messages, jours } = r as { messages?: unknown; jours?: unknown };
  return entierPositif(messages) && entierPositif(jours) && jours > 0 ? { messages, jours } : null;
}

/**
 * Le RELAIS du Meta Business Agent, sa moitié PURE (spec docs/superpowers/specs/2026-09-21-relais-mba-design.md).
 *
 * 🔴 POURQUOI UN RELAIS. Meta appelle le système du client en direct et ne lit pas notre mini-CRM : il ne
 * remplit une valeur que par son modèle, une constante ou trois macros. Un outil qui envoie un champ du
 * contact (`tag_ns` chez UChat) était donc impossible, et l'outil `add_tag` de Julien est parti chez Meta
 * sans son corps le 2026-09-21. Meta nous appelle désormais, et nous faisons l'appel déclaré dans Tools >
 * Connecteurs API, avec les gardes et le journal d'un agent IA. La route vit dans `src/http/mba-relais.ts`.
 */

import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import type { VariableDeclaree } from '../agent/requetes';

/**
 * L'en-tête que Meta remplit avec la macro `WHATSAPP_PHONE_NUMBER`. Publié sous ce nom, lu en minuscules
 * (Fastify normalise les en-têtes).
 */
export const ENTETE_CONTACT_META = 'X-Contact-WhatsApp';

/**
 * L'ADRESSE DU RELAIS, EN UN SEUL ENDROIT. Elle s'assemble en trois morceaux : la base du connecteur
 * (`baseDuRelais`, appelée par `src/index.ts`), le chemin de chaque outil (`cheminOutilRelais`, appelé par
 * `src/mba/publication.ts`) et la route montée (`src/http/mba-relais.ts`). Écrits trois fois, un seul qui
 * change envoie chaque appel de Meta sur une 404 sans qu'aucun test ne tombe : `tests/http-mba-relais.test.ts`
 * recolle les trois, en passant par ces deux fonctions.
 */
export const CHEMIN_RELAIS = '/mba/relais';

/** La base du connecteur chez Meta, depuis `PUBLIC_API_URL`. `null` = adresse publique non réglée. */
export function baseDuRelais(publicApiUrl: string): string | null {
  const base = publicApiUrl.trim().replace(/[/]+$/, '');
  return base === '' ? null : `${base}${CHEMIN_RELAIS}`;
}

/** Le chemin d'un outil, relatif à la base du connecteur chez Meta. */
export function cheminOutilRelais(outilId: string): string {
  return `/outils/${outilId}`;
}

/**
 * Le corps BRUT reçu est-il un JSON illisible ?
 *
 * ⚠️ LE LECTEUR DE JSON DU SERVEUR REND `{}` SUR UN JSON INVALIDE (celui du webhook Meta, monté pour tout le
 * serveur, `src/webhooks/receiver.ts`) : sans cette vérification, un corps tronqué passait pour un corps vide,
 * et l'appel partait sans les valeurs facultatives, sans aucun signal. Un corps VIDE, lui, est légitime :
 * c'est celui d'un outil dont toutes les valeurs viennent du mini-CRM.
 *
 * ⚠️ LE MÊME LECTEUR QUE LE SERVEUR (`secure-json-parse`, mêmes options) : un `JSON.parse` jugeait illisible
 * un corps que le serveur lit sans erreur (un corps précédé d'un BOM), et le relais le refusait à tort.
 */
export function corpsIllisible(brut: unknown): boolean {
  if (!(brut instanceof Uint8Array) || brut.length === 0) return false;
  try {
    secureJsonParse(Buffer.from(brut).toString('utf8'), { protoAction: 'remove', constructorAction: 'remove' });
    return false;
  } catch {
    return true;
  }
}

/**
 * Le numéro rempli par Meta, ramené à ce que `getContactStateByWaId` sait chercher.
 *
 * ⚠️ SON FORMAT N'EST PAS DOCUMENTÉ (avec ou sans `+` ?) : on accepte les deux, et la recherche de contact
 * sait déjà trouver `+33...`, `33...` et un BSUID. Une valeur qui n'a pas la forme d'un numéro est gardée
 * telle quelle, bornée : c'est peut-être l'identifiant d'un client qui n'a qu'un nom d'utilisateur.
 */
export function waIdDepuisEntete(brut: unknown): string | null {
  if (typeof brut !== 'string') return null;
  const v = brut.trim();
  if (v === '') return null;
  if (/^[0-9+ ()-]+$/.test(v)) {
    const chiffres = v.replace(/[^0-9]/g, '');
    return chiffres.length >= 7 && chiffres.length <= 15 ? chiffres : null;
  }
  return v.length <= 128 ? v : null;
}

/**
 * La FORME de l'en-tête, jamais sa valeur : ce qu'on journalise tant que le format réel de la macro n'est
 * pas mesuré. Un numéro de téléphone dans un journal range une donnée personnelle là où personne ne la cherche.
 */
export function formeEntete(brut: unknown): string {
  if (typeof brut !== 'string') return 'absent';
  const v = brut.trim();
  const sansPlus = v.startsWith('+') ? v.slice(1) : v;
  return `len=${v.length} plus=${v.startsWith('+')} chiffres=${/^[0-9]+$/.test(sansPlus)}`;
}

/**
 * Le schéma d'UNE variable du modèle. ⚠️ LES VALEURS PERMISES VALENT AUSSI POUR UN NOMBRE : l'écran d'une
 * requête accepte une liste sur `integer` et `number` (`src/http/agent-requetes.ts`), et la description
 * publiée chez Meta l'annonce. Elles sont stockées en TEXTE mais comparées en NOMBRE : « 1.0 » saisi à
 * l'écran doit accepter le `1` que le modèle envoie.
 */
function schemaVariable(v: VariableDeclaree): z.ZodType<unknown> {
  const permises = v.enum && v.enum.length > 0 ? v.enum : null;
  if (v.type === 'string') {
    return permises ? z.enum(permises as [string, ...string[]]) : z.string().max(2000);
  }
  if (v.type === 'integer' || v.type === 'number') {
    const base = v.type === 'integer' ? z.number().int() : z.number();
    return permises ? base.refine((n) => permises.some((p) => Number(p) === n)) : base;
  }
  return z.boolean();
}

/**
 * Les valeurs que le modèle de Meta envoie, validées contre les variables `modele` DÉCLARÉES.
 *
 * 🔴 SEULES LES VARIABLES `modele` SONT LUES. Une variable `champ` ou `contact` vient du mini-CRM : si le
 * modèle pouvait l'imposer, il enverrait l'étiquette ou l'identifiant de son choix au système du client.
 * Toute autre clé du corps est ignorée.
 */
export function lireValeursModele(
  variables: readonly VariableDeclaree[],
  corps: unknown,
): { ok: true; valeurs: Record<string, unknown> } | { ok: false; erreur: string } {
  const modele = variables.filter((v) => v.origine.type === 'modele');
  const brut = corps === undefined || corps === null ? {} : corps;
  if (typeof brut !== 'object' || Array.isArray(brut)) {
    return { ok: false, erreur: 'le corps de la requête doit être un objet JSON' };
  }
  const forme: Record<string, z.ZodType<unknown>> = {};
  for (const v of modele) forme[v.nom] = v.requis === true ? schemaVariable(v) : schemaVariable(v).nullish();
  const r = z.object(forme).safeParse(brut);
  if (!r.success) {
    const noms = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')))].filter((n) => n !== '').sort();
    return { ok: false, erreur: `valeur manquante ou invalide pour : ${noms.join(', ')}` };
  }
  const valeurs: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(r.data)) if (val !== undefined && val !== null) valeurs[k] = val;
  return { ok: true, valeurs };
}

/** Le message d'échec rendu à Meta : celui, SÛR, que le point de passage a déjà écrit pour un modèle. */
export function texteErreur(contenu: unknown): string {
  if (contenu !== null && typeof contenu === 'object' && typeof (contenu as { erreur?: unknown }).erreur === 'string') {
    return (contenu as { erreur: string }).erreur;
  }
  return 'l’appel a échoué';
}

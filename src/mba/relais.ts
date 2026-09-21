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
import type { VariableDeclaree } from '../agent/requetes';

/**
 * L'en-tête que Meta remplit avec la macro `WHATSAPP_PHONE_NUMBER`. Publié sous ce nom, lu en minuscules
 * (Fastify normalise les en-têtes).
 */
export const ENTETE_CONTACT_META = 'X-Contact-WhatsApp';

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

function schemaVariable(v: VariableDeclaree): z.ZodType<unknown> {
  if (v.type === 'string') {
    return v.enum && v.enum.length > 0 ? z.enum(v.enum as [string, ...string[]]) : z.string().max(2000);
  }
  if (v.type === 'integer') return z.number().int();
  if (v.type === 'number') return z.number();
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

/**
 * Le relais du Meta Business Agent, sa moitié pure. Meta n'appelle pas le mini-CRM : il ne remplit une valeur
 * que par son modèle, une constante ou trois macros. Il nous appelle donc, et nous faisons l'appel déclaré dans
 * Tools > Connecteurs API, avec les gardes et le journal d'un agent IA. La route vit dans `src/http/mba-relais.ts`.
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
 * L'adresse du relais, en un seul endroit : la base du connecteur (`baseDuRelais`), le chemin de chaque outil
 * (`cheminOutilRelais`) et la route montée (`src/http/mba-relais.ts`). Un seul morceau qui change enverrait
 * chaque appel de Meta sur une 404 : `tests/http-mba-relais.test.ts` recolle les trois.
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
 * Le corps brut reçu est-il un JSON illisible ? Le lecteur JSON du serveur (celui du webhook Meta) rend `{}` sur
 * un JSON invalide : sans ce test, un corps tronqué passerait pour vide, et l'appel partirait sans ses valeurs.
 * Un corps vide est légitime. Même lecteur que le serveur (`secure-json-parse`, mêmes options), pour ne pas
 * refuser un corps qu'il lit (précédé d'un BOM, par exemple).
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
 * Le numéro rempli par Meta, ramené à ce que `getContactStateByWaId` sait chercher. Format non documenté (avec
 * ou sans `+`) : les deux sont acceptés. Une valeur qui n'a pas la forme d'un numéro est gardée telle quelle,
 * bornée (peut-être un client qui n'a qu'un nom d'utilisateur).
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
 * La forme de l'en-tête, jamais sa valeur : ce qu'on journalise tant que le format réel de la macro n'est
 * pas mesuré. Un numéro de téléphone dans un journal range une donnée personnelle là où personne ne la cherche.
 */
export function formeEntete(brut: unknown): string {
  if (typeof brut !== 'string') return 'absent';
  const v = brut.trim();
  const sansPlus = v.startsWith('+') ? v.slice(1) : v;
  return `len=${v.length} plus=${v.startsWith('+')} chiffres=${/^[0-9]+$/.test(sansPlus)}`;
}

/**
 * Le schéma d'une variable du modèle. Les valeurs permises valent aussi pour un nombre (l'écran d'une requête
 * accepte une liste sur `integer` et `number`) : stockées en texte, comparées en nombre, pour que « 1.0 » saisi
 * accepte le `1` envoyé par le modèle.
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
 * Les valeurs que le modèle de Meta envoie, validées contre les variables `modele` déclarées. 🔴 Seules
 * celles-là sont lues : une variable `champ` ou `contact` vient du mini-CRM, et si le modèle pouvait l'imposer,
 * il enverrait la valeur de son choix au système du client. Toute autre clé est ignorée.
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

/** Le message d'échec rendu à Meta : celui, sûr, que le point de passage a déjà écrit pour un modèle. */
export function texteErreur(contenu: unknown): string {
  if (contenu !== null && typeof contenu === 'object' && typeof (contenu as { erreur?: unknown }).erreur === 'string') {
    return (contenu as { erreur: string }).erreur;
  }
  return 'l’appel a échoué';
}

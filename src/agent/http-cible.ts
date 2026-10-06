import { urlRecuperable } from '../lib/page-distante';
import type { RisqueOutil } from './catalog';

/**
 * L'URL finale d'un appel de connecteur, et le risque qu'une méthode HTTP porte. Seul endroit où une URL de
 * connecteur se construit ; module pur (`tests/agent-http-cible.test.ts` l'éprouve garde par garde).
 *
 * 🔴 Le serveur vit dans le réseau Docker du VPS (admin NPM, autres conteneurs, métadonnées du fournisseur) :
 * une adresse mal contrôlée ferait d'un connecteur un lecteur de l'intérieur. Et une valeur de paramètre mal
 * encodée ferait du gabarit de chemin un IDOR, la valeur venant du modèle.
 */

/** Les méthodes acceptées, liste fermée : `CONNECT` et `TRACE` n'ont rien à faire sur un connecteur. */
export const METHODES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type MethodeConnecteur = (typeof METHODES)[number];

export interface CibleConstruite {
  ok: true;
  url: string;
  methode: MethodeConnecteur;
}
export interface CibleRefusee {
  ok: false;
  /** Lisible par le client (elle remonte dans la console) et par le modèle. Ne cite jamais un secret. */
  raison: string;
}

function estMethode(v: unknown): v is MethodeConnecteur {
  return typeof v === 'string' && (METHODES as readonly string[]).includes(v);
}

/**
 * Une valeur de paramètre utilisable dans un chemin. Objets et tableaux refusés : `String({})` produirait
 * `[object Object]`, un appel faux plutôt qu'un refus lisible.
 */
function valeurDeChemin(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** Découpe l'URL en segments non vides, pour vérifier que la cible reste sous la base, segment par segment. */
function segments(chemin: string): string[] {
  return chemin.split('/').filter((s) => s !== '');
}

/**
 * `{{ nom }}` (noms à points et tirets, comme dans le corps) ou `{nom}`. Expression `/g` partagée
 * (`requete-http.ts` l'inventorie) : `replace` et `matchAll` s'en accommodent, un `.test()` ou un `.exec()`
 * laisserait un `lastIndex` qui fausserait l'appelant suivant.
 */
export const VARIABLE_DE_CHEMIN = /\{\{\s*([\w.-]+)\s*\}\}|\{([a-zA-Z0-9_]+)\}/g;

/**
 * Construit l'URL finale, ou refuse en le disant. Quatre gardes, dans cet ordre, aucune facultative :
 *  1. l'adresse de base est HTTPS et passe `urlRecuperable` (pas d'hôte interne, pas de littéral privé) ;
 *  2. chaque `{{param}}` ou `{param}` est remplacé par une valeur encodée (sinon `/` change le chemin et `?`
 *     ajoute des paramètres), et une valeur `.` ou `..` est refusée, car `new URL` résout ces segments ;
 *  3. l'URL résultante reste sous l'adresse de base, même origine et même préfixe de segments (contre un `..`
 *     du gabarit, écrit par l'administrateur et jamais encodé) ;
 *  4. un paramètre absent est un refus, jamais un chemin à trou : `/commandes/` appellerait la liste entière.
 */
export function construireCible(input: {
  baseUrl: string;
  binding: { methode: string; chemin: string };
  args: Record<string, unknown>;
}): CibleConstruite | CibleRefusee {
  const { baseUrl, binding, args } = input;

  if (!estMethode(binding.methode)) return { ok: false, raison: `méthode non acceptée : ${String(binding.methode)}` };

  // 1. L'adresse de base. `urlRecuperable` est importée, pas recopiée : un durcissement appliqué d'un seul
  // côté serait silencieux.
  const brute = String(baseUrl ?? '').trim();
  if (!urlRecuperable(brute)) return { ok: false, raison: 'adresse de base refusée (elle doit être publique)' };
  let base: URL;
  try {
    base = new URL(brute);
  } catch {
    return { ok: false, raison: 'adresse de base illisible' };
  }
  // HTTPS seulement, sinon le secret voyagerait en clair. `urlRecuperable` accepte http (elle lit aussi des
  // pages publiques), c'est donc ici que la restriction se pose.
  if (base.protocol !== 'https:') return { ok: false, raison: 'adresse de base : HTTPS obligatoire' };

  // 2. Le gabarit, paramètre par paramètre. Une valeur manquante refuse. Les deux formes, `{nom}` et
  // `{{nom}}` : la double se lit en premier, sinon la simple mangerait l'accolade intérieure.
  let manquant: string | null = null;
  let pointe: string | null = null;
  const chemin = String(binding.chemin ?? '').trim().replace(VARIABLE_DE_CHEMIN, (_m, double: string | undefined, simple: string | undefined) => {
    const nom = (double ?? simple)!;
    const v = valeurDeChemin(args[nom]);
    if (v === null) { manquant = nom; return ''; }
    // `.` et `..` : un segment que `new URL` résout (garde 2).
    if (v === '.' || v === '..') { pointe = nom; return ''; }
    return encodeURIComponent(v);
  });
  if (manquant !== null) return { ok: false, raison: `paramètre « ${manquant} » manquant` };
  if (pointe !== null) return { ok: false, raison: `paramètre « ${pointe} » refusé : « . » et « .. » déplaceraient l’appel dans le chemin` };
  if (chemin === '') return { ok: false, raison: 'chemin vide' };
  // Un gabarit qui ressemble à une adresse (schéma explicite, ou `//hote`) est refusé plutôt que rattaché
  // en silence sous la base : c'est une faute de saisie, on la dit.
  if (/^[a-z][a-z0-9+.-]*:/i.test(chemin) || chemin.startsWith('//')) {
    // Le message dit le geste, pas seulement la règle : l'adresse de base est déjà déclarée sur le système.
    return {
      ok: false,
      raison: 'le chemin ne doit pas contenir d’adresse complète : l’adresse du système est déjà déclarée, '
        + 'ne gardez que ce qui la suit (par exemple « /subscriber/add-tag »)',
    };
  }

  // 3. La cible. `new URL(chemin, base)` résout les `..` du gabarit et une adresse absolue : la
  // comparaison de segments qui suit les rattrape.
  const cheminBase = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  let cible: URL;
  try {
    cible = new URL(chemin.replace(/^\/+/, ''), `${base.origin}${cheminBase}`);
  } catch {
    return { ok: false, raison: 'chemin illisible' };
  }
  if (cible.origin !== base.origin) return { ok: false, raison: 'le chemin sort de l’adresse de base' };
  const attendus = segments(base.pathname);
  const obtenus = segments(cible.pathname);
  if (obtenus.length < attendus.length || attendus.some((s, i) => obtenus[i] !== s)) {
    return { ok: false, raison: 'le chemin sort de l’adresse de base' };
  }

  return { ok: true, url: cible.toString(), methode: binding.methode };
}

/**
 * Les en-têtes d'authentification d'une source, construits en un seul endroit pour le résolveur et
 * l'épreuve de source : sinon l'épreuve dirait « ça répond » d'une source que les appels ne savent pas
 * authentifier. Le secret ne doit apparaître ni dans un journal, ni dans une erreur, ni chez le modèle.
 */
export function enTetesAuthSource(source: {
  authKind: 'none' | 'bearer' | 'header'; authSecret: string | null; authHeaderName: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (source.authKind === 'bearer' && source.authSecret) headers.authorization = `Bearer ${source.authSecret}`;
  // 🔴 En minuscules, comme `assemblerAppel` range ceux de la requête : sinon `x-api-key` (requête) et
  // `X-Api-Key` (source) sont deux clés, et `Headers` les fusionne (« valeur, secret »), la première
  // moitié pouvant venir du modèle.
  if (source.authKind === 'header' && source.authSecret && source.authHeaderName) headers[source.authHeaderName.toLowerCase()] = source.authSecret;
  return headers;
}

/**
 * Le risque qu'une méthode porte, dérivé et non déclaré : un client qui marquerait `read` un `DELETE`
 * désarmerait la garde d'autonomie sur une action irréversible. Il peut monter le risque, jamais le
 * descendre.
 */
export function risqueSelonMethode(methode: MethodeConnecteur): RisqueOutil {
  if (methode === 'GET') return 'read';
  if (methode === 'DELETE') return 'irreversible';
  return 'write';
}

const ECHELLE: Record<RisqueOutil, number> = { read: 0, write: 1, irreversible: 2 };

/** `declare` est-il au moins aussi prudent que `plancher` ? */
export function risqueAuMoins(plancher: RisqueOutil, declare: RisqueOutil): boolean {
  return ECHELLE[declare] >= ECHELLE[plancher];
}

/** Les risques sous `plancher` : ceux que les outils d'une requête passée à cette méthode montent au plancher. */
export function risquesSous(plancher: RisqueOutil): RisqueOutil[] {
  return (Object.keys(ECHELLE) as RisqueOutil[]).filter((r) => !risqueAuMoins(plancher, r));
}

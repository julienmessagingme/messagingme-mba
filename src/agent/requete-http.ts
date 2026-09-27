/**
 * Le corps, les paramètres d'URL et les en-têtes d'un appel de connecteur, construits à partir de gabarits à
 * variables (le chemin se remplit dans `http-cible.ts`).
 *
 * 🔴 Le gabarit de corps est du JSON valide, et la substitution est structurelle, jamais textuelle : on parse,
 * on remplace dans l'arbre, on ré-encode. Une valeur peut venir du modèle ou de la dernière phrase du contact
 * (`Paris", "admin": true`) : en substitution textuelle, elle ajouterait des champs au corps. Ici elle ne
 * devient jamais de la structure. Le prix : ni clé dynamique ni tableau de longueur variable.
 */

import { VARIABLE_DE_CHEMIN } from './http-cible';

/** Variables nommées `{{ville}}`. Même motif que l'éditeur de la console (`web/components/VariableBodyEditor`),
 *  pour que ce qui s'écrit à l'écran soit exactement ce qui se substitue ici. */
const VARIABLE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Une chaîne qui n'est que `{{ville}}`, sans rien autour : c'est elle qui prend la valeur typée. */
const VARIABLE_SEULE = /^\{\{\s*([\w.-]+)\s*\}\}$/;

export type ValeurVariable = string | number | boolean | null;

export interface CorpsConstruit {
  ok: true;
  /** Le corps sérialisé, prêt à partir. `null` quand le connecteur n'en envoie pas. */
  corps: string | null;
}
export interface CorpsRefuse {
  ok: false;
  /** Lisible par le client (elle remonte dans la console). Ne cite jamais un secret. */
  raison: string;
}

/**
 * Remplace les variables dans une valeur de l'arbre JSON. Une chaîne qui vaut exactement `{{ville}}` prend
 * la valeur avec son type (`{"n": 42}` et non `"42"`, la différence entre une API qui répond et un 400).
 * Une variable parmi du texte est interpolée ; absente, elle y devient vide plutôt que le littéral.
 */
function substituer(noeud: unknown, valeurs: Readonly<Record<string, ValeurVariable>>, manquantes: Set<string>): unknown {
  if (typeof noeud === 'string') {
    const seule = VARIABLE_SEULE.exec(noeud);
    if (seule) {
      const nom = seule[1]!;
      if (!(nom in valeurs)) { manquantes.add(nom); return null; }
      return valeurs[nom] ?? null;
    }
    VARIABLE.lastIndex = 0;
    return noeud.replace(VARIABLE, (_m, nom: string) => {
      if (!(nom in valeurs)) { manquantes.add(nom); return ''; }
      const v = valeurs[nom];
      return v === null || v === undefined ? '' : String(v);
    });
  }
  if (Array.isArray(noeud)) return noeud.map((n) => substituer(n, valeurs, manquantes));
  if (noeud !== null && typeof noeud === 'object') {
    const out: Record<string, unknown> = {};
    // Les clés ne sont pas substituées : une clé variable ferait dépendre la forme du corps d'un texte que
    // le contact influence.
    for (const [cle, v] of Object.entries(noeud as Record<string, unknown>)) out[cle] = substituer(v, valeurs, manquantes);
    return out;
  }
  return noeud;
}

/** Une ligne du mode « liste de champs » : une clé, et un gabarit de valeur. */
export interface ChampCorps {
  cle: string;
  /** Du texte, éventuellement à variables (`{{ville}}`), exactement comme une valeur de paramètre d'URL. */
  valeur: string;
}

/**
 * Comment le corps est saisi : JSON brut, ou liste de champs. Deux saisies, un seul moteur : le mode `champs`
 * est compilé vers le même arbre que le mode `json`, puis les deux passent par `substituer`, pour qu'ils ne
 * divergent jamais.
 */
export type GabaritCorps =
  | { mode: 'aucun' }
  | { mode: 'json'; gabarit: string }
  | { mode: 'champs'; champs: readonly ChampCorps[] };

/**
 * Construit le corps d'un appel. Un gabarit illisible est un refus, jamais un corps vide envoyé quand même :
 * le client peut corriger son gabarit dans sa console.
 */
export function construireCorps(
  gabarit: GabaritCorps,
  valeurs: Readonly<Record<string, ValeurVariable>>,
): CorpsConstruit | CorpsRefuse {
  let arbre: unknown;

  if (gabarit.mode === 'aucun') return { ok: true, corps: null };

  if (gabarit.mode === 'champs') {
    // Une ligne sans clé est une ligne pas remplie, pas une erreur : même règle que les paramètres d'URL.
    const lignes = gabarit.champs.filter((c) => c.cle.trim() !== '');
    if (lignes.length === 0) return { ok: true, corps: null };
    const objet: Record<string, unknown> = {};
    for (const c of lignes) objet[c.cle.trim()] = c.valeur;
    arbre = objet;
  } else {
    const brut = gabarit.gabarit.trim();
    if (brut === '') return { ok: true, corps: null };
    try {
      arbre = JSON.parse(brut);
    } catch {
      return { ok: false, raison: 'le corps de la requête n’est pas du JSON valide' };
    }
  }

  const manquantes = new Set<string>();
  const rempli = substituer(arbre, valeurs, manquantes);
  if (manquantes.size > 0) {
    // Toutes les manquantes d'un coup, pour ne pas faire corriger le connecteur une variable à la fois.
    return { ok: false, raison: `variable(s) sans valeur dans le corps : ${[...manquantes].sort().join(', ')}` };
  }
  return { ok: true, corps: JSON.stringify(rempli) };
}

export interface ParametreUrl {
  cle: string;
  /** Gabarit de valeur : du texte, éventuellement à variables (`{{ville}}`). */
  valeur: string;
}

/** Un en-tête supplémentaire de la requête. Voir `EN_TETES_RESERVES` pour ce qui n'a rien à faire ici. */
export interface EnTete {
  nom: string;
  valeur: string;
}

/**
 * Les en-têtes que le client ne peut pas poser lui-même sur une requête.
 *
 * 🔴 `authorization` : l'authentification vit sur la source, chiffrée, et `enTetesAuthSource` en est l'unique
 * point de passage. La laisser saisir ici ferait un second chemin qui stocke le secret en clair dans la
 * configuration de la requête. `content-type` : posé d'après ce qui part réellement. `host` et
 * `content-length` décrivent le transport.
 */
export const EN_TETES_RESERVES = ['authorization', 'content-type', 'content-length', 'host'] as const;

export function estEnTeteReserve(nom: string): boolean {
  return (EN_TETES_RESERVES as readonly string[]).includes(nom.trim().toLowerCase());
}

/**
 * Construit la chaîne de requête (`?ville=Paris&depuis=2026-01-01`). `URLSearchParams` encode chaque valeur :
 * un `&` ou un `=` ne peut pas ajouter de paramètre. Une valeur vide après substitution est omise : beaucoup
 * d'API lisent `?ville=` comme un filtre sur la chaîne vide, donc zéro résultat.
 */
export function construireParametres(
  parametres: readonly ParametreUrl[] | null | undefined,
  valeurs: Readonly<Record<string, ValeurVariable>>,
): { ok: true; query: string } | CorpsRefuse {
  const liste = parametres ?? [];
  if (liste.length === 0) return { ok: true, query: '' };

  const sp = new URLSearchParams();
  const manquantes = new Set<string>();
  for (const p of liste) {
    const cle = p.cle.trim();
    if (cle === '') continue; // une ligne vide de l'écran n'est pas une erreur, c'est une ligne pas remplie
    VARIABLE.lastIndex = 0;
    const valeur = p.valeur.replace(VARIABLE, (_m, nom: string) => {
      if (!(nom in valeurs)) { manquantes.add(nom); return ''; }
      const v = valeurs[nom];
      return v === null || v === undefined ? '' : String(v);
    });
    if (valeur !== '') sp.set(cle, valeur);
  }
  if (manquantes.size > 0) {
    return { ok: false, raison: `variable(s) sans valeur dans les paramètres d’URL : ${[...manquantes].sort().join(', ')}` };
  }
  const query = sp.toString();
  return { ok: true, query };
}

/**
 * L'appel complet (adresse, méthode, en-têtes, corps), point de passage unique de l'exécution réelle et du
 * bouton « Test », pour que le test ne dise jamais « ça marche » d'un appel que l'exécution ne sait pas faire.
 *
 * L'authentification n'est pas ici : l'appelant superpose les en-têtes de la source en dernier, pour
 * qu'aucun en-tête saisi ne puisse la recouvrir, même si la garde de la route tombe.
 */
export function assemblerAppel(input: {
  baseUrl: string;
  methode: string;
  chemin: string;
  parametres?: readonly ParametreUrl[] | null;
  entetes?: readonly EnTete[] | null;
  corps: GabaritCorps;
  valeurs: Readonly<Record<string, ValeurVariable>>;
  /** Injectée pour tester la garde d'adresse sans dupliquer ses cas ici. */
  construireCible: (i: { baseUrl: string; binding: { methode: string; chemin: string }; args: Record<string, unknown> })
  => { ok: true; url: string; methode: string } | { ok: false; raison: string };
}): { ok: true; url: string; methode: string; entetes: Record<string, string>; corps: string | null } | CorpsRefuse {
  // 1. L'adresse, avec toutes ses gardes (HTTPS, hôte public, cible sous la base), avant le reste.
  const cible = input.construireCible({
    baseUrl: input.baseUrl,
    binding: { methode: input.methode, chemin: input.chemin },
    args: input.valeurs as Record<string, unknown>,
  });
  if (!cible.ok) return { ok: false, raison: cible.raison };

  // 2. Les paramètres d'URL.
  const q = construireParametres(input.parametres, input.valeurs);
  if (!q.ok) return q;
  const url = q.query === '' ? cible.url : `${cible.url}${cible.url.includes('?') ? '&' : '?'}${q.query}`;

  // 3. Le corps.
  const c = construireCorps(input.corps, input.valeurs);
  if (!c.ok) return c;

  // 4. Les en-têtes. Un en-tête réservé est ignoré (la route le refuse déjà : deux gardes sur un chemin qui
  // porte un secret). Substitués comme les paramètres d'URL. 🔴 Une valeur à retour à la ligne est refusée :
  // elle fabriquerait un second en-tête (injection), et elle peut venir du modèle.
  const entetes: Record<string, string> = { accept: 'application/json' };
  const manquantes = new Set<string>();
  for (const e of input.entetes ?? []) {
    const nom = e.nom.trim().toLowerCase();
    if (nom === '' || estEnTeteReserve(nom)) continue;
    VARIABLE.lastIndex = 0;
    const valeur = e.valeur.replace(VARIABLE, (_m, v: string) => {
      if (!(v in input.valeurs)) { manquantes.add(v); return ''; }
      const x = input.valeurs[v];
      return x === null || x === undefined ? '' : String(x);
    });
    if (/[\r\n]/.test(valeur)) return { ok: false, raison: `l’en-tête « ${e.nom.trim()} » contiendrait un retour à la ligne : il n’est pas envoyé` };
    // Et tout ce qu'un en-tête ne peut pas porter (au-delà de 0xFF, ou de contrôle) : `fetch` lèverait à
    // l'appel, et l'erreur passerait pour une panne réseau de la source.
    if (/[^\t\x20-\x7e\x80-\xff]/.test(valeur)) {
      return { ok: false, raison: `l’en-tête « ${e.nom.trim()} » contiendrait un caractère qu’un en-tête ne peut pas porter (apostrophe typographique, emoji…) : il n’est pas envoyé` };
    }
    // Vide après substitution : omis, comme un paramètre d'URL (un en-tête vide fait répondre 400 à
    // certaines API).
    if (valeur !== '') entetes[nom] = valeur;
  }
  if (manquantes.size > 0) {
    return { ok: false, raison: `variable(s) sans valeur dans les en-têtes : ${[...manquantes].sort().join(', ')}` };
  }
  // Posé d'après ce qui part réellement : annoncer un corps qu'on n'envoie pas fait répondre 400 à certaines
  // API.
  if (c.corps !== null) entetes['content-type'] = 'application/json';

  return { ok: true, url, methode: cible.methode, entetes, corps: c.corps };
}

/**
 * Les chemins lisibles d'une réponse, que l'écran propose à cocher après un test au lieu de faire écrire
 * `livraison.date` de tête. N'offre que ce que l'extracteur sait résoudre : il ne descend pas dans les
 * tableaux, donc un tableau est proposé entier (un `commandes.0.total` cochable ne rendrait jamais rien).
 * Borné en profondeur et en nombre.
 */
export function cheminsDeLaReponse(valeur: unknown, max = 200, profondeurMax = 5): string[] {
  const out: string[] = [];
  const marcher = (n: unknown, prefixe: string, profondeur: number): void => {
    if (out.length >= max) return;
    // Un tableau est une feuille : voir ci-dessus.
    if (n !== null && typeof n === 'object' && !Array.isArray(n) && profondeur < profondeurMax) {
      const entrees = Object.entries(n as Record<string, unknown>);
      if (entrees.length === 0 && prefixe !== '') out.push(prefixe);
      for (const [cle, v] of entrees) {
        // Une clé contenant un point casserait la notation (`a.b` désignerait deux niveaux) : omise.
        if (cle.includes('.')) continue;
        marcher(v, prefixe === '' ? cle : `${prefixe}.${cle}`, profondeur + 1);
      }
      return;
    }
    if (prefixe !== '') out.push(prefixe);
  };
  marcher(valeur, '', 0);
  return out;
}

/**
 * Les noms de variables qu'un gabarit réclame : pour signaler une variable non déclarée avant l'envoi, et
 * pour annoncer au client ce qui partira. Balaye le corps (les deux modes), les paramètres d'URL, le chemin
 * et les en-têtes : en oublier un ferait mentir la liste.
 */
export function variablesUtilisees(
  corps: GabaritCorps,
  parametres: readonly ParametreUrl[] | null | undefined,
  chemin?: string,
  entetes?: readonly EnTete[] | null,
): string[] {
  const vues = new Set<string>();
  const balayer = (s: string): void => {
    VARIABLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VARIABLE.exec(s)) !== null) vues.add(m[1]!);
  };
  if (corps.mode === 'json') balayer(corps.gabarit);
  if (corps.mode === 'champs') for (const c of corps.champs) balayer(c.valeur);
  for (const p of parametres ?? []) balayer(p.valeur);
  for (const e of entetes ?? []) balayer(e.valeur);
  // Le chemin admet `{{nom}}` et `{nom}` : la même expression que la substitution (`http-cible.ts`).
  VARIABLE_DE_CHEMIN.lastIndex = 0; // `matchAll` recopie le `lastIndex` de l'expression partagée
  for (const m of (chemin ?? '').matchAll(VARIABLE_DE_CHEMIN)) vues.add((m[1] ?? m[2])!);
  return [...vues].sort();
}

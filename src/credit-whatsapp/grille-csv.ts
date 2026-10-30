import { CATEGORIES_META, normaliserCategorie, type CategorieMeta, type TarifGrille } from './grille';
import { marcheDuNom } from './marches-meta';

/**
 * LA LECTURE DU FICHIER DE TARIFS EN EUROS QUE META PUBLIE (« EUR list rates », CSV), chargé par Julien dans `/ops`.
 *
 * La forme n'est pas documentée par Meta : la lecture cherche ses colonnes par leur titre (« Market », une colonne par
 * catégorie, « Currency » si elle existe), accepte la virgule ou le point décimal et un symbole d'euro, et laisse vide
 * une case sans tarif (l'authentification internationale ne vaut que pour certains marchés). Elle REFUSE plutôt que de
 * deviner : un marché inconnu, une devise autre que l'euro, un prix illisible ou un marché indispensable absent nomment la
 * ligne fautive. Une grille fausse enregistrée ferait payer les clients au mauvais prix sans que rien ne le dise.
 */
export type LectureGrille = { ok: true; tarifs: TarifGrille[] } | { ok: false; erreur: string };

/** Les marchés sans lesquels la grille ne sert à rien : nos clients écrivent en France, et tout le reste retombe sur Other. */
const INDISPENSABLES: ReadonlyArray<[string, CategorieMeta]> = [
  ['FR', 'marketing'], ['FR', 'utility'], ['FR', 'authentication'], ['FR', 'service'],
  ['other', 'marketing'], ['other', 'utility'], ['other', 'authentication'], ['other', 'service'],
];

/** Une ligne de CSV, guillemets compris (un nom de marché peut porter une virgule entre guillemets). */
function cellules(ligne: string, separateur: string): string[] {
  const sortie: string[] = [];
  let courant = '';
  let entreGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i]!;
    if (c === '"') {
      if (entreGuillemets && ligne[i + 1] === '"') { courant += '"'; i++; } else entreGuillemets = !entreGuillemets;
    } else if (c === separateur && !entreGuillemets) {
      sortie.push(courant.trim());
      courant = '';
    } else {
      courant += c;
    }
  }
  sortie.push(courant.trim());
  return sortie;
}

/** Un prix du fichier, en micro-euros, ou `null` pour une case vide ; `NaN` pour un prix illisible. */
function prixDe(brut: string): number | null {
  const t = brut.replace(/€|eur/gi, '').replace(/\s/g, '').replace(',', '.');
  if (t === '' || t === '-' || /^n\/?a$/i.test(t)) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 1_000_000);
}

export function lireGrilleCsv(texte: string): LectureGrille {
  const lignes = texte.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  // L'en-tête : la première ligne qui nomme le marché (le fichier peut commencer par un titre).
  const iEntete = lignes.findIndex((l) => /(^|[,;"\s])market([,;"\s]|$)/i.test(l));
  if (iEntete < 0) return { ok: false, erreur: 'colonne « Market » introuvable : ce n’est pas le fichier de tarifs de Meta' };
  const separateur = (lignes[iEntete]!.match(/;/g)?.length ?? 0) > (lignes[iEntete]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const entete = cellules(lignes[iEntete]!, separateur);
  const colMarche = entete.findIndex((c) => /^market$/i.test(c));
  if (colMarche < 0) return { ok: false, erreur: 'colonne « Market » introuvable : ce n’est pas le fichier de tarifs de Meta' };
  const colDevise = entete.findIndex((c) => /^currency$/i.test(c));
  const colonnes = new Map<number, CategorieMeta>();
  entete.forEach((titre, i) => {
    const c = normaliserCategorie(titre);
    if (c !== null) colonnes.set(i, c);
  });
  const manquantes = CATEGORIES_META.filter((c) => c !== 'authentication_international' && ![...colonnes.values()].includes(c));
  if (manquantes.length > 0) return { ok: false, erreur: `colonne(s) absente(s) : ${manquantes.join(', ')}` };

  const tarifs: TarifGrille[] = [];
  const vus = new Set<string>();
  for (let n = iEntete + 1; n < lignes.length; n++) {
    const ligne = cellules(lignes[n]!, separateur);
    const nom = ligne[colMarche] ?? '';
    if (nom === '') continue;
    const marche = marcheDuNom(nom);
    if (marche === null) return { ok: false, erreur: `ligne ${n + 1} : marché inconnu « ${nom} » (la liste des marchés de Meta a changé ?)` };
    if (vus.has(marche)) return { ok: false, erreur: `ligne ${n + 1} : marché « ${nom} » en double` };
    vus.add(marche);
    if (colDevise >= 0 && (ligne[colDevise] ?? '').toUpperCase() !== 'EUR') {
      return { ok: false, erreur: `ligne ${n + 1} : devise « ${ligne[colDevise] ?? ''} », le fichier attendu est celui en euros` };
    }
    for (const [i, categorie] of colonnes) {
      const prix = prixDe(ligne[i] ?? '');
      if (prix === null) continue;
      if (Number.isNaN(prix)) return { ok: false, erreur: `ligne ${n + 1} : prix illisible « ${ligne[i] ?? ''} » (${nom}, ${categorie})` };
      tarifs.push({ marche, categorie, palier: 0, prixMicroEur: prix });
    }
  }
  for (const [marche, categorie] of INDISPENSABLES) {
    if (!tarifs.some((t) => t.marche === marche && t.categorie === categorie)) {
      return { ok: false, erreur: `tarif absent : ${marche === 'other' ? 'Other' : marche}, ${categorie}` };
    }
  }
  return { ok: true, tarifs };
}

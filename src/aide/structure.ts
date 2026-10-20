/**
 * LA STRUCTURE D'UNE FICHE DU MODE D'EMPLOI (plan du centre d'aide, 2026-10-20, tâche 1).
 *
 * La fiche est la SEULE source : le bot d'aide la lit, et les pages publiques du centre d'aide en sont générées. Ce
 * module dit ce qu'elle contient, pour les deux : le chargeur du bot découpe par étape (`decouperFiche`), le générateur
 * de la vitrine écrit une étape par bloc. Il ne juge rien et ne lève jamais : `structureFiche` passe sur les 31 fiches,
 * publiques ou non. Le jugement est dans `erreursDeStructure`, que les tests appliquent aux fiches publiques.
 *
 * La grammaire : des blocs séparés par une ligne vide (paragraphe, liste de lignes `- `, intertitre `## `). Le premier
 * paragraphe est le CHAPEAU. Une ÉTAPE est un paragraphe qui commence par `**N. Titre.**` ; elle possède les blocs qui
 * la suivent jusqu'à l'étape suivante, un encadré ou un intertitre. Un ENCADRÉ commence par `**Bon à savoir.**`
 * (`**Good to know.**` en anglais). En ligne, seul le gras existe.
 */

export type LangueFiche = 'fr' | 'en';

export type BlocFiche = { type: 'paragraphe'; texte: string } | { type: 'liste'; items: string[] };

export type SectionFiche =
  | { type: 'prose'; titre: string | null; blocs: BlocFiche[] }
  | { type: 'etape'; numero: number; titre: string; tete: string; detail: BlocFiche[] }
  | { type: 'encadre'; texte: string };

export interface StructureFiche {
  chapeau: string;
  sections: SectionFiche[];
}

/** Le chapeau s'affiche dans la une de la page : au-delà, il devient un paragraphe. */
export const CHAPEAU_MAX = 320;
/** La tête d'une étape s'affiche à côté de sa capture, en deux ou trois lignes ; le reste se replie. */
export const TETE_MAX = 400;

/** Le marqueur d'un encadré, par langue. */
export const ENCADRE: Readonly<Record<LangueFiche, string>> = { fr: '**Bon à savoir.**', en: '**Good to know.**' };

/** Un bloc réécrit en Markdown, tel que la fiche l'écrirait (le découpage du bot en recompose ses morceaux). */
export const texteBloc = (b: BlocFiche): string =>
  b.type === 'paragraphe' ? b.texte : b.items.map((i) => `- ${i}`).join('\n');
/** `**3. Le contenu.** suite` : le numéro, le titre sans son point, puis la tête. */
const MARQUEUR = /^\*\*(\d+)\. ([^*]+?)\.\*\*(?:\s+(.*))?$/;

type BlocBrut = { type: 'titre'; texte: string } | BlocFiche;

/** Une ligne coupée se recolle d'une espace : la fiche est écrite à 120 colonnes, la page et le modèle la lisent d'un trait. */
const recoller = (lignes: string[]): string => lignes.map((l) => l.trim()).filter((l) => l !== '').join(' ');

/** Les blocs d'un corps : intertitres, paragraphes et listes, dans l'ordre. */
function blocs(corps: string): BlocBrut[] {
  const out: BlocBrut[] = [];
  for (const bloc of corps.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/)) {
    const lignes = bloc.split('\n').filter((l) => l.trim() !== '');
    if (lignes.length === 0) continue;
    if (/^## /.test(lignes[0]!)) {
      out.push({ type: 'titre', texte: lignes[0]!.slice(3).trim() });
      lignes.shift();
      if (lignes.length === 0) continue;
    }
    const debutListe = lignes.findIndex((l) => /^- /.test(l));
    if (debutListe < 0) {
      out.push({ type: 'paragraphe', texte: recoller(lignes) });
      continue;
    }
    if (debutListe > 0) out.push({ type: 'paragraphe', texte: recoller(lignes.slice(0, debutListe)) });
    const items: string[][] = [];
    for (const l of lignes.slice(debutListe)) {
      if (/^- /.test(l)) items.push([l.slice(2)]);
      else items.at(-1)!.push(l);
    }
    out.push({ type: 'liste', items: items.map(recoller) });
  }
  return out;
}

/** Ce que contient une fiche. Ne lève jamais : une fiche hors grammaire se lit en prose. */
export function structureFiche(corps: string, langue: LangueFiche = 'fr'): StructureFiche {
  const bruts = blocs(corps);
  const encadre = ENCADRE[langue];
  const estMarque = (b: BlocBrut) => b.type === 'paragraphe' && (MARQUEUR.test(b.texte) || b.texte.startsWith(encadre));
  let chapeau = '';
  if (bruts[0]?.type === 'paragraphe' && !estMarque(bruts[0])) chapeau = (bruts.shift() as { texte: string }).texte;

  const sections: SectionFiche[] = [];
  let courante: Extract<SectionFiche, { type: 'prose' | 'etape' }> | null = null;
  for (const b of bruts) {
    if (b.type === 'titre') {
      courante = { type: 'prose', titre: b.texte, blocs: [] };
      sections.push(courante);
      continue;
    }
    if (b.type === 'paragraphe') {
      const m = MARQUEUR.exec(b.texte);
      if (m) {
        courante = { type: 'etape', numero: Number(m[1]), titre: m[2]!.trim(), tete: (m[3] ?? '').trim(), detail: [] };
        sections.push(courante);
        continue;
      }
      if (b.texte.startsWith(encadre)) {
        sections.push({ type: 'encadre', texte: b.texte.slice(encadre.length).trim() });
        courante = null;
        continue;
      }
    }
    if (courante?.type === 'etape') courante.detail.push(b);
    else if (courante?.type === 'prose') courante.blocs.push(b);
    else {
      courante = { type: 'prose', titre: null, blocs: [b] };
      sections.push(courante);
    }
  }
  return { chapeau, sections };
}

/**
 * Ce qui, dans une fiche PUBLIQUE, ne passerait pas la page : une étape qui se lirait comme un simple paragraphe (le
 * pire, parce que rien ne le montre), une numérotation trouée, une balise que la page ne sait pas rendre, un chapeau ou
 * une tête trop longs. Vide si la fiche suit la grammaire.
 */
export function erreursDeStructure(corps: string, langue: LangueFiche): string[] {
  const erreurs: string[] = [];
  const s = structureFiche(corps, langue);
  if (s.chapeau === '') erreurs.push('pas de chapeau : le premier paragraphe doit être une phrase, ni une étape ni un encadré');
  if (s.chapeau.length > CHAPEAU_MAX) erreurs.push(`chapeau de ${s.chapeau.length} caractères, plus de ${CHAPEAU_MAX}`);

  s.sections.filter((x) => x.type === 'etape').forEach((e, i) => {
    if (e.numero !== i + 1) erreurs.push(`étape numérotée ${e.numero} à la place ${i + 1} : un numéro manque ou se répète`);
    if (e.tete === '') erreurs.push(`étape ${e.numero} sans tête : son marqueur doit être suivi du geste`);
    if (e.tete.length > TETE_MAX) erreurs.push(`tête de l’étape ${e.numero} de ${e.tete.length} caractères, plus de ${TETE_MAX}`);
  });

  const autre = ENCADRE[langue === 'fr' ? 'en' : 'fr'];
  for (const b of blocs(corps)) {
    if (b.type !== 'paragraphe') continue;
    if (/^\*\*\s*\d/.test(b.texte) && !MARQUEUR.test(b.texte)) erreurs.push(`marqueur d’étape mal écrit : « ${b.texte.slice(0, 40)} »`);
    const ressemble = /^(\*\*)?\s*(bon à savoir|good to know)/i.test(b.texte);
    if ((ressemble && !b.texte.startsWith(ENCADRE[langue])) || b.texte.startsWith(autre)) {
      erreurs.push(`encadré mal écrit (attendu ${ENCADRE[langue]}) : « ${b.texte.slice(0, 40)} »`);
    }
  }

  if (corps.includes('`')) erreurs.push('accent grave : la page ne rend pas le code');
  if (corps.includes('](')) erreurs.push('lien Markdown : la page ne rend pas les liens');
  if (corps.replace(/\*\*/g, '').includes('*')) erreurs.push('astérisque seul (italique ?) : seul le gras existe');
  if (/^#(?!# )/m.test(corps)) erreurs.push('titre autre que « ## » : seul l’intertitre existe');
  if (/^\d+\. /m.test(corps)) erreurs.push('liste numérotée : une étape s’écrit **N. Titre.**');
  return erreurs;
}

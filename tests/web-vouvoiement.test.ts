import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * LA CONSOLE VOUVOIE, PARTOUT (passe 3 de la refonte « anti-slop », 2026-09-26, décision de Julien).
 *
 * Elle mélangeait les deux : environ 165 chaînes au « tu » contre 185 au « vous », et 22 fichiers passaient
 * de l'un à l'autre d'une ligne à la suivante. Tout a été ramené au « vous » à la main ; sans garde, la
 * première phrase écrite par réflexe le défait.
 *
 * Ce qui est lu : le texte FRANÇAIS affiché, c'est-à-dire le premier argument de `t('fr', 'en')`, le texte
 * JSX, les attributs d'affichage (`placeholder`, `title`…) et les littéraux des modules de `lib/` (qui
 * portent leurs paires `[fr, en]`). Le second argument de `t()`, l'anglais, n'est pas lu.
 *
 * ⚠️ UNE SEULE EXCEPTION, ET ELLE EST NOMMÉE : `lib/mba-outils.ts` porte les CONSIGNES pré-remplies écrites
 * À L'AGENT DE META (« Appelle cet outil dès que le client te donne… »). Ce n'est pas la console qui parle au
 * client, c'est une instruction adressée au modèle, que le client relit et modifie.
 */

const RACINE = join(__dirname, '..', 'web');
const EXCEPTIONS = new Set(['lib/mba-outils.ts']);

function fichiers(dossier: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dossier)) {
    const p = join(dossier, e);
    if (statSync(p).isDirectory()) out.push(...fichiers(p));
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}
const rel = (f: string): string => f.slice(RACINE.length + 1).split('\\').join('/');

/** Attributs techniques : leur valeur n'est jamais lue par une personne. */
const ATTRIBUT_TECHNIQUE = /^(className|key|href|src|type|name|id|role|htmlFor|rel|target|value|defaultValue|testId|variante|taille|nom)$|^data-/;

/** Le texte français d'un fichier : tout littéral qui n'est ni l'anglais de `t()`, ni une classe, ni un import. */
function textesFrancais(fichier: string): { ligne: number; texte: string }[] {
  const src = readFileSync(fichier, 'utf8');
  const sf = ts.createSourceFile(fichier, src, ts.ScriptTarget.Latest, true, fichier.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { ligne: number; texte: string }[] = [];
  const visiter = (n: ts.Node): void => {
    let texte: string | null = null;
    if (n.kind === ts.SyntaxKind.JsxText) texte = n.getText(sf).replace(/\s+/g, ' ');
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      let noeud: ts.Node = n;
      while (noeud.parent && (ts.isTemplateSpan(noeud.parent) || ts.isTemplateExpression(noeud.parent))) noeud = noeud.parent;
      const parent = noeud.parent;
      const anglais = parent !== undefined && ts.isCallExpression(parent) && parent.expression.getText(sf) === 't' && parent.arguments.indexOf(noeud as ts.Expression) === 1;
      let technique = false;
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) { technique = true; break; }
        if (ts.isJsxAttribute(p)) { technique = ATTRIBUT_TECHNIQUE.test(p.name.getText(sf)); break; }
      }
      if (!anglais && !technique) texte = (n as ts.LiteralLikeNode).text;
    }
    if (texte && texte.trim() !== '') out.push({ ligne: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, texte });
    ts.forEachChild(n, visiter);
  };
  visiter(sf);
  return out;
}

/**
 * Les marques du tutoiement. Chacune est choisie pour ne rien attraper d'autre dans la console :
 * - les pronoms, sujet et complément (« tu », « toi », « te », « t’ ») ;
 * - les possessifs « ta » et « tes », et « ton » SUIVI D'UN NOM (« ton compte ») : seul, « ton » est le
 *   réglage de l'agent (« Identité et ton », « son ton, sa langue ») ;
 * - l'impératif suivi d'un pronom (« Connecte-le », « Saisis-le », « Crée-en », « veux-tu »), sauf à la
 *   forme en -ez et pour « dites » et « (re)faites » ;
 * - les impératifs que la console n'emploie JAMAIS à la troisième personne en tête de phrase. « Ouvre »,
 *   « Demande », « Lance » ou « Entre » n'y sont pas : ils y décrivent ce que FAIT un bouton ou une route,
 *   ou sont une préposition (« Entre parenthèses »).
 */
const MARQUES: RegExp[] = [
  /(?<![\p{L}’'-])(tu|toi|te)(?![\p{L}’'-])/iu,
  /-(tu|toi)(?![\p{L}])/iu,
  /(?<![\p{L}’'])t[’'](?=\p{L})/iu,
  /(?<![\p{L}’'-])(ta|tes)(?![\p{L}’'-])/iu,
  /(?<!\b(?:son|le|du|au|de|et|un) )(?<![\p{L}’'-])ton (?=\p{L})/iu,
  /(?<![\p{L}])\p{L}+(?<!ez|ites)-(le|la|les|lui|leur|en|moi)(?![\p{L}])/iu,
  /(?:^|[.!?:;(«]\s*|,\s+)(Clique|Coche|Décoche|Choisis|Saisis|Réessaie|Essaie|Vérifie|Reconnecte|Remplis|Sélectionne|Tape|Décris|Scanne|Tire|Lâche|Appuie|Pense|Corrige|Allume|Relie|Associe|Importe|Connecte|Utilise|Renseigne|Indique|Écris|Redépose|Réactive|Construis|Rafraîchis|Attends|Reviens)(?![\p{L}])/u,
  /(?<![\p{L}])(réessaie|rafraîchis|reconnecte)(?![\p{L}])/iu,
];

describe('La console vouvoie', () => {
  it('🔴 aucune marque du tutoiement dans le texte français affiché', () => {
    const fautifs: string[] = [];
    for (const f of ['app', 'components', 'lib'].flatMap((d) => fichiers(join(RACINE, d)))) {
      if (EXCEPTIONS.has(rel(f))) continue;
      for (const { ligne, texte } of textesFrancais(f)) {
        const m = MARQUES.map((r) => texte.match(r)).find((x) => x !== null);
        if (m) fautifs.push(`${rel(f)}:${ligne} « ${m[0].trim()} » dans : ${texte.trim().slice(0, 90)}`);
      }
    }
    expect(fautifs, 'la console dit « vous » : « ton compte » devient « votre compte », « réessaie » devient « réessayez »').toEqual([]);
  });

  it('garde de la garde : les marques attrapent le tutoiement et laissent passer le vouvoiement', () => {
    const attrape = (s: string): boolean => MARQUES.some((r) => r.test(s));
    for (const s of [
      'Tu ne peux pas supprimer ton propre compte', 'Connecte-le pour synchroniser', 'Saisis-le ci-dessous.',
      'Réessaie dans un instant.', 'Aucun bloc ne correspond à ta recherche.', 'tous tes scénarios', 'on t’envoie un lien',
      'Clique « Créer » pour commencer.', 'Crée-en un ci-dessus', 'Lequel veux-tu ouvrir ?', 'ou glisse-le ici',
      'Reconnecte-toi pour continuer', 'Sélectionne une conversation',
    ]) expect(attrape(s), s).toBe(true);
    for (const s of [
      'Vous ne pouvez pas supprimer votre propre compte', 'Connectez-le pour synchroniser', 'Dites-lui de ne jamais promettre',
      'Identité et ton', 'Choisissez son ton, sa langue', 'Ton', 'En-tête', 'Ouvre une page web.', 'Demande de RDV',
      'Au-delà, chaque message est facturé.', 'Réessayez dans un instant.', 'Tapez SUPPRIMER pour confirmer', 'statut',
      'Refaites-le depuis le début.', 'Entre parenthèses, le prix.', 'un prospect qui clique n’aurait aucune réponse',
    ]) expect(attrape(s), s).toBe(false);
  });
});

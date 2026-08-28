import { describe, it, expect } from 'vitest';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, pageEnFiches } from '../src/agent/scrape';

/**
 * Une page de site transformée en fiches de connaissance.
 *
 * 🔴 CE QUI EST VRAIMENT EN JEU ICI, et ce n'est pas la beauté du texte extrait. La recherche de la tâche
 * 16bis mesure « combien de termes de la question se retrouvent dans la fiche », et le garde-fou
 * anti-hallucination en dépend. Une page avalée d'un bloc contiendrait à peu près tous les mots du site :
 * elle serait pertinente pour n'importe quelle question, et `sortie:sans_source` ne tomberait plus jamais.
 * Le découpage est donc une garde, pas un confort de lecture, et c'est ce que ces tests verrouillent.
 */

const PAGE = `<!doctype html>
<html><head><title>Résidence Les Pins</title>
<style>.a{color:red}</style>
<script>window.tarif = "gratuit pour tous";</script>
</head>
<body>
<nav><a href="/">Accueil</a><a href="/contact">Contact</a></nav>
<p>La résidence Les Pins accueille les familles toute l'année, à deux pas de la plage.</p>
<h1>La piscine</h1>
<p>La piscine chauffée est ouverte tous les jours de 9 h à 20 h.</p>
<p>Le bonnet de bain est obligatoire pour tout le monde.</p>
<h2>Le parking</h2>
<div>Le parking souterrain est gratuit pour les résidents, une place par appartement.</div>
<footer>Mentions légales &amp; conditions</footer>
</body></html>`;

describe('pageEnFiches', () => {
  it('découpe la page sur ses titres, et garde le chapeau sous le titre du document', () => {
    const fiches = pageEnFiches(PAGE, 'https://exemple.fr/residence');
    expect(fiches.map((f) => f.titre)).toEqual(['Résidence Les Pins', 'La piscine', 'Le parking']);
    expect(fiches[0]!.corps).toContain('accueille les familles');
    expect(fiches[1]!.corps).toContain('9 h à 20 h');
    expect(fiches[1]!.corps).toContain('bonnet de bain');
    // Le contenu d'une section s'arrête au titre suivant : sans ça, la première fiche contiendrait tout le
    // reste de la page et redeviendrait pertinente pour n'importe quelle question.
    expect(fiches[1]!.corps).not.toContain('parking');
  });

  it('🔴 jette le script, le style et le chrome de page', () => {
    const fiches = pageEnFiches(PAGE, 'https://exemple.fr/residence');
    const tout = fiches.map((f) => `${f.titre}\n${f.corps}`).join('\n');
    // Un `<script>` seulement démarqué injecterait du JavaScript dans la base de connaissance, donc dans le
    // contexte du modèle : « gratuit pour tous » deviendrait une source citable.
    expect(tout).not.toContain('window.tarif');
    expect(tout).not.toContain('gratuit pour tous');
    expect(tout).not.toContain('color:red');
    // Le chrome est sur CHAQUE page du site : le garder ferait un mot commun à toutes les fiches, donc du
    // bruit pur pour une recherche qui compte les mots partagés.
    expect(tout).not.toContain('Mentions légales');
    expect(tout).not.toContain('Accueil');
  });

  it('rend UNE fiche quand la page n’a aucun titre, et nomme la fiche par le document', () => {
    const fiches = pageEnFiches('<html><head><title>Nos tarifs</title></head><body><p>Le forfait ménage est facturé 60 euros par séjour.</p></body></html>', 'https://exemple.fr/tarifs');
    expect(fiches).toHaveLength(1);
    expect(fiches[0]!.titre).toBe('Nos tarifs');
    expect(fiches[0]!.corps).toContain('60 euros');
  });

  it('sans balise `title`, se rabat sur le chemin de l’adresse', () => {
    const fiches = pageEnFiches('<p>Le forfait ménage est facturé 60 euros par séjour, linge compris.</p>', 'https://exemple.fr/nos-tarifs-2026/');
    expect(fiches[0]!.titre).toBe('nos tarifs 2026');
  });

  it('écarte les sections trop maigres plutôt que d’en faire des fiches', () => {
    const fiches = pageEnFiches('<h1>Ouvert</h1><p>Oui.</p><h2>Les horaires</h2><p>La réception est ouverte de 8 h à 19 h, sept jours sur sept, hors jours fériés.</p>', 'https://exemple.fr/infos');
    expect(fiches.map((f) => f.titre)).toEqual(['Les horaires']);
  });

  it('🔴 borne le nombre de fiches et la taille d’un corps', () => {
    const grosse = Array.from({ length: 120 }, (_, i) => `<h2>Section ${i}</h2><p>${'du contenu de section bien assez long pour compter. '.repeat(3)}</p>`).join('');
    const fiches = pageEnFiches(`<html><body>${grosse}</body></html>`, 'https://exemple.fr/tout');
    expect(fiches).toHaveLength(MAX_FICHES_PAR_PAGE);

    const enorme = `<h1>Le règlement</h1><p>${'phrase du règlement intérieur. '.repeat(1000)}</p>`;
    const [fiche] = pageEnFiches(enorme, 'https://exemple.fr/reglement');
    expect(fiche!.corps.length).toBe(MAX_CORPS);
  });

  it('décode les entités, et &amp; en dernier', () => {
    const [fiche] = pageEnFiches('<h1>Tarifs</h1><p>Chambre &amp; petit-d&#233;jeuner : 90&nbsp;euros, taxe de s&eacute;jour comprise.</p>', 'https://exemple.fr/t');
    expect(fiche!.corps).toContain('Chambre & petit-déjeuner');
    expect(fiche!.corps).toContain('90 euros');
    expect(fiche!.corps).toContain('taxe de séjour');
  });

  it('🔴 décode en UNE passe : `&amp;lt;` reste du texte, il ne devient pas une balise', () => {
    // Une suite de `replace` traiterait `&amp;` avant ou après `&lt;`, et le site qui a écrit du texte se
    // retrouverait avec une balise dans la base de connaissance, donc dans le contexte du modèle.
    const [fiche] = pageEnFiches('<h1>Gabarit</h1><p>Écrivez &amp;lt;nom&amp;gt; pour insérer le nom du client dans le message.</p>', 'https://exemple.fr/g');
    expect(fiche!.corps).toContain('&lt;nom&gt;');
    expect(fiche!.corps).not.toContain('<nom>');
  });

  it('rend un tableau vide sur une page sans contenu exploitable', () => {
    expect(pageEnFiches('<html><body><nav>Accueil</nav></body></html>', 'https://exemple.fr/')).toEqual([]);
  });
});

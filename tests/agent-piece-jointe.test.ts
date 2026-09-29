import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { reconnaitre, extraireTexte, texteEnFiches, TAILLE_DOCUMENT_MAX } from '../src/agent/setup/piece-jointe';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE } from '../src/agent/scrape';
import { CORPS_MAX } from '../src/agent/resolvers/connaissance';

/**
 * Les pièces jointes de la conversation de construction.
 *
 * 🔴 DEUX CHOSES SE JOUENT ICI. Le type est décidé par la SIGNATURE du fichier et jamais par ce que le
 * navigateur déclare (ce texte finit dans la base de connaissance, donc dans le prompt d'un agent qui parle à
 * de vrais contacts). Et le texte est DÉCOUPÉ : un document entier dans une seule fiche contiendrait à peu
 * près tous les mots du métier, deviendrait pertinent pour n'importe quelle question, et rendrait la garde
 * anti-hallucination inopérante sans qu'aucun test ne le voie.
 */

const DOC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>Nos horaires d’ouverture</w:t></w:r></w:p>
<w:p><w:r><w:t>La piscine est ouverte de 9h à 20h tous les jours, sauf le mardi où elle ferme à 18h.</w:t></w:r></w:p>
<w:p><w:r><w:t>Nos tarifs</w:t></w:r></w:p>
<w:p><w:r><w:t>L’entrée simple coûte 6 € ; l’abonnement mensuel 45 € ; la carte de dix entrées 50 €.</w:t></w:r></w:p>
</w:body></w:document>`;

const docx = (xml = DOC_XML): Buffer => Buffer.from(zipSync({ 'word/document.xml': strToU8(xml) }));

describe('reconnaissance par la SIGNATURE', () => {
  it('reconnaît PDF, DOCX, les images et le texte brut', () => {
    expect(reconnaitre(Buffer.from('%PDF-1.7\n...'))).toEqual({ nature: 'pdf', mime: 'application/pdf' });
    expect(reconnaitre(docx())).toMatchObject({ nature: 'docx' });
    expect(reconnaitre(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toEqual({ nature: 'image', mime: 'image/jpeg' });
    expect(reconnaitre(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ nature: 'image', mime: 'image/png' });
    expect(reconnaitre(Buffer.from('Bonjour, voici nos horaires.'))).toEqual({ nature: 'texte', mime: 'text/plain' });
  });

  it('webp est accepté ICI (une capture d’écran moderne en est une), et son tag est vérifié', () => {
    const entete = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([1, 2])]);
    expect(reconnaitre(entete)).toEqual({ nature: 'image', mime: 'image/webp' });
    // Un RIFF qui n'est PAS un webp (un wav, par exemple) ne passe pas pour une image.
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE'), Buffer.from([1, 2])]);
    expect(reconnaitre(wav)).toBeNull();
  });

  it('🔴 un fichier qui MENT sur sa nature est refusé, pas servi pour ce qu’il prétend être', () => {
    // Un binaire quelconque ne doit pas passer pour du texte : il injecterait des caractères de contrôle dans
    // la base de connaissance, donc dans le prompt.
    expect(reconnaitre(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(reconnaitre(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // exécutable Windows
    expect(reconnaitre(Buffer.from([]))).toBeNull();
    // Un texte contenant un octet nul est du binaire déguisé.
    expect(reconnaitre(Buffer.concat([Buffer.from('Bonjour'), Buffer.from([0x00])]))).toBeNull();
    // De l'UTF-8 INVALIDE non plus : une suite d'octets qui ne se relit pas telle quelle n'est pas du texte.
    expect(reconnaitre(Buffer.from([0xc3, 0x28, 0xa0, 0xff]))).toBeNull();
  });

  it('🔴 une ARCHIVE ZIP qui n’est pas un document Word est refusée', () => {
    // Sans ce contrôle, n'importe quel zip (donc n'importe quel contenu) passerait pour un `.docx`.
    const zipQuelconque = Buffer.from(zipSync({ 'notes.txt': strToU8('coucou') }));
    expect(reconnaitre(zipQuelconque)).toBeNull();
  });

  it('🔴 une archive qui annonce un contenu ÉNORME n’est pas un document Word', () => {
    /**
     * Le taux de compression d'un ZIP n'est pas borné : quelques kilo-octets d'archive peuvent déclarer des
     * centaines de méga à l'intérieur. Sans garde, c'est le fichier téléversé qui décide de la mémoire du
     * process, donc un arrêt de l'API offert à qui joint un document. On le refuse AVANT d'allouer.
     *
     * ⚠️ Le contenu est fait de zéros, donc l'archive reste minuscule : c'est exactement la forme du piège.
     */
    const enorme = Buffer.from(zipSync({ 'word/document.xml': new Uint8Array(70 * 1024 * 1024) }));
    expect(enorme.length).toBeLessThan(1024 * 1024); // l'archive, elle, tient dans un méga
    expect(reconnaitre(enorme)).toBeNull();
  });
});

describe('extraction du texte', () => {
  it('un .docx rend son texte, paragraphe par paragraphe', async () => {
    const t = await extraireTexte(docx(), 'docx');
    expect(t).toContain('Nos horaires d’ouverture');
    expect(t).toContain('45 €'); // les entités XML sont décodées, les € survivent
    expect(t!.split('\n').length).toBeGreaterThan(3); // les paragraphes ne sont pas collés en une phrase
  });

  it('un texte brut est normalisé (fins de ligne Windows comprises)', async () => {
    expect(await extraireTexte(Buffer.from('a\r\nb\r\n'), 'texte')).toBe('a\nb');
  });

  it('🔴 une IMAGE ne passe pas par l’extraction : c’est un modèle vision qui la lit', async () => {
    expect(await extraireTexte(Buffer.from([0xff, 0xd8, 0xff]), 'image')).toBeNull();
  });

  it('un PDF illisible rend null, il ne LÈVE pas', async () => {
    // Un PDF chiffré, corrompu, ou entièrement scanné : l'écran doit pouvoir le dire au client, pas planter.
    expect(await extraireTexte(Buffer.from('%PDF-1.4\nnimporte quoi'), 'pdf')).toBeNull();
  });
});

describe('découpage en fiches', () => {
  const long = (n: number) => 'phrase de contenu qui remplit la fiche. '.repeat(n);

  it('découpe sur les titres, et le corps suit son titre', async () => {
    const fiches = texteEnFiches((await extraireTexte(docx(), 'docx'))!, 'Document', 'docx');
    expect(fiches.map((f) => f.titre)).toEqual(['Nos horaires d’ouverture', 'Nos tarifs']);
    expect(fiches[0]!.corps).toContain('9h à 20h');
    expect(fiches[1]!.corps).toContain('45 €');
  });

  it('🔴 un document SANS AUCUN titre ne rend pas une fiche unique tronquée', () => {
    // C'est le pire cas (un PDF exporté sans structure) et le plus dangereux : une fiche unique contiendrait
    // tous les mots du métier et deviendrait pertinente pour n'importe quelle question. Le reste ne doit pas
    // non plus être perdu en silence.
    const source = long(600);
    const fiches = texteEnFiches(source, 'Manuel', 'pdf');
    expect(fiches.length).toBeGreaterThan(1);
    expect(fiches[1]!.titre).toContain('suite');
    for (const f of fiches) expect(f.corps.length).toBeLessThanOrEqual(MAX_CORPS);
    // 🔴 ET RIEN N'EST PERDU. C'est la vraie garantie : tronquer rendrait une fiche au plafond et jetterait
    // tout le reste en silence, le client croyant son document importé. On compare les caractères non blancs,
    // les frontières de coupe mangeant des espaces.
    const sansBlancs = (s: string) => s.replace(/\s+/g, '');
    expect(fiches.map((f) => f.corps).join('').replace(/\s+/g, '')).toBe(sansBlancs(source));
  });

  it('les plafonds sont ceux de l’import de page web, pas des copies', () => {
    const fiches = texteEnFiches(long(20000), 'Gros', 'texte');
    expect(fiches.length).toBeLessThanOrEqual(MAX_FICHES_PAR_PAGE);
    for (const f of fiches) {
      expect(f.titre.length).toBeLessThanOrEqual(MAX_TITRE);
      expect(f.corps.length).toBeLessThanOrEqual(MAX_CORPS);
    }
  });

  it('une section trop courte est écartée : elle ferait du bruit sans jamais répondre', () => {
    expect(texteEnFiches('Un titre\ncourt', 'Doc', 'texte')).toEqual([]);
  });

  it('deux titres de suite ne produisent pas de fiche vide au milieu', () => {
    const fiches = texteEnFiches(`Le guide\nChapitre premier\n${long(3)}`, 'Doc', 'texte');
    expect(fiches).toHaveLength(1);
    expect(fiches[0]!.titre).toBe('Chapitre premier'); // le plus proche du contenu
  });

  it('une puce n’est PAS un titre : c’est du contenu', () => {
    const fiches = texteEnFiches(`Nos services\n- la piscine\n- le sauna\n${long(3)}`, 'Doc', 'texte');
    expect(fiches).toHaveLength(1);
    expect(fiches[0]!.corps).toContain('- la piscine');
  });

  it('le plafond de poids est exporté, pour que la route et l’écran annoncent le MÊME chiffre', () => {
    expect(TAILLE_DOCUMENT_MAX).toBe(8 * 1024 * 1024);
  });
});

/** Une FAQ en point-virgule dont les réponses portent plusieurs virgules : laissé deviner, papaparse choisit la virgule. */
const FAQ_VIRGULES = [
  'Question;Réponse',
  'Quels animaux ?;Les chiens, les chats, et les NAC de moins de 10 kg',
  'Quels délais ?;Trois mois, six mois, ou un an, selon la formule',
  'Et après ?;Rien, sauf avis contraire, du vétérinaire',
].join('\n');

describe('🔴 un CSV : des rangées ENTIÈRES, l’en-tête en tête de chaque fiche', () => {
  /**
   * Mesuré le 2026-09-29 sur une grille de tarifs de 301 lignes : un CSV passait par le découpage du texte libre,
   * qui prend chaque rangée courte pour un titre. Un export ordinaire rendait ZÉRO fiche (un 422 « trop court »
   * qui taisait la cause), et le même fichier avec un séparateur final des fiches coupées au milieu d'une rangée,
   * l'en-tête perdu dès la deuxième : une fiche du milieu ne disait plus ce que valent ses colonnes.
   */
  const ENTETE = 'Espèce;Race;Formule 1;Formule 2;Formule 3';
  const rangees = Array.from({ length: 300 }, (_, i) => `Chien;Labrador ${i};${20 + (i % 9)},00;30,00;40,00`);
  const grille = [ENTETE, ...rangees].join('\n');
  const sousEntete = (corps: string): string[] => corps.split('\n').slice(1);

  it('un export ordinaire fait des fiches de rangées entières, sans en couper ni en perdre aucune', () => {
    const fiches = texteEnFiches(grille, 'Grille', 'texte');
    expect(fiches.length).toBeGreaterThan(1);
    for (const f of fiches) expect(f.corps.split('\n')[0]).toBe(ENTETE);
    // Chaque rangée, entière, une seule fois et dans l'ordre.
    expect(fiches.flatMap((f) => sousEntete(f.corps))).toEqual(rangees);
    expect(fiches.slice(0, 2).map((f) => f.titre)).toEqual(['Grille', 'Grille (suite 2)']);
  });

  it('🔴 une fiche ne dépasse pas ce que l’agent en LIT : ses dernières rangées lui seraient invisibles', () => {
    // La recherche et le juge de pertinence lisent la fiche entière, l'agent ses CORPS_MAX premiers caractères :
    // une rangée plus bas serait trouvée, puis cachée à celui qui doit répondre.
    for (const f of texteEnFiches(grille, 'Grille', 'texte')) expect(f.corps.length).toBeLessThanOrEqual(CORPS_MAX);
  });

  it('un séparateur en fin de ligne ne change rien', () => {
    const fiches = texteEnFiches([ENTETE, ...rangees].map((l) => `${l};`).join('\n'), 'Grille', 'texte');
    for (const f of fiches) expect(f.corps.split('\n')[0]).toBe(`${ENTETE};`);
    expect(fiches.flatMap((f) => sousEntete(f.corps))).toEqual(rangees.map((r) => `${r};`));
  });

  it('un CSV de questions-réponses, la forme que l’écran annonce, garde chaque réponse avec sa question', () => {
    // Entre guillemets, un champ peut porter le séparateur et des sauts de ligne : c'est toujours la même rangée.
    const faq = 'Question;Réponse\n"Horaires ; en été ?";"Du lundi au vendredi,\nde 9h à 18h"\nLes chiens sont-ils couverts ?;Oui, dès 3 mois';
    const fiches = texteEnFiches(faq, 'FAQ', 'texte');
    expect(fiches).toHaveLength(1);
    expect(fiches[0]!.corps).toBe(faq);
  });

  it('🔴 une FAQ en point-virgule dont les réponses portent des virgules reste un CSV', () => {
    // Les séparateurs sont essayés dans l'ordre, le point-virgule d'abord : laissé deviner, papaparse prenait la
    // virgule, et la FAQ retombait dans le découpage du texte libre.
    expect(texteEnFiches(FAQ_VIRGULES, 'FAQ', 'texte').map((f) => f.corps)).toEqual([FAQ_VIRGULES]);
  });

  it('une rangée plus longue qu’une fiche est coupée en morceaux sur une espace, jamais tronquée', () => {
    const longue = `Résiliation;${'Le contrat se résilie par lettre recommandée. '.repeat(100)}`;
    const fiches = texteEnFiches(`Sujet;Détail\n${longue}\nTarif;6 €`, 'Conditions', 'texte');
    expect(fiches.length).toBeGreaterThan(2);
    for (const f of fiches) {
      expect(f.corps.split('\n')[0]).toBe('Sujet;Détail');
      expect(f.corps.length).toBeLessThanOrEqual(CORPS_MAX);
    }
    expect(fiches.flatMap((f) => sousEntete(f.corps)).join('')).toBe(`${longue}Tarif;6 €`);
    // La suite reprend sur l'espace où la coupe est tombée : aucun mot, aucun montant n'est coupé en deux.
    expect(sousEntete(fiches[1]!.corps)[0]!.startsWith(' ')).toBe(true);
  });

  it('🔴 une coupe ne sépare jamais les deux moitiés d’un emoji : une moitié seule ne passe pas en base', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const orpheline = (s: string): boolean => [...s].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff);
    // Deux en-têtes de longueurs de parités différentes : l'une des deux fait tomber la coupe au milieu d'un emoji.
    for (const entete of ['Sujet;Avis', 'Sujet;Avis!']) {
      const fiches = texteEnFiches(`${entete}\nAvis;${emoji.repeat(1500)}`, 'Avis', 'texte');
      expect(fiches.length).toBeGreaterThan(1);
      for (const f of fiches) expect(orpheline(f.corps)).toBe(false);
    }
  });

  it('un TSV à case d’angle vide, avec un BOM et des rangées vides d’Excel, garde ses colonnes', async () => {
    // Couper les bords du texte retirait la tabulation de tête : l'en-tête perdait sa case vide, et le tableau
    // n'était plus régulier.
    const tsv = `${String.fromCharCode(0xfeff)}\tFormule 1\tFormule 2\r\nLabrador\t20,00\t30,00\r\n\t\t\r\nCaniche\t25,00\t\r\n`;
    const octets = Buffer.from(tsv, 'utf8');
    const texte = (await extraireTexte(octets, reconnaitre(octets)!.nature))!;
    expect(texteEnFiches(texte, 'Grille', 'texte').map((f) => f.corps))
      .toEqual(['\tFormule 1\tFormule 2\nLabrador\t20,00\t30,00\nCaniche\t25,00\t']);
  });

  it('un titre posé au-dessus du tableau rejoint l’en-tête : les noms de colonnes restent dans chaque fiche', () => {
    const fiches = texteEnFiches(['Grille tarifaire 2026;;;;', ';;;;', ENTETE, ...rangees].join('\n'), 'Grille', 'texte');
    expect(fiches.length).toBeGreaterThan(1);
    for (const f of fiches) expect(f.corps.split('\n').slice(0, 2)).toEqual(['Grille tarifaire 2026;;;;', ENTETE]);
    expect(fiches.flatMap((f) => f.corps.split('\n').slice(2))).toEqual(rangees);
  });

  it('un en-tête qui prendrait plus de la moitié d’une fiche n’est pas lu comme un tableau', () => {
    // Il ne laisserait presque plus de place aux rangées, et à la limite aucune : la coupe ne finirait jamais.
    const entete = `${'Colonne'.repeat(185)};Autre`;
    const rangee = `x;${'mot '.repeat(75)}`;
    expect(texteEnFiches([entete, rangee, rangee, rangee].join('\n'), 'Doc', 'texte')).toHaveLength(1);
  });

  it('une fiche de CSV reste modifiable à l’écran, où la route refuse un corps de plus de MAX_CORPS', () => {
    expect(CORPS_MAX).toBeLessThanOrEqual(MAX_CORPS);
  });

  it('au-delà du plafond de fiches, la suite n’est pas écrite, comme pour une page', () => {
    const enorme = [ENTETE, ...Array.from({ length: 5000 }, (_, i) => `Chat;Siamois ${i};20,00;30,00;40,00`)].join('\n');
    expect(texteEnFiches(enorme, 'Grille', 'texte')).toHaveLength(MAX_FICHES_PAR_PAGE);
  });

  it('un texte dont les lignes n’ont pas toutes le même nombre de colonnes garde le découpage par titres', () => {
    // Des virgules sur chaque ligne, mais pas le même nombre : de la prose, pas un tableau.
    const prose = 'Nos tarifs, à jour\nL’entrée coûte 6 €, l’abonnement 45 €, la carte 50 €.\nLes enfants, eux, entrent gratuitement.';
    expect(texteEnFiches(prose, 'Doc', 'texte').map((f) => f.titre)).toEqual(['Nos tarifs, à jour']);
  });

  it('une cellule bordée d’espaces ou portant un guillemet revient telle quelle, sans guillemets ajoutés', () => {
    const grille = 'Écran ; Taille ; Tarif\nTV ; 27" pouces ; 199,00 €\nMoniteur ; 24" pouces ; 149,00 €';
    expect(texteEnFiches(grille, 'Grille', 'texte').map((f) => f.corps)).toEqual([grille]);
  });

  it('seul un fichier TEXTE est lu comme un CSV : un PDF, un Word ou une image lue gardent le découpage par titres', () => {
    const texte = 'Nos horaires, tarifs\nLa piscine, ouverte de 9h à 20h.\nLe sauna, ouvert de 10h à 19h.';
    const parTitres = [{ titre: 'Nos horaires, tarifs', corps: 'La piscine, ouverte de 9h à 20h.\nLe sauna, ouvert de 10h à 19h.' }];
    for (const nature of ['pdf', 'docx', 'image'] as const) expect(texteEnFiches(texte, 'Doc', nature)).toEqual(parTitres);
    // Dans un fichier texte, une virgule par ligne a la forme d'un CSV : il est lu comme tel, sans rien perdre.
    expect(texteEnFiches(texte, 'Doc', 'texte')).toEqual([{ titre: 'Doc', corps: texte }]);
  });
});

describe('🔴 un CSV enregistré par Excel en Windows-1252', () => {
  /**
   * Excel sous Windows en français enregistre « CSV (séparateur: point-virgule) » en Windows-1252, pas en UTF-8.
   * Mesuré le 2026-09-29 : le « è » d'« Espèce » suffisait pour un refus 415 « format non accepté (texte, CSV,
   * PDF ou Word) ». Ce fichier passe désormais, mais SEULEMENT s'il a la forme d'un CSV : n'importe quelle
   * suite d'octets se lit en Windows-1252, et un binaire ne doit toujours pas passer pour du texte.
   */
  /** Ce qu'écrit Excel : un octet par caractère, l'euro rangé en 0x80. */
  const enWindows1252 = (s: string): Buffer => Buffer.from([...s].map((c) => (c === '€' ? 0x80 : c.charCodeAt(0))));
  const grille = 'Espèce;Race;Formule 1 (€);Formule 2 (€)\nChien;Épagneul breton;20,00;30,00\nChat;Européen;15,00;25,00';

  it('est reconnu comme du texte, et relu avec ses accents et son euro', async () => {
    const octets = enWindows1252(grille);
    expect(reconnaitre(octets)).toEqual({ nature: 'texte', mime: 'text/plain' });
    expect(await extraireTexte(octets, 'texte')).toBe(grille);
  });

  it('une FAQ en point-virgule dont les réponses portent des virgules passe aussi', () => {
    expect(reconnaitre(Buffer.from(FAQ_VIRGULES, 'latin1'))).toEqual({ nature: 'texte', mime: 'text/plain' });
  });

  it('🔴 un texte en Windows-1252 qui n’a PAS la forme d’un CSV reste refusé', () => {
    expect(reconnaitre(enWindows1252('Le café est ouvert de 9h à 18h, même le dimanche.'))).toBeNull();
  });

  it('🔴 un caractère de contrôle, ou un octet que Windows-1252 ne définit pas, le fait refuser', () => {
    expect(reconnaitre(Buffer.concat([enWindows1252(grille), Buffer.from([0x01])]))).toBeNull();
    expect(reconnaitre(Buffer.concat([enWindows1252(grille), Buffer.from([0x81])]))).toBeNull();
  });

  it('le décodage est celui de Windows-1252, octet par octet', async () => {
    // La table de 0x80 à 0x9F est écrite à la main (le décodeur de la plateforme dépend de l'ICU embarqué) : on
    // la compare ici à celui de Node, sur tous les octets hauts que ce jeu définit.
    const hauts = Array.from({ length: 128 }, (_, i) => 0x80 + i).filter((o) => ![0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(o));
    const octets = Buffer.concat([Buffer.from('a;b\nc;'), Buffer.from(hauts)]);
    expect(await extraireTexte(octets, 'texte')).toBe(new TextDecoder('windows-1252').decode(octets));
  });
});

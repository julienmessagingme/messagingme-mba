import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { reconnaitre, extraireTexte, texteEnFiches, TAILLE_DOCUMENT_MAX } from '../src/agent/setup/piece-jointe';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE } from '../src/agent/scrape';

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
    const fiches = texteEnFiches((await extraireTexte(docx(), 'docx'))!, 'Document');
    expect(fiches.map((f) => f.titre)).toEqual(['Nos horaires d’ouverture', 'Nos tarifs']);
    expect(fiches[0]!.corps).toContain('9h à 20h');
    expect(fiches[1]!.corps).toContain('45 €');
  });

  it('🔴 un document SANS AUCUN titre ne rend pas une fiche unique tronquée', () => {
    // C'est le pire cas (un PDF exporté sans structure) et le plus dangereux : une fiche unique contiendrait
    // tous les mots du métier et deviendrait pertinente pour n'importe quelle question. Le reste ne doit pas
    // non plus être perdu en silence.
    const source = long(600);
    const fiches = texteEnFiches(source, 'Manuel');
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
    const fiches = texteEnFiches(long(20000), 'Gros');
    expect(fiches.length).toBeLessThanOrEqual(MAX_FICHES_PAR_PAGE);
    for (const f of fiches) {
      expect(f.titre.length).toBeLessThanOrEqual(MAX_TITRE);
      expect(f.corps.length).toBeLessThanOrEqual(MAX_CORPS);
    }
  });

  it('une section trop courte est écartée : elle ferait du bruit sans jamais répondre', () => {
    expect(texteEnFiches('Un titre\ncourt', 'Doc')).toEqual([]);
  });

  it('deux titres de suite ne produisent pas de fiche vide au milieu', () => {
    const fiches = texteEnFiches(`Le guide\nChapitre premier\n${long(3)}`, 'Doc');
    expect(fiches).toHaveLength(1);
    expect(fiches[0]!.titre).toBe('Chapitre premier'); // le plus proche du contenu
  });

  it('une puce n’est PAS un titre : c’est du contenu', () => {
    const fiches = texteEnFiches(`Nos services\n- la piscine\n- le sauna\n${long(3)}`, 'Doc');
    expect(fiches).toHaveLength(1);
    expect(fiches[0]!.corps).toContain('- la piscine');
  });

  it('le plafond de poids est exporté, pour que la route et l’écran annoncent le MÊME chiffre', () => {
    expect(TAILLE_DOCUMENT_MAX).toBe(8 * 1024 * 1024);
  });
});

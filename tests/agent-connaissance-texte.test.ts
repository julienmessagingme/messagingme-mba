import { describe, it, expect, vi } from 'vitest';
import type { FicheAEcrire, SourceFiche } from '../src/agent/knowledge';
import type { OptionsLecture } from '../src/lib/hors-boucle';
import { importerDocument, importerTexteDocument, type DepsConnaissance } from '../src/agent/connaissance';
import { TAILLE_DOCUMENT_MAX } from '../src/agent/setup/piece-jointe';
import { connaissanceInerte } from './routes-inertes';

/**
 * Les lectures hors de la boucle, ENREGISTRÉES puis faites pour de vrai : le découpage reste celui du worker, et le
 * test voit sous quelle échéance chaque chemin l'a demandé.
 */
const lectures = vi.hoisted(() => [] as Array<{ fonction: string; options: OptionsLecture | undefined }>);
vi.mock('../src/lib/hors-boucle', async (original) => {
  const vrai = await original<typeof import('../src/lib/hors-boucle')>();
  return {
    ...vrai,
    horsBoucle: (module: URL, fonction: string, args: unknown[], options?: OptionsLecture) => {
      lectures.push({ fonction, options });
      return vrai.horsBoucle(module, fonction, args, options);
    },
  };
});

/**
 * LE TEXTE D'UN DOCUMENT, ENVOYÉ EN CLAIR (outil MCP `import_document_text`, lot 8a).
 *
 * 🔴 CE QUI EST PROMIS : le texte d'un document, extrait sur le poste de Claude, donne EXACTEMENT les fiches et la
 * provenance du même texte déposé en fichier dans l'onglet Connaissance. Deux découpages qui divergeraient feraient
 * deux bases différentes pour un même document, et le remplacement (par nom de document) ne retirerait plus les
 * fiches de l'autre chemin comme il le doit.
 */
const AG = '11111111-1111-4111-8111-111111111111';

function monter() {
  const ecrits: Array<{ source: SourceFiche; fiches: FicheAEcrire[] }> = [];
  const deps: DepsConnaissance = {
    ...connaissanceInerte,
    connaissance: {
      lister: async () => [],
      creer: async () => null,
      modifier: async () => null,
      supprimer: async () => false,
      remplacerSource: async (_t, agentId, source, fiches) => {
        ecrits.push({ source, fiches });
        return agentId === AG ? { retirees: 1, ecrites: fiches.length } : null;
      },
    },
  };
  return { deps, ecrits };
}

const enDataUrl = (texte: string): string => `data:text/plain;base64,${Buffer.from(texte, 'utf8').toString('base64')}`;

/** Fins de ligne Windows, titres, listes : ce que la normalisation et le découpage par sections ont à traiter. */
const GARANTIES = [
  '  Nos garanties',
  'Chaque séjour est couvert par une assurance annulation, souscrite au moment de la réservation.',
  '',
  'Remboursement',
  '- Annulation plus de trente jours avant l’arrivée : remboursement intégral, sans frais de dossier.',
  '- Moins de trente jours : la moitié du séjour est remboursée, le reste devient un avoir valable un an.',
  '',
  'Animaux',
  'Les chiens de moins de dix kilos sont acceptés dans les cottages, avec un supplément de huit euros par nuit.',
].join('\r\n');

/** Un CSV collé : il doit être découpé par rangées, comme le même fichier déposé. */
const GRILLE = [
  'Formule;Prix par nuit;Petit-déjeuner',
  'Cottage deux personnes;89 €;inclus dans le prix de chaque nuitée réservée',
  'Cottage famille;129 €;en supplément de douze euros par personne et par jour',
  'Chalet panoramique;179 €;inclus pour tous les occupants, servi sur la terrasse',
].join('\n');

describe('🔴 importer le TEXTE d’un document = déposer le même texte en fichier', () => {
  // Le CSV, court, tient en une fiche de rangées entières, chacune précédée de l'en-tête ; les garanties en font une par
  // section. Le compte minimal empêche une égalité à vide (deux chemins qui ne rendraient rien).
  // L'export d'Excel (marque d'ordre des octets, fins de ligne Windows), et un texte aux fins de ligne du vieux Mac
  // (`CR` seul) précédé d'espaces : ce dernier, seule la normalisation commune (`normaliser`) le découpe comme un
  // fichier, sans elle tout le texte tiendrait sur une ligne.
  const EXCEL = `\uFEFF${GRILLE.replace(/\n/g, '\r\n')}`;
  const MAC = `  ${GARANTIES.replace(/\r\n/g, '\r')}`;
  for (const [nom, texte, auMoins] of [['Garanties.txt', GARANTIES, 3], ['Grille.csv', GRILLE, 1], ['Export.csv', EXCEL, 1], ['Mac.txt', MAC, 3]] as const) {
    it(`mêmes fiches, même provenance, même réponse : ${nom}`, async () => {
      const fichier = monter();
      const texteSeul = monter();
      const parFichier = await importerDocument(fichier.deps, 't1', AG, { nom, dataUrl: enDataUrl(texte) });
      const parTexte = await importerTexteDocument(texteSeul.deps, 't1', AG, { nom, texte });
      expect(parFichier.ok && parTexte.ok).toBe(true);
      expect(parTexte).toEqual(parFichier);
      expect(texteSeul.ecrits).toEqual(fichier.ecrits);
      // Et ce n'est pas une égalité à vide : le document a bien été découpé, sous son nom de document.
      expect(texteSeul.ecrits[0]!.fiches.length).toBeGreaterThanOrEqual(auMoins);
      expect(texteSeul.ecrits[0]!.source).toEqual({ type: 'document', nom });
    });
  }

  it('un texte trop lourd est refusé en 413, au même plafond qu’un fichier, et rien n’est écrit', async () => {
    const m = monter();
    const r = await importerTexteDocument(m.deps, 't1', AG, { nom: 'Gros.txt', texte: 'é'.repeat(TAILLE_DOCUMENT_MAX / 2 + 1) });
    expect(r).toMatchObject({ ok: false, statut: 413 });
    expect(m.ecrits).toHaveLength(0);
  });

  it('sans nom, ou sans texte lisible, c’est un 400 ; un texte trop court pour une fiche, un 422', async () => {
    const m = monter();
    expect(await importerTexteDocument(m.deps, 't1', AG, { texte: GARANTIES })).toMatchObject({ ok: false, statut: 400 });
    expect(await importerTexteDocument(m.deps, 't1', AG, { nom: 'Vide', texte: ' \r\n ' })).toMatchObject({ ok: false, statut: 400 });
    expect(await importerTexteDocument(m.deps, 't1', AG, { nom: 'Court', texte: 'Bref.' })).toMatchObject({ ok: false, statut: 422 });
    expect(m.ecrits).toHaveLength(0);
  });

  it('🔴 un caractère nul est refusé en 400 avec une phrase lisible, comme le fichier binaire qu’il trahit, et rien n’est écrit', async () => {
    // Postgres refuse ce caractère dans un `text` : sans ce refus, l'écriture lèverait (une erreur interne pour l'outil).
    const m = monter();
    const r = await importerTexteDocument(m.deps, 't1', AG, { nom: 'b.bin', texte: `${GARANTIES}\u0000` });
    expect(r).toMatchObject({ ok: false, statut: 400 });
    expect(r.ok ? '' : r.erreur).toMatch(/^texte illisible : il contient un caractère nul/);
    expect(m.ecrits).toHaveLength(0);
  });

  it('🔴 la même échéance de découpe que le fichier : un texte refusé par un chemin ne doit pas passer par l’autre', async () => {
    lectures.length = 0;
    await importerDocument(monter().deps, 't1', AG, { nom: 'Garanties.txt', dataUrl: enDataUrl(GARANTIES) });
    await importerTexteDocument(monter().deps, 't1', AG, { nom: 'Garanties.txt', texte: GARANTIES });
    const fichier = lectures.find((l) => l.fonction === 'lireDocument');
    const texte = lectures.find((l) => l.fonction === 'texteEnFiches');
    expect(fichier?.options?.delaiMs, 'le chemin fichier n’est plus lu là où ce test le cherche').toBeGreaterThan(0);
    expect(texte?.options?.delaiMs).toBe(fichier?.options?.delaiMs);
  });

  it('l’agent d’un autre espace, ou un identifiant mal formé : 404', async () => {
    const m = monter();
    expect(await importerTexteDocument(m.deps, 't1', '99999999-9999-4999-8999-999999999999', { nom: 'G', texte: GARANTIES }))
      .toMatchObject({ ok: false, statut: 404 });
    expect(await importerTexteDocument(m.deps, 't1', 'pas-un-uuid', { nom: 'G', texte: GARANTIES }))
      .toMatchObject({ ok: false, statut: 404 });
  });
});

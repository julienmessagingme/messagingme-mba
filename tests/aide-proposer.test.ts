import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { decouperFeatures, empreinteDe } from '../scripts/aide-proposer';
import { lireFicheDuDepot } from '../src/aide/fiches';

/**
 * LE DÉCOUPAGE DE `features.md` EN SECTIONS, ET L'EMPREINTE QUI DIT QU'UNE SECTION A BOUGÉ.
 *
 * 🔴 C'EST CE QUI PERMET DE DÉTECTER UNE FICHE PÉRIMÉE SANS LA RÉGÉNÉRER EN SILENCE. Une régénération
 * automatique remplacerait un texte RELU par un texte non relu, et le bot se mettrait à parler au client
 * avec des phrases que personne n'a validées. La dérive doit donc être détectée mécaniquement même si la
 * correction, elle, reste humaine.
 *
 * ⚠️ Ce dépôt a un historique documenté de documentation qui dérive dès qu'elle est tenue à la main : le
 * compteur de migrations du CLAUDE.md a dérivé QUATRE fois, dont une le jour où cette conception a été
 * écrite. « Faire attention » n'est pas une parade.
 */
const FEATURES = readFileSync(new URL('../features.md', import.meta.url), 'utf8');
const DOSSIER = new URL('../docs/aide/fiches/', import.meta.url);

describe('découpage de features.md', () => {
  it('rend beaucoup de sections, toutes titrées', () => {
    const sections = decouperFeatures(FEATURES);
    expect(sections.length).toBeGreaterThan(10);
    expect(sections.every((s) => s.section.trim() !== '')).toBe(true);
    expect(sections.every((s) => s.corps.trim() !== '')).toBe(true);
  });

  it('les titres sont ceux du fichier, pas une invention', () => {
    const titres = decouperFeatures(FEATURES).map((s) => s.section);
    expect(titres).toContain('Campagnes');
    expect(titres).toContain('Inbox');
  });

  it('⚠️ le corps d’une section s’arrête à la section SUIVANTE', () => {
    // Sans ça, la première section avalerait tout le fichier : son empreinte changerait à chaque
    // modification de n'importe quelle autre section, et la détection de dérive crierait en permanence,
    // c'est-à-dire plus du tout.
    const sections = decouperFeatures(FEATURES);
    const campagnes = sections.find((s) => s.section === 'Campagnes')!;
    expect(campagnes.corps).not.toContain('\n## ');
    expect(campagnes.corps.length).toBeLessThan(FEATURES.length / 2);
  });

  it('aucune section n’apparaît deux fois', () => {
    // Deux sections de même titre rendraient l'appariement d'une fiche à sa source ambigu, et la dérive
    // serait mesurée contre la mauvaise.
    const titres = decouperFeatures(FEATURES).map((s) => s.section);
    const doublons = titres.filter((t, i) => titres.indexOf(t) !== i);
    expect(doublons, `sections en double : ${doublons.join(', ')}`).toEqual([]);
  });
});

describe('empreinte', () => {
  it('🔴 elle CHANGE quand le corps change, et pas quand il ne change pas', () => {
    expect(empreinteDe('bonjour')).toBe(empreinteDe('bonjour'));
    expect(empreinteDe('bonjour')).not.toBe(empreinteDe('bonjour '));
    expect(empreinteDe('bonjour')).not.toBe(empreinteDe('Bonjour'));
  });

  it('⚠️ aucune normalisation : le moindre écart compte', () => {
    // Normaliser les espaces ou la casse laisserait passer des reformulations réelles. Une empreinte qui
    // pardonne est une empreinte qui ne détecte plus rien.
    expect(empreinteDe('a\nb')).not.toBe(empreinteDe('a b'));
  });

  it('elle est courte et lisible dans un en-tête de fiche', () => {
    expect(empreinteDe('x')).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('🔴 dérive : une fiche dérivée reste à jour de sa section', () => {
  const fiches = readdirSync(DOSSIER)
    .filter((n) => n.endsWith('.md'))
    .map((n) => lireFicheDuDepot(n, readFileSync(new URL(n, DOSSIER), 'utf8')));

  it('le mécanisme fonctionne, prouvé sur un cas construit', () => {
    // Les trois premières fiches sont écrites À LA MAIN et ne portent donc AUCUNE `source_section` : le test
    // ci-dessous n'aurait rien à vérifier aujourd'hui, et annoncerait une garantie qu'il n'apporte pas. On
    // prouve donc d'abord le mécanisme sur un cas construit, qui lui existera toujours.
    const sections = new Map(decouperFeatures(FEATURES).map((s) => [s.section, s.empreinte]));
    const campagnes = sections.get('Campagnes')!;
    expect(campagnes).toBeTruthy();
    expect(empreinteDe('un texte qui n’est pas la section Campagnes')).not.toBe(campagnes);
  });

  it('chaque fiche qui NOMME une section pointe vers une section réelle, à jour', () => {
    const sections = new Map(decouperFeatures(FEATURES).map((s) => [s.section, s.empreinte]));
    for (const f of fiches) {
      if (f.sourceSection === null) continue;
      const attendue = sections.get(f.sourceSection);
      expect(attendue, `la fiche « ${f.cle} » cite la section « ${f.sourceSection} », qui n’existe plus`)
        .toBeTruthy();
      expect(f.sourceEmpreinte, `la fiche « ${f.cle} » est PÉRIMÉE : sa section a changé depuis sa relecture. `
        + 'La relire, puis mettre son empreinte à jour.').toBe(attendue);
    }
  });

  it('⚠️ une fiche qui cite une section DOIT porter son empreinte', () => {
    // Sans empreinte, la fiche échapperait au contrôle ci-dessus en silence, et ce serait le moyen le plus
    // simple de faire taire la détection de dérive.
    for (const f of fiches) {
      if (f.sourceSection === null) continue;
      expect(f.sourceEmpreinte, `la fiche « ${f.cle} » cite une section sans porter son empreinte`).not.toBeNull();
    }
  });
});

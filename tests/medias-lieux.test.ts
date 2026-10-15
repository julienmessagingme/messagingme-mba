import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { LIEUX_UTILISATION, type LieuUtilisation } from '../src/rcs/media-store.pg';

/**
 * 🔴 L'INVENTAIRE DES LIEUX QUI PEUVENT CITER UN FICHIER DE LA MÉDIATHÈQUE (spec médias du 2026-10-14, § 2.4).
 *
 * Un fichier ne se supprime pas tant qu'un contenu de l'espace le cite et peut encore partir (`utilisations`,
 * `src/rcs/media-store.pg.ts`). Cette liste de lieux DÉRIVE dès qu'un écran neuf se met à téléverser : son contenu
 * cite le fichier, la suppression ne le voit pas, et le fichier part pendant que l'écran l'envoie encore. Ce test dérive
 * de `web/` les écrans qui utilisent `ChampImageHebergee` et exige que chacun soit rattaché à des lieux connus : un écran
 * ajouté sans ligne ici fait échouer le test, et la question « où ce contenu est-il enregistré ? » se pose alors.
 */
const LIEUX_DES_ECRANS: Record<string, readonly LieuUtilisation[]> = {
  // Le bloc « message rapide » et le bloc RCS d'un scénario : `workflows.graph` et `workflows.draft_graph`.
  'web/components/WorkflowConfigPanel.tsx': ['scenario'],
  // La bibliothèque RCS (`rcs_messages`), et la création en ligne d'une campagne qui en reprend le contenu.
  'web/components/RcsMessageForm.tsx': ['message_rcs', 'campagne'],
  'web/components/RcsCarouselForm.tsx': ['message_rcs', 'campagne'],
  // La Chaîne WhatsApp (Channels Me) : la publication part TOUT DE SUITE chez le fournisseur, son `media_url` pointe sur
  // `/m/`, et rien n'est enregistré chez nous qu'une suppression pourrait lire. Aucun lieu ; la suppression douce de
  // 30 jours couvre une relecture tardive de l'adresse par le fournisseur (relecture du lot B, jaune n° 3).
  'web/components/ChaineComposeur.tsx': [],
  // L'étape « contenu » de l'assistant de campagne : son brouillon (`campaign_drafts.state`), puis la campagne créée
  // (`campaigns.rcs_message`). L'assistant lui-même ne pose pas le champ, il ne le cite qu'en commentaire.
  'web/components/campagne/EtapeContenu.tsx': ['brouillon_campagne', 'campagne'],
};

const RACINE = resolve(__dirname, '..');
const IGNORES = new Set(['node_modules', '.next', 'e2e']);

function ecransQuiTeleversent(): string[] {
  const trouves: string[] = [];
  const parcourir = (dossier: string): void => {
    for (const e of readdirSync(dossier, { withFileTypes: true })) {
      if (IGNORES.has(e.name)) continue;
      const chemin = join(dossier, e.name);
      if (e.isDirectory()) parcourir(chemin);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'ChampImageHebergee.tsx'
        // La BALISE, pas le mot : un module qui cite le composant dans un commentaire ne téléverse rien.
        && /<ChampImageHebergee\b/.test(readFileSync(chemin, 'utf8'))) {
        trouves.push(chemin.slice(RACINE.length + 1).split(sep).join('/'));
      }
    }
  };
  parcourir(join(RACINE, 'web'));
  return trouves.sort();
}

describe('🔴 chaque écran qui téléverse dans la médiathèque est rattaché à un lieu que la suppression vérifie', () => {
  it('l’inventaire n’est pas vide, sinon ce test ne prouverait rien', () => {
    expect(ecransQuiTeleversent().length).toBeGreaterThan(0);
  });

  it('les écrans trouvés dans web/ sont exactement ceux de la liste', () => {
    expect(ecransQuiTeleversent()).toEqual(Object.keys(LIEUX_DES_ECRANS).sort());
  });

  it('chaque lieu cité est un lieu que `utilisations` interroge, et aucun lieu interrogé n’est orphelin', () => {
    const cites = new Set(Object.values(LIEUX_DES_ECRANS).flat());
    for (const l of cites) expect(LIEUX_UTILISATION).toContain(l);
    for (const l of LIEUX_UTILISATION) expect(cites.has(l), `lieu ${l} interrogé sans écran`).toBe(true);
  });
});

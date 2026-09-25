import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lireContexteAvecReglages } from '../src/agent/contexte';
import { ficheVide } from '../src/agent/fiche';
import type { AgentComplet, FrequenceMentionIa } from '../src/agent/agent-store';
import type { ModeTransfert } from '../src/agent/disponibilite-equipe';
import type { BusinessHours } from '../src/workflow/conditions';

/**
 * LE CÂBLAGE DE LA DISPONIBILITÉ DE L'ÉQUIPE, DANS LES DEUX PROCESSUS (lot 1 du 2026-09-18).
 *
 * 🔴 CE TEST EXISTE PARCE QUE LA DÉPENDANCE EST OPTIONNELLE, ET QUE L'OPTIONNEL NE SE VOIT PAS. Absente,
 * `lireContexteAgent` rend un contexte sans `equipe`, l'agent se croit toujours joignable, et il promet un
 * conseiller à 3 h du matin. Aucun test unitaire ne le verrait : ils appellent tous la fonction en lui
 * passant ce qu'ils veulent. C'est mot pour mot la leçon du dépôt, « une garde qu'on peut débrancher sans
 * qu'aucun test ne tombe n'est pas une garde », vérifiée par mutation sur les deux fichiers.
 *
 * 🔴 ET IL Y EN A DEUX, PAS UN. Le tour de production (`worker.ts`) et le bac à sable de la console
 * (`index.ts`) construisent le contexte par le même point de passage, précisément pour que l'essai montre ce
 * que la production fera. Câbler un seul des deux redonnerait au bac à sable un comportement que la
 * production n'a pas, c'est-à-dire exactement ce que ce point de passage existe pour empêcher.
 *
 * ⚠️ Il LIT LE FICHIER, comme `campagne-cablage.test.ts`, et pour la même raison : ce qui traverse un
 * câblage ne se vérifie pas au type, il se vérifie en le regardant. Les commentaires sont retirés, sans quoi
 * une explication qui CITE le bon code ferait passer un câblage fautif.
 */
const sansCommentaires = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const CABLAGES = [
  { quoi: 'le tour de production', fichier: '../src/worker.ts', tenant: 't' },
  { quoi: 'le bac à sable de la console', fichier: '../src/index.ts', tenant: 'tenant' },
];

/**
 * ⚠️ DEPUIS L'AUDIT PONYTAIL DU 2026-09-25, LA LECTURE VIT DANS `lireContexteAvecReglages`
 * (`src/agent/contexte.ts`) : les deux câblages la recopiaient à l'identique. Ce qui se vérifiait en lisant
 * deux câblages se vérifie donc désormais EN L'EXÉCUTANT, une fois, et les câblages n'ont plus qu'une chose
 * à prouver : qu'ils passent bien par elle, avec les réglages de l'espace.
 */
describe('la disponibilité de l’équipe est câblée', () => {
  for (const { quoi, fichier, tenant } of CABLAGES) {
    it(`🔴 ${quoi} construit le contexte par \`lireContexteAvecReglages\`, sur les réglages de l’espace`, () => {
      expect(sansCommentaires(fichier)).toContain(
        `contexte: (${tenant}, agentId) => lireContexteAvecReglages({ agents: agentStore, outils: toolCatalog, reglages: settingsStore }, ${tenant}, agentId)`,
      );
    });
  }

  const contexte = sansCommentaires('../src/agent/contexte.ts');
  const debut = contexte.indexOf('export async function lireContexteAvecReglages');

  it('⚠️ prend l’heure AU MOMENT DU TOUR', () => {
    // Une disponibilité calculée à l'ouverture d'une conversation serait fausse sur celle qui traverse
    // l'heure de fermeture, c'est-à-dire précisément celles qui nous intéressent.
    expect(debut).toBeGreaterThan(-1);
    expect(contexte.slice(debut)).toMatch(/disponibiliteEquipe: async \(\) => equipePourPrompt\([\s\S]{0,200}new Date\(\)/);
  });

  const fiche = {
    id: 'ag1', label: 'A', status: 'active' as const, mentionIa: 'Je suis une IA.', modele: 'm',
    maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000, inactiviteMinutes: 30,
    contactInconnu: 'lecture_seule' as const, contenu: ficheVide(), ficheVersion: 1,
  } satisfies AgentComplet;
  const SEMAINE: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((j) => [j, { closed: true, open: '09:00', close: '18:00' }]));
  const monter = (reglages: { agentTransfertMode: ModeTransfert | null; mentionIaFrequence: FrequenceMentionIa | null }) => {
    const lectures: string[] = [];
    const deps = {
      agents: { complet: async () => fiche },
      outils: { listActifs: async () => [] },
      reglages: {
        get: async (t: string) => {
          lectures.push(t);
          return { ...reglages, timezone: 'Europe/Paris', businessHours: SEMAINE };
        },
      },
    };
    return { deps, lectures };
  };

  it('🔴 passe la disponibilité au contexte, et lit le RÉGLAGE de l’espace, pas une valeur en dur', async () => {
    // Un câblage qui passerait `'always'` en dur rendrait le réglage de l'écran parfaitement inerte.
    const ferme = monter({ agentTransfertMode: 'never', mentionIaFrequence: null });
    expect((await lireContexteAvecReglages(ferme.deps, 't1', 'ag1'))?.equipe).toEqual({ disponible: false, reouverture: null });
    const ouvert = monter({ agentTransfertMode: 'always', mentionIaFrequence: null });
    expect((await lireContexteAvecReglages(ouvert.deps, 't1', 'ag1'))?.equipe).toEqual({ disponible: true, reouverture: null });
  });

  it('🔴 lit les horaires ET le fuseau de l’espace (dans le texte : un fuseau en dur ne se verrait pas à l’exécution)', () => {
    // Le fuseau décide du jour : sans lui, un samedi soir à Paris se lit comme un vendredi ailleurs, et la
    // réouverture annoncée est fausse d'un jour entier.
    const corps = contexte.slice(debut);
    expect(corps).toContain('reglages.agentTransfertMode ?? MODE_TRANSFERT_DEFAUT');
    expect(corps).toContain('reglages.timezone');
    expect(corps).toContain('reglages.businessHours');
  });

  it('🔴 une semaine entièrement fermée, en mode « heures d’ouverture », rend l’équipe injoignable', async () => {
    // Le fuseau décide du jour, les horaires décident de l'ouverture : une semaine sans aucun créneau est
    // fermée maintenant, quel que soit le jour.
    const m = monter({ agentTransfertMode: 'business_hours', mentionIaFrequence: null });
    expect((await lireContexteAvecReglages(m.deps, 't1', 'ag1'))?.equipe?.disponible).toBe(false);
  });

  it('⚠️ ne lit les réglages QU’UNE FOIS pour les deux politiques d’espace, et sur le BON espace', async () => {
    // Cette fonction est sur le chemin de chaque tour d'agent : deux `get` y feraient deux allers-retours
    // pour la même ligne. La seconde politique est arrivée à côté de la première, c'est le moment exact
    // où l'on duplique une lecture sans s'en apercevoir.
    const m = monter({ agentTransfertMode: 'never', mentionIaFrequence: 'jamais' });
    const ctx = await lireContexteAvecReglages(m.deps, 't1', 'ag1');
    expect(ctx?.mentionIaFrequence).toBe('jamais');
    expect(m.lectures).toEqual(['t1']);
  });
});

/**
 * 🔴 ET LE CÂBLAGE QUI RENDAIT TOUT LE LOT INERTE (revue finale, 2026-09-18).
 *
 * `escalateToHuman` était écrit `async (t, waId) => { await inboxStore.setControlOwner(...); }` : les
 * accolades AVALAIENT le booléen. Or c'est le seul fait qui distingue « c'est nous qui venons de prendre la
 * main » de « un opérateur l'avait déjà prise », et sans lui `run-turn` jetait la dernière phrase de
 * l'agent, celle qui dit au contact que l'équipe est fermée. Tout le lot des horaires était calculé,
 * transporté, affiché dans le bac à sable, et perdu à l'envoi.
 *
 * ⚠️ C'EST LA QUESTION QU'ON POSE À UN CÂBLAGE, qui n'a par construction aucun dépendant : « que
 * suppose-t-il du module que je viens de changer ? ». Ici, que la bascule DIT si elle a eu lieu.
 */
describe('la bascule vers un humain rend son verdict', () => {
  const source = sansCommentaires('../src/worker.ts');

  it('🔴 `escalateToHuman` REND ce que `setControlOwner` a répondu, il ne l’avale pas', () => {
    // ⚠️ `escalade: true` depuis le 2026-09-23 : la prise de fil d'un agent IA est une ESCALADE (migration 0164).
    expect(source).toContain(
      "escalateToHuman: (t, waId) => inboxStore.setControlOwner(t, waId, 'app_human', { only: ['app_workflow'], escalade: true })",
    );
  });

  it('⚠️ et il ne reste aucune forme à accolades, qui rendrait `void` sans que rien ne le signale', () => {
    expect(source).not.toMatch(/escalateToHuman:\s*async\s*\([^)]*\)\s*=>\s*\{/);
  });
});

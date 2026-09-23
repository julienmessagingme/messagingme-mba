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

  it('🔴 un fichier en CRLF se decoupe comme un fichier en LF', () => {
    /**
     * Vecu le 2026-09-11, et le symptome etait le pire possible : ZERO section, sans aucune erreur. Sous
     * Windows, git reecrit les `.md` en CRLF au checkout (`core.autocrlf=true`), et tout outil qui reecrit
     * le fichier fait pareil. Le retour chariot final defaisait le motif de titre, et la detection de
     * derive annoncait que TOUTES les sections citees par les fiches avaient disparu.
     *
     * ⚠️ L assertion compare les DEUX decoupages plutot que de verifier un compte : c est leur EGALITE
     * qui est l invariant, et elle resterait vraie si l exemple changeait.
     */
    const lf = '## Un titre\nDu corps.\n\n## Un autre\nEncore du corps.\n';
    expect(decouperFeatures(lf.replace(/\n/g, '\r\n'))).toEqual(decouperFeatures(lf));
    expect(decouperFeatures(lf)).toHaveLength(2);
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

/**
 * UNE FICHE PEUT DÉRIVER DE PLUSIEURS SECTIONS, séparées par ` | ` dans son en-tête.
 *
 * 🔴 CE QUI A RENDU CETTE FORME NÉCESSAIRE, MESURÉ LE 2026-09-23. La fiche des automations annonçait QUATRE
 * déclencheurs quand l'écran en proposait SEPT, depuis des semaines. La garde n'avait pourtant rien laissé
 * passer : elle surveillait « Automation (menu « Automation ») », et les deux déclencheurs manquants avaient
 * été décrits dans DEUX AUTRES sections de `features.md` (« Rappels avant ou après une date » et
 * « Automatisations »). Une fiche dérivait d'UNE section, alors que l'écran qu'elle documente est alimenté
 * par PLUSIEURS : la section surveillée ne bougeait pas, et rien ne pouvait le dire.
 *
 * ⚠️ `source_section` et `source_empreinte` ne servent qu'ICI et au proposeur : le bot, lui, sert les fiches
 * par leur écran et par la recherche. Les rendre multivalués ne touche donc ni le runtime ni la base, dont
 * la colonne est du texte.
 */
const SEPARATEUR = ' | ';
const listeDe = (v: string | null): string[] =>
  (v === null ? [] : v.split(SEPARATEUR).map((x) => x.trim()).filter((x) => x !== ''));

/**
 * LES SECTIONS QUE LE BOT D'AIDE NE COUVRE PAS, ET POURQUOI.
 *
 * 🔴 ELLE EXISTE POUR QUE L'ABSENCE SOIT UNE DÉCISION, PAS UN OUBLI. Sans elle, une section NEUVE n'est
 * couverte par personne et rien ne le signale : c'est très exactement ce qui est arrivé à « Rappels avant ou
 * après une date », créée sans que la fiche des automations la reprenne. Le test ci-dessous refuse toute
 * section qui ne serait ni citée par une fiche ni listée ici.
 *
 * ⚠️ LES TROIS MOTIFS NE SE VALENT PAS. `interne` et `integrateurs` sont des décisions : ces pages ne
 * s'adressent pas au client de la console, leur donner une fiche serait du bruit. `aucune fiche` est un
 * MANQUE assumé : ces seize sections décrivent des écrans qu'un client ouvre, et le bot n'a rien à lui
 * répondre dessus. C'est un état, pas une cible, et il est écrit pour qu'on le voie.
 */
const SECTIONS_SANS_FICHE: ReadonlyMap<string, 'interne' | 'integrateurs' | 'aucune fiche'> = new Map([
  ['Exploitation `/ops` (interne, hors console client)', 'interne'],
  ["Plafonds d'usage (visible seulement si on force)", 'interne'],
  ['À venir / hors périmètre', 'interne'],
  ['API publique `/v1` (intégrateurs externes)', 'integrateurs'],
  ['Webhooks entrants (menu Tools)', 'integrateurs'],
  ['Brancher vos systèmes : les connecteurs API (menu « Tools » > Connecteurs API)', 'integrateurs'],
  ['Brancher un serveur MCP (menu « Tools » > Connecteurs MCP)', 'integrateurs'],
  ['Serveur MCP : brancher un assistant sur la console (LIVE, 2026-09-01)', 'integrateurs'],
  ['Navigation (trois onglets en haut, barre latérale par onglet)', 'aucune fiche'],
  ['Comptes & authentification', 'aucune fiche'],
  ['Formulaires WhatsApp (WhatsApp Flows, menu Contenu)', 'aucune fiche'],
  ["E-mail (menu Compte > Boîtes email, menu Contenu > Modèles d'email)", 'aucune fiche'],
  ['Analytics (menu Analytics)', 'aucune fiche'],
  ["L'aide de la console (bouton flottant, sur tous les écrans)", 'aucune fiche'],
  ['Support (menu Support)', 'aucune fiche'],
  ['Accueil (1re entrée du menu)', 'aucune fiche'],
  ["L'onglet « Outils » de l'agent de Meta (Meta Business Agent > Paramètres > Outils)", 'aucune fiche'],
  ['Sécurité & compliance (menu Sécurité)', 'aucune fiche'],
  ['Journaux et traces (menu Sécurité)', 'aucune fiche'],
  ['Agent IA (menu « AI Agent » > Other AI agent)', 'aucune fiche'],
  ['MBA, le répondeur de Meta (menu « AI Agent » > MBA, guide / MBA, paramètres)', 'aucune fiche'],
  ['Canal RCS (menu Contenu > Messages RCS, et canal de campagne)', 'aucune fiche'],
  ['Chaîne WhatsApp (menu Chaîne) : publier, et démarrer des conversations', 'aucune fiche'],
]);

/**
 * LES FICHES QUI NE DÉRIVENT D'AUCUNE SECTION, et pourquoi.
 *
 * ⚠️ Une fiche sans section n'est surveillée par RIEN : elle peut devenir fausse sans que personne ne le
 * sache. L'exception se déclare donc, elle ne se constate pas.
 */
const FICHES_SANS_SECTION: ReadonlyMap<string, string> = new Map([
  ['la-fenetre-de-24-heures', 'explique une règle de WhatsApp, pas un écran du produit : aucune section ne la décrit'],
]);

describe('🔴 dérive : une fiche dérivée reste à jour de ses sections', () => {
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
      const noms = listeDe(f.sourceSection);
      const empreintes = listeDe(f.sourceEmpreinte);
      if (noms.length === 0) continue;
      expect(empreintes, `la fiche « ${f.cle} » cite ${noms.length} section(s) et ${empreintes.length} `
        + 'empreinte(s) : il en faut autant de chaque, dans le même ordre.').toHaveLength(noms.length);
      for (const [i, nom] of noms.entries()) {
        const attendue = sections.get(nom);
        expect(attendue, `la fiche « ${f.cle} » cite la section « ${nom} », qui n’existe plus`).toBeTruthy();
        expect(empreintes[i], `la fiche « ${f.cle} » est PÉRIMÉE sur « ${nom} » : cette section a changé `
          + 'depuis sa relecture. La relire, puis mettre son empreinte à jour.').toBe(attendue);
      }
    }
  });

  it('🔴 TOUTE section de features.md est couverte par une fiche, ou déclarée sans fiche', () => {
    /**
     * LA GARDE QUI MANQUAIT, ET C'EST CELLE-CI QUI AURAIT ATTRAPÉ LE DÉFAUT DU 2026-09-23. L'autre compare
     * une fiche à SA section : elle voit une section qui CHANGE, jamais une section NEUVE que personne ne
     * reprend. « Rappels avant ou après une date » est née sans fiche, et la fiche des automations est
     * restée en retard d'un déclencheur sans que rien ne crie.
     *
     * Ce que ce test force : au moment où l'on crée une section, on tranche. Soit une fiche la cite, soit on
     * écrit pourquoi elle n'en a pas. Les deux sont acceptables ; le silence ne l'est pas.
     */
    const citees = new Set(fiches.flatMap((f) => listeDe(f.sourceSection)));
    const orphelines = decouperFeatures(FEATURES)
      .map((s) => s.section)
      .filter((n) => !citees.has(n) && !SECTIONS_SANS_FICHE.has(n));
    expect(orphelines, 'section(s) de features.md que personne ne couvre : soit une fiche la cite dans son '
      + '`source_section`, soit elle entre dans SECTIONS_SANS_FICHE avec sa raison').toEqual([]);
  });

  it('🔴 et la liste des sections sans fiche ne cite aucune section MORTE', () => {
    // Sans ce sens-là, renommer une section laisserait son ancien nom dans la liste, qui deviendrait une
    // dispense permanente pour une section qui n'existe plus, pendant que la neuve passerait inaperçue.
    const reelles = new Set(decouperFeatures(FEATURES).map((s) => s.section));
    const fantomes = [...SECTIONS_SANS_FICHE.keys()].filter((n) => !reelles.has(n));
    expect(fantomes, 'SECTIONS_SANS_FICHE cite des sections qui n’existent plus dans features.md').toEqual([]);
  });

  it('🔴 chaque fiche déclare au moins une section, ou son absence est ÉCRITE', () => {
    // Une fiche sans section n'est surveillée par rien. L'exception reste possible, elle doit être dite.
    const muettes = fiches
      .filter((f) => listeDe(f.sourceSection).length === 0 && !FICHES_SANS_SECTION.has(f.cle))
      .map((f) => f.cle);
    expect(muettes, 'fiche(s) sans `source_section` : lui en donner une, ou déclarer l’exception dans '
      + 'FICHES_SANS_SECTION avec sa raison').toEqual([]);
  });

  it('⚠️ et l’exception ne survit pas à la fiche qu’elle dispense', () => {
    const cles = new Set(fiches.map((f) => f.cle));
    const mortes = [...FICHES_SANS_SECTION.keys()].filter((c) => !cles.has(c));
    expect(mortes, 'FICHES_SANS_SECTION dispense des fiches qui n’existent plus').toEqual([]);
  });

  it('les trois motifs de SECTIONS_SANS_FICHE disent ce qu’ils veulent dire', () => {
    // `aucune fiche` est un MANQUE, pas une décision : le compte est écrit pour qu'on le voie bouger.
    const manques = [...SECTIONS_SANS_FICHE.values()].filter((m) => m === 'aucune fiche').length;
    expect(manques, 'le nombre de sections sans fiche a changé : c’est peut-être une bonne nouvelle '
      + '(une fiche de plus), auquel cas ajustez ce chiffre').toBe(15);
  });

  it('⚠️ une fiche qui cite une section DOIT porter son empreinte', () => {
    // Sans empreinte, la fiche échapperait au contrôle ci-dessus en silence, et ce serait le moyen le plus
    // simple de faire taire la détection de dérive.
    for (const f of fiches) {
      if (listeDe(f.sourceSection).length === 0) continue;
      expect(f.sourceEmpreinte, `la fiche « ${f.cle} » cite une section sans porter son empreinte`).not.toBeNull();
    }
  });
});

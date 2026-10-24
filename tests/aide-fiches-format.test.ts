import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { lireFicheDuDepot, publicationDe, type PublicationFiche, type Rubrique } from '../src/aide/fiches';
import { erreursDeStructure } from '../src/aide/structure';
import { chargerCarte } from '../src/aide/carte';

/**
 * LE CONTENU DES FICHES D'AIDE, vérifié comme du code.
 *
 * 🔴 CES FICHES SONT LUES PAR DES CLIENTS, et c'est ce qui rend ce test obligatoire. Notre documentation
 * interne parle de migrations, de fichiers source et d'incidents datés ; une fiche qui en garde un morceau
 * expose notre cuisine à un client, ou le renvoie vers quelque chose qu'il ne peut pas voir. La parade n'est
 * pas « relire attentivement », parce qu'une relecture attentive se relâche au dixième fichier : c'est ce
 * test, qui ne se relâche pas.
 *
 * ⚠️ LES FICHES SONT LA SOURCE, LA BASE EST L'INDEX. Elles vivent dans le dépôt, donc leur relecture est un
 * diff git : versionnée, attribuable, réversible, et faite là où l'on relit déjà tout le reste. C'est ce qui
 * a permis de supprimer l'écran d'administration que la conception prévoyait d'abord.
 */
const DOSSIER = new URL('../docs/aide/fiches/', import.meta.url);
const fichiers = readdirSync(DOSSIER).filter((n) => n.endsWith('.md'));

/**
 * Ce qui trahit une fiche recopiée de notre documentation interne.
 *
 * ⚠️ Cette liste se COMPLÈTE quand on trouve une nouvelle fuite, elle ne se raccourcit pas pour faire passer
 * une fiche. Une fiche qui déclenche un de ces motifs se réécrit, elle ne se blanchit pas.
 */
const MARQUEURS_INTERNES: Array<[RegExp, string]> = [
  [/db\/migrations\//, 'un chemin de migration'],
  [/\bsrc\//, 'un chemin du code serveur'],
  [/\bweb\//, 'un chemin du code front'],
  [/migration \d{3,4}/i, 'un numéro de migration'],
  [/\bvécu le\b/i, 'un récit d’incident interne'],
  [/\.tsx?\b/, 'un nom de fichier TypeScript'],
  [/\bcommit\b/i, 'du vocabulaire de dépôt'],
  [/\bpooler\b/i, 'du vocabulaire d’infrastructure'],
  [/\bpg-boss\b/i, 'du vocabulaire d’infrastructure'],
  [/\bUChat\b/i, 'le nom de l’infrastructure sous-jacente, invisible du client'],
];

describe('les fiches d’aide', () => {
  it('il y en a au moins une', () => {
    // Garde-fou du test lui-même : sur un dossier vide, toutes les boucles ci-dessous passeraient sans rien
    // vérifier, et ce fichier annoncerait une garantie qu'il n'apporte pas.
    expect(fichiers.length).toBeGreaterThan(0);
  });

  it('🔴 aucune ne contient de marqueur INTERNE', () => {
    for (const nom of fichiers) {
      const texte = readFileSync(new URL(nom, DOSSIER), 'utf8');
      for (const [motif, quoi] of MARQUEURS_INTERNES) {
        expect(motif.test(texte), `${nom} contient ${quoi} (${motif})`).toBe(false);
      }
    }
  });

  it('🔴 chaque `ecran` désigne un écran RÉEL de la carte', () => {
    // Une fiche qui pointe vers un écran disparu ferait produire au bot un lien mort, c'est-à-dire
    // exactement la faute que toute cette conception cherche à rendre impossible.
    const cles = new Set(chargerCarte().map((e) => e.cle));
    for (const nom of fichiers) {
      const f = lireFicheDuDepot(nom, readFileSync(new URL(nom, DOSSIER), 'utf8'));
      if (f.ecran === null) continue;
      expect(cles.has(f.ecran), `${nom} pointe vers l’écran « ${f.ecran} », absent de la carte`).toBe(true);
    }
  });

  it('chaque fiche a un titre et un corps qui disent quelque chose', () => {
    for (const nom of fichiers) {
      const f = lireFicheDuDepot(nom, readFileSync(new URL(nom, DOSSIER), 'utf8'));
      expect(f.titre.trim(), `${nom} sans titre`).not.toBe('');
      expect(f.corps.trim().length, `${nom} a un corps trop court pour répondre à quoi que ce soit`)
        .toBeGreaterThan(80);
    }
  });

  it('⚠️ aucun tiret cadratin ni demi-cadratin', () => {
    // Même règle que le reste de la documentation du dépôt : c'est un marqueur « écrit par IA », repérable
    // immédiatement, et ces fiches sont la voix du produit.
    for (const nom of fichiers) {
      const texte = readFileSync(new URL(nom, DOSSIER), 'utf8');
      expect(/[—–]/.test(texte), `${nom} contient un tiret long`).toBe(false);
    }
  });

  it('🔴 aucun résidu d’en-tête ne se retrouve dans le CORPS', () => {
    // Une fiche sans rien à déclarer porte un en-tête VIDE (`---` suivi de `---`). La première version du
    // lecteur ne le reconnaissait pas et laissait les deux tirets dans le corps, donc sous les yeux du
    // client. Ce test garde le cas quelle que soit la façon dont le lecteur sera réécrit.
    for (const nom of fichiers) {
      const f = lireFicheDuDepot(nom, readFileSync(new URL(nom, DOSSIER), 'utf8'));
      expect(f.corps.trimStart().startsWith('---'), `${nom} garde un résidu d’en-tête dans son corps`).toBe(false);
      expect(f.corps).not.toContain('source_empreinte');
    }
  });

  it('⚠️ un en-tête VIDE est reconnu comme tel', () => {
    const f = lireFicheDuDepot('x.md', '---\n---\n# Titre\n\nUn corps.');
    expect(f.corps).toBe('Un corps.');
    expect(f.ecran).toBeNull();
  });

  it('la CLÉ d’une fiche est le nom de son fichier, et elle est unique', () => {
    // C'est elle qui rend le chargement idempotent : recharger met à jour, il ne duplique pas.
    const cles = fichiers.map((nom) => lireFicheDuDepot(nom, readFileSync(new URL(nom, DOSSIER), 'utf8')).cle);
    expect(new Set(cles).size).toBe(cles.length);
    for (const c of cles) expect(c).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('fichesDuDepot', () => {
  it('🔴 le chargeur VOIT les fiches du dépôt', async () => {
    // Le chargeur construit son chemin depuis `db/`, ce test depuis `tests/`. Un chemin faux ne se verrait
    // qu'au déploiement, au moment où le bot répondrait « je ne sais pas » à tout, et on chercherait le
    // défaut dans le modèle.
    const { fichesDuDepot } = await import('../db/charger-aide');
    const lues = fichesDuDepot();
    expect(lues.length).toBe(fichiers.length);
    expect(lues.map((f) => f.cle)).toContain('lancer-une-campagne');
  });
});

describe('lireFicheDuDepot', () => {
  const exemple = [
    '---',
    'ecran: campagnes',
    'source_section: Campagnes',
    'source_empreinte: 8f2a1c',
    '---',
    '# Lancer une campagne',
    '',
    'Une campagne envoie un message à une liste de contacts.',
  ].join('\n');

  it('lit l’en-tête, le titre et le corps', () => {
    const f = lireFicheDuDepot('lancer-une-campagne.md', exemple);
    expect(f).toEqual({
      cle: 'lancer-une-campagne',
      titre: 'Lancer une campagne',
      corps: 'Une campagne envoie un message à une liste de contacts.',
      ecran: 'campagnes',
      sourceSection: 'Campagnes',
      sourceEmpreinte: '8f2a1c',
    });
  });

  it('⚠️ un en-tête ABSENT ne jette pas : la fiche existe, elle ne pointe simplement vers aucun écran', () => {
    // Une fiche mal formée qui ferait échouer le chargement priverait le bot de TOUTES les autres. Le
    // défaut sûr est de charger ce qu'on comprend ; le test de format, lui, refuse le fichier en amont.
    const f = lireFicheDuDepot('sans-entete.md', '# Un titre\n\nDu texte.');
    expect(f.titre).toBe('Un titre');
    expect(f.corps).toBe('Du texte.');
    expect(f.ecran).toBeNull();
  });

  it('un champ VIDE vaut absent, il ne vaut pas la chaîne vide', () => {
    // Sans ça, `ecran: ` produirait une clé d'écran vide, que la carte ne résoudrait jamais et que personne
    // ne verrait, au lieu d'une fiche honnêtement sans écran.
    const f = lireFicheDuDepot('x.md', '---\necran:   \n---\n# T\n\nCorps.');
    expect(f.ecran).toBeNull();
  });

  it('le titre reste hors du corps : il est déjà donné au modèle à part', () => {
    // Le laisser dans le corps le ferait compter deux fois dans la vectorisation et dans le rappel lexical,
    // ce qui avantagerait les fiches au titre long sans aucune raison.
    const f = lireFicheDuDepot('x.md', '# Mon titre\n\nMon corps.');
    expect(f.corps).toBe('Mon corps.');
  });
});

/**
 * LES FICHES PUBLIQUES (plan du centre d'aide, tâche 3). Une fiche marquée `publique: oui` devient une page de la
 * vitrine : elle suit la grammaire de `src/aide/structure.ts`, et la première vague est celle que Julien a validée.
 */
describe('les fiches publiques', () => {
  /**
   * La première vague (plan, « Global Constraints ») : rubrique et rang. Puis la boutique Shopify, rendue publique le
   * 2026-10-24 (conception `2026-10-23-vitrine-shopify-design.md`, lot 1).
   */
  const VAGUE: Record<string, [Rubrique, number]> = {
    'choisir-mon-offre': ['demarrer', 1],
    'ce-qu-il-faut-chez-meta': ['demarrer', 2],
    'connecter-mon-numero-whatsapp': ['demarrer', 3],
    'me-reperer-dans-la-console': ['demarrer', 4],
    'repondre-dans-l-inbox': ['parler-aux-clients', 1],
    'la-fenetre-de-24-heures': ['parler-aux-clients', 2],
    'faire-approuver-un-modele': ['parler-aux-clients', 3],
    'importer-mes-contacts': ['parler-aux-clients', 4],
    'lancer-une-campagne': ['parler-aux-clients', 5],
    'brancher-ma-boutique-shopify': ['parler-aux-clients', 6],
  };
  /** Les six écrans qui portent « Comment faire », et leur page. */
  const COMMENT_FAIRE: Record<string, string> = {
    accueil: 'connecter-mon-numero-whatsapp',
    offre: 'choisir-mon-offre',
    inbox: 'repondre-dans-l-inbox',
    templates: 'faire-approuver-un-modele',
    contacts: 'importer-mes-contacts',
    campagnes: 'lancer-une-campagne',
  };
  const texteDe = (nom: string) => readFileSync(new URL(nom, DOSSIER), 'utf8');
  const publiques = fichiers
    .map((nom) => ({ nom, cle: nom.replace(/\.md$/, ''), texte: texteDe(nom), publication: publicationDe(texteDe(nom)) }))
    .filter((f): f is typeof f & { publication: PublicationFiche } => f.publication !== null);

  it('la première vague, et elle seule, est publique, à sa place', () => {
    expect(Object.fromEntries(publiques.map((f) => [f.cle, [f.publication.rubrique, f.publication.rang]]))).toEqual(VAGUE);
  });

  it('🔴 chaque fiche publique suit la grammaire : aucune étape ne se perdrait en simple paragraphe', () => {
    for (const f of publiques) {
      expect(erreursDeStructure(lireFicheDuDepot(f.nom, f.texte).corps, 'fr'), f.cle).toEqual([]);
    }
  });

  it('« Comment faire » : une page par écran, sur les six écrans prévus', () => {
    const vus: Record<string, string> = {};
    for (const f of publiques.filter((x) => x.publication.commentFaire)) {
      const ecran = lireFicheDuDepot(f.nom, f.texte).ecran;
      expect(ecran, `${f.cle} est la page d’un écran, il lui faut son ecran`).not.toBeNull();
      expect(vus[ecran!], `deux pages pour l’écran ${ecran}`).toBeUndefined();
      vus[ecran!] = f.cle;
    }
    expect(vus).toEqual(COMMENT_FAIRE);
  });

  it('les pages sans capture et sans mention d’offre sont celles prévues', () => {
    expect(publiques.filter((f) => !f.publication.captures).map((f) => f.cle).sort())
      .toEqual(['ce-qu-il-faut-chez-meta', 'la-fenetre-de-24-heures']);
    expect(publiques.filter((f) => !f.publication.offre).map((f) => f.cle).sort())
      .toEqual(['ce-qu-il-faut-chez-meta', 'choisir-mon-offre', 'la-fenetre-de-24-heures']);
  });

  it('un prérequis désigne une autre fiche publique', () => {
    const cles = new Set(publiques.map((f) => f.cle));
    for (const f of publiques.filter((x) => x.publication.prerequis !== null)) {
      expect(cles.has(f.publication.prerequis!), `${f.cle} -> ${f.publication.prerequis}`).toBe(true);
      expect(f.publication.prerequis).not.toBe(f.cle);
    }
  });

  it('publicationDe lève sur un champ mal écrit, en le nommant', () => {
    const fiche = (entete: string) => `---\npublique: oui\n${entete}\n---\n# T\n\nC.`;
    expect(() => publicationDe(fiche('rubrique: autre\nrang: 1'))).toThrow(/rubrique/);
    expect(() => publicationDe(fiche('rubrique: demarrer\nrang: 0'))).toThrow(/rang/);
    expect(() => publicationDe(fiche('rubrique: demarrer\nrang: 2\ncaptures: peut-etre'))).toThrow(/captures/);
    expect(publicationDe('---\necran: offre\n---\n# T\n\nC.')).toBeNull();
    expect(() => publicationDe(fiche('rubrique: demarrer\nrang: 2\nclaude_code: si'))).toThrow(/claude_code/);
    expect(publicationDe(fiche('rubrique: demarrer\nrang: 2'))).toEqual({
      rubrique: 'demarrer', rang: 2, commentFaire: false, captures: true, video: false, prerequis: null, offre: true,
      claudeCode: false,
    });
    expect(publicationDe(fiche('rubrique: demarrer\nrang: 2\nclaude_code: oui'))?.claudeCode).toBe(true);
  });
});

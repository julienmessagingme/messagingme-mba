import { gardeOuverte } from './gardes';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { registerMbaAssistant, type MbaAssistantDeps } from '../src/http/mba-assistant';
import { calculerCompletion } from '../src/mba/completion';
import {
  magasinPiecesJointes, typeMetaDuContenu, DUREE_PIECE_MS, MAX_PIECES_PAR_ESPACE, MAX_OCTETS_MAGASIN,
  MAX_FICHIER,
} from '../src/mba/assistant/pieces-jointes';
import { appliquer, ERREUR_PIECE_ABSENTE, raisonLisible, type ApplicationDeps } from '../src/mba/assistant/application';
import { MBA_ASSISTANT_FILE_ACCEPT, MBA_FILE_ACCEPT } from '../web/lib/mba-files';
import { zipSync, strToU8 } from 'fflate';

/**
 * LES PIÈCES JOINTES DU MBA.
 *
 * 🔴 CE QUI EST ÉPROUVÉ ICI EST UN ORDRE, PAS UNE FONCTION : le dépôt n'écrit RIEN chez Meta, l'écriture
 * n'arrive qu'à l'acceptation du diff. Un test qui vérifierait seulement « le fichier est bien monté »
 * passerait tout aussi bien sur la version qui envoie tout de suite, c'est-à-dire sur le défaut.
 */

/** Un PDF minimal : la SIGNATURE est ce qui compte, pas la validité du document. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('x'.repeat(64))]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x'.repeat(64))]);
const GIF = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38]), Buffer.from('x'.repeat(64))]);
const TEXTE = Buffer.from('ville;code\nLille;59000\n');

const dataUrl = (mimeDeclare: string, b: Buffer) => `data:${mimeDeclare};base64,${b.toString('base64')}`;

function monter(sur: Partial<MbaAssistantDeps> = {}, opts: { role?: string } = {}) {
  const journal = { montes: [] as Array<{ nom: string; taille: number }> };
  const pieces = magasinPiecesJointes();

  const application = (): ApplicationDeps => ({
    numeroDuTenant: async () => '123',
    client: async () => ({
      listFaqs: async () => [], createFaq: async () => ({}), updateFaq: async () => ({}), deleteFaq: async () => {},
      listSkills: async () => [], createSkill: async () => ({}), updateSkill: async () => ({}), deleteSkill: async () => {},
      listWebsites: async () => [], createWebsite: async () => ({}), deleteWebsite: async () => {},
      listFiles: async () => [], deleteFile: async () => {},
      uploadFile: async (_p: string, nom: string, contenu: Blob) => {
        journal.montes.push({ nom, taille: contenu.size });
        return {};
      },
      getBusinessInfo: async () => ({}), putBusinessInfo: async () => ({}),
      getSettings: async () => ({}), putSettings: async () => ({}),
    } as never),
    journaliser: async () => {},
    pieceJointe: async (t: string, jeton: string) => pieces.reprendre(t, jeton),
    acteur: { id: 'u1', email: null },
  });

  const deps: MbaAssistantDeps = {
    inventaire: async () => ({
      completion: calculerCompletion({
        settings: {} as never, businessInfo: { business_description: '' } as never,
        faqs: [], skills: [], websites: [], files: [],
      }),
      resume: { description: '', faqs: [], competences: [], sites: [], fichiers: [], enService: false },
    }),
    entretiens: { lire: async () => null, ecrire: async () => {}, effacer: async () => {} },
    depenses: { lire: async () => 0, ajouter: async () => {} },
    plafondEuros: 2,
    modele: 'test/modele',
    tauxEurParDollar: 0.92,
    agentIdDuTenant: async () => 'ag-1',
    pieces,
    application,
    ...sur,
  };

  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { auth?: unknown }).auth = { userId: 'u1', tenantId: 't1', role: opts.role ?? 'admin' };
  });
  registerMbaAssistant(app, deps, gardeOuverte);
  return { app, journal, pieces };
}

const deposer = (app: ReturnType<typeof monter>['app'], nom: string, mime: string, b: Buffer) =>
  app.inject({ method: 'POST', url: '/tenants/t1/mba/assistant/piece-jointe', payload: { nom, dataUrl: dataUrl(mime, b) } });

describe('le dépôt', () => {
  it('🔴 n’écrit RIEN chez Meta : il rend une opération pour le diff', async () => {
    const m = monter();
    const r = await deposer(m.app, 'manuel.pdf', 'application/pdf', PDF);
    expect(r.statusCode).toBe(201);
    expect(r.json().operation).toMatchObject({ type: 'fichier.ajouter', nom: 'manuel.pdf', libelle: 'Document : manuel.pdf' });
    expect(r.json().operation.jeton).toMatch(/^[a-f0-9]{32}$/);
    // 🔴 LE POINT DU LOT : rien n'est monté tant que le diff n'est pas accepté.
    expect(m.journal.montes).toEqual([]);
  });

  it('🔴 et c’est SEULEMENT à l’application que le fichier part', async () => {
    const m = monter();
    const { operation } = (await deposer(m.app, 'manuel.pdf', 'application/pdf', PDF)).json();
    const r = await m.app.inject({
      method: 'POST', url: '/tenants/t1/mba/assistant/appliquer',
      payload: { operations: [{ type: 'fichier.ajouter', jeton: operation.jeton, nom: 'manuel.pdf' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().echec).toBeNull();
    expect(m.journal.montes).toEqual([{ nom: 'manuel.pdf', taille: PDF.length }]);
  });

  it('un non-admin ne dépose rien', async () => {
    const m = monter({}, { role: 'agent' });
    expect((await deposer(m.app, 'manuel.pdf', 'application/pdf', PDF)).statusCode).toBe(403);
  });

  it('⚠️ sans magasin, 503 : le reste de la conversation continue', async () => {
    const m = monter({ pieces: undefined });
    expect((await deposer(m.app, 'manuel.pdf', 'application/pdf', PDF)).statusCode).toBe(503);
  });
});

describe('le type vient de la SIGNATURE', () => {
  it('🔴 un exécutable renommé en .pdf et déclaré PDF est refusé', async () => {
    // Le navigateur peut déclarer ce qu'il veut : ce sont les octets qui décident.
    const m = monter();
    const faux = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const r = await deposer(m.app, 'manuel.pdf', 'application/pdf', faux);
    expect(r.statusCode).toBe(415);
    expect(m.journal.montes).toEqual([]);
  });

  it('🔴 un PNG renommé .pdf est refusé : le NOM doit suivre le contenu', async () => {
    // Meta garde `file_name` à part du binaire : un nom incohérent fait échouer l'ingestion en silence.
    const r = await deposer(monter().app, 'manuel.pdf', 'image/png', PNG);
    expect(r.statusCode).toBe(415);
    expect(r.json().error).toMatch(/\.png/);
  });

  it('⚠️ un GIF est refusé ici alors que sa signature est valide : Meta ne le prend pas', async () => {
    const r = await deposer(monter().app, 'photo.gif', 'image/gif', GIF);
    expect(r.statusCode).toBe(415);
  });

  it('un texte nommé .csv passe, le même texte nommé .txt non', () => {
    expect(typeMetaDuContenu(TEXTE, 'villes.csv')).toEqual({ mime: 'text/csv' });
    expect(typeMetaDuContenu(TEXTE, 'notes.txt')).toHaveProperty('refus');
  });

  it('⚠️ le refus NOMME ce que l’onglet Documents accepte en plus', () => {
    const r = typeMetaDuContenu(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x00]), 'vieux.doc');
    expect('refus' in r && r.refus).toMatch(/Documents/);
  });

  it('un fichier trop lourd est refusé en 413, sur les octets DÉCODÉS', async () => {
    const m = monter();
    const gros = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_FICHIER)]);
    const r = await deposer(m.app, 'gros.pdf', 'application/pdf', gros);
    expect(r.statusCode).toBe(413);
  });
});

describe('le jeton', () => {
  it('🔴 inconnu : 422 AVANT d’avoir rien écrit chez Meta', async () => {
    const m = monter();
    const r = await m.app.inject({
      method: 'POST', url: '/tenants/t1/mba/assistant/appliquer',
      payload: {
        operations: [
          { type: 'faq.ajouter', question: 'Horaires ?', reponse: '9h-18h' },
          { type: 'fichier.ajouter', jeton: 'f'.repeat(32), nom: 'manuel.pdf' },
        ],
      },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/manuel\.pdf/);
    // 🔴 La FAQ qui précédait n'a pas été posée : le contrôle passe avant la première écriture.
    expect(m.journal.montes).toEqual([]);
  });

  it('🔴 celui d’un AUTRE espace ne résout pas', () => {
    const pieces = magasinPiecesJointes();
    const jeton = pieces.deposer('t1', { nom: 'a.pdf', mime: 'application/pdf', octets: PDF });
    expect(pieces.contient('t1', jeton)).toBe(true);
    expect(pieces.contient('t2', jeton)).toBe(false);
    expect(pieces.reprendre('t2', jeton)).toBeNull();
  });

  it('🔴 un tenant vide ne résout rien non plus', () => {
    // La garde qui aurait attrapé le `pieceJointe('', jeton)` d'une révision de ce lot.
    const pieces = magasinPiecesJointes();
    const jeton = pieces.deposer('t1', { nom: 'a.pdf', mime: 'application/pdf', octets: PDF });
    expect(pieces.reprendre('', jeton)).toBeNull();
  });

  it('expire au bout de deux heures', () => {
    let t = 1_000_000;
    const pieces = magasinPiecesJointes(() => t);
    const jeton = pieces.deposer('t1', { nom: 'a.pdf', mime: 'application/pdf', octets: PDF });
    t += DUREE_PIECE_MS - 1;
    expect(pieces.contient('t1', jeton)).toBe(true);
    t += 1;
    expect(pieces.contient('t1', jeton)).toBe(false);
  });

  it('⚠️ une reprise ne CONSOMME pas : un diff réessayé remonte le même document', () => {
    const pieces = magasinPiecesJointes();
    const jeton = pieces.deposer('t1', { nom: 'a.pdf', mime: 'application/pdf', octets: PDF });
    expect(pieces.reprendre('t1', jeton)).not.toBeNull();
    expect(pieces.reprendre('t1', jeton)).not.toBeNull();
  });

  it('le magasin est BORNÉ par espace, et la borne ne touche pas les voisins', () => {
    const pieces = magasinPiecesJointes();
    const jetons = Array.from({ length: MAX_PIECES_PAR_ESPACE + 1 }, (_, i) =>
      pieces.deposer('t1', { nom: `f${i}.pdf`, mime: 'application/pdf', octets: PDF }));
    const chezLAutre = pieces.deposer('t2', { nom: 'autre.pdf', mime: 'application/pdf', octets: PDF });
    expect(pieces.contient('t1', jetons[0]!)).toBe(false); // la plus ancienne est partie
    expect(pieces.contient('t1', jetons[jetons.length - 1]!)).toBe(true);
    expect(pieces.contient('t2', chezLAutre)).toBe(true);
  });
});

describe('la borne GLOBALE du magasin', () => {
  it('🔴 elle existe : la borne par espace grandit avec le nombre de clients, pas la mémoire du process', () => {
    const pieces = magasinPiecesJointes();
    const gros = Buffer.alloc(16 * 1024 * 1024);
    // Six espaces différents, donc hors d'atteinte de la borne PAR ESPACE (5 pièces chacun).
    const jetons = Array.from({ length: 6 }, (_, i) =>
      [`t${i}`, pieces.deposer(`t${i}`, { nom: 'g.pdf', mime: 'application/pdf', octets: gros })] as const);
    // 6 x 16 Mo = 96 Mo > 64 Mo : les plus anciennes sont parties, la dernière est là.
    expect(pieces.contient(...jetons[0]!)).toBe(false);
    expect(pieces.contient(...jetons[jetons.length - 1]!)).toBe(true);
    expect(MAX_OCTETS_MAGASIN).toBe(64 * 1024 * 1024);
  });

  it('⚠️ et elle n’évince JAMAIS la pièce qu’on vient de déposer', () => {
    // Sinon le jeton rendu serait mort dans la seconde, sur le seul dépôt dont on est sûr qu'il sert.
    const pieces = magasinPiecesJointes();
    const enorme = Buffer.alloc(MAX_OCTETS_MAGASIN + 1);
    const jeton = pieces.deposer('t1', { nom: 'g.pdf', mime: 'application/pdf', octets: enorme });
    expect(pieces.contient('t1', jeton)).toBe(true);
  });
});

describe('le message quand ça casse', () => {
  it('🔴 n’accuse PAS Meta d’un jeton expiré chez nous', () => {
    expect(raisonLisible(new Error(ERREUR_PIECE_ABSENTE))).toMatch(/redéposez/i);
    expect(raisonLisible(new Error('(#131000) blocked'))).toMatch(/Meta/);
  });

  it('⚠️ l’application transmet le TENANT au magasin, pas une chaîne vide', async () => {
    const vus: string[] = [];
    const deps: ApplicationDeps = {
      numeroDuTenant: async () => '123',
      client: async () => ({ uploadFile: async () => ({}) } as never),
      journaliser: async () => {},
      pieceJointe: async (t: string) => { vus.push(t); return { nom: 'a.pdf', contenu: new Blob(['x']) }; },
      acteur: { id: null, email: null },
    };
    await appliquer(deps, 'tenant-reel', 'ag-1', [{ type: 'fichier.ajouter', jeton: 'a'.repeat(32), nom: 'a.pdf' }]);
    expect(vus).toEqual(['tenant-reel']);
  });
});

/**
 * 🔴 DEUX LISTES DANS DEUX FICHIERS, ET C'EST LEUR ÉCART QUI PORTE L'INVARIANT.
 *
 * Le sélecteur du navigateur propose des extensions ; le serveur décide sur la SIGNATURE. Chacune est
 * plausible seule : proposer un `.xlsx` a l'air correct (l'onglet Documents l'accepte), et le refuser côté
 * serveur a l'air correct aussi. C'est ensemble qu'elles sont fausses, et aucun des deux fichiers ne le
 * montre.
 */
describe('la liste proposée et la liste acceptée', () => {
  /** Un fichier RÉEL par extension proposée : c'est la signature qui est éprouvée, pas le nom. */
  const EXEMPLES: Record<string, Buffer> = {
    pdf: PDF,
    png: PNG,
    jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('x'.repeat(64))]),
    jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('x'.repeat(64))]),
    csv: TEXTE,
    docx: Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:p><w:t>Procedure interne detaillee</w:t></w:p>') })),
  };

  it('🔴 tout ce que le navigateur propose, le serveur l’accepte', () => {
    for (const ext of MBA_ASSISTANT_FILE_ACCEPT.split(',')) {
      const nu = ext.replace('.', '');
      const octets = EXEMPLES[nu];
      expect(octets, `aucun exemple pour ${ext}`).toBeDefined();
      expect(typeMetaDuContenu(octets!, `exemple${ext}`), `${ext} refusé par le serveur`).toHaveProperty('mime');
    }
  });

  it('🔴 et ce que le serveur refuse n’est PAS proposé (.doc, .xlsx)', () => {
    // ⚠️ On compare des ÉLÉMENTS, jamais des sous-chaînes : « .doc » est contenu dans « .docx », et un
    // `toContain` sur la chaîne entière rendrait ce test vert ou rouge pour la mauvaise raison.
    const onglet = MBA_FILE_ACCEPT.split(',');
    const assistant = MBA_ASSISTANT_FILE_ACCEPT.split(',');
    for (const ext of ['.doc', '.xlsx']) {
      // Ils sont bien dans l'onglet Documents : l'écart entre les deux écrans est voulu, pas un oubli.
      expect(onglet).toContain(ext);
      expect(assistant).not.toContain(ext);
    }
    // Et rien ne s'est glissé dans l'assistant qui ne soit pas dans l'onglet.
    for (const ext of assistant) expect(onglet).toContain(ext);
  });
});

/**
 * 🔴 LA GARDE DE CÂBLAGE, comme au lot B : un moteur monté nulle part est un moteur mort, et aucun test
 * unitaire ne peut le voir puisqu'ils montent tous un faux câblage.
 */
describe('le vrai câblage', () => {
  const index = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');

  it('🔴 le magasin est construit UNE fois et partagé par le dépôt et l’application', () => {
    expect(index).toContain('const piecesJointesMba = magasinPiecesJointes()');
    expect(index).toContain('pieces: piecesJointesMba');
    expect(index).toContain('piecesJointesMba.reprendre(t, jeton)');
    // Deux constructions séparées rendraient tout jeton introuvable à l'application, sans erreur visible.
    expect(index.match(/magasinPiecesJointes\(\)/g) ?? []).toHaveLength(1);
  });
});

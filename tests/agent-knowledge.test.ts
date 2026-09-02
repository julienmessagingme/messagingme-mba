import { describe, it, expect } from 'vitest';
import { creerResolveurMba, type DepsResolveurMba } from '../src/agent/resolvers/mba';
import {
  COUVERTURE_MIN, MIN_TERMES_COMMUNS, PROXIMITE_TITRE_MIN,
  ficheEstPertinente, termesDeRecherche, type FicheTrouvee,
} from '../src/agent/knowledge';
import { SORTIE_SANS_SOURCE } from '../src/agent/sorties';
import type { ContexteAppel } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';

/**
 * Tâche 16bis : le garde-fou anti-hallucination, et il est DÉTERMINISTE.
 *
 * ⚠️ La première version de ces tests fabriquait un « score » et le comparait à un seuil : elle ne pouvait
 * donc pas voir que ce seuil était INERTE en production (toute ligne rendue par le SQL était au-dessus).
 * D'où deux niveaux ici : la RÈGLE se teste sur des mesures, et le fait que la base produise des mesures
 * capables de la déclencher se teste en intégration, contre un vrai Postgres.
 */

const CTX: ContexteAppel = {
  tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
  contact: { wa_id: '33600' },
  contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000, deadline: Date.now() + 30_000,
};

const OUTIL: OutilDefini = {
  id: 'to1', tenantId: 't1', agentId: 'ag1', origin: 'mba', name: 'mba_chercher_connaissance', description: '',
  params: [], binding: { handler: 'chercher_connaissance' }, sourceId: null, requestId: null, nePasUtiliser: '', outputPaths: [],
  risk: 'read', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
};

const fiche = (titre: string, mesures: Partial<FicheTrouvee> = {}): FicheTrouvee => ({
  id: `f-${titre}`, titre, corps: `corps de ${titre}`, sourceUrl: 'https://exemple.test/fiche',
  termesTrouves: 0, couverture: 0, proximiteTitre: 0, ...mesures,
});

function harnais(rendu: FicheTrouvee[] | (() => never)) {
  const vues: Array<{ tenantId: string; agentId: string; requete: string; limite: number }> = [];
  const deps: DepsResolveurMba = {
    envoyerBloc: async () => ({ ok: true }),
    escaladerVersHumain: async () => {},
    poserTag: async () => {},
    ecrireChamp: async () => {},
    connaissance: {
      chercher: async (tenantId, agentId, requete, limite) => {
        vues.push({ tenantId, agentId, requete, limite });
        return typeof rendu === 'function' ? rendu() : rendu;
      },
    },
  };
  return { resolveur: creerResolveurMba(deps), vues };
}

const appel = (args: Record<string, unknown>) =>
  ({ outil: OUTIL, args, ctx: CTX, signal: new AbortController().signal });

describe('la règle de pertinence (tâche 16bis)', () => {
  it('deux mots communs suffisent, un seul ne suffit PAS', () => {
    // C'est LA règle qui écarte la fiche partageant un mot incident avec la question. Un compte et non une
    // proportion : une question polie et bavarde ne doit pas être punie pour sa longueur.
    expect(ficheEstPertinente(fiche('deux', { termesTrouves: 2, couverture: 2 / 9 }))).toBe(true);
    expect(ficheEstPertinente(fiche('un seul', { termesTrouves: 1, couverture: 1 / 9 }))).toBe(false);
  });

  it('une question COURTE passe par la couverture, même avec un seul mot commun', () => {
    // « la piscine ? » : un seul terme signifiant, retrouvé. Sans cette seconde raison, la question la plus
    // simple du monde serait transférée à un humain.
    expect(ficheEstPertinente(fiche('piscine', { termesTrouves: 1, couverture: 1 }))).toBe(true);
    expect(ficheEstPertinente(fiche('moitié', { termesTrouves: 1, couverture: COUVERTURE_MIN }))).toBe(true);
    expect(ficheEstPertinente(fiche('sous la moitié', { termesTrouves: 1, couverture: COUVERTURE_MIN - 0.01 }))).toBe(false);
  });

  it('un titre très proche rattrape la faute de frappe, là où le plein texte ne trouve rien', () => {
    expect(ficheEstPertinente(fiche('parkin', { termesTrouves: 0, proximiteTitre: PROXIMITE_TITRE_MIN }))).toBe(true);
    expect(ficheEstPertinente(fiche('trop loin', { termesTrouves: 0, proximiteTitre: PROXIMITE_TITRE_MIN - 0.01 }))).toBe(false);
  });

  it('les trois seuils sont des bornes INCLUSIVES, et rien ne passe en dessous', () => {
    expect(ficheEstPertinente(fiche('pile', { termesTrouves: MIN_TERMES_COMMUNS }))).toBe(true);
    expect(ficheEstPertinente(fiche('rien', {}))).toBe(false);
  });

  it('🔴 le cas adverse de la revue : un mot incident partagé ne fait PAS une source', () => {
    // « je suis résident depuis deux ans, je peux annuler ma réservation ? » face à la fiche « parking » :
    // le seul mot commun est « résident ». C'est exactement ce que la première version laissait passer.
    const parking = fiche('Le parking', { termesTrouves: 1, couverture: 1 / 6, proximiteTitre: 0.08 });
    expect(ficheEstPertinente(parking)).toBe(false);
  });
});

describe('mba_chercher_connaissance : l agent ne répond que depuis ses sources', () => {
  it('question COUVERTE : les fiches repartent au modèle, et AUCUNE sortie n est demandée', async () => {
    const { resolveur, vues } = harnais([
      fiche('Piscine', { termesTrouves: 2, couverture: 1, corps: 'ouverte de 9 h à 20 h' } as Partial<FicheTrouvee>),
    ]);
    const r = await resolveur(appel({ requete: 'horaires piscine' }));
    expect(r.sortie).toBeUndefined();
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toEqual({
      sources: [{ titre: 'Piscine', contenu: 'ouverte de 9 h à 20 h', url: 'https://exemple.test/fiche' }],
    });
    // Le tenant ET l'agent sont passés au store : c'est le seul contrôle d'isolation (pooler superuser).
    expect(vues[0]).toMatchObject({ tenantId: 't1', agentId: 'ag1', requete: 'horaires piscine' });
  });

  it('🔴 question HORS SUJET : aucune source, sortie sans_source', async () => {
    // La base ne rend rien du tout (son `where` est un filtre, pas un tri). C'est ce cas-là qui porte la
    // garantie, et il ne dépend d'aucun réglage.
    const { resolveur } = harnais([]);
    const r = await resolveur(appel({ requete: 'quelle est la capitale de la Mongolie' }));
    expect(r.contenu).toEqual({ aucune_source: true });
    expect(r.sortie).toBe(SORTIE_SANS_SOURCE);
  });

  it('🔴 des fiches trouvées mais TOUTES non pertinentes valent aucune source', async () => {
    const { resolveur } = harnais([fiche('Le parking', { termesTrouves: 1, couverture: 1 / 6 })]);
    const r = await resolveur(appel({ requete: 'annuler ma reservation' }));
    expect(r.contenu).toEqual({ aucune_source: true });
    expect(r.sortie).toBe(SORTIE_SANS_SOURCE);
  });

  it('les fiches faibles sont RETIRÉES même quand une bonne les accompagne', async () => {
    const { resolveur } = harnais([
      fiche('Piscine', { termesTrouves: 2, couverture: 1 }),
      fiche('Vaguement voisin', { termesTrouves: 1, couverture: 1 / 6 }),
    ]);
    const r = await resolveur(appel({ requete: 'horaires piscine' }));
    const contenu = r.contenu as { sources: Array<{ titre: string }> };
    expect(contenu.sources.map((s) => s.titre)).toEqual(['Piscine']);
  });

  it('les MESURES ne sont jamais montrées au modèle : la décision lui est retirée, pas déléguée', async () => {
    const { resolveur } = harnais([fiche('Piscine', { termesTrouves: 2, couverture: 0.87 })]);
    const rendu = JSON.stringify((await resolveur(appel({ requete: 'piscine' }))).contenu);
    for (const fuite of ['couverture', 'termesTrouves', 'proximite', '0.87']) {
      expect(rendu).not.toContain(fuite);
    }
  });

  it('un corps très long est borné PAR FICHE, et la coupe est annoncée', async () => {
    // Le tronc commun borne la réponse entière, mais sa troncature remplace toute la structure par un
    // aperçu : le modèle recevrait une source mutilée au lieu de sources listées.
    const { resolveur } = harnais([fiche('Longue', { termesTrouves: 2, couverture: 1, corps: 'x'.repeat(9_000) })]);
    const r = await resolveur(appel({ requete: 'piscine horaires' }));
    const contenu = r.contenu as { sources: Array<{ contenu: string }> };
    expect(contenu.sources[0]?.contenu.length).toBeLessThan(2_100);
    expect(contenu.sources[0]?.contenu.endsWith('...')).toBe(true);
  });

  it('la requête est bornée avant d atteindre la base', async () => {
    const { resolveur, vues } = harnais([]);
    await resolveur(appel({ requete: 'piscine '.repeat(500) }));
    expect(vues[0]?.requete.length).toBeLessThanOrEqual(512);
  });

  it('requête manquante ou vide : refus, aucune recherche lancée', async () => {
    const { resolveur, vues } = harnais([]);
    expect((await resolveur(appel({}))).ok).toBe(false);
    expect((await resolveur(appel({ requete: '   ' }))).ok).toBe(false);
    expect(vues).toEqual([]);
  });

  it('un store qui LÈVE remonte au tronc commun, qui le rattrape (il ne tue pas le tour)', async () => {
    // Le contrat du tronc commun est celui-là. Le prouver ici évite d'ajouter un try/catch qui masquerait
    // la panne.
    const { resolveur } = harnais(() => { throw new Error('base injoignable'); });
    await expect(resolveur(appel({ requete: 'piscine' }))).rejects.toThrow('base injoignable');
  });
});

describe('découpage des termes de recherche (sécurité de la requête plein texte)', () => {
  it('🔴 aucun métacaractère de tsquery ne survit', () => {
    // `to_tsquery` LÈVE sur `&`, `|`, `!`, `(`, `)`, `:` et `*`. La requête vient du modèle, donc d un texte
    // qu un contact peut influencer : un seul qui survivrait ferait échouer TOUTE recherche, donc sortirait
    // l agent en `sans_source` en permanence.
    const termes = termesDeRecherche("piscine & parking | !(chambre) : tarif * 'vue'");
    expect(termes).toEqual(['piscine', 'parking', 'chambre', 'tarif', 'vue']);
    for (const t of termes) expect(t).not.toMatch(/[&|!():*'<>]/);
  });

  it('🔴 les accents sont CONSERVÉS', () => {
    // `to_tsvector('french', ...)` les garde : les retirer côté requête casserait le rapprochement.
    expect(termesDeRecherche('résidence à Sète, déjà réservée')).toEqual(['résidence', 'Sète', 'déjà', 'réservée']);
  });

  it('ponctuation seule, chaîne vide, termes d une lettre : rien à chercher', () => {
    expect(termesDeRecherche('')).toEqual([]);
    expect(termesDeRecherche('?!... ,;')).toEqual([]);
    expect(termesDeRecherche('a b c')).toEqual([]);
  });

  it('🔴 les doublons sont retirés AVANT le plafond, sinon une question bavarde perd son sujet', () => {
    // Trouvé en revue : garder les 20 premiers jetons bruts laissait « le », « la », « de » manger la place
    // du mot qui porte la question.
    const bavarde = `${'le la de du et '.repeat(6)} piscine`;
    expect(termesDeRecherche(bavarde)).toContain('piscine');
  });

  it('le plafond tient malgré tout sur une requête vraiment longue', () => {
    const long = Array.from({ length: 60 }, (_, i) => `terme${i}`).join(' ');
    expect(termesDeRecherche(long)).toHaveLength(20);
  });

  it('la casse ne crée pas de doublon', () => {
    expect(termesDeRecherche('Piscine piscine PISCINE')).toEqual(['Piscine']);
  });

  it('chiffres et traits d union : un numéro de résidence reste cherchable', () => {
    expect(termesDeRecherche('residence 2B-14, code 4590')).toEqual(['residence', '2B', '14', 'code', '4590']);
  });
});

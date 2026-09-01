import { describe, it, expect } from 'vitest';
import { entetesQuali, ligneQuali } from './quali-export';
import { toCsv } from './csv';
import type { AnalyzedConversation } from './api';

/**
 * L'export des conversations analysées.
 *
 * Ce qui compte ici n'est pas la mise en forme mais deux propriétés qui rendent le fichier UTILISABLE : le
 * nombre de colonnes doit coller au nombre d'en-têtes (sinon le tableur décale tout, en silence), et une
 * cellule qui contient une virgule, un guillemet ou un retour à la ligne ne doit pas casser la ligne. Un
 * résumé de conversation contient à peu près sûrement les trois.
 */
const CONV: AnalyzedConversation = {
  conversationId: 'cv1',
  waId: '33600000001',
  profileName: 'Léa Martin',
  sentiment: 'negatif',
  intent: 'reclamation',
  topic: 'retard de livraison',
  resolved: false,
  actionSuggestion: 'rappeler',
  confidence: 0.8999999,
  justification: 'Client mécontent, à rappeler',
  handledBy: 'automatise',
  exchangesCount: 7,
  analyzedAt: '2026-08-30T09:15:00.000Z',
  inboxHref: '/inbox?c=cv1',
  summary: 'Le client signale un retard.\nIl demande un "geste commercial", et menace de partir.',
  entities: { commande: 'A-42' },
};

const T = (fr: string) => fr;
const LIBELLES = { sentiment: (v: string) => v, intent: (v: string) => v, action: (v: string) => v };

describe('export CSV des conversations analysées', () => {
  it('🔴 autant de colonnes que d’en-têtes', () => {
    // Un décalage ici ne se voit pas à l'écran : il se découvre dans le tableur du client, avec le résumé
    // rangé sous « Confiance ».
    expect(ligneQuali(CONV, T, LIBELLES)).toHaveLength(entetesQuali(T).length);
  });

  it('🔴 un résumé avec virgule, guillemets et retour à la ligne ne casse pas le fichier', () => {
    const csv = toCsv(entetesQuali(T), [ligneQuali(CONV, T, LIBELLES)]);
    // Le champ est entouré de guillemets et ses guillemets internes sont doublés (RFC 4180).
    expect(csv).toContain('""geste commercial""');
    // Et il n'y a bien que DEUX fins de ligne CRLF « de structure » : l'en-tête et la ligne unique. Le
    // retour à la ligne du résumé vit à l'intérieur des guillemets, il ne compte pas.
    expect(csv.split('\r\n').filter((l) => l.trim() !== '')).toHaveLength(2);
  });

  it('la confiance sort en pourcentage entier, pas en flottant', () => {
    // 0.8999999 en tableur donne « 0,8999999 », que personne ne lit. Le tableau à l'écran arrondit déjà.
    expect(ligneQuali(CONV, T, LIBELLES)).toContain('90%');
  });

  it('« résolu » sort en oui/non traduit, pas en true/false', () => {
    // Un tableur français ne comprend pas `true`, et `VRAI` serait interprété comme un booléen local.
    expect(ligneQuali(CONV, T, LIBELLES)).toContain('non');
    expect(ligneQuali({ ...CONV, resolved: true }, T, LIBELLES)).toContain('oui');
  });

  it('une analyse SANS résumé laisse la cellule vide, elle ne la remplit pas avec autre chose', () => {
    // Le repli de la fiche est une PHRASE affichée à l'écran ; dans un fichier, la bonne valeur est le vide.
    // Y recopier `justification` ferait croire à un résumé sur toutes les lignes d'avant la migration 0100.
    const sansResume = ligneQuali({ ...CONV, summary: null }, T, LIBELLES);
    expect(sansResume).toHaveLength(entetesQuali(T).length);
    expect(sansResume[10]).toBe('');
    expect(sansResume[11]).toBe(CONV.justification);
  });
});

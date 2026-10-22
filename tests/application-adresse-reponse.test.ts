import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { adresseDeReponse, envoyeur, memoireDesEnvois } from '../src/application/transport/session';
import { correspondancesPostgres } from '../src/application/transport/etat-auth';

/**
 * L'ADRESSE D'UNE RÉPONSE (essai réel du 2026-10-22). WhatsApp adresse la plupart des conversations par identifiant
 * masqué : une réponse envoyée au NUMÉRO du contact arrivait sur son ordinateur et restait « En attente de ce message »
 * sur son mobile ; la même, adressée à son IDENTIFIANT MASQUÉ, est arrivée sur les deux (mesuré sur newCompany).
 */
const LID = '70291652927652@lid';
const PN = '33633921577@s.whatsapp.net';

describe('l’adresse d’une réponse', () => {
  const connus = { lidDe: async (numero: string) => (numero === '33633921577' ? LID : null) };

  it('🔴 un contact qui nous a écrit depuis son identifiant masqué reçoit la réponse à cet identifiant', async () => {
    expect(await adresseDeReponse(PN, connus)).toBe(LID);
  });

  it('un contact dont on ne connaît que le numéro reçoit la réponse à son numéro', async () => {
    expect(await adresseDeReponse('33612345678@s.whatsapp.net', connus)).toBe('33612345678@s.whatsapp.net');
  });

  it('une adresse déjà masquée, ou un groupe, passe telle quelle', async () => {
    expect(await adresseDeReponse(LID, connus)).toBe(LID);
    expect(await adresseDeReponse('120363000000000000@g.us', connus)).toBe('120363000000000000@g.us');
  });

  it('🔴 l’envoi part à l’adresse choisie, et le message est gardé pour un renvoi', async () => {
    const vers: string[] = [];
    const memoire = memoireDesEnvois();
    const envoyer = envoyeur({
      sendMessage: async (jid) => { vers.push(jid); return { key: { id: '3EB0D' }, message: { conversation: 'Réponse' } }; },
    }, memoire, (jid) => adresseDeReponse(jid, connus));
    expect(await envoyer(PN, 'Réponse')).toBe('3EB0D');
    expect(vers).toEqual([LID]);
    expect(memoire.retrouver('3EB0D')).toEqual({ conversation: 'Réponse' });
  });
});

/** Une table `comptes_application_auth` en mémoire : l'insert multi-lignes et la lecture d'une clé. */
function tableEnMemoire(): Pool {
  const lignes = new Map<string, string>();
  const query = async (sql: string, p: unknown[]) => {
    if (sql.trimStart().startsWith('insert')) {
      const [comptes, categories, cles, valeurs] = p as string[][];
      categories!.forEach((categorie, i) => lignes.set(`${comptes![i]}|${categorie}|${cles![i]}`, valeurs![i]!));
      return { rows: [] };
    }
    const [compte, categorie, cle] = p as string[];
    const valeur = lignes.get(`${compte}|${categorie}|${cle}`);
    return { rows: valeur === undefined ? [] : [{ valeur }] };
  };
  return { query } as unknown as Pool;
}

describe('les correspondances d’un compte, dans les deux sens', () => {
  const COMPTE = 'd2307af6-4612-4a2f-afb7-82607acd10c9';

  it('🔴 un identifiant masqué appris d’un message reçu se retrouve par le numéro, même après un redémarrage', async () => {
    const pool = tableEnMemoire();
    const cle = randomBytes(32);
    await correspondancesPostgres(pool, COMPTE, cle).retenir(LID, '33633921577');
    // Une nouvelle instance n'a rien en mémoire : elle relit la table, comme un service redémarré.
    const relue = correspondancesPostgres(pool, COMPTE, cle);
    expect(await relue.lidDe('33633921577')).toBe(LID);
    expect(await relue.numeroDe(LID)).toBe('33633921577');
    expect(await relue.lidDe('33612345678')).toBeNull();
  });
});

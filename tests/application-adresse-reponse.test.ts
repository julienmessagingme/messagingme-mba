import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
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
/** Notre propre identifiant masqué (`creds.me.lid`). */
const MON_LID = '241914855080103:2@lid';

describe('l’adresse d’une réponse', () => {
  const connus = { lidDe: async (numero: string) => (numero === '33633921577' ? LID : null) };

  it('🔴 un contact qui nous a écrit depuis son identifiant masqué reçoit la réponse à cet identifiant', async () => {
    expect(await adresseDeReponse(PN, connus, MON_LID)).toBe(LID);
  });

  it('🔴 sans identifiant masqué à nous, la réponse reste au numéro : Baileys 6.7.23 lèverait sinon à l’envoi', async () => {
    expect(await adresseDeReponse(PN, connus, undefined)).toBe(PN);
    expect(await adresseDeReponse(PN, connus, '')).toBe(PN);
  });

  it('un contact dont on ne connaît que le numéro reçoit la réponse à son numéro', async () => {
    expect(await adresseDeReponse('33612345678@s.whatsapp.net', connus, MON_LID)).toBe('33612345678@s.whatsapp.net');
  });

  it('une adresse déjà masquée, ou un groupe, passe telle quelle', async () => {
    expect(await adresseDeReponse(LID, connus, MON_LID)).toBe(LID);
    expect(await adresseDeReponse('120363000000000000@g.us', connus, MON_LID)).toBe('120363000000000000@g.us');
  });

  it('🔴 l’envoi part à l’adresse choisie, et le message est gardé pour un renvoi', async () => {
    const vers: string[] = [];
    const memoire = memoireDesEnvois();
    const envoyer = envoyeur({
      sendMessage: async (jid) => { vers.push(jid); return { key: { id: '3EB0D' }, message: { conversation: 'Réponse' } }; },
    }, memoire, (jid) => adresseDeReponse(jid, connus, MON_LID));
    expect(await envoyer(PN, 'Réponse')).toBe('3EB0D');
    expect(vers).toEqual([LID]);
    expect(memoire.retrouver('3EB0D')).toEqual({ conversation: 'Réponse' });
  });
});

/** Une table `comptes_application_auth` en mémoire : l'insert multi-lignes, la suppression par lot et la lecture d'une clé. */
function tableEnMemoire(): Pool & { lignes: Map<string, string> } {
  const lignes = new Map<string, string>();
  const query = async (sql: string, p: unknown[]) => {
    if (sql.trimStart().startsWith('insert')) {
      const [comptes, categories, cles, valeurs] = p as string[][];
      categories!.forEach((categorie, i) => lignes.set(`${comptes![i]}|${categorie}|${cles![i]}`, valeurs![i]!));
      return { rows: [] };
    }
    if (sql.trimStart().startsWith('delete')) {
      const [compte, categories, cles] = p as [string, string[], string[]];
      categories.forEach((categorie, i) => lignes.delete(`${compte}|${categorie}|${cles[i]}`));
      return { rows: [] };
    }
    const [compte, categorie, cle] = p as string[];
    const valeur = lignes.get(`${compte}|${categorie}|${cle}`);
    return { rows: valeur === undefined ? [] : [{ valeur }] };
  };
  return { query, lignes } as unknown as Pool & { lignes: Map<string, string> };
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

  it('🔴 un contact connu avant le redémarrage reçoit son sens inverse à son message suivant', async () => {
    // Le sens direct seul en base (une correspondance d'avant le sens inverse), puis lu par `numeroDe` : `retenir`
    // s'arrêtait sur la mémoire du sens direct, et l'inverse n'était jamais écrit (relecture de 8e9b3d8d).
    const pool = tableEnMemoire();
    const cle = randomBytes(32);
    const ancienne = correspondancesPostgres(pool, COMPTE, cle);
    await ancienne.retenir(LID, '33633921577');
    for (const k of [...pool.lignes.keys()]) if (k.includes('|lid-du-numero|')) pool.lignes.delete(k);
    const relue = correspondancesPostgres(pool, COMPTE, cle);
    expect(await relue.numeroDe(LID)).toBe('33633921577');
    await relue.retenir(LID, '33633921577');
    expect(await relue.lidDe('33633921577')).toBe(LID);
  });

  it('🔴 un compte qui change de numéro garde son identifiant masqué : l’ancien numéro ne mène plus à lui', async () => {
    const pool = tableEnMemoire();
    const c = correspondancesPostgres(pool, COMPTE, randomBytes(32));
    await c.retenir(LID, '33633921577');
    await c.retenir(LID, '33699999999');
    expect(await c.lidDe('33699999999')).toBe(LID);
    expect(await c.lidDe('33633921577')).toBeNull();
  });

  it('🔴 le numéro n’est jamais en clair dans la clé de ligne, et une ancienne ligne en clair s’efface à la réécriture', async () => {
    const pool = tableEnMemoire();
    const cle = randomBytes(32);
    // Une ligne inverse au format de 8e9b3d8d : le numéro en clair pour clé.
    pool.lignes.set(`${COMPTE}|lid-du-numero|33633921577`, 'chiffré');
    await correspondancesPostgres(pool, COMPTE, cle).retenir(LID, '33633921577');
    const cles = [...pool.lignes.keys()].filter((k) => k.includes('|lid-du-numero|'));
    expect(cles).toEqual([`${COMPTE}|lid-du-numero|${createHmac('sha256', cle).update('33633921577').digest('hex')}`]);
    expect(await correspondancesPostgres(pool, COMPTE, cle).lidDe('33633921577')).toBe(LID);
  });
});

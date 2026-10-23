// Recopié de wagroups, commit 526d3cc, `src/transport/baileys/authState.ts`. Changé : la table
// (`comptes_application_auth`, migration 0247, au lieu de `wa_auth_state`), le pool (`pg`), le chiffrement recopié
// (`./chiffrement`), et un `effacer` pour qu'une session retirée ne laisse aucune clé derrière elle.
import { BufferJSON, initAuthCreds, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { chiffrer, dechiffrer } from './chiffrement';

const CATEGORIE_CREDS = 'creds';
const CLE_CREDS = 'main';

// JSON.stringify d'un tableau plutot qu'une concatenation par ':' : `cle` contient couramment des ':' (JID d'appareil,
// id de cle d'expediteur). JSON.stringify encode la longueur de chaque element, deux triplets distincts ne produisent
// jamais le meme AAD.
function aad(compteId: string, categorie: string, cle: string): string {
  return JSON.stringify([compteId, categorie, cle]);
}

function lireValeur(clair: string): unknown {
  try {
    return JSON.parse(clair, BufferJSON.reviver);
  } catch {
    // JSON.parse cite un extrait de son entree dans son erreur, et cette entree est du materiel dechiffre.
    throw new Error('Echec de decodage JSON apres dechiffrement');
  }
}

async function lireUne(pool: Pool, compteId: string, cle: Buffer, categorie: string, id: string): Promise<unknown> {
  const r = await pool.query<{ valeur: string }>(
    'select valeur from comptes_application_auth where compte_id = $1 and categorie = $2 and cle = $3',
    [compteId, categorie, id],
  );
  const ligne = r.rows[0];
  return ligne ? lireValeur(dechiffrer(cle, ligne.valeur, aad(compteId, categorie, id))) : null;
}

// Une seule requete pour tout le lot d'ids : Baileys demande souvent plusieurs cles d'un coup.
async function lireLot(pool: Pool, compteId: string, cle: Buffer, categorie: string, ids: readonly string[]): Promise<Map<string, unknown>> {
  const resultat = new Map<string, unknown>();
  if (ids.length === 0) return resultat;
  const r = await pool.query<{ cle: string; valeur: string }>(
    'select cle, valeur from comptes_application_auth where compte_id = $1 and categorie = $2 and cle = any($3::text[])',
    [compteId, categorie, ids],
  );
  for (const ligne of r.rows) resultat.set(ligne.cle, lireValeur(dechiffrer(cle, ligne.valeur, aad(compteId, categorie, ligne.cle))));
  return resultat;
}

type Ecriture = { categorie: string; cle: string; valeur: unknown };
type Suppression = { categorie: string; cle: string };

// Upsert PAR CLE, en un seul insert multi-lignes : les cles de Signal se reecrivent a chaque message, et un lot
// s'ecrit atomiquement au lieu d'etre applique a moitie.
async function ecrireLot(pool: Pool, compteId: string, cle: Buffer, entrees: Ecriture[]): Promise<void> {
  if (entrees.length === 0) return;
  await pool.query(
    `insert into comptes_application_auth (compte_id, categorie, cle, valeur, maj_le)
     select t.compte_id, t.categorie, t.cle, t.valeur, now()
       from unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) as t(compte_id, categorie, cle, valeur)
     on conflict (compte_id, categorie, cle) do update set valeur = excluded.valeur, maj_le = now()`,
    [
      entrees.map(() => compteId),
      entrees.map((e) => e.categorie),
      entrees.map((e) => e.cle),
      entrees.map((e) => chiffrer(cle, JSON.stringify(e.valeur, BufferJSON.replacer), aad(compteId, e.categorie, e.cle))),
    ],
  );
}

async function supprimerLot(pool: Pool, compteId: string, entrees: Suppression[]): Promise<void> {
  if (entrees.length === 0) return;
  await pool.query(
    `delete from comptes_application_auth
      where compte_id = $1 and (categorie, cle) in (select * from unnest($2::text[], $3::text[]) as t(categorie, cle))`,
    [compteId, entrees.map((e) => e.categorie), entrees.map((e) => e.cle)],
  );
}

/** L'etat d'authentification Baileys d'un compte, adosse a Postgres et chiffre au repos. */
export async function etatAuthPostgres(pool: Pool, compteId: string, cle: Buffer): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const existant = (await lireUne(pool, compteId, cle, CATEGORIE_CREDS, CLE_CREDS)) as AuthenticationCreds | null;
  const creds: AuthenticationCreds = existant ?? initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const lignes = await lireLot(pool, compteId, cle, type, ids);
        const resultat: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const [id, valeur] of lignes) resultat[id] = valeur as SignalDataTypeMap[typeof type];
        return resultat;
      },
      set: async (data) => {
        const aEcrire: Ecriture[] = [];
        const aSupprimer: Suppression[] = [];
        for (const categorie of Object.keys(data)) {
          const entrees = data[categorie as keyof typeof data];
          if (!entrees) continue;
          for (const [id, valeur] of Object.entries(entrees)) {
            if (valeur === null || valeur === undefined) aSupprimer.push({ categorie, cle: id });
            else aEcrire.push({ categorie, cle: id, valeur });
          }
        }
        await Promise.all([ecrireLot(pool, compteId, cle, aEcrire), supprimerLot(pool, compteId, aSupprimer)]);
      },
    },
  };
  return {
    state,
    saveCreds: () => ecrireLot(pool, compteId, cle, [{ categorie: CATEGORIE_CREDS, cle: CLE_CREDS, valeur: creds }]),
  };
}

/** Le numero d'un contact masque (`…@lid`), appris de ses messages recus (`completerNumero`, `./session.ts`). */
export interface Correspondances {
  retenir(lid: string, numero: string): Promise<void>;
  numeroDe(lid: string): Promise<string | null>;
  /** L'identifiant masque d'un numero, quand le contact nous a ecrit depuis lui (`adresseDeReponse`, `./session.ts`). */
  lidDe(numero: string): Promise<string | null>;
}

const CATEGORIE_NUMEROS = 'numero-du-lid';
// Le sens inverse, ecrit avec le premier : une reponse se retrouve par le numero, cle de la conversation. Sa cle de
// ligne est un HMAC du numero sous la cle du compte, jamais le numero en clair (relecture de 8e9b3d8d).
const CATEGORIE_LIDS = 'lid-du-numero';
const cleDuNumero = (cle: Buffer, numero: string): string => createHmac('sha256', cle).update(numero).digest('hex');

/**
 * Les correspondances d'un compte, rangees avec son etat (chiffrees, effacees avec lui). Une memoire par session evite
 * une ecriture par message recu : on n'ecrit qu'un numero neuf ou change.
 */
export function correspondancesPostgres(pool: Pool, compteId: string, cle: Buffer): Correspondances {
  const memoire = new Map<string, string>();
  const inverse = new Map<string, string>();
  const numeroDe = async (lid: string): Promise<string | null> => {
    const connu = memoire.get(lid);
    if (connu) return connu;
    const lu = await lireUne(pool, compteId, cle, CATEGORIE_NUMEROS, lid);
    if (typeof lu !== 'string') return null;
    memoire.set(lid, lu);
    return lu;
  };
  return {
    async retenir(lid, numero) {
      // Les DEUX sens en memoire, pas le seul sens direct : `numeroDe` le range aussi, et un contact connu avant le
      // redemarrage n'aurait jamais eu son sens inverse (relecture de 8e9b3d8d).
      if (memoire.get(lid) === numero && inverse.get(numero) === lid) return;
      await ecrireLot(pool, compteId, cle, [
        { categorie: CATEGORIE_NUMEROS, cle: lid, valeur: numero },
        { categorie: CATEGORIE_LIDS, cle: cleDuNumero(cle, numero), valeur: lid },
      ]);
      // La ligne du format de 8e9b3d8d, le numero en clair pour cle, ne survit pas a la reecriture.
      await supprimerLot(pool, compteId, [{ categorie: CATEGORIE_LIDS, cle: numero }]);
      memoire.set(lid, numero);
      inverse.set(numero, lid);
    },
    async lidDe(numero) {
      const lid = inverse.get(numero) ?? (await lireUne(pool, compteId, cle, CATEGORIE_LIDS, cleDuNumero(cle, numero)));
      if (typeof lid !== 'string') return null;
      // Les deux sens doivent concorder : un compte qui change de numero garde son identifiant masque, et l'ancienne
      // ligne inverse enverrait la reponse au nouveau titulaire de ce numero.
      if ((await numeroDe(lid)) !== numero) return null;
      inverse.set(numero, lid);
      return lid;
    },
    numeroDe,
  };
}

/** Efface tout l'etat d'un compte : une session retiree ne garde aucune cle. */
export async function effacerEtatAuth(pool: Pool, compteId: string): Promise<void> {
  await pool.query('delete from comptes_application_auth where compte_id = $1', [compteId]);
}

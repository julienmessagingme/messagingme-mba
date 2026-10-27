import type { Pool } from 'pg';
import type { MagasinObjets } from '../lib/magasin-objets';
import type { MimeFichier } from './fichier';
import { cleObjet } from '../rcs/media-store.pg';
import { texteDe } from '../lib/erreur';

/**
 * LA RECOPIE DES FICHIERS EN BASE VERS LE BUCKET (lot A des médias, tâche 3 du plan). Ligne par ligne : déposer l'objet,
 * puis poser sa clé ET vider les octets dans la même instruction (le CHECK de 0256 refuse les deux à la fois comme
 * aucun). Rejouable : une fiche déjà recopiée n'est plus « en base », et un dépôt refait écrase le même objet. Un dépôt
 * en échec laisse la fiche en base, et la passe suivante la reprend. Ce qui compte à la fin, c'est le compte des fiches
 * encore en base : 0, sinon la colonne `bytes` ne part pas (migration A2).
 */
export interface FicheEnBase {
  id: string;
  tenantId: string;
  code: string;
  mime: MimeFichier;
  bytes: Buffer;
}

export interface SourceRecopie {
  /** Les fiches encore en base dont l'id suit `apres` (null : depuis le début), par id croissant, `limite` au plus. */
  lot(apres: string | null, limite: number): Promise<FicheEnBase[]>;
  /** Pose la clé et vide les octets. false : la fiche n'était plus en base (une autre passe l'a prise). */
  poser(id: string, cle: string): Promise<boolean>;
  /** Le nombre de fiches encore en base. */
  restantes(): Promise<number>;
}

/** Les fiches sont lues par lots : une vidéo pèse jusqu'à 16 Mo, dix suffisent à ne pas encombrer la mémoire. */
export const LOT_RECOPIE = 10;

export async function recopierVersObjets(
  source: SourceRecopie,
  magasin: MagasinObjets,
  journal: (ligne: string) => void = () => {},
): Promise<{ recopiees: number; echecs: number; restantes: number }> {
  let recopiees = 0;
  let echecs = 0;
  let apres: string | null = null;
  for (;;) {
    const lot = await source.lot(apres, LOT_RECOPIE);
    if (lot.length === 0) break;
    for (const f of lot) {
      apres = f.id;
      const cle = cleObjet(f.tenantId, f.code, f.mime);
      try {
        await magasin.deposer(cle, f.bytes, f.mime);
        if (await source.poser(f.id, cle)) recopiees += 1;
      } catch (err) {
        echecs += 1;
        journal(`echec ${f.id} (${cle}) : ${texteDe(err)}`);
      }
    }
  }
  return { recopiees, echecs, restantes: await source.restantes() };
}

/**
 * La source sur la table `rcs_media`, toute la table, ou les seuls espaces nommés (`espaces`) : un premier espace
 * recopié seul sert d'essai avant le reste.
 */
export function sourceRecopiePg(pool: Pick<Pool, 'query'>, espaces: string[] | null = null): SourceRecopie {
  return {
    lot: async (apres, limite) => {
      const { rows } = await pool.query<{ id: string; tenant_id: string; code: string; mime: MimeFichier; bytes: Buffer }>(
        `select id, tenant_id, code, mime, bytes from rcs_media
          where bytes is not null and ($1::uuid is null or id > $1::uuid) and ($3::uuid[] is null or tenant_id = any($3::uuid[]))
          order by id limit $2`,
        [apres, limite, espaces],
      );
      return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, code: r.code, mime: r.mime, bytes: r.bytes }));
    },
    poser: async (id, cle) => {
      const r = await pool.query('update rcs_media set cle_objet = $2, bytes = null where id = $1 and bytes is not null', [id, cle]);
      return r.rowCount === 1;
    },
    restantes: async () => {
      const { rows } = await pool.query<{ n: string }>(
        'select count(*)::text as n from rcs_media where bytes is not null and ($1::uuid[] is null or tenant_id = any($1::uuid[]))',
        [espaces],
      );
      return Number(rows[0]!.n);
    },
  };
}

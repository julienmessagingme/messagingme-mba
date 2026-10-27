import type { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

/**
 * LE MAGASIN D'OBJETS (lot A des médias, spec `docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md`, § 1) :
 * les fichiers de la médiathèque sortent de Postgres vers un bucket Object Storage privé, à Amsterdam. Une interface
 * étroite, pour que les tests tournent contre un faux en mémoire (`tests/magasin-objets-faux.ts`, jamais dans `src/`).
 * 🔴 L'adresse du bucket ne sort jamais : `/m/` lit l'objet et le sert lui-même.
 */
export interface MagasinObjets {
  deposer(cle: string, octets: Buffer, type: string): Promise<void>;
  /** Le contenu en flux, ou null si l'objet n'existe pas. */
  lireFlux(cle: string): Promise<Readable | null>;
  /** Le contenu entier, ou null si l'objet n'existe pas : pour ce qui part chez Meta (16 Mo au plus). */
  lireOctets(cle: string): Promise<Buffer | null>;
  /** Réussit aussi sur une clé absente : une purge interrompue se rejoue. */
  effacer(cle: string): Promise<void>;
  /** Efface tout ce qui commence par le préfixe et rend le nombre d'objets effacés. */
  effacerPrefixe(prefixe: string): Promise<number>;
}

export interface ConfigObjets {
  pointAcces: string;
  region: string;
  bucket: string;
  cle: string;
  secret: string;
}

/** Le préfixe des objets d'un espace : l'effacer suffit à vider l'espace, sans lire la base. */
export const prefixeEspace = (tenantId: string): string => `tenants/${tenantId}/`;

/** Les cinq variables `OBJETS_*`, ou null quand aucune n'est posée (la configuration refuse un réglage partiel). */
export function configObjets(c: {
  OBJETS_POINT_ACCES: string; OBJETS_REGION: string; OBJETS_BUCKET: string; OBJETS_CLE: string; OBJETS_SECRET: string;
}): ConfigObjets | null {
  if (c.OBJETS_BUCKET === '') return null;
  return { pointAcces: c.OBJETS_POINT_ACCES, region: c.OBJETS_REGION, bucket: c.OBJETS_BUCKET, cle: c.OBJETS_CLE, secret: c.OBJETS_SECRET };
}

/** Effacements simultanés de `effacerPrefixe` : une suppression d'espace, pas une rafale. */
const EFFACEMENTS_SIMULTANES = 8;

/**
 * Le magasin chez Scaleway, par le protocole S3 standard. ⚠️ Les sommes de contrôle ne s'envoient et ne se vérifient
 * que là où S3 les exige : depuis sa version 3.729, le SDK en ajoute par défaut à chaque dépôt et à chaque lecture, ce
 * que les stockages compatibles S3 ne savent pas tous lire. Et l'effacement d'un préfixe passe par des effacements
 * UNITAIRES, jamais par `DeleteObjects`, que S3 veut signé d'une somme de contrôle précisément.
 */
export function creerMagasinObjets(c: ConfigObjets | null): MagasinObjets | null {
  if (c === null) return null;
  const s3 = new S3Client({
    endpoint: c.pointAcces,
    region: c.region,
    forcePathStyle: true,
    credentials: { accessKeyId: c.cle, secretAccessKey: c.secret },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = c.bucket;
  const lire = async (cle: string) => {
    try {
      return await s3.send(new GetObjectCommand({ Bucket, Key: cle }));
    } catch (err) {
      // `NoSuchKey` chez AWS ; un stockage compatible peut ne rendre qu'un 404 sans ce nom.
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  };
  const effacer = async (cle: string): Promise<void> => {
    await s3.send(new DeleteObjectCommand({ Bucket, Key: cle }));
  };
  return {
    deposer: async (cle, octets, type) => {
      await s3.send(new PutObjectCommand({ Bucket, Key: cle, Body: octets, ContentType: type, ContentLength: octets.length }));
    },
    lireFlux: async (cle) => {
      const r = await lire(cle);
      return r ? (r.Body as Readable) : null;
    },
    lireOctets: async (cle) => {
      const r = await lire(cle);
      return r?.Body ? Buffer.from(await r.Body.transformToByteArray()) : null;
    },
    effacer,
    effacerPrefixe: async (prefixe) => {
      if (!prefixe.endsWith('/')) throw new Error(`préfixe sans « / » final refusé : ${prefixe}`);
      let total = 0;
      let suite: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefixe, ContinuationToken: suite }));
        const cles = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string');
        for (let i = 0; i < cles.length; i += EFFACEMENTS_SIMULTANES) {
          await Promise.all(cles.slice(i, i + EFFACEMENTS_SIMULTANES).map(effacer));
        }
        total += cles.length;
        suite = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (suite);
      return total;
    },
  };
}

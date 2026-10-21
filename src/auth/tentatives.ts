import { createHash } from 'node:crypto';
import { MESSAGE_PLAFOND_INDISPONIBLE, type Consommation } from './plafond-partage';

/**
 * Clé du compteur partagé : l'empreinte de `ip::discriminant`. L'adresse ou le jeton présenté n'entre donc jamais
 * en clair dans la base, son journal ou ses sauvegardes, et la taille reste bornée même pour un jeton Google.
 * `ip` peut être celle du proxy selon l'adaptateur ; le choix de l'adresse de référence reste sa responsabilité.
 */
export function empreinteTentative(source: { ip: string }, discriminant: string): string {
  return createHash('sha256').update(`${source.ip}::${discriminant}`).digest('hex');
}

export type DecisionTentative =
  | { acceptee: true }
  | { acceptee: false; attenteMs: number; message: string };

export interface CompteurTentatives {
  consommer(cle: string): Promise<Pick<Consommation, 'accepte' | 'indisponible' | 'attenteMs'>>;
}

/** Consomme une tentative sans dépendre du transport HTTP. */
export async function verifierTentative(
  plafond: CompteurTentatives,
  cle: string,
): Promise<DecisionTentative> {
  const consommation = await plafond.consommer(cle);
  if (consommation.accepte) return { acceptee: true };
  return {
    acceptee: false,
    attenteMs: consommation.attenteMs,
    message: consommation.indisponible ? MESSAGE_PLAFOND_INDISPONIBLE : 'trop de tentatives, réessaie plus tard',
  };
}

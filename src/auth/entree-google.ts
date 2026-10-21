import type { GoogleIdentity } from './google';
import { marquerConnexion, type CompteParAdresse, type ComptesAuthDep } from './comptes';
import { nomEspace } from '../user/nom-espace';
import type { OrigineEspace } from '../user/store.pg';

type ComptesGoogle = Required<Pick<ComptesAuthDep, 'getByEmail'>> & Pick<ComptesAuthDep, 'createTenantWithAdmin' | 'touchLastLogin'>;

export interface EntreeGoogleDeps {
  verifyGoogle(idToken: string): Promise<GoogleIdentity | null>;
  comptes: ComptesGoogle;
}

export type ResultatEntreeGoogle =
  | { statut: 'invalide' }
  | { statut: 'inconnue'; identite: GoogleIdentity }
  | { statut: 'revoquee'; identite: GoogleIdentity }
  | { statut: 'ouverte'; identite: GoogleIdentity; comptes: CompteParAdresse[]; nouveau: boolean };

function nomDuNouvelEspace(identite: Pick<GoogleIdentity, 'name'>): string {
  const nomGoogle = (identite.name ?? '').slice(0, 60).trim();
  const construit = nomEspace.safeParse(nomGoogle !== '' ? `Espace de ${nomGoogle}` : '');
  return construit.success ? construit.data : 'Mon espace';
}

/**
 * Vérifie l'identité Google, résout ses comptes actifs et, si une origine est fournie, crée l'espace d'une
 * adresse inconnue. Les adaptateurs HTTP gardent leurs réponses, leurs sessions et leurs preuves OAuth.
 * Sans `origine`, une adresse inconnue est seulement signalée : l'entrée Ops peut ainsi interdire toute création.
 */
export async function entrerParGoogle(
  deps: EntreeGoogleDeps,
  idToken: string,
  origine?: OrigineEspace,
): Promise<ResultatEntreeGoogle> {
  const identite = await deps.verifyGoogle(idToken);
  if (!identite?.emailVerified) return { statut: 'invalide' };

  const tous = await deps.comptes.getByEmail(identite.email);
  if (tous.length > 0) {
    const actifs = tous.filter((compte) => !compte.disabled);
    return actifs.length === 0
      ? { statut: 'revoquee', identite }
      : { statut: 'ouverte', identite, comptes: actifs, nouveau: false };
  }

  if (origine === undefined) return { statut: 'inconnue', identite };
  const creer = deps.comptes.createTenantWithAdmin;
  if (!creer) throw new Error('entrerParGoogle : création d’espace non câblée');
  const tenantName = nomDuNouvelEspace(identite);
  const { tenantId, userId } = await creer(
    tenantName,
    { email: identite.email, name: identite.name, passwordHash: null },
    origine,
  );
  marquerConnexion(deps.comptes, userId);
  return {
    statut: 'ouverte',
    identite,
    nouveau: true,
    comptes: [{ id: userId, tenantId, tenantName, role: 'admin', disabled: false }],
  };
}

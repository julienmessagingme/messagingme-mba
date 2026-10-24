import { estAdresseOps } from './middleware';
import type { EtatMfa, MfaStore } from './mfa-store.pg';
import { verifyPassword } from './password';
import { RateLimiter } from './rate-limit';
import { verifyEnrolement, verifyMfa, type EtapeConnexion, type MoyenFacteur } from './token';
import {
  EMETTEUR_TOTP,
  empreinteCodeSecours,
  genererCodesSecours,
  genererSecret,
  uriOtpauth,
  verifierCode,
} from './totp';

/** Les lignes de journal du second facteur que la connexion écrit elle-même (la réinitialisation s'écrit ailleurs). */
export type ActionMfa = 'mfa.active' | 'mfa.code_secours_utilise' | 'mfa.echec' | 'mfa.codes_regeneres' | 'mfa.desactive';

export interface MfaDeps {
  secret: string;
  /**
   * Les adresses qui ouvrent `/ops` (`OPS_EMAILS`). Une adresse d'exploitation ne retire jamais son facteur
   * depuis Mon compte, quel que soit le réglage de ses espaces.
   */
  opsEmails?: readonly string[];
  /**
   * Absent : les commandes ferment l'accès avec `indisponible`. Le magasin reste un objet : ses méthodes sont
   * toujours appelées sur lui, car `PgMfaStore` lit `this.pool` et `this.cle`.
   */
  mfa?: MfaStore;
  /** Journal sans code ni secret, non bloquant pour la réponse. */
  auditMfa?: (identityId: string, action: ActionMfa, detail?: Record<string, unknown>) => Promise<void>;
}

/**
 * `ttlChoix` allonge le jeton de choix quand l'écran des codes de secours s'intercale avant le choix.
 * `facteur` est le moyen qui vient de prouver le second facteur.
 */
export interface OptionsSuite { ttlChoix?: string; facteur?: MoyenFacteur }

/** Termine une connexion après la preuve du second facteur. */
export type SuiteDeConnexion = (etape: EtapeConnexion, options?: OptionsSuite) => Promise<Record<string, unknown>>;

export type CommandeMfa =
  | { type: 'verifier_connexion'; jeton: string; code: string }
  | { type: 'commencer_enrolement_connexion'; jeton: string }
  | { type: 'activer_connexion'; jeton: string; code: string }
  | { type: 'lire_compte'; userId: string }
  | { type: 'commencer_enrolement_compte'; userId: string; motDePasse: string }
  | { type: 'activer_compte'; userId: string; code: string }
  | { type: 'regenerer_codes'; userId: string; code: string }
  | { type: 'desactiver_compte'; userId: string; code: string };

export type ResultatMfa =
  | { kind: 'succes'; corps: Record<string, unknown> }
  | { kind: 'etape_expiree' }
  | { kind: 'indisponible' }
  | { kind: 'trop_de_tentatives' }
  | { kind: 'code_invalide' }
  | { kind: 'bloque'; jusqua: Date }
  | { kind: 'deja_active'; reconnecter: boolean }
  | { kind: 'compte_inconnu' }
  | { kind: 'mot_de_passe_absent' }
  | { kind: 'mot_de_passe_incorrect' }
  | { kind: 'facteur_inactif' }
  | { kind: 'facteur_obligatoire'; raison: 'exploitation' | 'espace' };

interface EtapeValide {
  kind: 'etape_valide';
  etape: EtapeConnexion;
  mfa: MfaStore;
}

interface EtatValide {
  kind: 'etat_valide';
  etat: EtatMfa;
  mfa: MfaStore;
}

interface FacteurValide {
  kind: 'facteur_valide';
  moyen: MoyenFacteur;
}

interface ActivationValide {
  kind: 'activation_valide';
  codes: string[];
}

type VerificateurEtape = (jeton: string, secret: string) => Promise<EtapeConnexion | null>;

const estBloque = (etat: EtatMfa): boolean =>
  etat.bloqueJusqua !== null && etat.bloqueJusqua.getTime() > Date.now();

/**
 * La machine possède les transitions MFA et leur ordre d'écriture. Son interface est une commande normalisée
 * et un résultat nommé ; l'adapter HTTP ne connaît ni le rejeu, ni les secours, ni les compteurs en base.
 */
export function creerMachineMfa(
  deps: MfaDeps,
  suite: SuiteDeConnexion,
): (commande: CommandeMfa) => Promise<ResultatMfa> {
  const essais = new RateLimiter(5, 60_000);
  // Un secret neuf à chaque appel : l'enrôlement ne se devine pas, il se borne seulement.
  const enrolements = new RateLimiter(10, 60_000);

  const journal = (identityId: string, action: ActionMfa, detail?: Record<string, unknown>): void => {
    void deps.auditMfa?.(identityId, action, detail)?.catch(() => {});
  };

  async function etapeDe(
    jeton: string,
    verifier: VerificateurEtape,
    limiteur: RateLimiter,
  ): Promise<EtapeValide | ResultatMfa> {
    // Le jeton avant le magasin : sans lui, rien n'autorise la commande.
    const etape = jeton !== '' ? await verifier(jeton, deps.secret) : null;
    if (!etape) return { kind: 'etape_expiree' };
    if (!deps.mfa) return { kind: 'indisponible' };
    if (!limiteur.take(etape.identityId)) return { kind: 'trop_de_tentatives' };
    return { kind: 'etape_valide', etape, mfa: deps.mfa };
  }

  async function etatDeLaSession(userId: string): Promise<EtatValide | ResultatMfa> {
    if (!deps.mfa) return { kind: 'indisponible' };
    const etat = await deps.mfa.lireParCompte(userId);
    if (!etat) return { kind: 'compte_inconnu' };
    return { kind: 'etat_valide', etat, mfa: deps.mfa };
  }

  /**
   * TOTP d'abord, secours ensuite. Le pas TOTP s'écrit conditionnellement avant le succès : deux présentations
   * simultanées du même code ne passent pas. Pendant un blocage, seul un code de secours reste accepté.
   */
  async function verifierFacteur(mfa: MfaStore, etat: EtatMfa, code: string): Promise<MoyenFacteur | null> {
    if (etat.secret === null) return null;
    if (!estBloque(etat)) {
      const pas = verifierCode(etat.secret, code, Date.now(), etat.dernierPas);
      if (pas !== null && await mfa.marquerPas(etat.identityId, pas)) return 'totp';
    }
    const empreinte = empreinteCodeSecours(code);
    if (empreinte !== null && await mfa.consommerCodeSecours(etat.identityId, empreinte)) return 'secours';
    return null;
  }

  async function controler(
    mfa: MfaStore,
    etat: EtatMfa,
    code: string,
    etape: string,
  ): Promise<FacteurValide | ResultatMfa> {
    const moyen = await verifierFacteur(mfa, etat, code);
    if (moyen) {
      await mfa.noterReussite(etat.identityId);
      return { kind: 'facteur_valide', moyen };
    }
    const bloque = await mfa.noterEchec(etat.identityId);
    journal(etat.identityId, 'mfa.echec', { etape, ...(bloque ? { bloque: true } : {}) });
    return bloque ? { kind: 'bloque', jusqua: bloque } : { kind: 'code_invalide' };
  }

  async function activer(
    mfa: MfaStore,
    etat: EtatMfa,
    code: string,
    etape: string,
  ): Promise<ActivationValide | ResultatMfa> {
    const secret = etat.secretEnAttente;
    const pas = secret === null ? null : verifierCode(secret, code, Date.now(), null);
    if (pas === null || secret === null) {
      journal(etat.identityId, 'mfa.echec', { etape });
      return { kind: 'code_invalide' };
    }
    const { clairs, empreintes } = genererCodesSecours();
    if (!(await mfa.activer(etat.identityId, secret, pas, empreintes))) {
      return { kind: 'deja_active', reconnecter: etape === 'connexion' };
    }
    journal(etat.identityId, 'mfa.active');
    return { kind: 'activation_valide', codes: clairs };
  }

  function raisonObligatoire(etat: EtatMfa): 'exploitation' | 'espace' | null {
    if (estAdresseOps(deps.opsEmails, etat.email)) return 'exploitation';
    return etat.obligatoire ? 'espace' : null;
  }

  async function commencerEnrolement(
    mfa: MfaStore,
    etat: EtatMfa,
    emailDuLibelle: string,
  ): Promise<ResultatMfa> {
    const secret = genererSecret();
    await mfa.poserSecretEnAttente(etat.identityId, secret);
    return {
      kind: 'succes',
      corps: { secret, uri: uriOtpauth(EMETTEUR_TOTP, emailDuLibelle, secret) },
    };
  }

  return async (commande: CommandeMfa): Promise<ResultatMfa> => {
    switch (commande.type) {
      case 'verifier_connexion': {
        const ok = await etapeDe(commande.jeton, verifyMfa, essais);
        if (ok.kind !== 'etape_valide') return ok;
        const etat = await ok.mfa.lire(ok.etape.identityId);
        if (!etat) return { kind: 'etape_expiree' };
        const facteur = await controler(ok.mfa, etat, commande.code, 'connexion');
        if (facteur.kind !== 'facteur_valide') return facteur;
        if (facteur.moyen === 'secours') {
          // Le journal précède la suite, comme la consommation : même si l'ouverture de session échoue, le code a servi.
          journal(ok.etape.identityId, 'mfa.code_secours_utilise');
          const corps = await suite(ok.etape, { facteur: facteur.moyen });
          // L'état précède la consommation, d'où le -1.
          return {
            kind: 'succes',
            corps: { ...corps, codesSecoursRestants: Math.max(0, etat.codesSecoursRestants - 1) },
          };
        }
        return { kind: 'succes', corps: await suite(ok.etape, { facteur: facteur.moyen }) };
      }

      case 'commencer_enrolement_connexion': {
        const ok = await etapeDe(commande.jeton, verifyEnrolement, enrolements);
        if (ok.kind !== 'etape_valide') return ok;
        const etat = await ok.mfa.lire(ok.etape.identityId);
        if (!etat) return { kind: 'etape_expiree' };
        if (etat.secret !== null) return { kind: 'deja_active', reconnecter: true };
        // Le libellé reste celui du jeton signé, même si l'adresse stockée a changé entre-temps.
        return commencerEnrolement(ok.mfa, etat, ok.etape.email);
      }

      case 'activer_connexion': {
        const ok = await etapeDe(commande.jeton, verifyEnrolement, essais);
        if (ok.kind !== 'etape_valide') return ok;
        const etat = await ok.mfa.lire(ok.etape.identityId);
        if (!etat) return { kind: 'etape_expiree' };
        if (etat.secret !== null) return { kind: 'deja_active', reconnecter: true };
        const activation = await activer(ok.mfa, etat, commande.code, 'connexion');
        if (activation.kind !== 'activation_valide') return activation;
        const corps = await suite(ok.etape, { ttlChoix: '15m', facteur: 'totp' });
        return { kind: 'succes', corps: { codesSecours: activation.codes, ...corps } };
      }

      case 'lire_compte': {
        const ok = await etatDeLaSession(commande.userId);
        if (ok.kind !== 'etat_valide') return ok;
        const raison = raisonObligatoire(ok.etat);
        return {
          kind: 'succes',
          corps: {
            actif: ok.etat.secret !== null,
            activeLe: ok.etat.activeLe?.toISOString() ?? null,
            codesSecoursRestants: ok.etat.secret === null ? 0 : ok.etat.codesSecoursRestants,
            obligatoire: raison !== null,
            raison,
          },
        };
      }

      case 'commencer_enrolement_compte': {
        const ok = await etatDeLaSession(commande.userId);
        if (ok.kind !== 'etat_valide') return ok;
        if (!enrolements.take(ok.etat.identityId)) return { kind: 'trop_de_tentatives' };
        if (ok.etat.secret !== null) return { kind: 'deja_active', reconnecter: false };
        const hash = await ok.mfa.motDePasse(ok.etat.identityId);
        if (hash === null) return { kind: 'mot_de_passe_absent' };
        if (!(await verifyPassword(commande.motDePasse, hash))) {
          journal(ok.etat.identityId, 'mfa.echec', { etape: 'enrolement' });
          return { kind: 'mot_de_passe_incorrect' };
        }
        return commencerEnrolement(ok.mfa, ok.etat, ok.etat.email);
      }

      case 'activer_compte': {
        const ok = await etatDeLaSession(commande.userId);
        if (ok.kind !== 'etat_valide') return ok;
        if (!essais.take(ok.etat.identityId)) return { kind: 'trop_de_tentatives' };
        if (ok.etat.secret !== null) return { kind: 'deja_active', reconnecter: false };
        const activation = await activer(ok.mfa, ok.etat, commande.code, 'activation');
        if (activation.kind !== 'activation_valide') return activation;
        return { kind: 'succes', corps: { codesSecours: activation.codes } };
      }

      case 'regenerer_codes': {
        const ok = await etatDeLaSession(commande.userId);
        if (ok.kind !== 'etat_valide') return ok;
        if (!essais.take(ok.etat.identityId)) return { kind: 'trop_de_tentatives' };
        if (ok.etat.secret === null) return { kind: 'facteur_inactif' };
        const facteur = await controler(ok.mfa, ok.etat, commande.code, 'codes');
        if (facteur.kind !== 'facteur_valide') return facteur;
        const { clairs, empreintes } = genererCodesSecours();
        if (!(await ok.mfa.remplacerCodesSecours(ok.etat.identityId, empreintes))) {
          return { kind: 'facteur_inactif' };
        }
        journal(ok.etat.identityId, 'mfa.codes_regeneres');
        return { kind: 'succes', corps: { codesSecours: clairs } };
      }

      case 'desactiver_compte': {
        const ok = await etatDeLaSession(commande.userId);
        if (ok.kind !== 'etat_valide') return ok;
        const raison = raisonObligatoire(ok.etat);
        if (raison !== null) return { kind: 'facteur_obligatoire', raison };
        if (!essais.take(ok.etat.identityId)) return { kind: 'trop_de_tentatives' };
        if (ok.etat.secret === null) return { kind: 'facteur_inactif' };
        const facteur = await controler(ok.mfa, ok.etat, commande.code, 'desactivation');
        if (facteur.kind !== 'facteur_valide') return facteur;
        await ok.mfa.desactiver(ok.etat.identityId);
        journal(ok.etat.identityId, 'mfa.desactive');
        return { kind: 'succes', corps: { ok: true } };
      }
    }
  };
}

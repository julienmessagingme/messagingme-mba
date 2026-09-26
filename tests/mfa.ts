import type { FastifyInstance } from 'fastify';
import type { EtatMfa, IssueReinitialisation, MfaStore } from '../src/auth/mfa-store.pg';
import type { AuthUser, EmailIdentity, UserAuthStore } from '../src/auth/store';
import { codeAuPas, genererSecret, pasDe } from '../src/auth/totp';

/**
 * LE SECOND FACTEUR DANS LES TESTS, PAR LE VRAI PARCOURS.
 *
 * 🔴 AUCUN RACCOURCI DANS `src/` : pas de drapeau, pas de variable d'environnement qui sauterait l'étape du code.
 * Ce serait une porte en production. Un test qui a besoin d'une session d'admin la gagne comme en production :
 * mot de passe, puis enrôlement (ou code), puis la suite. C'est ce que fait `connecter` ci-dessous.
 */

/** L'identité d'une adresse dans les faux : une par adresse, comme la table `identities` (migration 0072). */
export const identiteDe = (email: string): string => `identite-${email.toLowerCase()}`;

export interface CompteFaux {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
  disabled?: boolean;
}

interface EtatFaux {
  secret: string | null;
  activeLe: Date | null;
  dernierPas: number | null;
  attente: string | null;
  /** empreinte -> date d'utilisation */
  codes: Map<string, Date | null>;
}

/** Un magasin du second facteur en mémoire, fidèle aux CONDITIONS du vrai (activation unique, pas croissant). */
export class MfaEnMemoire implements MfaStore {
  private readonly etats = new Map<string, EtatFaux>();
  constructor(private readonly liste: CompteFaux[] = []) {}

  ajouterCompte(c: CompteFaux): void {
    this.liste.push(c);
  }

  private etatDe(identityId: string): EtatFaux {
    let e = this.etats.get(identityId);
    if (!e) {
      e = { secret: null, activeLe: null, dernierPas: null, attente: null, codes: new Map() };
      this.etats.set(identityId, e);
    }
    return e;
  }

  private comptesDe(identityId: string): CompteFaux[] {
    return this.liste.filter((c) => identiteDe(c.email) === identityId);
  }

  async lire(identityId: string): Promise<EtatMfa | null> {
    const comptes = this.comptesDe(identityId);
    if (comptes.length === 0) return null;
    const e = this.etatDe(identityId);
    return {
      identityId,
      email: comptes[0]!.email,
      secret: e.activeLe ? e.secret : null,
      activeLe: e.activeLe,
      dernierPas: e.dernierPas,
      secretEnAttente: e.attente,
      codesSecoursRestants: [...e.codes.values()].filter((d) => d === null).length,
      obligatoire: comptes.some((c) => c.role === 'admin' && !c.disabled),
    };
  }

  async lireParCompte(userId: string): Promise<EtatMfa | null> {
    const c = this.liste.find((x) => x.userId === userId);
    return c ? this.lire(identiteDe(c.email)) : null;
  }

  async poserSecretEnAttente(identityId: string, secret: string): Promise<void> {
    this.etatDe(identityId).attente = secret;
  }

  async activer(identityId: string, secret: string, pas: number, empreintes: string[]): Promise<boolean> {
    const e = this.etatDe(identityId);
    if (e.activeLe) return false;
    Object.assign(e, { secret, activeLe: new Date(), dernierPas: pas, attente: null, codes: new Map(empreintes.map((h) => [h, null])) });
    return true;
  }

  async marquerPas(identityId: string, pas: number): Promise<boolean> {
    const e = this.etatDe(identityId);
    if (!e.activeLe || (e.dernierPas !== null && e.dernierPas >= pas)) return false;
    e.dernierPas = pas;
    return true;
  }

  async consommerCodeSecours(identityId: string, empreinte: string): Promise<boolean> {
    const e = this.etatDe(identityId);
    if (e.codes.get(empreinte) !== null) return false; // absent (undefined) ou déjà utilisé (une date)
    e.codes.set(empreinte, new Date());
    return true;
  }

  async remplacerCodesSecours(identityId: string, empreintes: string[]): Promise<boolean> {
    const e = this.etatDe(identityId);
    if (!e.activeLe) return false;
    e.codes = new Map(empreintes.map((h) => [h, null]));
    return true;
  }

  async desactiver(identityId: string): Promise<void> {
    this.etats.delete(identityId);
  }

  async reinitialiserDansEspace(tenantId: string, userId: string): Promise<IssueReinitialisation> {
    const c = this.liste.find((x) => x.userId === userId && x.tenantId === tenantId);
    if (!c) return 'not_found';
    const id = identiteDe(c.email);
    if (this.comptesDe(id).some((x) => x.tenantId !== tenantId)) return 'autres_espaces';
    this.etats.delete(id);
    return 'ok';
  }

  async reinitialiserParEmail(email: string): Promise<string | null> {
    const id = identiteDe(email);
    if (this.comptesDe(id).length === 0) return null;
    this.etats.delete(id);
    return id;
  }

  async comptes(identityId: string): Promise<Array<{ userId: string; tenantId: string; email: string }>> {
    return this.comptesDe(identityId).map((c) => ({ userId: c.userId, tenantId: c.tenantId, email: c.email }));
  }

  // --- Aides de test, hors contrat ------------------------------------------------------------------------

  estActif(email: string): boolean {
    return this.etats.get(identiteDe(email))?.activeLe != null;
  }

  /** Pose un facteur ACTIF, comme après un enrôlement réussi. Rend le secret, pour calculer les codes. */
  poserFacteur(email: string, secret = genererSecret()): string {
    Object.assign(this.etatDe(identiteDe(email)), { secret, activeLe: new Date(), dernierPas: null, attente: null });
    return secret;
  }

  /**
   * Le prochain code que le serveur acceptera : le pas courant, ou le suivant si le courant a déjà servi (deux
   * connexions dans la même demi-minute). La fenêtre du serveur est de plus ou moins un pas, pas davantage.
   */
  codeSuivant(email: string): string {
    const e = this.etats.get(identiteDe(email));
    if (!e?.secret || !e.activeLe) throw new Error(`aucun facteur actif pour ${email}`);
    const courant = pasDe(Date.now());
    const pas = Math.max(courant, (e.dernierPas ?? -1) + 1);
    if (pas > courant + 1) throw new Error('plus aucun pas disponible dans la fenêtre : attendre la demi-minute suivante');
    return codeAuPas(e.secret, pas);
  }
}

/**
 * Le faux `findIdentity` des tests d'authentification : une identité par adresse, et son facteur lu dans `mfa`.
 * Même forme que le vrai (`identityId`, `mfaActif` REQUIS) : un faux ne dit pas « pas de facteur » par omission.
 */
export class UtilisateursFaux implements UserAuthStore {
  constructor(private readonly users: AuthUser[], private readonly mfa?: MfaEnMemoire) {}
  async findIdentity(email: string): Promise<EmailIdentity | null> {
    const trouves = this.users.filter((u) => u.email.toLowerCase() === email.toLowerCase());
    const hash = trouves[0]?.passwordHash;
    if (!hash) return null;
    return {
      identityId: identiteDe(email),
      passwordHash: hash,
      mfaActif: this.mfa?.estActif(email) ?? false,
      comptes: trouves.map((u) => ({ id: u.id, tenantId: u.tenantId, tenantName: `Espace ${u.tenantId}`, email: u.email, role: u.role })),
    };
  }
}

/** Les comptes du magasin du second facteur, déduits des `AuthUser` d'un test. */
export const comptesDe = (users: AuthUser[]): CompteFaux[] =>
  users.map((u) => ({ userId: u.id, tenantId: u.tenantId, role: u.role, email: u.email }));

const json = { 'content-type': 'application/json' };

export interface Reponse { statusCode: number; body: string; json<T = Record<string, unknown>>(): T }

/**
 * Termine une étape de connexion rendue par `/auth/login`, `/auth/signup` ou `/auth/invitations/accept` : un
 * `enrolToken` passe par l'enrôlement (secret, premier code), un `mfaToken` par le code courant. Toute autre
 * réponse est rendue telle quelle. C'est le parcours de la console, sans rien sauter.
 */
export async function passerLeSecondFacteur(app: FastifyInstance, res: Reponse, mfa: MfaEnMemoire, email: string): Promise<Reponse> {
  const corps = res.statusCode < 300 ? res.json() : {};
  if (typeof corps.enrolToken === 'string') {
    const enrolement = await app.inject({ method: 'POST', url: '/auth/mfa/enroler', headers: json, payload: { enrolToken: corps.enrolToken } });
    if (enrolement.statusCode !== 200) throw new Error(`enrôlement refusé : ${enrolement.statusCode} ${enrolement.body}`);
    const { secret } = enrolement.json<{ secret: string }>();
    return app.inject({
      method: 'POST', url: '/auth/mfa/activer', headers: json,
      payload: { enrolToken: corps.enrolToken, code: codeAuPas(secret, pasDe(Date.now())) },
    });
  }
  if (typeof corps.mfaToken === 'string') {
    return app.inject({ method: 'POST', url: '/auth/mfa/verifier', headers: json, payload: { mfaToken: corps.mfaToken, code: mfa.codeSuivant(email) } });
  }
  return res;
}

/** Connexion complète par mot de passe : `/auth/login`, puis le second facteur s'il est dû. */
export async function connecter(app: FastifyInstance, mfa: MfaEnMemoire, email: string, password: string): Promise<Reponse> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', headers: json, payload: { email, password } });
  return passerLeSecondFacteur(app, res, mfa, email);
}

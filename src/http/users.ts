import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DuplicateEmailError } from '../user/store.pg';
import type { UserRow, UserMutation } from '../user/store.pg';
import type { Guard } from '../auth/middleware';
import { renderInvitationEmail } from '../support/email-templates';
import { espaceVerifie, estUuid } from './scope';
import type { IssueReinitialisation } from '../auth/mfa-store.pg';
import { makeJournal, type AuditSink } from '../audit/journal';
import { nomEspace, MESSAGE_NOM_ESPACE_INVALIDE } from '../user/nom-espace';

export interface UsersRouteDeps {
  /**
   * Journal d'audit des accès (les fixtures qui ne l'observent pas passent `journalMuet`).
   * 🔴 Le `detail` ne porte jamais d'email ni de nom, seulement le rôle avant et après : cette table n'est pas
   * purgée avec les contacts, une donnée personnelle y deviendrait ineffaçable. `actor_email` est la seule
   * exception, dénormalisée pour rester lisible après le départ du collaborateur.
   */
  audit: AuditSink;
  listUsers(tenantId: string): Promise<UserRow[]>;
  /** 'ok' | 'last_admin' (refusé : dernier admin actif) | 'not_found' (inconnu/hors tenant). */
  setUserRole(tenantId: string, userId: string, role: string): Promise<UserMutation>;
  /** Révoque (true) ou réactive (false) un compte. Mêmes garde-fous que le rôle. */
  setUserDisabled(tenantId: string, userId: string, disabled: boolean): Promise<UserMutation>;
  /** Supprime définitivement un compte. Refusé si dernier admin actif. */
  deleteUser(tenantId: string, userId: string): Promise<UserMutation>;
  /** Invitation : crée un compte en attente (sans mdp). */
  createPendingUser(tenantId: string, email: string, role: string, name?: string): Promise<UserRow>;
  /**
   * Pose le nom affiché d'un membre. `not_found` = id inconnu ou autre espace. Même type de retour que les autres
   * mutations de membre (`last_admin` n'arrive pas ici) : un type plus étroit obligerait le câblage à traduire.
   */
  setUserName(tenantId: string, userId: string, name: string): Promise<UserMutation>;
  /** Génère un token d'invitation à usage unique pour ce compte, renvoie le token en clair. */
  createInviteToken(userId: string): Promise<string>;
  /** Envoi de l'email d'invitation (Resend). Absent -> l'invitation est créée mais aucun email n'est envoyé. */
  sendEmail?(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
  /** Nom (ou email de repli) de l'invitant, pour personnaliser l'email. null -> phrase générique. */
  getInviterName(userId: string): Promise<string | null>;
  /**
   * Nom de l'espace de travail (tenant). Sert à personnaliser l'email d'invitation (null -> phrase
   * générique), et à la carte « Espace » de Compte & équipe (null -> 404).
   */
  getWorkspaceName(tenantId: string): Promise<string | null>;
  /** Renomme l'espace (`tenants.name`). `false` = espace inconnu. */
  renommerEspace(tenantId: string, nom: string): Promise<boolean>;
  /**
   * Réinitialise le second facteur d'un membre (téléphone perdu, codes de secours épuisés). `autres_espaces` = la
   * personne a un compte dans un autre espace : refusé ici, ce cas passe par l'exploitation.
   */
  reinitialiserMfa(tenantId: string, userId: string): Promise<IssueReinitialisation>;
  /** Base URL du front pour le lien d'invitation. */
  appUrl: string;
}

/**
 * Rôles attribuables à un membre. `manager` est un statut, pas encore un jeu de droits : côté serveur, tout ce qui
 * n'est pas `admin` reste fermé, donc un manager a les accès d'un agent. Ouvrir une route à ce rôle se décide
 * écriture par écriture.
 */
const ROLES = new Set(['admin', 'manager', 'agent']);

/**
 * Borne du nom affiché d'un membre : un libellé d'écran (liste des membres, affectation de l'Inbox, « suivi
 * par… »), pas un champ libre.
 */
const MAX_NOM = 60;
// Validation d'email minimale (un @, pas d'espace) : le vrai contrôle d'unicité est en base.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Le nom d'un espace, tel qu'il se choisit dans Compte & équipe. La règle est celle de `src/user/nom-espace.ts`,
 * partagée avec l'inscription : les deux écrivains publics de `tenants.name` refusent la même chose.
 */
const nomEspaceSchema = z.object({ nom: nomEspace });

/**
 * Gestion des comptes (onglet Admin). Le groupe est réservé aux admins via `garde`
 * (`[garde, makeRequireRole(['admin'])]`) : pas de garde de rôle en plus ici, la barrière
 * est au preHandler. On ne renvoie jamais le hash ; les mots de passe ne sont jamais journalisés.
 */
export function registerUsers(app: FastifyInstance, deps: UsersRouteDeps, garde: Guard): void {
  const journal = makeJournal(deps.audit);
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/users', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ users: await deps.listUsers(tenant) });
  });

  // Inviter un membre : crée un compte en attente (sans mot de passe) + envoie un lien pour qu'il choisisse le sien.
  app.post('/tenants/:tenantId/invitations', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);

    const b = (req.body ?? {}) as Partial<{ email: unknown; role: unknown; name: unknown }>;
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'email invalide' });
    if (typeof b.role !== 'string' || !ROLES.has(b.role)) return reply.code(400).send({ error: 'role invalide (admin|manager|agent)' });
    if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > MAX_NOM)) {
      return reply.code(400).send({ error: `nom invalide (${MAX_NOM} caractères maximum)` });
    }
    const nom = typeof b.name === 'string' ? b.name.trim() : '';

    try {
      const user = await deps.createPendingUser(tenant, email, b.role, nom);
      const raw = await deps.createInviteToken(user.id);
      let emailSent = false;
      if (deps.sendEmail && deps.appUrl) {
        const acceptUrl = `${deps.appUrl}/invite/${raw}`;
        // Personnalisation au mieux : le nom de l'invitant (req.auth.userId) et de l'espace. Une panne de lookup ne
        // bloque jamais l'invitation -> repli sur une formulation générique.
        const inviterName = req.auth?.userId ? await deps.getInviterName(req.auth.userId).catch(() => null) : null;
        const workspaceName = await deps.getWorkspaceName(tenant).catch(() => null);
        const html = renderInvitationEmail({ inviterName, workspaceName, acceptUrl, role: b.role });
        // Repli texte brut pour les clients qui ne rendent pas le HTML (personnalisé si dispo).
        const intro = inviterName && workspaceName
          ? `${inviterName} t'invite à rejoindre l'espace ${workspaceName} sur Messaging Me.`
          : workspaceName
            ? `Tu es invité à rejoindre l'espace ${workspaceName} sur Messaging Me.`
            : `Tu es invité à rejoindre un espace de travail sur Messaging Me.`;
        const subject = workspaceName ? `Rejoins ${workspaceName} sur Messaging Me` : 'Tu es invité sur Messaging Me';
        try {
          await deps.sendEmail({
            to: email,
            subject,
            text: `${intro}\n\nClique sur ce lien pour choisir ton mot de passe et activer ton compte (valide 7 jours) :\n${acceptUrl}`,
            html,
          });
          emailSent = true;
        } catch {
          // L'invitation (compte + lien) est déjà créée ; l'admin pourra ré-inviter si l'email a échoué.
        }
      }
      /**
       * Le rôle invité, pas l'adresse : l'email est une donnée personnelle que cette table ne purge jamais,
       * l'identifiant interne suffit à retrouver qui. `emailSent` est journalisé : une invitation créée mais non
       * envoyée est un état réel.
       */
      await journal(tenant, req, 'utilisateur.invite', { kind: 'user', id: user.id }, { role: b.role, emailSent });
      return reply.code(201).send({ user, emailSent });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: 'email déjà utilisé' });
      throw err;
    }
  });

  /**
   * Le nom affiché d'un membre (tous les écrans font `name ?? email`). Pas de self-block, contrairement au rôle :
   * se renommer n'a aucune conséquence sur les droits.
   */
  app.patch('/tenants/:tenantId/users/:userId/name', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { userId } = req.params as { userId: string };
    const nom = (req.body as { name?: unknown } | null)?.name;
    if (typeof nom !== 'string' || nom.length > MAX_NOM) {
      return reply.code(400).send({ error: `nom invalide (${MAX_NOM} caractères maximum)` });
    }
    const result = await deps.setUserName(tenant, userId, nom);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    // Le nom effectif est rendu : vide -> `null`, que l'écran affiche comme « pas de nom » et non comme une
    // chaîne vide qu'il aurait crue enregistrée.
    return reply.code(200).send({ id: userId, name: nom.trim() === '' ? null : nom.trim() });
  });

  app.patch('/tenants/:tenantId/users/:userId/role', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { userId } = req.params as { userId: string };

    const role = (req.body as { role?: unknown } | null)?.role;
    if (typeof role !== 'string' || !ROLES.has(role)) {
      return reply.code(400).send({ error: 'role invalide (admin|manager|agent)' });
    }
    // Self-block : un admin ne peut pas changer son propre rôle (auto-lockout en pleine session). L'invariant
    // « au moins un admin par espace » est garanti en base par setUserRole (refus 'last_admin').
    if (req.auth?.userId === userId) {
      return reply.code(400).send({ error: 'tu ne peux pas changer ton propre rôle' });
    }
    // NB : le rôle vit dans le JWT (TTL du token) ; une rétrogradation prend pleinement effet au
    // plus tard à l'expiration/reconnexion. L'invariant base ci-dessus empêche néanmoins le zéro-admin.
    const result = await deps.setUserRole(tenant, userId, role);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur est requis' });
    // Après le succès, jamais avant : une intention refusée (404, 409) ferait du journal un registre de tentatives.
    await journal(tenant, req, 'utilisateur.role_change', { kind: 'user', id: userId }, { role });
    return reply.code(200).send({ id: userId, role });
  });

  // Révoquer (disabled=true) ou réactiver (false) un compte : login bloqué sans supprimer la ligne.
  app.patch('/tenants/:tenantId/users/:userId/disabled', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { userId } = req.params as { userId: string };
    const disabled = (req.body as { disabled?: unknown } | null)?.disabled;
    if (typeof disabled !== 'boolean') return reply.code(400).send({ error: 'disabled (booléen) requis' });
    // Self-block : ne pas se révoquer soi-même (auto-lockout).
    if (req.auth?.userId === userId) return reply.code(400).send({ error: 'tu ne peux pas révoquer ton propre compte' });
    const result = await deps.setUserDisabled(tenant, userId, disabled);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur actif est requis' });
    await journal(tenant, req, 'utilisateur.desactive', { kind: 'user', id: userId }, { disabled });
    return reply.code(200).send({ id: userId, disabled });
  });

  // Supprimer définitivement un compte (irréversible). Mêmes garde-fous que la révocation.
  app.delete('/tenants/:tenantId/users/:userId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { userId } = req.params as { userId: string };
    // Self-block : ne pas supprimer son propre compte.
    if (req.auth?.userId === userId) return reply.code(400).send({ error: 'tu ne peux pas supprimer ton propre compte' });
    const result = await deps.deleteUser(tenant, userId);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur actif est requis' });
    await journal(tenant, req, 'utilisateur.retire', { kind: 'user', id: userId });
    return reply.code(200).send({ id: userId, deleted: true });
  });

  /**
   * Réinitialiser le second facteur d'un membre (téléphone perdu, codes épuisés) : il repassera par l'enrôlement
   * s'il est admin, et se connectera sans code sinon.
   * 🔴 Refusé (409) si la personne a un compte dans un autre espace : le facteur appartient à l'identité, le retirer
   * d'ici l'affaiblirait chez un autre client ; ce cas passe par l'exploitation (`POST /ops/mfa/reinitialiser`).
   * Pas sur soi-même : une session volée ne doit pas pouvoir retirer le facteur de son porteur.
   */
  app.delete('/tenants/:tenantId/users/:userId/mfa', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { userId } = req.params as { userId: string };
    if (req.auth?.userId === userId) {
      return reply.code(400).send({ error: 'Vous ne pouvez pas réinitialiser votre propre double authentification.' });
    }
    // Un identifiant mal formé partirait dans un `where id = $1` sur une colonne `uuid` : 22P02, donc un 500.
    if (!estUuid(userId)) return reply.code(404).send({ error: 'Utilisateur inconnu.' });
    const issue = await deps.reinitialiserMfa(tenant, userId);
    if (issue === 'not_found') return reply.code(404).send({ error: 'Utilisateur inconnu.' });
    if (issue === 'autres_espaces') {
      return reply.code(409).send({
        error: 'Ce membre a aussi un compte dans un autre espace : sa double authentification se réinitialise par le support.',
      });
    }
    await journal(tenant, req, 'mfa.reinitialise', { kind: 'user', id: userId });
    return reply.code(200).send({ id: userId, mfaReinitialise: true });
  });

  /**
   * Le nom de l'espace (`tenants.name`, affiché au choix de l'espace et dans /ops). Réservé aux admins par la garde
   * du groupe (`g.admin` au montage), comme toutes les écritures de Compte & équipe.
   */
  app.get('/tenants/:tenantId/nom', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const nom = await deps.getWorkspaceName(tenant);
    if (nom === null) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send({ nom });
  });

  app.patch('/tenants/:tenantId/nom', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = nomEspaceSchema.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: MESSAGE_NOM_ESPACE_INVALIDE });
    const nom = corps.data.nom;
    // L'ancien nom est lu avant l'écriture : il dit si l'espace existe, et si le nom change vraiment.
    const ancien = await deps.getWorkspaceName(tenant);
    if (ancien === null) return reply.code(404).send({ error: 'espace inconnu' });
    // Rien n'a changé : ni écriture ni ligne de journal, qui est un registre de changements.
    if (ancien === nom) return reply.code(200).send({ nom });
    if (!(await deps.renommerEspace(tenant, nom))) return reply.code(404).send({ error: 'espace inconnu' });
    /**
     * 🔴 Le journal dit qui a renommé et quand, jamais les deux noms : un nom d'espace peut porter le nom complet
     * d'une personne (inscription par Google) ou un numéro, et `audit_log`, gardé deux ans, le rendrait ineffaçable.
     */
    await journal(tenant, req, 'espace.renomme', { kind: 'tenant', id: tenant });
    return reply.code(200).send({ nom });
  });
}

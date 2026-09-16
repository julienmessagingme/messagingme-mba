import type { FastifyInstance } from 'fastify';
import { DuplicateEmailError } from '../user/store.pg';
import type { UserRow, UserMutation } from '../user/store.pg';
import type { Guard } from '../auth/middleware';
import { renderInvitationEmail } from '../support/email-templates';
import { scopeTenant } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

export interface UsersRouteDeps {
  /**
   * Journal d'audit des ACCÈS (2026-09-15). Optionnel : absent -> aucune trace, ce qui est le comportement
   * des câblages de test qui ne montent pas de base.
   *
   * 🔴 LE `detail` NE PORTE JAMAIS D'EMAIL NI DE NOM, seulement le RÔLE avant et après. Cette table n'est
   * jamais purgée par la rétention des contacts : y écrire une donnée personnelle la rendrait ineffaçable, et
   * annulerait l'effacement qu'une autre ligne du même journal certifie (migration 0061). `actor_email` est
   * la seule exception, dénormalisée exprès pour rester lisible après le départ du collaborateur.
   */
  audit?: AuditSink;
  listUsers(tenantId: string): Promise<UserRow[]>;
  /** 'ok' | 'last_admin' (refusé : dernier admin actif) | 'not_found' (inconnu/hors tenant). */
  setUserRole(tenantId: string, userId: string, role: string): Promise<UserMutation>;
  /** Révoque (true) ou réactive (false) un compte. Mêmes garde-fous que le rôle. */
  setUserDisabled(tenantId: string, userId: string, disabled: boolean): Promise<UserMutation>;
  /** Supprime définitivement un compte. Refusé si dernier admin actif. */
  deleteUser(tenantId: string, userId: string): Promise<UserMutation>;
  /** Invitation : crée un compte EN ATTENTE (sans mdp). Absent -> invitations indisponibles (503). */
  createPendingUser?(tenantId: string, email: string, role: string, name?: string): Promise<UserRow>;
  /**
   * Pose le nom affiché d'un membre. `not_found` = id inconnu ou autre espace.
   *
   * ⚠️ Le type de retour est celui des autres mutations de membre (`UserMutation`), même si `last_admin` ne
   * peut pas arriver ici : renommer quelqu'un ne touche à aucun invariant. Le déclarer plus étroit obligerait
   * le câblage à traduire, et c'est précisément là que les contrats divergent.
   */
  setUserName?(tenantId: string, userId: string, name: string): Promise<UserMutation>;
  /** Génère un token d'invitation à usage unique pour ce compte, renvoie le token en clair. */
  createInviteToken?(userId: string): Promise<string>;
  /** Envoi de l'email d'invitation (Resend). Absent -> l'invitation est créée mais aucun email n'est envoyé. */
  sendEmail?(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
  /** Nom (ou email de repli) de l'invitant, pour personnaliser l'email. Absent/null -> phrase générique. */
  getInviterName?(userId: string): Promise<string | null>;
  /** Nom de l'espace de travail (tenant), pour personnaliser l'email. Absent/null -> phrase générique. */
  getWorkspaceName?(tenantId: string): Promise<string | null>;
  /** Base URL du front pour le lien d'invitation. */
  appUrl?: string;
}

/**
 * Rôles attribuables à un membre.
 *
 * ⚠️ `manager` est un STATUT, pas encore un jeu de droits : côté serveur, tout ce qui n'est pas `admin` reste
 * fermé (`makeRequireRole(['admin'])` sur les groupes de routes, `forbidNonAdmin` dans les handlers). Un
 * manager a donc aujourd'hui exactement les accès d'un agent. Ouvrir des routes à ce rôle demandera de
 * décider, écriture par écriture, ce qu'un manager a le droit de faire : on n'accorde pas une autorisation
 * par défaut d'implémentation.
 */
const ROLES = new Set(['admin', 'manager', 'agent']);

/**
 * Borne du NOM affiché d'un membre.
 *
 * ⚠️ C'est un libellé d'écran, pas un champ libre : il s'affiche dans la liste des membres, dans le sélecteur
 * d'affectation de l'Inbox et dans « suivi par… ». Trop long, il déborde partout à la fois.
 */
const MAX_NOM = 60;
// Validation d'email minimale (un @, pas d'espace) : le vrai contrôle d'unicité est en base.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Gestion des comptes (onglet Admin). Le GROUPE est réservé aux admins via `garde`
 * (`[garde, makeRequireRole(['admin'])]`) : pas de garde de rôle en plus ici, la barrière
 * est au preHandler. On ne renvoie jamais le hash ; les mots de passe ne sont jamais journalisés.
 */
export function registerUsers(app: FastifyInstance, deps: UsersRouteDeps, garde: Guard): void {
  const journal = makeJournal(deps.audit);
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/users', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ users: await deps.listUsers(tenant) });
  });

  // Inviter un membre : crée un compte EN ATTENTE (sans mot de passe) + envoie un lien pour qu'il choisisse le sien.
  app.post('/tenants/:tenantId/invitations', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.createPendingUser || !deps.createInviteToken) return reply.code(503).send({ error: 'invitations indisponibles' });

    const b = (req.body ?? {}) as Partial<{ email: unknown; role: unknown; name: unknown }>;
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'email invalide' });
    if (typeof b.role !== 'string' || !ROLES.has(b.role)) return reply.code(400).send({ error: 'role invalide (admin|manager|agent)' });
    // ⚠️ LE NOM EST FACULTATIF, et borné : c'est un libellé d'écran, pas un champ libre. Trop long, il
    // déborderait de la liste des membres et du sélecteur d'affectation de l'Inbox.
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
        // Personnalisation best-effort : le nom de l'invitant (req.auth.userId) et de l'espace (tenant).
        // Une panne de lookup ne bloque JAMAIS l'invitation -> repli sur une formulation générique.
        const inviterName = req.auth?.userId && deps.getInviterName ? await deps.getInviterName(req.auth.userId).catch(() => null) : null;
        const workspaceName = deps.getWorkspaceName ? await deps.getWorkspaceName(tenant).catch(() => null) : null;
        const html = renderInvitationEmail({ inviterName, workspaceName, acceptUrl, role: b.role });
        // Repli TEXTE brut pour les clients qui ne rendent pas le HTML (personnalisé si dispo).
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
       * ⚠️ LE RÔLE INVITÉ, PAS L'ADRESSE. C'est le rôle qui dit ce qu'on vient d'accorder, et une adresse
       * e-mail est une donnée personnelle que cette table ne purge jamais. La cible porte l'identifiant
       * interne du compte créé : il suffit à retrouver qui, sans le graver.
       *
       * ⚠️ `emailSent` est journalisé parce qu'une invitation créée mais NON envoyée est un état réel, et la
       * question « pourquoi n'a-t-il jamais reçu le lien ? » se pose des semaines après.
       */
      await journal(tenant, req, 'utilisateur.invite', { kind: 'user', id: user.id }, { role: b.role, emailSent });
      return reply.code(201).send({ user, emailSent });
    } catch (err) {
      if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: 'email déjà utilisé' });
      throw err;
    }
  });

  /**
   * LE NOM AFFICHÉ d'un membre.
   *
   * 🔴 POURQUOI CETTE ROUTE EXISTE : la colonne `users.name` était là depuis toujours, tous les écrans font
   * déjà `name ?? email`, et RIEN ne permettait de l'écrire. Conséquence, l'Inbox affichait des adresses
   * e-mail partout (« suivi par julien@messagingme.fr »), ce qui n'est ni lisible ni ce qu'on montre à une
   * équipe. Demandé par Julien le 2026-09-11.
   *
   * ⚠️ PAS DE SELF-BLOCK, contrairement au rôle : se renommer soi-même n'a aucune conséquence sur les droits,
   * et un admin qui ne pourrait pas corriger son propre nom serait une bizarrerie sans raison.
   */
  app.patch('/tenants/:tenantId/users/:userId/name', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.setUserName) return reply.code(503).send({ error: 'renommage indisponible' });
    const { userId } = req.params as { userId: string };
    const nom = (req.body as { name?: unknown } | null)?.name;
    if (typeof nom !== 'string' || nom.length > MAX_NOM) {
      return reply.code(400).send({ error: `nom invalide (${MAX_NOM} caractères maximum)` });
    }
    const result = await deps.setUserName(tenant, userId, nom);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    // Le nom EFFECTIF est rendu : vide -> `null`, ce que l'écran doit afficher comme « pas de nom » et non
    // comme une chaîne vide qu'il aurait crue enregistrée.
    return reply.code(200).send({ id: userId, name: nom.trim() === '' ? null : nom.trim() });
  });

  app.patch('/tenants/:tenantId/users/:userId/role', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { userId } = req.params as { userId: string };

    const role = (req.body as { role?: unknown } | null)?.role;
    if (typeof role !== 'string' || !ROLES.has(role)) {
      return reply.code(400).send({ error: 'role invalide (admin|manager|agent)' });
    }
    // Self-block : un admin ne peut pas changer son PROPRE rôle (évite l'auto-lockout de l'UI en
    // pleine session). L'invariant « ≥1 admin par tenant » est réellement garanti EN BASE par
    // setUserRole (refus 'last_admin'), pas par ce seul self-block.
    if (req.auth?.userId === userId) {
      return reply.code(400).send({ error: 'tu ne peux pas changer ton propre rôle' });
    }
    // NB : le rôle vit dans le JWT (TTL du token) ; une rétrogradation prend pleinement effet au
    // plus tard à l'expiration/reconnexion. L'invariant base ci-dessus empêche néanmoins le zéro-admin.
    const result = await deps.setUserRole(tenant, userId, role);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur est requis' });
    // ⚠️ APRÈS le succès, jamais avant : journaliser une intention qui a été REFUSÉE (404, 409) ferait lire
    // le journal comme un registre de changements alors qu'il serait un registre de tentatives.
    await journal(tenant, req, 'utilisateur.role_change', { kind: 'user', id: userId }, { role });
    return reply.code(200).send({ id: userId, role });
  });

  // Révoquer (disabled=true) ou réactiver (false) un compte : login bloqué sans supprimer la ligne.
  app.patch('/tenants/:tenantId/users/:userId/disabled', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
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
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { userId } = req.params as { userId: string };
    // Self-block : ne pas supprimer son propre compte.
    if (req.auth?.userId === userId) return reply.code(400).send({ error: 'tu ne peux pas supprimer ton propre compte' });
    const result = await deps.deleteUser(tenant, userId);
    if (result === 'not_found') return reply.code(404).send({ error: 'utilisateur inconnu' });
    if (result === 'last_admin') return reply.code(409).send({ error: 'au moins un administrateur actif est requis' });
    await journal(tenant, req, 'utilisateur.retire', { kind: 'user', id: userId });
    return reply.code(200).send({ id: userId, deleted: true });
  });
}

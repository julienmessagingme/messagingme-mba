'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listUsers, inviteMember, setUserRole, setUserDisabled, deleteUser, renommerMembre, lireNomEspace, renommerEspace, reinitialiserSecondFacteur, lireSecondFacteurEspace, poserSecondFacteurEspace, type AdminUser, type UserRole } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { inputCls } from '@/lib/ui';
import { estAnnulation, ApiError } from '@/lib/http';
import { routeInconnue } from '@/lib/canaux-services';
import { Bouton } from '@/components/Bouton';
import { lireSiegeRequis, type SiegeRequis } from '@/lib/offre';
import { changerSieges } from '@/lib/api/offre';
import { oublierOffre, useOffre } from '@/lib/use-offre';
import { useChargement } from '@/lib/use-chargement';
import { TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';
import { DemandeMotDePasse } from '@/components/DemandeMotDePasse';

export default function AdminPage() {
  return <AppShell active="admin">{(session) => <AdminInner session={session} />}</AppShell>;
}

function AdminInner({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
  const { locale } = useLocale();
  /**
   * EN PRO, TOUS ADMINISTRATEURS (spec Business, « promus d'office ») : le serveur traite chaque membre en administrateur
   * et refuse un changement de rôle (409 `roles_en_business`). L'écran n'offre donc aucun choix de rôle et dit
   * « Administrateur » pour tous ; le rôle enregistré reprend effet si l'espace monte en Business.
   */
  const tousAdmins = useOffre(session.tenantId)?.offre === 'pro';
  const [users, setUsers] = useState<AdminUser[]>([]);
  /** Le membre dont l'admin s'apprête à réinitialiser le facteur : la fenêtre du mot de passe est ouverte pour lui. */
  const [aReinitialiser, setAReinitialiser] = useState<AdminUser | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const charger = useCallback(async () => {
    const { users } = await listUsers(session.tenantId);
    setUsers(users);
  }, [session.tenantId]);
  const { chargement: loading, erreur: error, setErreur: setError, recharger: load } = useChargement(charger);

  /**
   * Renomme un membre, à la sortie du champ.
   *
   * ⚠️ OPTIMISTE PUIS ROLLBACK, comme le changement de rôle juste en dessous : l'écran ne doit pas clignoter
   * pour une écriture qui réussit presque toujours, mais il ne doit pas non plus garder un nom que le serveur
   * a refusé.
   */
  async function renommer(u: AdminUser, nom: string) {
    const propre = nom.trim();
    if (propre === (u.name ?? '')) return; // rien n'a changé : pas d'écriture.
    setError(null);
    const prev = users;
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, name: propre === '' ? null : propre } : x)));
    try {
      await renommerMembre(session.tenantId, u.id, propre);
    } catch (err) {
      setUsers(prev);
      setError(err instanceof Error ? err.message : t('Renommage impossible', 'Unable to rename'));
    }
  }

  async function changeRole(u: AdminUser, role: UserRole) {
    setError(null);
    const prev = users;
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, role } : x))); // optimiste
    try {
      await setUserRole(session.tenantId, u.id, role);
    } catch (err) {
      setUsers(prev); // rollback
      setError(err instanceof Error ? err.message : t('Changement de rôle impossible', 'Unable to change role'));
    }
  }

  async function toggleDisabled(u: AdminUser) {
    setError(null);
    const next = !u.disabled;
    const prev = users;
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, disabled: next } : x))); // optimiste
    try {
      await setUserDisabled(session.tenantId, u.id, next);
    } catch (err) {
      setUsers(prev); // rollback
      setError(err instanceof Error ? err.message : t('Action impossible', 'Action failed'));
    }
  }

  async function removeUser(u: AdminUser) {
    if (!(await confirmer({ titre: t('Supprimer le compte', 'Delete the account'), message: t(`Supprimer définitivement le compte ${u.email} ?\nCette action est irréversible.`, `Permanently delete account ${u.email}?\nThis action is irreversible.`), confirmer: t('Supprimer', 'Delete') }))) return;
    setError(null);
    const prev = users;
    setUsers((list) => list.filter((x) => x.id !== u.id)); // optimiste
    try {
      await deleteUser(session.tenantId, u.id);
    } catch (err) {
      setUsers(prev); // rollback
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  /**
   * Retire le second facteur d'un membre (téléphone perdu, codes épuisés). Si l'espace exige la double
   * authentification de ses administrateurs, un administrateur la reposera à sa prochaine connexion ; sinon, la
   * personne se connectera sans code.
   *
   * ⚠️ Le 409 n'est pas une panne : la personne a aussi un compte dans un AUTRE espace, et son facteur vaut
   * là-bas aussi. L'admin d'ici n'en décide pas, le support si.
   */
  /**
   * 🔴 Le mot de passe de l'admin est redemandé avant (décision de Julien du 2026-10-13) : une session restée ouverte
   * ne retire pas le facteur d'un collègue en un clic. Un mot de passe faux (403) se redit dans la fenêtre, qui reste
   * ouverte ; le reste la ferme et s'affiche sur la page.
   */
  async function reinitialiserMfa(u: AdminUser, motDePasse: string): Promise<string | null> {
    setError(null);
    setInfo(null);
    try {
      await reinitialiserSecondFacteur(session.tenantId, u.id, motDePasse);
      setAReinitialiser(null);
      setInfo(t(`Double authentification réinitialisée pour ${u.email}.`, `Two-factor authentication reset for ${u.email}.`));
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return t('Mot de passe incorrect.', 'Wrong password.');
      if (err instanceof ApiError && err.status === 429) return err.message;
      setAReinitialiser(null);
      setError(err instanceof ApiError && err.status === 409
        ? (err.message.includes('mot de passe')
          ? t('Posez d’abord un mot de passe sur votre compte (Mon compte), puis recommencez.', 'Set a password on your account first (My account), then try again.')
          : t('Cette personne a un accès à un autre espace : la réinitialisation passe par le support.', 'This person has access to another workspace: the reset goes through support.'))
        : err instanceof Error ? err.message : t('Réinitialisation impossible', 'Unable to reset'));
      return null;
    }
  }

  return (
    <div className="space-y-6">
      <TitrePage>{t('Compte', 'Account')}</TitrePage>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="admin-erreur">{error}</p>}
      {info && <p className="rounded-controle bg-succes-50 px-3 py-2 text-sm text-succes-800" data-testid="admin-info">{info}</p>}

      <EspaceCard tenantId={session.tenantId} />
      <SecuriteEspaceCard tenantId={session.tenantId} />
      {aReinitialiser && (
        <DemandeMotDePasse
          titre={t('Réinitialiser la double authentification', 'Reset two-factor authentication')}
          message={t(`Retirer la double authentification de ${aReinitialiser.email} ?\nSi l’espace l’exige de ses administrateurs, un administrateur la configurera de nouveau à sa prochaine connexion.`, `Remove two-factor authentication from ${aReinitialiser.email}?\nIf the workspace requires it of its administrators, an administrator will set it up again at their next sign-in.`)}
          libelleConfirmer={t('Réinitialiser', 'Reset')}
          onConfirmer={(mdp) => reinitialiserMfa(aReinitialiser, mdp)}
          onAnnuler={() => setAReinitialiser(null)}
        />
      )}

      <InviteCard tenantId={session.tenantId} onInvited={load} tousAdmins={tousAdmins} />

      <div className="overflow-hidden rounded-carte border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">
          {t('Comptes', 'Accounts')} ({users.length})
        </div>
        {loading ? (
          <Squelette forme="carte" className="px-5 py-6" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Email', 'Email')}</th>
                <th className="px-5 py-2 font-medium">{t('Rôle', 'Role')}</th>
                <th className="px-5 py-2 font-medium">{t('Statut', 'Status')}</th>
                <th className="px-5 py-2 font-medium">{t('Dernière connexion', 'Last sign-in')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.email.toLowerCase() === session.email.toLowerCase();
                return (
                  <tr key={u.id} className="border-b border-ink-50 last:border-0">
                    {/* 🔴 LE NOM EST MODIFIABLE ICI, et c'est tout le sujet : la colonne existait, tous les
                        écrans font déjà `name ?? email`, mais rien ne permettait de l'écrire. L'Inbox
                        affichait donc des adresses e-mail partout. */}
                    <td className="px-5 py-3">
                      <input
                        data-testid={`membre-nom-${u.id}`}
                        defaultValue={u.name ?? ''}
                        onBlur={(e) => { void renommer(u, e.target.value); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        placeholder={t('prénom', 'first name')}
                        maxLength={60}
                        className={`w-36 rounded-controle border border-transparent px-2 py-1 text-sm hover:border-ink-200 focus:border-brand-500 focus:outline-none ${u.disabled ? 'text-ink-400' : 'text-ink-900'}`}
                      />
                    </td>
                    <td className={`px-5 py-3 ${u.disabled ? 'text-ink-400' : 'text-ink-500'}`}>{u.email}</td>
                    <td className="px-5 py-3">
                      {tousAdmins ? (
                        <span className="text-sm text-ink-900" data-testid="role-administrateur">{t('Administrateur', 'Administrator')}</span>
                      ) : (
                      <select
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) => changeRole(u, e.target.value as UserRole)}
                        title={isSelf ? t('Vous ne pouvez pas changer votre propre rôle', 'You cannot change your own role') : ''}
                        className="rounded-controle border border-ink-300 bg-white px-2 py-1 text-sm text-ink-900 disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-400"
                      >
                        <option value="admin">Admin</option>
                        <option value="manager">Manager</option>
                        <option value="agent">Agent</option>
                      </select>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {u.disabled ? (
                        <span className="inline-flex items-center rounded-full bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-700">{t('Révoqué', 'Revoked')}</span>
                      ) : u.pending ? (
                        <span className="inline-flex items-center rounded-full bg-alerte-50 px-2 py-0.5 text-xs font-medium text-alerte" title={t("A été invité mais n’a pas encore choisi son mot de passe", "Has been invited but hasn't chosen a password yet")}>{t('Invité', 'Invited')}</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-succes-50 px-2 py-0.5 text-xs font-medium text-succes-700">{t('Actif', 'Active')}</span>
                      )}
                    </td>
                    <td className={`px-5 py-3 tabular-nums ${u.disabled ? 'text-ink-400' : 'text-ink-500'}`}>
                      {u.lastLoginAt ? (
                        <>
                          {formatDate(u.lastLoginAt, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })}
                          <span className="ml-1.5 text-ink-500">{hourMin(u.lastLoginAt, locale)}</span>
                        </>
                      ) : (
                        <span className="text-ink-500" title={t('Aucune connexion depuis la mise en place du suivi', 'No sign-in since tracking was introduced')}>
                          {t('Jamais', 'Never')}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                        {/* Pas sur soi (le serveur refuse, et une session volée ne doit pas retirer le facteur de
                            son porteur), ni sur une invitation en attente, qui n'a pas encore de facteur. */}
                        {!isSelf && !u.pending && (
                          <button
                            onClick={() => setAReinitialiser(u)}
                            data-testid={`membre-mfa-${u.id}`}
                            className="text-ink-500 hover:text-ink-900"
                          >
                            {t('Réinitialiser la double authentification', 'Reset two-factor authentication')}
                          </button>
                        )}
                        <button
                          onClick={() => toggleDisabled(u)}
                          disabled={isSelf}
                          title={isSelf ? t('Vous ne pouvez pas révoquer votre propre compte', 'You cannot revoke your own account') : ''}
                          className="text-ink-500 hover:text-ink-900 disabled:cursor-not-allowed disabled:text-ink-400"
                        >
                          {u.disabled ? t('Réactiver', 'Reactivate') : t('Révoquer', 'Revoke')}
                        </button>
                        <button
                          onClick={() => removeUser(u)}
                          disabled={isSelf}
                          title={isSelf ? t('Vous ne pouvez pas supprimer votre propre compte', 'You cannot delete your own account') : t('Suppression définitive', 'Permanent deletion')}
                          className="text-danger hover:text-danger-500 disabled:cursor-not-allowed disabled:text-ink-400"
                        >
                          {t('Supprimer', 'Delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function InviteCard({ tenantId, onInvited, tousAdmins }: { tenantId: string; onInvited: () => void; tousAdmins: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const [email, setEmail] = useState('');
  const [nom, setNom] = useState('');
  const [role, setRole] = useState<UserRole>('agent');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /**
   * Le siège proposé par un refus à la limite d'utilisateurs d'un Pro (spec offres v2, livraison 7) : son prix est dit, et
   * l'administrateur confirme avant que rien ne soit facturé. `facture` : le prorata n'a pas été payé, sa page Stripe.
   */
  const [siege, setSiege] = useState<SiegeRequis | null>(null);
  const [facture, setFacture] = useState<string | null>(null);

  async function inviter() {
    const res = await inviteMember(tenantId, email.trim(), role, nom.trim());
    setMsg({ kind: 'ok', text: res.emailSent ? t(`Invitation envoyée à ${email.trim()}.`, `Invitation sent to ${email.trim()}.`) : t(`Invitation créée pour ${email.trim()} (email non envoyé, vérifiez la configuration).`, `Invitation created for ${email.trim()} (email not sent, check the config).`) });
    setEmail('');
    setNom('');
    setRole('agent');
    onInvited();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setFacture(null);
    setBusy(true);
    try {
      await inviter();
    } catch (err) {
      const s = err instanceof ApiError ? lireSiegeRequis(err.corps) : null;
      if (s) setSiege(s);
      else setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Invitation impossible', 'Unable to invite') });
    } finally {
      setBusy(false);
    }
  }

  /** Le siège payé chez Stripe D'ABORD (le prorata, sur la carte de la formule Pro), puis la même invitation. */
  async function acheterEtInviter() {
    if (!siege) return;
    setMsg(null);
    setBusy(true);
    try {
      try {
        await changerSieges(tenantId, siege.cible - 1, siege.cible);
      } finally {
        // La limite a peut-être changé : la page Offre et la coquille la relisent (Y18 de la relecture).
        oublierOffre();
      }
      setSiege(null);
      await inviter();
    } catch (err) {
      const corps = err instanceof ApiError ? err.corps : null;
      const url = typeof corps === 'object' && corps !== null && (corps as { code?: unknown }).code === 'paiement_siege_incomplet'
        ? (corps as { url?: unknown }).url : null;
      setFacture(typeof url === 'string' && url.startsWith('https://') ? url : null);
      setSiege(null);
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Ajout impossible', 'Unable to add') });
    } finally {
      setBusy(false);
    }
  }
  const prixSiege = siege ? (siege.prixHtCentimes / 100).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR') : '';

  return (
    <form onSubmit={submit} className="space-y-3 rounded-carte border border-brand-200 bg-brand-50/40 p-5">
      <div className="text-sm font-semibold text-ink-900">{t('Inviter un membre', 'Invite a member')}</div>
      <p className="text-xs text-ink-500">{t("Il reçoit un email pour choisir son mot de passe et rejoindre l’espace.", 'They receive an email to choose their password and join the workspace.')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Email', 'Email')}</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder={t('membre@entreprise.fr', 'member@company.com')} />
        </div>
        {/* ⚠️ FACULTATIF, mais proposé ICI : posé à l'invitation, le membre apparaît tout de suite sous son
            prénom dans l'Inbox. Saisi plus tard, il aura été une adresse e-mail entre-temps. */}
        <div className="min-w-[140px]">
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Prénom (facultatif)', 'First name (optional)')}</label>
          <input value={nom} onChange={(e) => setNom(e.target.value)} maxLength={60} className={inputCls} placeholder={t('Camille', 'Camille')} />
        </div>
        {!tousAdmins && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Rôle', 'Role')}</label>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="rounded-controle border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100">
            <option value="agent">{t('Agent', 'Agent')}</option>
            <option value="manager">{t('Manager', 'Manager')}</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        )}
        <Bouton enCours={busy} type="submit" disabled={busy}>
          {busy ? t('Envoi…', 'Sending…') : t('Inviter', 'Invite')}
        </Bouton>
      </div>
      {/* Dit ce que chaque rôle donne VRAIMENT (spec Business, « À savoir ») : la phrase d'avant réduisait le manager à
          l'Inbox, alors que les routes lui ouvrent l'affectation, l'encadrement, les désabonnés et le journal. En Pro, il
          n'y a pas de rôle : tout membre est administrateur (`roleEffectif`). */}
      <p className="text-xs leading-snug text-ink-500" data-testid="roles-explication">
        {tousAdmins
          ? t(
            'En formule Pro, chaque membre est administrateur. Les rôles (manager, agent) viennent avec l’offre Business.',
            'On Pro, every member is an administrator. Roles (manager, agent) come with the Business plan.',
          )
          : t(
            'Un agent répond dans l’Inbox, aux conversations libres et aux siennes. Un manager y voit toutes les conversations, les affecte, règle l’encadrement de l’équipe, consulte les contacts désabonnés et le journal. Un administrateur a toute la console.',
            'An agent replies in the Inbox, to unassigned conversations and their own. A manager sees every conversation there, assigns them, sets the team supervision, checks unsubscribed contacts and the log. An administrator has the whole console.',
          )}
      </p>
      {siege && (
        <div data-testid="siege-requis" className="space-y-3 rounded-controle border border-brand-200 bg-white px-4 py-3 text-sm text-ink-700">
          <p>
            {siege.periodicite === 'an'
              ? t(`Votre formule Pro compte déjà tous ses utilisateurs. Un utilisateur de plus coûte ${prixSiege} € HT par an : le prorata jusqu’à la fin de votre période est facturé maintenant, sur la carte de la formule Pro (pendant un essai, rien n’est facturé avant sa fin).`, `Your Pro plan already has all its users. One more user costs €${prixSiege} excl. VAT per year: the prorated amount until the end of your period is charged now, on the Pro card (during a trial, nothing is charged before it ends).`)
              : t(`Votre formule Pro compte déjà tous ses utilisateurs. Un utilisateur de plus coûte ${prixSiege} € HT par mois : le prorata jusqu’à la fin de votre période est facturé maintenant, sur la carte de la formule Pro (pendant un essai, rien n’est facturé avant sa fin).`, `Your Pro plan already has all its users. One more user costs €${prixSiege} excl. VAT per month: the prorated amount until the end of your period is charged now, on the Pro card (during a trial, nothing is charged before it ends).`)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Bouton type="button" enCours={busy} disabled={busy} onClick={() => { void acheterEtInviter(); }}>{t('Ajouter et inviter', 'Add and invite')}</Bouton>
            <Bouton type="button" variante="secondaire" disabled={busy} onClick={() => setSiege(null)}>{t('Annuler', 'Cancel')}</Bouton>
          </div>
        </div>
      )}
      {msg && <p className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>}
      {facture && (
        <a data-testid="siege-facture" href={facture} target="_blank" rel="noopener noreferrer" className="inline-block text-sm font-medium text-brand-600 hover:underline">
          {t('Régler la facture de l’utilisateur en plus', 'Pay the invoice for the extra user')}
        </a>
      )}
    </form>
  );
}

/**
 * LE NOM DE L'ESPACE (2026-09-25). `tenants.name` s'affiche au choix de l'espace à la connexion et dans /ops, et il
 * n'était modifiable nulle part. La règle (1 à 80 caractères une fois rogné, sans caractère de contrôle) est tenue
 * par le SERVEUR : l'écran rogne, borne la saisie et affiche son refus tel quel.
 *
 * ⚠️ LA ROUTE PEUT MANQUER : Vercel publie la console à chaque `git push`, l'API attend son déploiement. Son 404 de
 * routeur est dit comme tel, pas affiché comme une panne.
 */
function EspaceCard({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [actuel, setActuel] = useState<string | null>(null);
  const [saisie, setSaisie] = useState('');
  const [lecture, setLecture] = useState<'en_cours' | 'ok' | 'indisponible'>('en_cours');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const pasAJour = t('Le renommage de l’espace n’est pas encore disponible : le serveur n’est pas à jour. Réessayez un peu plus tard.', 'Renaming the workspace is not available yet: the server is not up to date. Try again a bit later.');

  useEffect(() => {
    let vivant = true;
    lireNomEspace(tenantId)
      .then((r) => {
        if (!vivant) return;
        setActuel(r.nom);
        setSaisie(r.nom);
        setLecture('ok');
      })
      .catch((err: unknown) => {
        if (!vivant || estAnnulation(err)) return;
        setLecture('indisponible');
        setMsg({ kind: 'err', text: routeInconnue(err) ? pasAJour : err instanceof Error ? err.message : t('Lecture du nom impossible', 'Unable to read the name') });
      });
    return () => { vivant = false; };
    // `pasAJour` et `t` suivent la langue : relire le nom pour un changement de langue n'aurait aucun sens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const propre = saisie.trim();
  const inchange = propre === '' || propre === actuel;

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    if (inchange || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      // Le nom EFFECTIF rendu par le serveur remplace la saisie : l'écran montre ce qui est en base.
      const r = await renommerEspace(tenantId, propre);
      setActuel(r.nom);
      setSaisie(r.nom);
      setMsg({ kind: 'ok', text: t('Nom de l’espace enregistré.', 'Workspace name saved.') });
    } catch (err) {
      setMsg({ kind: 'err', text: routeInconnue(err) ? pasAJour : err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form data-testid="espace-carte" onSubmit={enregistrer} className="space-y-3 rounded-carte border border-ink-200 bg-white p-5">
      <div className="text-sm font-semibold text-ink-900">{t('Espace', 'Workspace')}</div>
      {lecture === 'en_cours' && <Squelette forme="carte" />}
      {lecture === 'ok' && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label htmlFor="espace-nom" className="mb-1 block text-xs font-medium text-ink-500">{t('Nom de l’espace', 'Workspace name')}</label>
            <input id="espace-nom" data-testid="espace-nom" value={saisie} onChange={(e) => setSaisie(e.target.value)} maxLength={80} required className={inputCls} />
          </div>
          <Bouton enCours={busy}
            type="submit"
            data-testid="espace-enregistrer"
            disabled={busy || inchange}
          >
            {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
          </Bouton>
        </div>
      )}
      {msg && (
        <p data-testid="espace-message" className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>
      )}
    </form>
  );
}

/**
 * LA DOUBLE AUTHENTIFICATION DES ADMINISTRATEURS, AU CHOIX DE L'ESPACE (migration 0230, décision de Julien du
 * 2026-10-13). Désactivée à la création d'un espace : c'était le premier geste demandé à qui venait de créer le sien.
 * Cochée, elle vaut pour TOUS les administrateurs de l'espace : chacun, s'il n'en a pas, la configure à sa prochaine
 * connexion par mot de passe, et ne peut plus la retirer. Une connexion Google ne la demande pas (choix du même jour),
 * et l'écran le dit : sans cette phrase, on croirait l'espace protégé contre ce qui ne l'est pas.
 *
 * ⚠️ LA ROUTE PEUT MANQUER (console publiée avant l'API) : la carte se cache, il n'y a rien à régler.
 */
function SecuriteEspaceCard({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [exige, setExige] = useState<boolean | null>(null);
  const [lecture, setLecture] = useState<'en_cours' | 'ok' | 'absente' | 'erreur'>('en_cours');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** La fenêtre du mot de passe, ouverte par un décochage. */
  const [demandeMdp, setDemandeMdp] = useState(false);

  useEffect(() => {
    let vivant = true;
    lireSecondFacteurEspace(tenantId)
      .then((r) => {
        if (!vivant) return;
        // Une réponse sans booléen ne dit rien du réglage : la carte se cache plutôt que d'afficher une case fausse.
        if (typeof r.exigePourLesAdmins !== 'boolean') { setLecture('absente'); return; }
        setExige(r.exigePourLesAdmins);
        setLecture('ok');
      })
      .catch((err: unknown) => {
        if (!vivant || estAnnulation(err)) return;
        if (routeInconnue(err)) { setLecture('absente'); return; }
        setLecture('erreur');
        setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Lecture du réglage impossible', 'Unable to read the setting') });
      });
    return () => { vivant = false; };
    // `t` suit la langue : relire le réglage pour un changement de langue n'aurait aucun sens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (lecture === 'absente') return null;

  const messageOk = (exigee: boolean): string => (exigee
    ? t('Exigée : chaque administrateur qui ne l’a pas encore la configurera à sa prochaine connexion.', 'Required: each administrator who does not have it yet will set it up at their next sign-in.')
    : t('Laissée au choix de chaque administrateur, depuis Mon compte.', 'Left to each administrator, from My account.'));

  /** Cocher renforce l'espace : tout de suite, la case suit le geste et un refus la remet comme avant. */
  async function exiger() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    setExige(true);
    try {
      const r = await poserSecondFacteurEspace(tenantId, true);
      setExige(r.exigePourLesAdmins);
      setMsg({ kind: 'ok', text: messageOk(r.exigePourLesAdmins) });
    } catch (err) {
      setExige(false);
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save') });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 🔴 Décocher l'affaiblit : le mot de passe d'abord (décision de Julien du 2026-10-13). La case ne bouge qu'une fois
   * le serveur d'accord ; un mot de passe faux se redit dans la fenêtre, qui reste ouverte.
   */
  async function liberer(motDePasse: string): Promise<string | null> {
    setMsg(null);
    try {
      const r = await poserSecondFacteurEspace(tenantId, false, motDePasse);
      setExige(r.exigePourLesAdmins);
      setDemandeMdp(false);
      setMsg({ kind: 'ok', text: messageOk(r.exigePourLesAdmins) });
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return t('Mot de passe incorrect.', 'Wrong password.');
      if (err instanceof ApiError && err.status === 429) return err.message;
      setDemandeMdp(false);
      setMsg({ kind: 'err', text: err instanceof ApiError && err.status === 409
        ? t('Posez d’abord un mot de passe sur votre compte (Mon compte), puis recommencez.', 'Set a password on your account first (My account), then try again.')
        : err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save') });
      return null;
    }
  }

  return (
    <div data-testid="securite-espace-carte" className="space-y-3 rounded-carte border border-ink-200 bg-white p-5">
      <div className="text-sm font-semibold text-ink-900">{t('Sécurité de l’espace', 'Workspace security')}</div>
      {lecture === 'en_cours' && <Squelette forme="carte" />}
      {lecture === 'ok' && exige !== null && (
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            data-testid="securite-espace-second-facteur"
            checked={exige}
            disabled={busy}
            onChange={(e) => { if (e.target.checked) void exiger(); else setDemandeMdp(true); }}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium text-ink-900">{t('Exiger la double authentification pour tous les administrateurs', 'Require two-factor authentication for all administrators')}</span>
            <span className="block text-xs text-ink-500">
              {t(
                'Chaque administrateur de l’espace donne alors un code d’application en plus de son mot de passe, et ne peut plus le retirer. Ceux qui ne l’ont pas encore la configurent à leur prochaine connexion. Les sessions déjà ouvertes continuent, et la connexion avec Google ne la demande pas.',
                'Every administrator of the workspace then gives an app code in addition to their password, and can no longer remove it. Those who do not have it yet set it up at their next sign-in. Sessions already open carry on, and signing in with Google does not ask for it.',
              )}
            </span>
          </span>
        </label>
      )}
      {demandeMdp && (
        <DemandeMotDePasse
          titre={t('Ne plus exiger la double authentification', 'Stop requiring two-factor authentication')}
          message={t('Les administrateurs qui l’ont gardent leur code ; les autres ne seront plus tenus de la configurer.', 'Administrators who have it keep their code; the others will no longer have to set it up.')}
          libelleConfirmer={t('Ne plus exiger', 'Stop requiring')}
          onConfirmer={liberer}
          onAnnuler={() => setDemandeMdp(false)}
        />
      )}
      {msg && (
        <p data-testid="securite-espace-message" className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>
      )}
    </div>
  );
}

// Création de compte par mot de passe RETIRÉE : on n'ajoute des membres QUE par invitation (InviteCard).

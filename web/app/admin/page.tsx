'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listUsers, inviteMember, setUserRole, setUserDisabled, deleteUser, renommerMembre, lireNomEspace, renommerEspace, type AdminUser, type UserRole } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { inputCls } from '@/lib/ui';
import { estAnnulation } from '@/lib/http';
import { routeInconnue } from '@/lib/canaux-services';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';

export default function AdminPage() {
  return <AppShell active="admin">{(session) => <AdminInner session={session} />}</AppShell>;
}

function AdminInner({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
  const { locale } = useLocale();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { users } = await listUsers(session.tenantId);
      setUsers(users);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="space-y-6">
      <TitrePage>{t('Compte', 'Account')}</TitrePage>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      <EspaceCard tenantId={session.tenantId} />

      <InviteCard tenantId={session.tenantId} onInvited={load} />

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
                      <select
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) => changeRole(u, e.target.value as UserRole)}
                        title={isSelf ? t('Tu ne peux pas changer ton propre rôle', 'You cannot change your own role') : ''}
                        className="rounded-controle border border-ink-300 bg-white px-2 py-1 text-sm text-ink-900 disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-400"
                      >
                        <option value="admin">Admin</option>
                        <option value="manager">Manager</option>
                        <option value="agent">Agent</option>
                      </select>
                    </td>
                    <td className="px-5 py-3">
                      {u.disabled ? (
                        <span className="inline-flex items-center rounded-full bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-700">{t('Révoqué', 'Revoked')}</span>
                      ) : u.pending ? (
                        <span className="inline-flex items-center rounded-full bg-alerte-50 px-2 py-0.5 text-xs font-medium text-alerte" title={t("A été invité mais n'a pas encore choisi son mot de passe", "Has been invited but hasn't chosen a password yet")}>{t('Invité', 'Invited')}</span>
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
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => toggleDisabled(u)}
                          disabled={isSelf}
                          title={isSelf ? t('Tu ne peux pas révoquer ton propre compte', 'You cannot revoke your own account') : ''}
                          className="text-ink-500 hover:text-ink-900 disabled:cursor-not-allowed disabled:text-ink-400"
                        >
                          {u.disabled ? t('Réactiver', 'Reactivate') : t('Révoquer', 'Revoke')}
                        </button>
                        <button
                          onClick={() => removeUser(u)}
                          disabled={isSelf}
                          title={isSelf ? t('Tu ne peux pas supprimer ton propre compte', 'You cannot delete your own account') : t('Suppression définitive', 'Permanent deletion')}
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

function InviteCard({ tenantId, onInvited }: { tenantId: string; onInvited: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [nom, setNom] = useState('');
  const [role, setRole] = useState<UserRole>('agent');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const res = await inviteMember(tenantId, email.trim(), role, nom.trim());
      setMsg({ kind: 'ok', text: res.emailSent ? t(`Invitation envoyée à ${email.trim()}.`, `Invitation sent to ${email.trim()}.`) : t(`Invitation créée pour ${email.trim()} (email non envoyé, vérifie la config).`, `Invitation created for ${email.trim()} (email not sent, check the config).`) });
      setEmail('');
      setNom('');
      setRole('agent');
      onInvited();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Invitation impossible', 'Unable to invite') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-carte border border-brand-200 bg-brand-50/40 p-5">
      <div className="text-sm font-semibold text-ink-900">{t('Inviter un membre', 'Invite a member')}</div>
      <p className="text-xs text-ink-500">{t("Il reçoit un email pour choisir son mot de passe et rejoindre l'espace.", 'They receive an email to choose their password and join the workspace.')}</p>
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
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Rôle', 'Role')}</label>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="rounded-controle border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100">
            <option value="agent">{t('Agent (inbox)', 'Agent (inbox)')}</option>
            <option value="manager">{t('Manager (inbox)', 'Manager (inbox)')}</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Bouton enCours={busy} type="submit" disabled={busy}>
          {busy ? t('Envoi…', 'Sending…') : t('Inviter', 'Invite')}
        </Bouton>
      </div>
      {/* Dit franchement ce que les rôles donnent AUJOURD'HUI : « manager » est un statut, ses droits propres
          restent à définir. Sans cette ligne, on invite un manager en s'attendant à ce qu'il voie tout. */}
      <p className="text-xs leading-snug text-ink-500">
        {t(
          'Manager et agent accèdent à l’inbox. Seul un admin accède au reste de la console.',
          'Managers and agents get the inbox. Only an admin reaches the rest of the console.',
        )}
      </p>
      {msg && <p className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>}
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

// Création de compte par mot de passe RETIRÉE : on n'ajoute des membres QUE par invitation (InviteCard).

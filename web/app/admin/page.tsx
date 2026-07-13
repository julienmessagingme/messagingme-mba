'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listUsers, createUser, inviteMember, setUserRole, setUserDisabled, deleteUser, type AdminUser, type UserRole } from '@/lib/api';

export default function AdminPage() {
  return <AppShell active="admin">{(session) => <AdminInner session={session} />}</AppShell>;
}

function AdminInner({ session }: { session: Session }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { users } = await listUsers(session.tenantId);
      setUsers(users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeRole(u: AdminUser, role: UserRole) {
    setError(null);
    const prev = users;
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, role } : x))); // optimiste
    try {
      await setUserRole(session.tenantId, u.id, role);
    } catch (err) {
      setUsers(prev); // rollback
      setError(err instanceof Error ? err.message : 'Changement de rôle impossible');
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
      setError(err instanceof Error ? err.message : 'Action impossible');
    }
  }

  async function removeUser(u: AdminUser) {
    if (!window.confirm(`Supprimer définitivement le compte ${u.email} ?\nCette action est irréversible.`)) return;
    setError(null);
    const prev = users;
    setUsers((list) => list.filter((x) => x.id !== u.id)); // optimiste
    try {
      await deleteUser(session.tenantId, u.id);
    } catch (err) {
      setUsers(prev); // rollback
      setError(err instanceof Error ? err.message : 'Suppression impossible');
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold tracking-tight text-ink-900">Compte</h2>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <InviteCard tenantId={session.tenantId} onInvited={load} />
      <CreateUserCard tenantId={session.tenantId} onCreated={load} />

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">
          Comptes ({users.length})
        </div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">Chargement…</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">Nom</th>
                <th className="px-5 py-2 font-medium">Email</th>
                <th className="px-5 py-2 font-medium">Rôle</th>
                <th className="px-5 py-2 font-medium">Statut</th>
                <th className="px-5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.email.toLowerCase() === session.email.toLowerCase();
                return (
                  <tr key={u.id} className="border-b border-ink-50 last:border-0">
                    <td className={`px-5 py-3 ${u.disabled ? 'text-ink-400' : 'text-ink-800'}`}>{u.name ?? <span className="text-ink-300">·</span>}</td>
                    <td className={`px-5 py-3 ${u.disabled ? 'text-ink-400' : 'text-ink-600'}`}>{u.email}</td>
                    <td className="px-5 py-3">
                      <select
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) => changeRole(u, e.target.value as UserRole)}
                        title={isSelf ? 'Tu ne peux pas changer ton propre rôle' : ''}
                        className="rounded-lg border border-ink-300 bg-white px-2 py-1 text-sm text-ink-800 disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-400"
                      >
                        <option value="admin">Admin</option>
                        <option value="agent">Agent</option>
                      </select>
                    </td>
                    <td className="px-5 py-3">
                      {u.disabled ? (
                        <span className="inline-flex items-center rounded-full bg-coral/10 px-2 py-0.5 text-xs font-medium text-coral">Révoqué</span>
                      ) : u.pending ? (
                        <span className="inline-flex items-center rounded-full bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold" title="A été invité mais n'a pas encore choisi son mot de passe">Invité</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-mint-50 px-2 py-0.5 text-xs font-medium text-mint-700">Actif</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => toggleDisabled(u)}
                          disabled={isSelf}
                          title={isSelf ? 'Tu ne peux pas révoquer ton propre compte' : ''}
                          className="text-ink-600 hover:text-ink-900 disabled:cursor-not-allowed disabled:text-ink-300"
                        >
                          {u.disabled ? 'Réactiver' : 'Révoquer'}
                        </button>
                        <button
                          onClick={() => removeUser(u)}
                          disabled={isSelf}
                          title={isSelf ? 'Tu ne peux pas supprimer ton propre compte' : 'Suppression définitive'}
                          className="text-coral hover:text-coral/80 disabled:cursor-not-allowed disabled:text-ink-300"
                        >
                          Supprimer
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
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('agent');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const res = await inviteMember(tenantId, email.trim(), role);
      setMsg({ kind: 'ok', text: res.emailSent ? `Invitation envoyée à ${email.trim()}.` : `Invitation créée pour ${email.trim()} (email non envoyé, vérifie la config).` });
      setEmail('');
      setRole('agent');
      onInvited();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Invitation impossible' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm">
      <div className="text-sm font-semibold text-ink-900">Inviter un membre</div>
      <p className="text-xs text-ink-500">Il reçoit un email pour choisir son mot de passe et rejoindre l&apos;espace.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-xs font-medium text-ink-600">Email</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" placeholder="membre@entreprise.fr" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Rôle</label>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100">
            <option value="agent">Agent (inbox)</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button type="submit" disabled={busy} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60">
          {busy ? 'Envoi…' : 'Inviter'}
        </button>
      </div>
      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
    </form>
  );
}

function CreateUserCard({ tenantId, onCreated }: { tenantId: string; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('agent');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await createUser(tenantId, { email: email.trim(), password, role, ...(name.trim() ? { name: name.trim() } : {}) });
      setMsg({ kind: 'ok', text: `Compte ${email.trim()} créé.` });
      setEmail('');
      setName('');
      setPassword('');
      setRole('agent');
      onCreated();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Création impossible' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-semibold text-ink-900">Créer un compte</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Nom (optionnel)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            placeholder="Marie Dupont"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            placeholder="agent@demo.test"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Mot de passe (min 8)</label>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            placeholder="••••••••"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Rôle</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            <option value="agent">Agent (inbox uniquement)</option>
            <option value="admin">Admin (accès complet)</option>
          </select>
        </div>
      </div>
      {msg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-mint-50 text-mint-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
      >
        {busy ? 'Création…' : 'Créer le compte'}
      </button>
    </form>
  );
}

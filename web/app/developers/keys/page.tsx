'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listApiKeys, createApiKey, revokeApiKey, API_SCOPES, type ApiKeyRow, type ApiKeyCreated } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export default function ApiKeysPage() {
  return <AppShell active="api-keys">{(session) => <KeysInner session={session} />}</AppShell>;
}

function KeysInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(() => new Set(API_SCOPES));
  const [busy, setBusy] = useState(false);
  // La clé en clair n'existe QUE dans la réponse de création. Elle est gardée ici pour la modale, et il ne
  // faut surtout pas recharger la liste avant de l'avoir montrée : la liste ne la renvoie jamais.
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setKeys((await listApiKeys(session.tenantId)).keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  const SCOPE_LABEL: Record<string, string> = {
    'contacts:write': t('Créer et mettre à jour des contacts', 'Create and update contacts'),
    'sends:create': t('Déclencher des envois', 'Trigger sends'),
  };

  function toggleScope(s: string) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  async function create() {
    if (!name.trim() || scopes.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createApiKey(session.tenantId, name.trim(), [...scopes]);
      // La modale D'ABORD, le rechargement ENSUITE : c'est le seul instant où la clé existe en clair.
      setCreated(res);
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Creation failed'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKeyRow) {
    const ok = window.confirm(t(
      `Révoquer « ${k.name} » ? Tout appel avec cette clé sera refusé immédiatement, et elle ne peut pas être réactivée.`,
      `Revoke “${k.name}”? Any call using this key will be refused immediately, and it cannot be reactivated.`,
    ));
    if (!ok) return;
    setError(null);
    try {
      await revokeApiKey(session.tenantId, k.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Révocation impossible', 'Revocation failed'));
    }
  }

  const fmt = (iso: string | null) => (iso ? `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}` : '—');
  const active = keys.filter((k) => !k.revokedAt);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Clés d\'API', 'API keys')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'Une clé authentifie les appels à l\'API publique. Elle porte le compte : ne la mets jamais dans du code côté navigateur.',
            'A key authenticates calls to the public API. It carries the account: never put it in browser-side code.',
          )}
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
        <label className="mb-1 block text-sm font-medium text-ink-700">{t('Nouvelle clé', 'New key')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('Nom (ex. « intégration site web »)', 'Name (e.g. “website integration”)')}
          className={inputCls}
        />
        <div className="mt-3 space-y-1.5">
          {API_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" checked={scopes.has(s)} onChange={() => toggleScope(s)} className="h-4 w-4 rounded border-ink-300" />
              <span className="font-mono text-xs text-ink-800">{s}</span>
              <span className="text-ink-500">{SCOPE_LABEL[s]}</span>
            </label>
          ))}
        </div>
        <button
          onClick={() => { void create(); }}
          disabled={busy || !name.trim() || scopes.size === 0}
          className="mt-3 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          {busy ? t('Création...', 'Creating...') : t('Créer la clé', 'Create key')}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-medium text-ink-800">
          {t('Clés', 'Keys')} ({active.length} {t('active(s)', 'active')}{keys.length > active.length ? `, ${keys.length - active.length} ${t('révoquée(s)', 'revoked')}` : ''})
        </div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
        ) : keys.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucune clé. Crée-en une ci-dessus.', 'No keys yet. Create one above.')}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Droits', 'Scopes')}</th>
                <th className="px-5 py-2 font-medium">{t('Créée le', 'Created')}</th>
                <th className="px-5 py-2 font-medium">{t('Dernier appel', 'Last call')}</th>
                <th className="px-5 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                // Une clé révoquée RESTE listée (le serveur ne la supprime pas) : sans ce badge, la ligne
                // ressemblerait à une clé encore valide.
                <tr key={k.id} className="border-b border-ink-50 last:border-0">
                  <td className={`px-5 py-2.5 ${k.revokedAt ? 'text-ink-400' : 'text-ink-800'}`}>
                    {k.name}
                    {k.revokedAt && (
                      <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">{t('révoquée', 'revoked')}</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 font-mono text-xs text-ink-500">{k.scopes.join(', ')}</td>
                  <td className={`px-5 py-2.5 ${k.revokedAt ? 'text-ink-400' : 'text-ink-600'}`}>{fmt(k.createdAt)}</td>
                  <td className={`px-5 py-2.5 ${k.revokedAt ? 'text-ink-400' : 'text-ink-600'}`}>
                    {k.lastUsedAt ? fmt(k.lastUsedAt) : t('jamais', 'never')}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {!k.revokedAt && (
                      <button onClick={() => { void revoke(k); }} className="text-xs text-red-600 hover:underline">
                        {t('Révoquer', 'Revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {created && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-ink-900">{t('Clé créée', 'Key created')} : {created.name}</h3>
            <p className="mt-1 text-sm text-ink-600">
              {t(
                'Copie-la maintenant. Elle ne sera plus jamais affichée : seule son empreinte est conservée, et une clé perdue se remplace, elle ne se retrouve pas.',
                'Copy it now. It will never be shown again: only its fingerprint is stored, and a lost key is replaced, not recovered.',
              )}
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-ink-50 px-3 py-2 font-mono text-xs text-ink-800">{created.key}</pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => { void navigator.clipboard?.writeText(created.key); }}
                className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50"
              >
                {t('Copier', 'Copy')}
              </button>
              <button
                onClick={() => setCreated(null)}
                className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600"
              >
                {t('J\'ai copié la clé', 'I copied the key')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

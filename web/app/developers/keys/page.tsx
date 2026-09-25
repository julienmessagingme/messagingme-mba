'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listApiKeys, createApiKey, revokeApiKey, API_SCOPES, API_SCOPES_PAR_DEFAUT, type ApiKeyRow, type ApiKeyCreated, type ApiScope } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';

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
  // Pas `API_SCOPES` : les droits MCP ne sont pas cochés d'avance (cf. `API_SCOPES_PAR_DEFAUT`).
  const [scopes, setScopes] = useState<Set<string>>(() => new Set<string>(API_SCOPES_PAR_DEFAUT));
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

  /** Le droit de la clé que la publication pose chez Meta (`src/mba/cle-relais.ts`). */
  const DROIT_RELAIS = 'mba:relais';

  // Typé sur `ApiScope` : un droit ajouté à la liste sans libellé ne compile pas.
  const SCOPE_LABEL: Record<ApiScope, string> = {
    'contacts:write': t('Créer et mettre à jour des contacts', 'Create and update contacts'),
    'contacts:read': t('Lire les contacts', 'Read contacts'),
    'sends:create': t('Déclencher des envois', 'Trigger sends'),
    'mcp:read': t('MCP : lire les conversations et les contacts', 'MCP: read conversations and contacts'),
    'mcp:write': t('MCP : répondre, taguer, affecter', 'MCP: reply, tag, assign'),
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
    /**
     * ⚠️ LA CLÉ « AGENT DE META » EST POSÉE CHEZ META PAR LA PUBLICATION (relais, 2026-09-21) : la révoquer
     * coupe les outils de l'agent de Meta jusqu'au prochain « Envoyer », qui en pose une neuve. Le dire ici,
     * sinon la révocation d'une clé qu'on ne se souvient pas d'avoir créée casse un agent sans explication.
     */
    const relais = k.scopes.includes(DROIT_RELAIS);
    const ok = window.confirm(relais
      ? t(
        `Révoquer « ${k.name} » ? L’agent de Meta ne pourra plus appeler vos outils jusqu’au prochain « Envoyer » dans ses outils, qui posera une clé neuve.`,
        `Revoke “${k.name}”? Meta’s agent will not be able to call your tools until the next “Send” from its tools, which sets a new key.`,
      )
      : t(
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
        <TitrePage>{t('Clés d\'API', 'API keys')}</TitrePage>
        <IntroPage>
          {t(
            'Une clé authentifie les appels à l\'API publique. Elle porte le compte : ne la mets jamais dans du code côté navigateur.',
            'A key authenticates calls to the public API. It carries the account: never put it in browser-side code.',
          )}
        </IntroPage>
      </div>

      {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      <div className="rounded-2xl border border-ink-200 bg-white p-4">
        <label className="mb-1 block text-sm font-medium text-ink-900">{t('Nouvelle clé', 'New key')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('Nom (ex. « intégration site web »)', 'Name (e.g. “website integration”)')}
          className={inputCls}
        />
        <div className="mt-3 space-y-1.5">
          {API_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-ink-900">
              <input type="checkbox" checked={scopes.has(s)} onChange={() => toggleScope(s)} className="h-4 w-4 rounded border-ink-300" />
              <span className="font-mono text-xs text-ink-900">{s}</span>
              <span className="text-ink-500">{SCOPE_LABEL[s]}</span>
            </label>
          ))}
        </div>
        <Bouton enCours={busy}
          onClick={() => { void create(); }}
          disabled={busy || !name.trim() || scopes.size === 0}
          className="mt-3"
        >
          {busy ? t('Création...', 'Creating...') : t('Créer la clé', 'Create key')}
        </Bouton>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-medium text-ink-900">
          {t('Clés', 'Keys')} ({active.length} {t('active(s)', 'active')}{keys.length > active.length ? `, ${keys.length - active.length} ${t('révoquée(s)', 'revoked')}` : ''})
        </div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
        ) : keys.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucune clé. Crée-en une ci-dessus.', 'No keys yet. Create one above.')}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-100 text-xs text-ink-500">
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
                  <td className={`px-5 py-2.5 ${k.revokedAt ? 'text-ink-400' : 'text-ink-900'}`}>
                    {k.name}
                    {k.revokedAt && (
                      <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">{t('révoquée', 'revoked')}</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 font-mono text-xs text-ink-500">
                    {/* `mba:relais` ne se crée pas ici (absent d'`API_SCOPES`) : seule la publication chez Meta
                        en pose une. On le NOMME pour qu'il se reconnaisse dans la liste. */}
                    {k.scopes.map((sc) => (sc === DROIT_RELAIS ? t('relais de l’agent de Meta', 'Meta agent relay') : sc)).join(', ')}
                  </td>
                  <td className={`px-5 py-2.5 ${k.revokedAt ? 'text-ink-400' : 'text-ink-500'}`}>{fmt(k.createdAt)}</td>
                  <td className={`px-5 py-2.5 ${k.revokedAt ? 'text-ink-400' : 'text-ink-500'}`}>
                    {k.lastUsedAt ? fmt(k.lastUsedAt) : t('jamais', 'never')}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {!k.revokedAt && (
                      <button onClick={() => { void revoke(k); }} className="text-xs text-danger-600 hover:underline">
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
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-mm-lg">
            <h3 className="text-sm font-semibold text-ink-900">{t('Clé créée', 'Key created')} : {created.name}</h3>
            <p className="mt-1 text-sm text-ink-500">
              {t(
                'Copie-la maintenant. Elle ne sera plus jamais affichée : seule son empreinte est conservée, et une clé perdue se remplace, elle ne se retrouve pas.',
                'Copy it now. It will never be shown again: only its fingerprint is stored, and a lost key is replaced, not recovered.',
              )}
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-ink-50 px-3 py-2 font-mono text-xs text-ink-900">{created.key}</pre>
            <div className="mt-4 flex justify-end gap-2">
              <Bouton variante="secondaire"
                onClick={() => { void navigator.clipboard?.writeText(created.key); }}
              >
                {t('Copier', 'Copy')}
              </Bouton>
              <Bouton
                onClick={() => setCreated(null)}
              >
                {t('J\'ai copié la clé', 'I copied the key')}
              </Bouton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

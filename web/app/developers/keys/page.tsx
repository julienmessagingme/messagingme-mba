'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listApiKeys, createApiKey, revokeApiKey, API_SCOPES, API_SCOPES_PAR_DEFAUT, MAX_CLES_API_ACTIVES, DROIT_RELAIS, type ApiKeyRow, type ApiKeyCreated, type ApiScope } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';
import { Nd } from '@/components/Nd';
import { erreurDeChargement } from '@/lib/http';
import { listerAutorisations, personneDe, revoquerAutorisation, type AutorisationOauth } from '@/lib/oauth';

export default function ApiKeysPage() {
  return <AppShell active="api-keys">{(session) => <KeysInner session={session} />}</AppShell>;
}

function KeysInner({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
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
      setError(erreurDeChargement(err, t));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  // Typé sur `ApiScope` : un droit ajouté à la liste sans libellé ne compile pas.
  const SCOPE_LABEL: Record<ApiScope, string> = {
    'contacts:write': t('Créer et mettre à jour des contacts', 'Create and update contacts'),
    'contacts:read': t('Lire les contacts', 'Read contacts'),
    'sends:create': t('Déclencher des envois', 'Trigger sends'),
    'mcp:read': t('MCP : lire les conversations, les contacts, les widgets et les scénarios', 'MCP: read conversations, contacts, widgets and scenarios'),
    'mcp:write': t('MCP : répondre, taguer, affecter, créer et modifier les widgets du site', 'MCP: reply, tag, assign, create and edit the website widgets'),
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
    const ok = await confirmer({ titre: t('Révoquer la clé', 'Revoke the key'), message: relais
      ? t(
        `Révoquer « ${k.name} » ? L’agent de Meta ne pourra plus appeler vos outils jusqu’au prochain « Envoyer » dans ses outils, qui posera une clé neuve.`,
        `Revoke “${k.name}”? Meta’s agent will not be able to call your tools until the next “Send” from its tools, which sets a new key.`,
      )
      : t(
        `Révoquer « ${k.name} » ? Tout appel avec cette clé sera refusé immédiatement, et elle ne peut pas être réactivée.`,
        `Revoke “${k.name}”? Any call using this key will be refused immediately, and it cannot be reactivated.`,
      ), confirmer: t('Révoquer', 'Revoke') });
    if (!ok) return;
    setError(null);
    try {
      await revokeApiKey(session.tenantId, k.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Révocation impossible', 'Revocation failed'));
    }
  }

  const fmt = (iso: string | null) => (iso ? `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}` : <Nd />);
  const active = keys.filter((k) => !k.revokedAt);
  // Le plafond ne compte pas la clé du relais, que la publication pose (même règle que le serveur).
  const activesComptees = active.filter((k) => !k.scopes.includes(DROIT_RELAIS)).length;
  const plafondAtteint = activesComptees >= MAX_CLES_API_ACTIVES;

  return (
    <div className="max-w-formulaire space-y-6">
      <div>
        <TitrePage>{t('Clés d’API', 'API keys')}</TitrePage>
        <IntroPage>
          {t(
            'Une clé donne accès au compte : ne la mettez jamais dans du code côté navigateur.',
            'A key grants access to the account: never put it in browser-side code.',
          )}
        </IntroPage>
      </div>

      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      <div className="rounded-carte border border-ink-200 bg-white p-4">
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <label className="block text-sm font-medium text-ink-900">{t('Nouvelle clé', 'New key')}</label>
          {/* Le compte que le plafond regarde : la clé « Agent de Meta » n'y entre pas. */}
          {!loading && (
            <span className="text-xs tabular-nums text-ink-500" data-testid="compte-cles">
              {t(`${activesComptees} sur ${MAX_CLES_API_ACTIVES} clés actives`, `${activesComptees} of ${MAX_CLES_API_ACTIVES} active keys`)}
            </span>
          )}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('Nom (ex. « intégration site web »)', 'Name (e.g. “website integration”)')}
          className={inputCls}
        />
        <div className="mt-3 space-y-1.5">
          {API_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-ink-900">
              <input type="checkbox" checked={scopes.has(s)} onChange={() => toggleScope(s)} className="h-4 w-4 rounded-controle border-ink-300" />
              <span className="font-mono text-xs text-ink-900">{s}</span>
              <span className="text-ink-500">{SCOPE_LABEL[s]}</span>
            </label>
          ))}
        </div>
        <Bouton enCours={busy}
          onClick={() => { void create(); }}
          disabled={busy || plafondAtteint || !name.trim() || scopes.size === 0}
          className="mt-3"
        >
          {busy ? t('Création…', 'Creating…') : t('Créer la clé', 'Create key')}
        </Bouton>
        {plafondAtteint && (
          <p className="mt-2 text-sm text-ink-500" data-testid="plafond-cles">
            {t(
              `${MAX_CLES_API_ACTIVES} clés actives au maximum par espace (la clé « Agent de Meta » ne compte pas) : révoquez-en une pour en créer une autre.`,
              `${MAX_CLES_API_ACTIVES} active keys at most per workspace (the “Agent de Meta” key does not count): revoke one to create another.`,
            )}
          </p>
        )}
      </div>

      <div className="overflow-hidden rounded-carte border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-medium text-ink-900">
          {t('Clés', 'Keys')} ({active.length} {t('active(s)', 'active')}{keys.length > active.length ? `, ${keys.length - active.length} ${t('révoquée(s)', 'revoked')}` : ''})
        </div>
        {loading ? (
          <Squelette forme="lignes" className="px-5 py-6" />
        ) : keys.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucune clé : créez-en une ci-dessus.', 'No keys yet: create one above.')}</p>
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
                      <span className="ml-2 rounded-controle bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">{t('révoquée', 'revoked')}</span>
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

      <ApplicationsAutorisees tenantId={session.tenantId} />

      {created && (
        <Modale
          titre={`${t('Clé créée', 'Key created')} : ${created.name}`}
          fermeture="boutons"
          onClose={() => setCreated(null)}
        >
          <p className="mt-1 text-sm text-ink-500">
            {t(
              'Copiez-la maintenant : elle ne sera plus jamais affichée, et une clé perdue se remplace, elle ne se retrouve pas.',
              'Copy it now: it will never be shown again, and a lost key is replaced, not recovered.',
            )}
          </p>
          <pre className="mt-3 overflow-x-auto rounded-controle bg-ink-50 px-3 py-2 font-mono text-xs text-ink-900">{created.key}</pre>
          <div className="mt-4 flex justify-end gap-2">
            <Bouton variante="secondaire"
              onClick={() => { void navigator.clipboard?.writeText(created.key); }}
            >
              {t('Copier', 'Copy')}
            </Bouton>
            <Bouton
              onClick={() => setCreated(null)}
            >
              {t('J’ai copié la clé', 'I copied the key')}
            </Bouton>
          </div>
        </Modale>
      )}
    </div>
  );
}

/**
 * « APPLICATIONS AUTORISÉES » (spec `2026-10-03-oauth-mcp-design.md`, section 6) : les Claude qu'un admin a connectés
 * à l'espace par le consentement (`/autoriser`), une ligne par passage dans le consentement. Deux Claude Code sur deux
 * machines font deux lignes, révocables séparément.
 *
 * Sur la page des clés parce que c'est la même question, « qui peut appeler l'espace de l'extérieur ? », et la même
 * réserve aux admins. Une autorisation révoquée disparaît de la liste (le serveur ne rend que les vivantes), à la
 * différence d'une clé, qui reste listée avec son badge.
 */
function ApplicationsAutorisees({ tenantId }: { tenantId: string }) {
  const t = useT();
  const confirmer = useConfirmation();
  const { locale } = useLocale();
  const [autorisations, setAutorisations] = useState<AutorisationOauth[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAutorisations(await listerAutorisations(tenantId));
    } catch (err) {
      setError(erreurDeChargement(err, t));
    }
  }, [tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  async function revoke(a: AutorisationOauth) {
    const ok = await confirmer({
      titre: t('Révoquer l’accès', 'Revoke access'),
      message: t(
        `Révoquer l’accès de « ${a.client} », autorisé par ${personneDe(a)} ? Son prochain appel sera refusé, et il devra demander une nouvelle autorisation.`,
        `Revoke “${a.client}” access, authorized by ${personneDe(a)}? Its next call will be refused, and it will have to ask for a new authorization.`,
      ),
      confirmer: t('Révoquer', 'Revoke'),
    });
    if (!ok) return;
    setError(null);
    try {
      await revoquerAutorisation(tenantId, a.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Révocation impossible', 'Revocation failed'));
    }
    // Relue dans les deux cas : un 404 veut dire « déjà révoquée », la ligne ne doit pas rester affichée.
    await load();
  }

  const fmt = (iso: string) => `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;

  return (
    <div className="overflow-hidden rounded-carte border border-ink-200 bg-white" data-testid="applications-autorisees">
      <div className="border-b border-ink-100 px-5 py-3">
        <h2 className="text-sm font-medium text-ink-900">{t('Applications autorisées', 'Authorized applications')}</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          {t(
            'Claude (Claude Code, claude.ai) connecté à cet espace par un administrateur, sans clé d’API. Révoquer coupe l’accès dès son prochain appel.',
            'Claude (Claude Code, claude.ai) connected to this workspace by an administrator, without an API key. Revoking cuts access on its next call.',
          )}
        </p>
      </div>
      {error && <p className="mx-5 mt-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
      {autorisations === null ? (
        error ? null : <Squelette forme="lignes" lignes={2} className="px-5 py-6" />
      ) : autorisations.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-500" data-testid="applications-vide">
          {t(
            'Aucune application autorisée. Quand un administrateur connecte Claude à cet espace, il apparaît ici.',
            'No authorized application. When an administrator connects Claude to this workspace, it shows up here.',
          )}
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-100 text-xs text-ink-500">
            <tr>
              <th className="px-5 py-2 font-medium">{t('Application', 'Application')}</th>
              <th className="px-5 py-2 font-medium">{t('Autorisée par', 'Authorized by')}</th>
              <th className="px-5 py-2 font-medium">{t('Autorisée le', 'Authorized')}</th>
              <th className="px-5 py-2 font-medium">{t('Dernier appel', 'Last call')}</th>
              <th className="px-5 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {autorisations.map((a) => (
              <tr key={a.id} className="border-b border-ink-50 last:border-0">
                <td className="px-5 py-2.5 text-ink-900">{a.client}</td>
                <td className="px-5 py-2.5 text-ink-500">{personneDe(a)}</td>
                <td className="px-5 py-2.5 text-ink-500">{fmt(a.creeLe)}</td>
                <td className="px-5 py-2.5 text-ink-500">{a.dernierUsageLe ? fmt(a.dernierUsageLe) : t('jamais', 'never')}</td>
                <td className="px-5 py-2.5 text-right">
                  <button onClick={() => { void revoke(a); }} className="text-xs text-danger-600 hover:underline" data-testid={`revoquer-${a.id}`}>
                    {t('Révoquer', 'Revoke')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

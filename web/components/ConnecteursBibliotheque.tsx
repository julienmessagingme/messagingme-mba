'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { RequetesConnecteur } from '@/components/RequetesConnecteur';
import {
  creerSource, eprouverSource, listSources, patchSource, supprimerSource,
  type AuthSource, type SourceAgent,
} from '@/lib/api-agent-sources';

/**
 * LA BIBLIOTHÈQUE DE SYSTÈMES du workspace (menu Tools).
 *
 * 🔴 POURQUOI ELLE EST ICI ET PAS DANS UN AGENT. Un système appartient au CLIENT, pas à un agent : l'adresse,
 * l'authentification et le secret sont les mêmes quel que soit l'agent qui s'en sert, et plusieurs agents
 * tapent dans la même bibliothèque. La poser dans un agent aurait fait croire qu'elle lui appartient, et on
 * l'aurait supprimée en cassant les autres. En base, `agent_tool_sources` porte `tenant_id` et pas
 * `agent_id` : cet écran ne fait que le rendre visible.
 *
 * Ce que chaque agent fait ensuite, dans SON onglet Outils : choisir un système d'ici et déclarer les appels
 * qu'il a le droit d'y faire, avec ses mots à lui. Deux agents peuvent donc taper le même système avec des
 * consignes différentes, ce qui est exactement le besoin.
 */

export function ConnecteursBibliotheque({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [sources, setSources] = useState<SourceAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [epreuves, setEpreuves] = useState<Record<string, string>>({});
  /**
   * 🔴 UN SEUL SYSTEME OUVERT A LA FOIS, ET RIEN D'OUVERT AU DEPART. L'ecran depliait TOUT : chaque systeme
   * en grande fiche, le formulaire « brancher un systeme » toujours ouvert AU MILIEU, puis les appels de tous
   * les systemes a la suite. On arrivait donc sur un formulaire de creation coince entre ce qu'on a deja et
   * ce qu'on venait chercher. Ici : la liste, on clique, ca s'ouvre.
   */
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [ajout, setAjout] = useState(false);

  const charger = useCallback(async () => {
    try {
      setSources(await listSources(tenantId));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    }
  }, [tenantId, t]);
  useEffect(() => { void charger(); }, [charger]);

  async function agir(travail: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    try {
      await travail();
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Opération impossible', 'Operation failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t(
          'Ce que vous branchez ici sert à TOUS vos agents IA. L’adresse est figée : un agent ne choisit jamais où appeler, seulement quoi demander, et vous décidez quoi dans son onglet Outils.',
          'What you connect here serves ALL your AI agents. The address is fixed: an agent never chooses where to call, only what to ask, and you decide what in its Tools tab.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="connecteurs-erreur">{erreur}</MbaNotice>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-900">{t('Vos systèmes', 'Your systems')}</h2>
        <button
          type="button"
          data-testid="source-ajouter"
          onClick={() => { setAjout((v) => !v); setOuvert(null); }}
          className="rounded-lg border border-brand-500 px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
        >
          {ajout ? t('Annuler', 'Cancel') : t('+ Brancher un système', '+ Connect a system')}
        </button>
      </div>

      {/* Le formulaire d'ajout : REPLIE par défaut, et au-dessus de la liste quand il s'ouvre, là où on
          regarde après avoir cliqué. Déplié en permanence au MILIEU de la page, il séparait les systèmes de
          leurs appels et faisait croire qu'il fallait le remplir pour continuer. */}
      {ajout && (
        <NouvelleSource
          busy={busy}
          onCreer={(input) => agir(async () => { await creerSource(tenantId, input); setAjout(false); })}
        />
      )}

      {sources === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}
      {sources?.length === 0 && !ajout && (
        <p data-testid="sources-vide" className="text-sm text-ink-500">
          {t('Aucun système branché. Déclarez-en un pour que vos agents puissent aller y chercher une information.', 'No system connected. Declare one so your agents can look up information in it.')}
        </p>
      )}

      {(sources ?? []).map((s) => (
        <div key={s.id} className="flex flex-col gap-3">
          {/* LA LIGNE : ce qu'on lit d'un coup d'oeil pour choisir. Le détail et les appels sont dessous, à
              la demande. */}
          <button
            type="button"
            data-testid={`source-ligne-${s.id}`}
            aria-expanded={ouvert === s.id}
            onClick={() => setOuvert((v) => (v === s.id ? null : s.id))}
            className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
              ouvert === s.id ? 'border-brand-500 bg-brand-50/40' : 'border-ink-200 bg-white hover:bg-ink-50'
            }`}
          >
            <span className="text-ink-400">{ouvert === s.id ? '▾' : '▸'}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium text-ink-900">{s.label}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.status === 'active' ? 'bg-mint/20 text-emerald-700' : 'bg-ink-100 text-ink-600'}`}>
                  {s.status === 'active' ? t('Actif', 'Active') : s.status === 'draft' ? t('Brouillon', 'Draft') : t('Désactivé', 'Disabled')}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-ink-500">{s.baseUrl}</span>
            </span>
            {/* 🔴 QUI TAPE DEDANS, dès la liste : sans ce chiffre on croirait le système lié à l'agent d'où
                on l'a vu, et on le supprimerait en cassant les autres. */}
            <span data-testid={`source-usage-${s.id}`} className="shrink-0 text-right text-xs text-ink-600">
              {s.agents === 0
                ? t('aucun agent', 'no agent')
                : t(`${s.agents} agent(s)`, `${s.agents} agent(s)`)}
              <span className="block text-ink-400">
                {t(`${s.outilsActifs} appel(s) actif(s)`, `${s.outilsActifs} active call(s)`)}
              </span>
            </span>
          </button>

          {ouvert === s.id && (
            <>
              <Source
                source={s}
                busy={busy}
                epreuve={epreuves[s.id]}
                onEprouver={(chemin) => agir(async () => {
                  const r = await eprouverSource(tenantId, s.id, chemin);
                  setEpreuves((e) => ({
                    ...e,
                    [s.id]: r.ok
                      ? t(`Répond (HTTP ${r.httpStatus})`, `Responds (HTTP ${r.httpStatus})`)
                      : t(`Échec : ${r.erreur ?? 'inconnu'}`, `Failed: ${r.erreur ?? 'unknown'}`),
                  }));
                })}
                onPatch={(patch) => agir(async () => { await patchSource(tenantId, s.id, patch); })}
                onSupprimer={() => agir(async () => { await supprimerSource(tenantId, s.id); setOuvert(null); })}
              />

              {/* Les APPELS DE CE SYSTÈME, sous lui. C'est la suite logique du geste : on ne met pas au point
                  un appel sans regarder le système, et l'écran ne montre plus les appels des autres. */}
              <div className="border-t border-ink-200 pt-4">
                <RequetesConnecteur tenantId={tenantId} sources={sources ?? []} sourceFiltre={s.id} />
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Source({ source, busy, epreuve, onEprouver, onPatch, onSupprimer }: {
  source: SourceAgent;
  busy: boolean;
  epreuve?: string;
  onEprouver: (chemin: string) => void;
  onPatch: (patch: { status?: SourceAgent['status']; authSecret?: string }) => void;
  onSupprimer: () => void;
}) {
  const t = useT();
  const [chemin, setChemin] = useState('/');
  const [secret, setSecret] = useState('');

  return (
    <div className={`${cardCls} flex flex-col gap-3`} data-testid={`source-${source.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* ⚠️ NI LE NOM NI L'ADRESSE ICI : ils sont dans la ligne qu'on vient de déplier, juste au-dessus.
            Les répéter donnait deux fois la même information et repoussait les boutons hors de vue. */}
        <div className="min-w-0">
          <p className="text-xs text-ink-500">
            {source.authKind === 'none'
              ? t('Sans authentification', 'No authentication')
              : source.authKind === 'bearer'
                ? t('Jeton (Bearer)', 'Token (Bearer)')
                : t(`En-tête ${source.authHeaderName ?? ''}`, `Header ${source.authHeaderName ?? ''}`)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            data-testid={`source-statut-${source.id}`}
            disabled={busy}
            onClick={() => onPatch({ status: source.status === 'active' ? 'disabled' : 'active' })}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
          >
            {source.status === 'active' ? t('Désactiver', 'Disable') : t('Activer', 'Activate')}
          </button>
          <button
            data-testid={`source-supprimer-${source.id}`}
            disabled={busy}
            onClick={onSupprimer}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-coral hover:bg-red-50 disabled:opacity-40"
          >
            {t('Supprimer', 'Delete')}
          </button>
        </div>
      </div>

      {/* 🔴 L'ÉPREUVE. Un jeton expiré ne produit aucune erreur applicative : l'agent dégraderait en silence
          au milieu d'une conversation. C'est le seul endroit où ça se voit avant qu'un contact ne le trouve. */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-ink-200 px-3 py-2">
        <label className="flex-1 text-xs text-ink-600">
          {t('Éprouver la connexion sur ce chemin', 'Test the connection on this path')}
          <input className={`${inputCls} mt-1`} data-testid={`source-chemin-${source.id}`} value={chemin} onChange={(e) => setChemin(e.target.value)} />
        </label>
        <button
          data-testid={`source-eprouver-${source.id}`}
          disabled={busy}
          onClick={() => onEprouver(chemin)}
          className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
        >
          {t('Éprouver', 'Test')}
        </button>
        <p data-testid={`source-epreuve-${source.id}`} className="w-full text-xs text-ink-600">
          {epreuve ?? (source.lastError
            ? t(`Dernière erreur : ${source.lastError}`, `Last error: ${source.lastError}`)
            : source.lastOkAt
              ? t(`Dernière réussite : ${new Date(source.lastOkAt).toLocaleString()}`, `Last success: ${new Date(source.lastOkAt).toLocaleString()}`)
              : t('Jamais éprouvée', 'Never tested'))}
        </p>
      </div>

      {/* Le secret : jamais relu, donc jamais rempli. Le dire, sinon le client croira l'avoir effacé. */}
      {source.authKind !== 'none' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 text-xs text-ink-600">
            {t('Remplacer le secret (laisser vide = inchangé)', 'Replace the secret (leave empty = unchanged)')}
            <input
              type="password" autoComplete="off" className={`${inputCls} mt-1`}
              data-testid={`source-secret-${source.id}`}
              value={secret} onChange={(e) => setSecret(e.target.value)}
              placeholder={source.aAuthentification ? '••••••••' : t('aucun secret enregistré', 'no secret stored')}
            />
          </label>
          <button
            disabled={busy || secret.trim() === ''}
            onClick={() => { onPatch({ authSecret: secret.trim() }); setSecret(''); }}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
          >
            {t('Remplacer', 'Replace')}
          </button>
        </div>
      )}
    </div>
  );
}

function NouvelleSource({ busy, onCreer }: {
  busy: boolean;
  onCreer: (input: { label: string; baseUrl: string; authKind: AuthSource; authHeaderName?: string; authSecret?: string }) => void;
}) {
  const t = useT();
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [authKind, setAuthKind] = useState<AuthSource>('bearer');
  const [authHeaderName, setAuthHeaderName] = useState('x-api-key');
  const [authSecret, setAuthSecret] = useState('');

  return (
    <div className={`${cardCls} flex flex-col gap-3`}>
      <p className="text-sm font-medium text-ink-700">{t('Brancher un système', 'Connect a system')}</p>
      <label className="text-xs text-ink-600">
        {t('Nom (pour vous)', 'Name (for you)')}
        <input className={`${inputCls} mt-1`} data-testid="source-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ERP, CRM…" />
      </label>
      <label className="text-xs text-ink-600">
        {t('Adresse de base (HTTPS, publique)', 'Base address (HTTPS, public)')}
        <input className={`${inputCls} mt-1`} data-testid="source-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.mon-systeme.fr/v1" />
        <span className="mt-1 block text-[11px] text-ink-500">
          {t('Vos agents ne pourront JAMAIS appeler ailleurs que sous cette adresse.', 'Your agents will NEVER be able to call outside this address.')}
        </span>
      </label>
      <label className="text-xs text-ink-600">
        {t('Authentification', 'Authentication')}
        <select className={`${inputCls} mt-1`} data-testid="source-auth" value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthSource)}>
          <option value="bearer">{t('Jeton (Bearer)', 'Token (Bearer)')}</option>
          <option value="header">{t('En-tête nommé', 'Named header')}</option>
          <option value="none">{t('Aucune', 'None')}</option>
        </select>
      </label>
      {authKind === 'header' && (
        <label className="text-xs text-ink-600">
          {t('Nom de l’en-tête', 'Header name')}
          <input className={`${inputCls} mt-1`} data-testid="source-entete" value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} />
        </label>
      )}
      {authKind !== 'none' && (
        <label className="text-xs text-ink-600">
          {t('Secret', 'Secret')}
          <input type="password" autoComplete="off" className={`${inputCls} mt-1`} data-testid="source-secret" value={authSecret} onChange={(e) => setAuthSecret(e.target.value)} />
          <span className="mt-1 block text-[11px] text-ink-500">
            {t('Chiffré chez nous, jamais réaffiché.', 'Encrypted on our side, never displayed again.')}
          </span>
        </label>
      )}
      <button
        data-testid="source-creer"
        disabled={busy || label.trim() === '' || baseUrl.trim() === ''}
        onClick={() => onCreer({
          label: label.trim(), baseUrl: baseUrl.trim(), authKind,
          ...(authKind === 'header' ? { authHeaderName: authHeaderName.trim() } : {}),
          ...(authKind !== 'none' ? { authSecret: authSecret.trim() } : {}),
        })}
        className="self-start rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-40"
      >
        {t('Brancher', 'Connect')}
      </button>
    </div>
  );
}

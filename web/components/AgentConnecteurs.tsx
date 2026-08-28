'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import {
  creerSource, eprouverSource, listSources, patchSource, supprimerSource,
  type AuthSource, type SourceAgent,
} from '@/lib/api-agent-sources';
import { ajouterConnecteur, type OutilAgent } from '@/lib/api-agent-tools';

/**
 * BRANCHER LE SYSTÈME DU CLIENT (lot L2) : déclarer une source, l'éprouver, puis y poser des outils.
 *
 * 🔴 CE QUE CET ÉCRAN DOIT RENDRE ÉVIDENT, et qui n'est pas décoratif :
 *
 *  - **la source d'abord, l'outil ensuite.** Un outil de connecteur sans source active est un outil mort ;
 *  - **qui remplit chaque paramètre.** C'est la garde anti-IDOR du lot : le modèle ne remplit que ce qu'on
 *    lui confie, le reste vient du contact authentifié ou d'une constante. Elle doit être LISIBLE par le
 *    client, pas seulement vraie dans le code ;
 *  - **les champs que l'agent lira.** La réponse appartient au client et part chez le fournisseur de modèle :
 *    c'est ici, et seulement ici, que quelqu'un décide ce qui traverse ;
 *  - **l'épreuve**, avec sa date. Un jeton expiré ne produit AUCUNE erreur applicative : l'agent dégrade en
 *    silence, au milieu d'une conversation. C'est le seul endroit où ça se voit avant un contact ;
 *  - **le secret ne se relit jamais** : un champ vide veut dire « inchangé », et l'écran le dit.
 */

const CHAMPS_CONTACT = ['wa_id', 'nom'] as const;

interface ParamBrouillon {
  name: string;
  source: 'modele' | 'contact' | 'fixe';
  description: string;
  contactPath: string;
  value: string;
}

export function AgentConnecteurs({ tenantId, agentId, outils, onChange }: {
  tenantId: string;
  agentId: string;
  /** Les outils déjà posés : sert à montrer, sous chaque source, ce qui s'appuie dessus. */
  outils: OutilAgent[];
  onChange: () => Promise<void> | void;
}) {
  const t = useT();
  const [sources, setSources] = useState<SourceAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [epreuves, setEpreuves] = useState<Record<string, string>>({});

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
      await onChange();
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
          'Un connecteur laisse l’agent interroger VOTRE système. L’adresse est figée ici : l’agent ne choisit jamais où appeler, seulement quoi demander.',
          'A connector lets the agent query YOUR system. The base address is fixed here: the agent never chooses where to call, only what to ask.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="connecteurs-erreur">{erreur}</MbaNotice>}

      {sources === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}
      {sources?.length === 0 && (
        <p data-testid="sources-vide" className="text-sm text-ink-500">
          {t('Aucun système branché. Déclarez-en un pour que l’agent puisse aller y chercher une information.', 'No system connected. Declare one so the agent can look up information in it.')}
        </p>
      )}

      {(sources ?? []).map((s) => (
        <Source
          key={s.id}
          source={s}
          outils={outils.filter((o) => o.sourceId === s.id)}
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
          onSupprimer={() => agir(async () => { await supprimerSource(tenantId, s.id); })}
          onOutil={(outil) => agir(async () => { await ajouterConnecteur(tenantId, agentId, { ...outil, sourceId: s.id }); })}
        />
      ))}

      <NouvelleSource busy={busy} onCreer={(input) => agir(async () => { await creerSource(tenantId, input); })} />
    </div>
  );
}

function Source({ source, outils, busy, epreuve, onEprouver, onPatch, onSupprimer, onOutil }: {
  source: SourceAgent;
  outils: OutilAgent[];
  busy: boolean;
  epreuve?: string;
  onEprouver: (chemin: string) => void;
  onPatch: (patch: { status?: SourceAgent['status']; authSecret?: string }) => void;
  onSupprimer: () => void;
  onOutil: (outil: Parameters<typeof ajouterConnecteur>[2] extends infer T ? Omit<T & object, 'sourceId'> : never) => void;
}) {
  const t = useT();
  const [chemin, setChemin] = useState('/');
  const [secret, setSecret] = useState('');
  const [ouvert, setOuvert] = useState(false);

  return (
    <div className={`${cardCls} flex flex-col gap-3`} data-testid={`source-${source.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-800">
            {source.label}{' '}
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${source.status === 'active' ? 'bg-mint/20 text-emerald-700' : 'bg-ink-100 text-ink-600'}`}>
              {source.status === 'active' ? t('Actif', 'Active') : source.status === 'draft' ? t('Brouillon', 'Draft') : t('Désactivé', 'Disabled')}
            </span>
          </p>
          <p className="mt-0.5 break-all text-xs text-ink-500">{source.baseUrl}</p>
          <p className="mt-0.5 text-xs text-ink-500">
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

      <div className="border-t border-ink-100 pt-2">
        <p className="text-xs font-medium text-ink-700">
          {outils.length === 0
            ? t('Aucun outil sur ce système', 'No tool on this system')
            : t(`${outils.length} outil(s) sur ce système`, `${outils.length} tool(s) on this system`)}
        </p>
        <ul className="mt-1 space-y-0.5">
          {outils.map((o) => (
            <li key={o.id} className="text-xs text-ink-600">
              <code>{o.name}</code> {String((o.binding as { methode?: string }).methode ?? '')} {String((o.binding as { chemin?: string }).chemin ?? '')}
              {!o.actif && <span className="ml-1 text-ink-400">{t('(inactif)', '(inactive)')}</span>}
            </li>
          ))}
        </ul>
        <button
          data-testid={`source-nouvel-outil-${source.id}`}
          onClick={() => setOuvert((v) => !v)}
          className="mt-2 text-xs text-brand-600 hover:underline"
        >
          {ouvert ? t('Annuler', 'Cancel') : t('+ un outil sur ce système', '+ a tool on this system')}
        </button>
        {ouvert && <NouvelOutil busy={busy} onCreer={(o) => { onOutil(o); setOuvert(false); }} />}
      </div>
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
          {t('L’agent ne pourra JAMAIS appeler ailleurs que sous cette adresse.', 'The agent will NEVER be able to call outside this address.')}
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

function NouvelOutil({ busy, onCreer }: {
  busy: boolean;
  onCreer: (outil: {
    name: string; title: string; description: string; nePasUtiliser: string;
    methode: string; chemin: string;
    params: Array<{ name: string; type: string; source: string; description?: string; contactPath?: string; value?: string }>;
    outputPaths: string[];
  }) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [nePasUtiliser, setNePasUtiliser] = useState('');
  const [methode, setMethode] = useState('GET');
  const [chemin, setChemin] = useState('/');
  const [outputPaths, setOutputPaths] = useState('');
  const [params, setParams] = useState<ParamBrouillon[]>([]);

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-ink-200 p-3">
      <label className="text-xs text-ink-600">
        {t('Nom technique (vu par l’agent)', 'Technical name (seen by the agent)')}
        <input className={`${inputCls} mt-1`} data-testid="outil-nom" value={name} onChange={(e) => setName(e.target.value)} placeholder="lire_commande" />
      </label>
      <label className="text-xs text-ink-600">
        {t('Titre (pour vous)', 'Title (for you)')}
        <input className={`${inputCls} mt-1`} data-testid="outil-titre" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <label className="w-32 text-xs text-ink-600">
          {t('Méthode', 'Method')}
          <select className={`${inputCls} mt-1`} data-testid="outil-methode" value={methode} onChange={(e) => setMethode(e.target.value)}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex-1 text-xs text-ink-600">
          {t('Chemin (sous l’adresse de base)', 'Path (below the base address)')}
          <input className={`${inputCls} mt-1`} data-testid="outil-chemin" value={chemin} onChange={(e) => setChemin(e.target.value)} placeholder="/commandes/{ref}" />
        </label>
      </div>
      <label className="text-xs text-ink-600">
        {t('Quand l’appeler', 'When to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="text-xs text-ink-600">
        {t('Quand NE PAS l’appeler', 'When NOT to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-nepasutiliser" value={nePasUtiliser} onChange={(e) => setNePasUtiliser(e.target.value)} />
      </label>

      {/* 🔴 Le filtre de sortie. La réponse de VOTRE système part chez le fournisseur du modèle : c'est ici
          que vous décidez ce qui traverse, et c'est obligatoire. */}
      <label className="text-xs text-ink-600">
        {t('Champs que l’agent lira (un par ligne)', 'Fields the agent will read (one per line)')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-champs" value={outputPaths} onChange={(e) => setOutputPaths(e.target.value)} placeholder={'statut\nlivraison.date'} />
        <span className="mt-1 block text-[11px] text-ink-500">
          {t('L’agent ne verra QUE ces champs, et ce sont les seuls qui partiront chez le fournisseur du modèle.', 'The agent will ONLY see these fields, and they are the only ones sent to the model provider.')}
        </span>
      </label>

      <div className="rounded-lg border border-ink-200 p-2">
        <p className="text-xs font-medium text-ink-700">{t('Paramètres', 'Parameters')}</p>
        <p className="mt-0.5 text-[11px] text-ink-500">
          {t('Dites QUI remplit chaque paramètre. Un paramètre « le contact » ne peut pas être fabriqué par l’agent : il vient du numéro authentifié.', 'Say WHO fills each parameter. A “contact” parameter cannot be forged by the agent: it comes from the authenticated number.')}
        </p>
        {params.map((p, i) => (
          <div key={i} className="mt-2 flex flex-wrap gap-2">
            <input
              className={`${inputCls} w-32`} data-testid={`param-nom-${i}`} value={p.name} placeholder="ref"
              onChange={(e) => setParams((ps) => ps.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)))}
            />
            <select
              className={`${inputCls} w-40`} data-testid={`param-source-${i}`} value={p.source}
              onChange={(e) => setParams((ps) => ps.map((x, j) => (i === j ? { ...x, source: e.target.value as ParamBrouillon['source'] } : x)))}
            >
              <option value="modele">{t('l’agent le remplit', 'the agent fills it')}</option>
              <option value="contact">{t('le contact', 'the contact')}</option>
              <option value="fixe">{t('valeur fixe', 'fixed value')}</option>
            </select>
            {p.source === 'contact' && (
              <select
                className={`${inputCls} w-32`} data-testid={`param-contact-${i}`} value={p.contactPath || 'wa_id'}
                onChange={(e) => setParams((ps) => ps.map((x, j) => (i === j ? { ...x, contactPath: e.target.value } : x)))}
              >
                {CHAMPS_CONTACT.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {p.source === 'fixe' && (
              <input
                className={`${inputCls} w-32`} data-testid={`param-valeur-${i}`} value={p.value} placeholder={t('valeur', 'value')}
                onChange={(e) => setParams((ps) => ps.map((x, j) => (i === j ? { ...x, value: e.target.value } : x)))}
              />
            )}
            <button className="text-xs text-coral" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button
          data-testid="param-ajouter"
          onClick={() => setParams((ps) => [...ps, { name: '', source: 'modele', description: '', contactPath: 'wa_id', value: '' }])}
          className="mt-2 text-xs text-brand-600 hover:underline"
        >
          {t('+ paramètre', '+ parameter')}
        </button>
      </div>

      <button
        data-testid="outil-creer"
        disabled={busy || name.trim() === '' || title.trim() === '' || description.trim() === '' || outputPaths.trim() === ''}
        onClick={() => onCreer({
          name: name.trim(),
          title: title.trim(),
          description: description.trim(),
          nePasUtiliser: nePasUtiliser.trim() || t('Ne pas l’utiliser pour autre chose.', 'Do not use it for anything else.'),
          methode,
          chemin: chemin.trim(),
          params: params.filter((p) => p.name.trim() !== '').map((p) => ({
            name: p.name.trim(),
            type: 'string',
            source: p.source,
            ...(p.source === 'contact' ? { contactPath: p.contactPath || 'wa_id' } : {}),
            ...(p.source === 'fixe' ? { value: p.value } : {}),
          })),
          outputPaths: outputPaths.split('\n').map((x) => x.trim()).filter((x) => x !== ''),
        })}
        className="self-start rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-40"
      >
        {t('Déclarer l’outil', 'Declare the tool')}
      </button>
      <p className="text-[11px] text-ink-500">
        {t('Il naîtra INACTIF : c’est vous qui l’activerez, plus haut, après l’avoir relu.', 'It will be created INACTIVE: you activate it above, after reviewing it.')}
      </p>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { listSources, type SourceAgent } from '@/lib/api-agent-sources';
import { ajouterConnecteur, type OutilAgent } from '@/lib/api-agent-tools';

/**
 * CE QUE CET AGENT A LE DROIT D'APPELER dans les systèmes du workspace.
 *
 * 🔴 IL NE DÉCLARE AUCUN SYSTÈME. L'adresse, l'authentification et le secret vivent dans la BIBLIOTHÈQUE du
 * workspace (menu Tools > Connecteurs API), parce qu'ils appartiennent au client et que plusieurs agents
 * tapent dedans. Ici on ne fait qu'une chose : choisir un système de cette bibliothèque et dire quels APPELS
 * cet agent-ci peut y faire, avec SES mots. Deux agents peuvent donc interroger le même système avec des
 * consignes différentes, ce qui est le besoin réel.
 *
 * 🔴 CE QUE L'ÉCRAN DOIT RENDRE ÉVIDENT, et qui n'est pas décoratif :
 *  - **qui remplit chaque paramètre.** C'est la garde anti-IDOR : le modèle ne remplit que ce qu'on lui
 *    confie, le reste vient du contact authentifié ou d'une constante ;
 *  - **les champs que l'agent lira.** La réponse appartient au client et part chez le fournisseur de modèle :
 *    c'est ici, et seulement ici, que quelqu'un décide ce qui traverse.
 */

const CHAMPS_CONTACT = ['wa_id', 'nom'] as const;

interface ParamBrouillon {
  name: string;
  source: 'modele' | 'contact' | 'fixe';
  contactPath: string;
  value: string;
}

export function AgentConnecteurs({ tenantId, agentId, outils, onChange }: {
  tenantId: string;
  agentId: string;
  /** Les outils déjà posés sur CET agent : on n'en garde que les connecteurs. */
  outils: OutilAgent[];
  onChange: () => Promise<void> | void;
}) {
  const t = useT();
  const [sources, setSources] = useState<SourceAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);

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

  const appels = outils.filter((o) => o.origin !== 'mba');

  return (
    <div className="flex flex-col gap-3">
      {erreur && <MbaNotice kind="error" testid="connecteurs-erreur">{erreur}</MbaNotice>}

      {sources === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}

      {/* Aucun système dans la bibliothèque : on ne propose pas d'en déclarer un ICI, on dit où ça se passe.
          Déclarer une adresse et un secret est un geste de workspace, pas un geste d'agent. */}
      {sources?.length === 0 && (
        <p data-testid="connecteurs-aucune-source" className="text-sm text-ink-500">
          {t(
            'Aucun système branché sur ce workspace. Rendez-vous dans Tools > Connecteurs API pour en déclarer un ; il servira ensuite à tous vos agents.',
            'No system connected to this workspace. Go to Tools > API connectors to declare one; it will then serve all your agents.',
          )}{' '}
          <a href="/connecteurs" className="text-brand-600 hover:underline">{t('Ouvrir Tools > Connecteurs API', 'Open Tools > API connectors')}</a>
        </p>
      )}

      {(sources ?? []).map((s) => {
        const siens = appels.filter((o) => o.sourceId === s.id);
        return (
          <div key={s.id} className={`${cardCls} flex flex-col gap-2`} data-testid={`agent-source-${s.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-ink-800">
                {s.label}
                {s.status !== 'active' && (
                  <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600">
                    {t('système désactivé', 'system disabled')}
                  </span>
                )}
              </p>
              <p className="text-xs text-ink-500">{s.baseUrl}</p>
            </div>

            {siens.length === 0 ? (
              <p className="text-xs text-ink-500">{t('Cet agent n’y fait aucun appel.', 'This agent makes no call to it.')}</p>
            ) : (
              <ul className="space-y-0.5">
                {siens.map((o) => (
                  <li key={o.id} className="text-xs text-ink-600">
                    <code>{o.name}</code> {String((o.binding as { methode?: string }).methode ?? '')} {String((o.binding as { chemin?: string }).chemin ?? '')}
                    {!o.actif && <span className="ml-1 text-ink-400">{t('(inactif)', '(inactive)')}</span>}
                  </li>
                ))}
              </ul>
            )}

            <button
              data-testid={`source-nouvel-outil-${s.id}`}
              onClick={() => setOuvert((v) => (v === s.id ? null : s.id))}
              className="self-start text-xs text-brand-600 hover:underline"
            >
              {ouvert === s.id ? t('Annuler', 'Cancel') : t('+ un appel vers ce système', '+ a call to this system')}
            </button>
            {ouvert === s.id && (
              <NouvelAppel
                busy={busy}
                onCreer={(o) => { void agir(async () => { await ajouterConnecteur(tenantId, agentId, { ...o, sourceId: s.id }); }); setOuvert(null); }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function NouvelAppel({ busy, onCreer }: {
  busy: boolean;
  onCreer: (outil: {
    name: string; title: string; description: string; nePasUtiliser: string;
    methode: string; chemin: string;
    params: Array<{ name: string; type: string; source: string; contactPath?: string; value?: string }>;
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
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-ink-200 p-3">
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
          {t('Chemin (sous l’adresse du système)', 'Path (below the system address)')}
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
          onClick={() => setParams((ps) => [...ps, { name: '', source: 'modele', contactPath: 'wa_id', value: '' }])}
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
        {t('Déclarer l’appel', 'Declare the call')}
      </button>
      <p className="text-[11px] text-ink-500">
        {t('Il naîtra INACTIF : c’est vous qui l’activerez, plus haut, après l’avoir relu.', 'It will be created INACTIVE: you activate it above, after reviewing it.')}
      </p>
    </div>
  );
}

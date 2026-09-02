'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { listSources, type SourceAgent } from '@/lib/api-agent-sources';
import { listRequetes, type RequeteApi } from '@/lib/api-agent-requetes';
import { ajouterConnecteur, type OutilAgent } from '@/lib/api-agent-tools';

/**
 * CE QUE CET AGENT A LE DROIT D'APPELER dans les systèmes du workspace.
 *
 * 🔴 IL NE DÉCRIT PLUS AUCUN APPEL. L'adresse, l'authentification, la méthode, le chemin, le corps et les
 * variables vivent dans la BIBLIOTHÈQUE du workspace (menu Tools > Connecteurs API), parce qu'ils
 * appartiennent au client et que plusieurs agents s'en servent. Un appel décrit ici était redécrit pour
 * chaque agent, et le corriger quelque part ne le corrigeait pas ailleurs.
 *
 * Ici on ne fait plus qu'une chose : choisir un appel déjà ÉPROUVÉ et lui donner les mots de CET agent. Deux
 * agents peuvent donc utiliser le même appel avec des consignes différentes, ce qui est le besoin réel.
 *
 * 🔴 CE QUE L'ÉCRAN DOIT RENDRE ÉVIDENT, et qui n'est pas décoratif : **ce qui partira dans la requête**. Le
 * client confirme au moment de brancher, parce que c'est le seul moment où il peut s'apercevoir qu'un appel
 * enverra le dernier message de ses contacts à un système tiers.
 */

export function AgentConnecteurs({ tenantId, agentId, outils, onChange }: {
  tenantId: string;
  agentId: string;
  /** Les outils déjà posés sur CET agent : on n'en garde que les connecteurs. */
  outils: OutilAgent[];
  onChange: () => Promise<void> | void;
}) {
  const t = useT();
  const [sources, setSources] = useState<SourceAgent[] | null>(null);
  const [requetes, setRequetes] = useState<RequeteApi[]>([]);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([listSources(tenantId), listRequetes(tenantId)]);
      // ⚠️ Défensif des DEUX côtés : une réponse mal formée doit dégrader, jamais blanchir l'écran. Un
      // `.map` sur `undefined` fait planter le rendu de TOUT l'onglet, y compris la liste des outils
      // maison, qui n'a rien à voir. Même précaution que la liste des conversations de l'inbox.
      setSources(Array.isArray(s) ? s : []);
      setRequetes(Array.isArray(r?.requetes) ? r.requetes : []);
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
  const libelleSource = (id: string): string => sources?.find((s) => s.id === id)?.label ?? '';

  return (
    <div className="flex flex-col gap-3">
      {erreur && <MbaNotice kind="error" testid="connecteurs-erreur">{erreur}</MbaNotice>}

      {sources === null && <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>}

      {/* Rien dans la bibliothèque : on ne propose pas d'y remédier ICI, on dit où ça se passe. Mettre au
          point un appel demande de l'éprouver, ce qui est un geste de workspace, pas un geste d'agent. */}
      {sources !== null && requetes.length === 0 && (
        <p data-testid="connecteurs-aucune-requete" className="text-sm text-ink-500">
          {t(
            'Aucun appel API n’est prêt sur ce workspace. Rendez-vous dans Tools > Connecteurs API pour en mettre un au point et l’éprouver ; il servira ensuite à tous vos agents.',
            'No API call is ready on this workspace. Go to Tools > API connectors to set one up and test it; it will then serve all your agents.',
          )}{' '}
          <a href="/connecteurs" className="text-brand-600 hover:underline">{t('Ouvrir Tools > Connecteurs API', 'Open Tools > API connectors')}</a>
        </p>
      )}

      {requetes.map((rq) => {
        const siens = appels.filter((o) => o.requestId === rq.id);
        return (
          <div key={rq.id} className={`${cardCls} flex flex-col gap-2`} data-testid={`agent-requete-${rq.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-ink-800">{rq.label}</p>
              <p className="text-xs text-ink-500">
                <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px]">{rq.methode}</span>{' '}
                {libelleSource(rq.sourceId)} {rq.chemin}
              </p>
            </div>

            {siens.length === 0 ? (
              <p className="text-xs text-ink-500">{t('Cet agent ne s’en sert pas.', 'This agent does not use it.')}</p>
            ) : (
              <ul className="space-y-0.5">
                {siens.map((o) => (
                  <li key={o.id} className="text-xs text-ink-600">
                    <code>{o.name}</code>
                    {!o.actif && <span className="ml-1 text-ink-400">{t('(inactif)', '(inactive)')}</span>}
                  </li>
                ))}
              </ul>
            )}

            <button
              data-testid={`requete-nouvel-outil-${rq.id}`}
              onClick={() => setOuvert((v) => (v === rq.id ? null : rq.id))}
              className="self-start text-xs text-brand-600 hover:underline"
            >
              {ouvert === rq.id ? t('Annuler', 'Cancel') : t('+ donner cet appel à l’agent', '+ give this call to the agent')}
            </button>
            {ouvert === rq.id && (
              <NouvelAppel
                requete={rq}
                busy={busy}
                onCreer={(mots) => { void agir(async () => { await ajouterConnecteur(tenantId, agentId, { ...mots, requeteId: rq.id }); }); setOuvert(null); }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Le libellé français d'une origine de variable.
 *
 * ⚠️ Il DOUBLE `libelleOrigine` de `src/agent/variables.ts`, et c'est assumé : les deux builds ne partagent
 * aucun module, comme `web/lib/button-url.ts` double `src/meta/button-url.ts`. Le serveur reste la source de
 * vérité (il renvoie `envoi` à la création) ; celui-ci sert à montrer ce qui partira AVANT de valider, donc
 * quand il n'y a encore rien à demander au serveur.
 */
function libelleOrigine(o: RequeteApi['variables'][number]['origine']): [string, string] {
  if (o.type === 'modele') return ['décidée par l’agent', 'decided by the agent'];
  if (o.type === 'contact') return o.cle === 'wa_id' ? ['numéro WhatsApp du contact', 'contact’s WhatsApp number'] : ['nom du contact', 'contact’s name'];
  if (o.type === 'champ') return [`champ « ${o.cle} » du contact`, `contact field “${o.cle}”`];
  if (o.type === 'systeme') return o.cle === 'maintenant' ? ['date et heure courantes', 'current date and time'] : ['dernier message du contact', 'contact’s last message'];
  return [`valeur fixe « ${String(o.valeur)} »`, `fixed value “${String(o.valeur)}”`];
}

function NouvelAppel({ requete, busy, onCreer }: {
  requete: RequeteApi;
  busy: boolean;
  onCreer: (mots: { name: string; title: string; description: string; nePasUtiliser: string }) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [nePasUtiliser, setNePasUtiliser] = useState('');
  const [confirme, setConfirme] = useState(false);

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-ink-200 p-3">
      {/* 🔴 CE QUI PARTIRA, montré AVANT de valider. Julien : « il faut bien faire confirmer au client, on
          envoie telle et telle valeur, est-on d'accord que c'est bien ça que tu veux ? » */}
      <div className="rounded-lg bg-ink-50 p-3" data-testid="envoi-resume">
        <p className="text-xs font-medium text-ink-800">
          {t('Cet appel enverra à votre système :', 'This call will send to your system:')}
        </p>
        {requete.variables.length === 0 ? (
          <p className="mt-1 text-xs text-ink-500">{t('aucune donnée variable', 'no variable data')}</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {requete.variables.map((v) => (
              <li key={v.nom} className="text-xs text-ink-600">
                <code>{v.nom}</code> : {t(...libelleOrigine(v.origine))}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-600">
          {t('Il lira en retour :', 'It will read back:')} <code>{requete.outputPaths.join(', ')}</code>
        </p>
        <label className="mt-2 flex items-start gap-2 text-xs text-ink-700">
          <input type="checkbox" data-testid="envoi-confirme" checked={confirme} onChange={(e) => setConfirme(e.target.checked)} className="mt-0.5" />
          <span>{t('C’est bien ce que je veux envoyer.', 'This is what I want to send.')}</span>
        </label>
      </div>

      <label className="text-xs text-ink-600">
        {t('Nom technique (vu par l’agent)', 'Technical name (seen by the agent)')}
        <input className={`${inputCls} mt-1`} data-testid="outil-nom" value={name} onChange={(e) => setName(e.target.value)} placeholder="lire_commande" />
      </label>
      <label className="text-xs text-ink-600">
        {t('Titre lisible', 'Readable title')}
        <input className={`${inputCls} mt-1`} data-testid="outil-titre" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="text-xs text-ink-600">
        {t('À quoi ça sert (l’agent le lit pour décider quand appeler)', 'What it does (the agent reads this to decide when to call)')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="text-xs text-ink-600">
        {t('Quand NE PAS l’appeler', 'When NOT to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-nepasutiliser" value={nePasUtiliser} onChange={(e) => setNePasUtiliser(e.target.value)} />
      </label>

      <button
        data-testid="outil-creer"
        // La confirmation est BLOQUANTE : sans elle, le résumé ne serait qu'une décoration qu'on survole.
        disabled={busy || !confirme || name.trim() === '' || title.trim() === '' || description.trim() === '' || nePasUtiliser.trim() === ''}
        onClick={() => onCreer({ name: name.trim(), title: title.trim(), description: description.trim(), nePasUtiliser: nePasUtiliser.trim() })}
        className="self-start rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
      >
        {t('Donner cet appel à l’agent', 'Give this call to the agent')}
      </button>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import { listerAdressesEvenements } from '@/lib/api/evenements';
import {
  BORNES_ACTION, TYPES_CHAMP_ACTION, codeLibre, normaliserCodeChamp,
  type CibleActionSaisie, type ChampActionSaisi, type TypeChampAction,
} from '@/lib/agent-outils';

const LIBELLES_TYPE: Readonly<Record<TypeChampAction, readonly [string, string]>> = {
  texte: ['Texte', 'Text'],
  nombre: ['Nombre', 'Number'],
  date: ['Date', 'Date'],
  email: ['E-mail', 'Email'],
  liste: ['Liste de valeurs', 'List of values'],
};

/** Le type d'événement sortant d'une action (`TYPE_ACTION_AGENT` côté serveur). */
const TYPE_WEBHOOK = 'agent.action';

/**
 * LA CIBLE D'UNE ACTION (plan `docs/superpowers/plans/2026-10-13-actions-agent.md`) : son nom, sa consigne (quand
 * l'utiliser, quoi dire au client ensuite), et ses champs. Tous les champs sont facultatifs pour l'agent ; ce sont leurs
 * DESCRIPTIONS que l'écran exige.
 *
 * 🔴 LE CODE D'UN CHAMP EST UN CONTRAT AVEC L'APPLICATION DU CLIENT (la clé dans `fields` du webhook) : il suit le
 * libellé tant que le champ est neuf et qu'on ne l'a pas retouché, jamais sur un champ déjà enregistré. Renommer un
 * libellé ne doit pas casser une application branchée.
 *
 * ⚠️ `agent.action` est DÉCOCHÉ par défaut sur les adresses de webhook : sans adresse abonnée, l'agent dirait « c'est
 * enregistré » et rien ne partirait vers l'application. L'écran le dit (relecture de la livraison A).
 */
export function CibleAction({ tenantId, valeur, onChange }: {
  tenantId: string;
  valeur: CibleActionSaisie;
  onChange: (c: CibleActionSaisie) => void;
}) {
  const t = useT();
  // Pour chaque champ : son code suit-il encore le libellé ? Faux pour un champ déjà enregistré.
  const [suivis, setSuivis] = useState<boolean[]>(() => valeur.champs.map(() => false));
  // Le texte des valeurs d'une liste, tel qu'il est tapé (les virgules et espaces en cours de frappe restent).
  const [textesValeurs, setTextesValeurs] = useState<string[]>(() => valeur.champs.map((c) => c.valeurs.join(', ')));
  const [abonnee, setAbonnee] = useState<boolean | null | 'erreur'>(null);

  useEffect(() => {
    let vivant = true;
    listerAdressesEvenements(tenantId)
      .then((r) => {
        if (vivant) setAbonnee((r?.adresses ?? []).some((a) => a.active && a.types.includes(TYPE_WEBHOOK)));
      })
      .catch(() => { if (vivant) setAbonnee('erreur'); });
    return () => { vivant = false; };
  }, [tenantId]);

  const changerChamp = (i: number, ch: ChampActionSaisi): void => {
    onChange({ ...valeur, champs: valeur.champs.map((c, j) => (j === i ? ch : c)) });
  };

  const changerLibelle = (i: number, libelle: string): void => {
    const ch = valeur.champs[i]!;
    const autres = valeur.champs.filter((_, j) => j !== i).map((c) => c.code);
    changerChamp(i, { ...ch, libelle, ...(suivis[i] ? { code: codeLibre(normaliserCodeChamp(libelle), autres) } : {}) });
  };

  const ajouter = (): void => {
    if (valeur.champs.length >= BORNES_ACTION.champs) return;
    const code = codeLibre('champ', valeur.champs.map((c) => c.code));
    onChange({ ...valeur, champs: [...valeur.champs, { code, libelle: '', type: 'texte', valeurs: [] }] });
    setSuivis((s) => [...s, true]);
    setTextesValeurs((v) => [...v, '']);
  };

  const retirer = (i: number): void => {
    onChange({ ...valeur, champs: valeur.champs.filter((_, j) => j !== i) });
    setSuivis((s) => s.filter((_, j) => j !== i));
    setTextesValeurs((v) => v.filter((_, j) => j !== i));
  };

  return (
    <div className="flex flex-col gap-3" data-testid="agent-action">
      {abonnee === false && (
        <MbaNotice kind="warning" testid="agent-action-sans-adresse">
          {t('Aucune adresse de webhook n’est abonnée à « Action de l’agent IA » : l’action ne partira vers aucune application. ',
            'No webhook address subscribes to “AI agent action”: the action will reach no application. ')}
          <Link href="/developers/evenements" className="underline">
            {t('Abonner une adresse dans Webhooks sortants', 'Subscribe an address in Outgoing webhooks')}
          </Link>
          {t(', ou déclenchez une automation sur cette action.', ', or trigger an automation on this action.')}
        </MbaNotice>
      )}
      <label className="text-xs text-ink-500">
        {t('Nom de l’action', 'Action name')}
        <input className={`${inputCls} mt-1`} data-testid="agent-action-nom" value={valeur.nom} maxLength={BORNES_ACTION.nom}
          placeholder={t('Ex : Résiliation', 'E.g. Cancellation')}
          onChange={(e) => onChange({ ...valeur, nom: e.target.value })} />
      </label>
      <label className="text-xs text-ink-500">
        {t('Consigne : quand l’utiliser, et ce que l’agent dit ensuite au client', 'Instruction: when to use it, and what the agent then tells the customer')}
        <textarea className={`${inputCls} mt-1`} rows={3} data-testid="agent-action-consigne" value={valeur.consigne}
          maxLength={BORNES_ACTION.consigne}
          placeholder={t(
            'Ex : quand le client veut résilier. L’agent lui répond que sa demande est enregistrée et qu’il recevra une confirmation par e-mail sous 48 h.',
            'E.g. when the customer wants to cancel. Tell them the request is recorded and they will get an email confirmation within 48 h.',
          )}
          onChange={(e) => onChange({ ...valeur, consigne: e.target.value })} />
      </label>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-ink-500">
          {t(
            'Les informations que l’agent recueille, toutes facultatives : il part avec ce que le client a donné. Le code est la clé du champ dans le webhook (fields) : ne le changez plus une fois votre application branchée.',
            'The details the agent collects, all optional: it goes with what the customer gave. The code is the field key in the webhook (fields): do not change it once your application is wired.',
          )}
        </p>
        {valeur.champs.map((ch, i) => (
          // La clé est la position : une ligne n'a pas d'identifiant stable, son code change à la frappe.
          <div key={i} className="flex flex-col gap-2 rounded-controle border border-ink-200 p-3" data-testid={`agent-action-champ-${i}`}>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[12rem] flex-1 text-xs text-ink-500">
                {t('Libellé', 'Label')}
                <input className={`${inputCls} mt-1`} data-testid={`agent-action-champ-libelle-${i}`} value={ch.libelle}
                  maxLength={BORNES_ACTION.libelle} onChange={(e) => changerLibelle(i, e.target.value)} />
              </label>
              <label className="text-xs text-ink-500">
                {t('Type', 'Type')}
                <select className={`${inputCls} mt-1`} data-testid={`agent-action-champ-type-${i}`} value={ch.type}
                  onChange={(e) => changerChamp(i, { ...ch, type: e.target.value as TypeChampAction })}>
                  {TYPES_CHAMP_ACTION.map((ty) => <option key={ty} value={ty}>{t(LIBELLES_TYPE[ty][0], LIBELLES_TYPE[ty][1])}</option>)}
                </select>
              </label>
              <label className="text-xs text-ink-500">
                {t('Code', 'Code')}
                <input className={`${inputCls} mt-1 font-mono`} data-testid={`agent-action-champ-code-${i}`} value={ch.code}
                  maxLength={BORNES_ACTION.code}
                  onChange={(e) => {
                    setSuivis((s) => s.map((v, j) => (j === i ? false : v)));
                    changerChamp(i, { ...ch, code: normaliserCodeChamp(e.target.value, true) || e.target.value });
                  }} />
              </label>
              <button type="button" data-testid={`agent-action-champ-retirer-${i}`} onClick={() => retirer(i)}
                className="pb-2 text-xs text-ink-500 hover:underline">
                {t('Retirer', 'Remove')}
              </button>
            </div>
            {ch.type === 'liste' && (
              <label className="text-xs text-ink-500">
                {t('Valeurs permises, séparées par des virgules', 'Allowed values, comma-separated')}
                <input className={`${inputCls} mt-1`} data-testid={`agent-action-champ-valeurs-${i}`} value={textesValeurs[i] ?? ''}
                  onChange={(e) => {
                    const brut = e.target.value;
                    setTextesValeurs((v) => v.map((x, j) => (j === i ? brut : x)));
                    changerChamp(i, { ...ch, valeurs: brut.split(',').map((x) => x.trim()).filter((x) => x !== '') });
                  }} />
              </label>
            )}
          </div>
        ))}
        <button type="button" data-testid="agent-action-champ-ajouter" disabled={valeur.champs.length >= BORNES_ACTION.champs}
          onClick={ajouter} className="self-start text-xs text-brand-600 hover:underline disabled:opacity-40">
          {t('+ Ajouter un champ', '+ Add a field')}
        </button>
      </div>
    </div>
  );
}

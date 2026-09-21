'use client';

import { useEffect, useState } from 'react';
import { listTags, listUserFields, type TagCount, type UserFieldDef } from '@/lib/api';
import { listRequetes, type RequeteApi } from '@/lib/api-agent-requetes';
import { inputCls } from '@/lib/ui';
import { useT } from '@/lib/i18n';

/**
 * LES CIBLES D'UN OUTIL DE L'AGENT DE META : ce que l'administrateur FIXE (spec 2026-09-21-outils-maison-mba,
 * § 9.4). L'agent de Meta ne choisit que le moment, et pour un champ, la valeur.
 *
 * ⚠️ LECTURES DÉFENSIVES : une liste qu'on ne sait pas lire est VIDE, jamais fatale. L'ancien écran l'a appris
 * à ses dépens (une réponse sans `requetes` faisait tomber tout l'onglet).
 */
export function CibleTag({ tenantId, valeur, onChange }: {
  tenantId: string; valeur: string; onChange: (v: string) => void;
}) {
  const t = useT();
  const [tags, setTags] = useState<TagCount[]>([]);
  useEffect(() => {
    let vivant = true;
    listTags(tenantId)
      .then((r) => { if (vivant) setTags(Array.isArray(r?.tags) ? r.tags : []); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId]);
  return (
    <label className="text-xs text-ink-600">
      {t('Étiquette à poser', 'Tag to set')}
      <input className={`${inputCls} mt-1`} list="mba-tags" data-testid="mba-cible-tag" value={valeur}
        onChange={(e) => onChange(e.target.value)} placeholder="client_vip" />
      <datalist id="mba-tags">{tags.map((x) => <option key={x.tag} value={x.tag} />)}</datalist>
      <span className="mt-1 block text-[11px] text-ink-500" data-testid="mba-cible-tag-note">
        {t(
          'Elle déclenche vos automations « tag ajouté ». Celles qui lancent un scénario attendent que l’agent de Meta rende la conversation : pour lancer un scénario, ajoutez plutôt un outil « Lancer un scénario ».',
          'It triggers your “tag added” automations. Those that start a scenario wait until Meta’s agent hands the conversation back: to start a scenario, add a “Start a scenario” tool instead.',
        )}
      </span>
    </label>
  );
}

export function CibleChamp({ tenantId, champ, valeurs, onChange }: {
  tenantId: string; champ: string; valeurs: string[]; onChange: (champ: string, valeurs: string[]) => void;
}) {
  const t = useT();
  const [champs, setChamps] = useState<UserFieldDef[]>([]);
  // Le texte brut des valeurs, pour qu'une ligne vide en cours de frappe ne disparaisse pas sous le curseur.
  const [texte, setTexte] = useState(valeurs.join('\n'));
  useEffect(() => {
    let vivant = true;
    listUserFields(tenantId)
      .then((r) => { if (vivant) setChamps(Array.isArray(r?.fields) ? r.fields : []); })
      .catch(() => {});
    return () => { vivant = false; };
  }, [tenantId]);
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-ink-600">
        {t('Champ de la fiche', 'Record field')}
        <select className={`${inputCls} mt-1`} data-testid="mba-cible-champ" value={champ}
          onChange={(e) => onChange(e.target.value, valeurs)}>
          <option value="">{t('Choisir un champ', 'Pick a field')}</option>
          {champs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </label>
      <label className="text-xs text-ink-600">
        {t('Valeurs permises, une par ligne (facultatif)', 'Allowed values, one per line (optional)')}
        <textarea className={`${inputCls} mt-1`} rows={3} data-testid="mba-cible-valeurs" value={texte}
          onChange={(e) => {
            setTexte(e.target.value);
            onChange(champ, e.target.value.split('\n').map((v) => v.trim()).filter((v) => v !== ''));
          }} />
      </label>
    </div>
  );
}

export function CibleConnecteur({ tenantId, requeteId, fixe, onChoisir }: {
  tenantId: string; requeteId: string | null; fixe: boolean; onChoisir: (r: RequeteApi) => void;
}) {
  const t = useT();
  const [requetes, setRequetes] = useState<RequeteApi[] | null>(null);
  useEffect(() => {
    let vivant = true;
    listRequetes(tenantId)
      .then((r) => { if (vivant) setRequetes(Array.isArray(r?.requetes) ? r.requetes : []); })
      .catch(() => { if (vivant) setRequetes([]); });
    return () => { vivant = false; };
  }, [tenantId]);
  if (requetes === null) return null;
  const choisie = requetes.find((r) => r.id === requeteId) ?? null;
  if (fixe) {
    // Plan, écart 1 : la définition d'un connecteur est partagée avec les agents IA, son appel ne change pas.
    return (
      <div className="flex flex-col gap-1" data-testid="mba-cible-appel-fixe">
        <p className="text-sm text-ink-800">{choisie?.label ?? t('Appel supprimé', 'Deleted call')}</p>
        <p className="text-[11px] text-ink-500">{t('Pour changer d’appel, créez un autre outil.', 'To change the call, create another tool.')}</p>
        {choisie && <ValeursDeLAppel requete={choisie} />}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-500">
        {t('L’agent de Meta passe par Engage Me, qui appelle votre système et lui rend toute la réponse.',
          'Meta’s agent goes through Engage Me, which calls your system and hands it the whole response.')}
      </p>
      <ul className="flex flex-col gap-1" data-testid="mba-cible-appels">
        {requetes.map((r) => (
          <li key={r.id}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${r.id === requeteId ? 'border-brand-400 bg-brand-50' : 'border-ink-200'}`}>
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm text-ink-800">{r.label}</span>
              <code className="text-[11px] text-ink-500">{r.methode} {r.chemin}</code>
            </span>
            <button type="button" data-testid={`mba-cible-appel-${r.id}`} onClick={() => onChoisir(r)}
              className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
              {r.id === requeteId ? t('Choisi', 'Picked') : t('Choisir', 'Pick')}
            </button>
          </li>
        ))}
      </ul>
      {choisie && <ValeursDeLAppel requete={choisie} />}
    </div>
  );
}

/**
 * QUI FOURNIT CHAQUE VALEUR DE L'APPEL (repris de l'ancien écran, relais du 2026-09-21) : Engage Me remplit le
 * mini-CRM, l'agent de Meta obtient le reste du client.
 */
function ValeursDeLAppel({ requete }: { requete: RequeteApi }) {
  const t = useT();
  const remplies = requete.variables.filter((v) => v.origine.type !== 'modele').map((v) => v.nom);
  const demandees = requete.variables.filter((v) => v.origine.type === 'modele').map((v) => v.nom);
  if (remplies.length === 0 && demandees.length === 0) return null;
  return (
    <p className="text-xs text-ink-600" data-testid="mba-cible-valeurs-appel">
      {remplies.length > 0 && (
        <span data-testid="mba-cible-valeurs-remplies">
          {t('Engage Me remplit lui-même : ', 'Engage Me fills in: ')}{remplies.join(', ')}.{' '}
        </span>
      )}
      {demandees.length > 0 && (
        <span data-testid="mba-cible-valeurs-demandees">
          {t('L’agent de Meta les obtient du client : ', 'Meta’s agent gets these from the customer: ')}{demandees.join(', ')}.
        </span>
      )}
    </p>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { ecrireSeuilsOps, lireSeuilsOps, type SeuilsCapaciteOps, type SeuilsLusOps } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { useLocale, useT } from '@/lib/i18n';
import { formatDate } from '@/lib/day';
import { Bouton } from '@/components/Bouton';

/**
 * LES SEUILS DE CAPACITÉ, DANS RÉGLAGES (refonte de /ops, lot 4) : l'orange et le rouge de chaque signal, qui colorent
 * Santé, tracent les courbes de Capacité et déclenchent les alertes Telegram. Tous d'un coup, une note obligatoire, comme
 * la grille de prix. 🔴 PAS D'ENREGISTREMENT OPTIMISTE : le serveur peut refuser une valeur (bornes, orange au-dessus du
 * rouge) et nomme alors le champ fautif.
 */

interface Ligne { cle: string; nom: [string, string]; unite: [string, string]; uniteRouge?: [string, string] }

/** L'ordre et les noms de l'écran ; une clé que le serveur ajouterait sans que l'écran la connaisse garde son nom. */
const LIGNES: Ligne[] = [
  { cle: 'accuses', nom: ['Retard des accusés de Meta', 'Meta receipts delay'], unite: ['s', 's'] },
  { cle: 'entrants', nom: ['Retard des messages entrants', 'Inbound messages delay'], unite: ['s', 's'] },
  { cle: 'connexions', nom: ['Connexions de la base', 'Database connections'], unite: ['%', '%'] },
  { cle: 'processeurBase', nom: ['Processeur de la base', 'Database CPU'], unite: ['%', '%'] },
  { cle: 'processeurMachine', nom: ['Processeur de la machine des workers', 'Workers machine CPU'], unite: ['%', '%'] },
  { cle: 'memoireWorker', nom: ['Mémoire d’un worker (part de sa limite)', 'Worker memory (share of its limit)'], unite: ['%', '%'] },
  { cle: 'erreurs', nom: ['Erreurs 5xx de l’API (sur l’heure)', 'API 5xx errors (over the hour)'], unite: ['%', '%'] },
  { cle: 'battement', nom: ['Battement d’un worker', 'Worker heartbeat'], unite: ['s', 's'] },
  { cle: 'secondeCopie', nom: ['2e copie d’API sur 7 jours (montées, puis minutes)', '2nd API copy over 7 days (rises, then minutes)'], unite: ['fois', 'times'], uniteRouge: ['min', 'min'] },
];

type Champs = Record<string, { orange: string; rouge: string }>;
const enChamps = (s: SeuilsCapaciteOps): Champs => Object.fromEntries(
  Object.entries(s).map(([cle, v]) => [cle, { orange: String(v.orange), rouge: String(v.rouge) }]),
);
const depuisChamps = (c: Champs): SeuilsCapaciteOps => Object.fromEntries(
  // Un champ vide part tel quel en NaN : le serveur le refuse et le nomme, plutôt qu'un zéro que personne n'a saisi.
  Object.entries(c).map(([cle, v]) => [cle, { orange: v.orange.trim() === '' ? NaN : Number(v.orange.replace(',', '.')), rouge: v.rouge.trim() === '' ? NaN : Number(v.rouge.replace(',', '.')) }]),
);

export function OpsSeuils({ token }: { token: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [lus, setLus] = useState<SeuilsLusOps | null>(null);
  const [champs, setChamps] = useState<Champs | null>(null);
  const [absente, setAbsente] = useState(false);
  const [note, setNote] = useState('');
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [champFautif, setChampFautif] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    lireSeuilsOps(token)
      .then((r) => {
        if (!vivant) return;
        // Une API d'une autre version peut rendre une autre forme : la carte le dit au lieu de faire tomber la page.
        if (r && typeof r.seuils === 'object' && r.seuils !== null && typeof r.defauts === 'object' && r.defauts !== null) {
          setLus(r);
          setChamps(enChamps(r.seuils));
        } else setAbsente(true);
      })
      // Une API plus ancienne que cette console n'a pas la route : la carte le dit, sans tomber.
      .catch(() => { if (vivant) setAbsente(true); });
    return () => { vivant = false; };
  }, [token]);

  const fr = locale !== 'en';
  const choisir = (paire: [string, string]): string => (fr ? paire[0] : paire[1]);

  function changer(cle: string, cote: 'orange' | 'rouge', valeur: string): void {
    setChamps((p) => (p === null ? p : { ...p, [cle]: { ...(p[cle] ?? { orange: '', rouge: '' }), [cote]: valeur } }));
    setStatut('idle');
    setChampFautif(null);
  }

  function enregistrer(): void {
    if (champs === null) return;
    setStatut('saving');
    setMsg(null);
    ecrireSeuilsOps(token, depuisChamps(champs), note)
      .then((r) => {
        setChamps(enChamps(r.seuils));
        setLus((l) => (l ? { ...l, seuils: r.seuils, modifieLe: r.modifieLe ?? null, modifiePar: r.modifiePar ?? null } : l));
        setStatut('saved'); setChampFautif(null); setNote('');
      })
      .catch((err: unknown) => {
        const texte = err instanceof ApiError || err instanceof Error ? err.message : '';
        setChampFautif(/champ invalide : ([\w.]+)/.exec(texte)?.[1] ?? null);
        setMsg(texte || null);
        setStatut('error');
      });
  }

  const titre = <h2 className="text-sm font-semibold text-ink-900">{t('Seuils de capacité', 'Capacity thresholds')}</h2>;
  if (absente) {
    return (
      <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-seuils-absente">
        {titre}
        <p className="mt-1 text-xs text-ink-500">{t('Arrive avec le prochain déploiement de l’API.', 'Arrives with the next API deployment.')}</p>
      </div>
    );
  }
  if (lus === null || champs === null) return null;

  const cles = [...LIGNES.map((l) => l.cle), ...Object.keys(champs).filter((c) => !LIGNES.some((l) => l.cle === c))];
  const champ = 'w-20 rounded-controle border px-2 py-1.5 text-sm tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
  const bordure = (nom: string): string => (champFautif === nom ? 'border-danger-500' : 'border-ink-300');

  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-seuils">
      {titre}
      <p className="mt-1 text-xs text-ink-500">
        {t(
          'Ils colorent les pastilles de Santé, tracent les courbes de Capacité et déclenchent les alertes Telegram : une aggravation part aussitôt, une baisse ou un retour au vert au plus une fois par demi-heure. Le battement et la 2e copie ne jouent que sur l’écran (le silence d’un worker a sa propre alerte).',
          'They color the Health dots, draw the Capacity curves and trigger the Telegram alerts: a worsening is sent at once, a decrease or a return to green at most once per half hour. The heartbeat and the 2nd copy only affect the screen (a silent worker has its own alert).',
        )}
      </p>
      {lus.modifieLe && (
        <p className="mt-1 text-xs text-ink-500" data-testid="ops-seuils-auteur">
          {t('Modifiés le', 'Changed on')} {formatDate(lus.modifieLe, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          {lus.modifiePar ? ` : ${lus.modifiePar}` : ''}
        </p>
      )}

      <div className="mt-4 space-y-2">
        <div className="hidden grid-cols-[minmax(0,1fr)_8rem_8rem] gap-3 text-xs font-medium text-ink-500 sm:grid">
          <span>{t('Signal', 'Signal')}</span><span>{t('Orange', 'Orange')}</span><span>{t('Rouge', 'Red')}</span>
        </div>
        {cles.map((cle) => {
          const l = LIGNES.find((x) => x.cle === cle);
          const v = champs[cle] ?? { orange: '', rouge: '' };
          const unite = l ? choisir(l.unite) : '';
          const uniteRouge = l?.uniteRouge ? choisir(l.uniteRouge) : unite;
          return (
            <div key={cle} className="grid grid-cols-2 items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]" data-testid={`ops-seuil-${cle}`}>
              <span className="col-span-2 text-sm text-ink-700 sm:col-span-1">{l ? choisir(l.nom) : cle}</span>
              <label className="flex items-center gap-1 text-xs text-ink-500">
                <input
                  aria-label={`${l ? choisir(l.nom) : cle} : ${t('orange', 'orange')}`} inputMode="decimal" value={v.orange}
                  onChange={(e) => changer(cle, 'orange', e.target.value)} className={`${champ} ${bordure(`${cle}.orange`)}`}
                  data-testid={`ops-seuil-${cle}-orange`}
                />
                {unite}
              </label>
              <label className="flex items-center gap-1 text-xs text-ink-500">
                <input
                  aria-label={`${l ? choisir(l.nom) : cle} : ${t('rouge', 'red')}`} inputMode="decimal" value={v.rouge}
                  onChange={(e) => changer(cle, 'rouge', e.target.value)} className={`${champ} ${bordure(`${cle}.rouge`)}`}
                  data-testid={`ops-seuil-${cle}-rouge`}
                />
                {uniteRouge}
              </label>
            </div>
          );
        })}
      </div>

      <div className="mt-4">
        <label htmlFor="seuils-note" className="block text-xs font-medium text-ink-900">{t('Pourquoi ce changement ?', 'Why this change?')}</label>
        <input
          id="seuils-note" value={note} onChange={(e) => setNote(e.target.value)} data-testid="ops-seuils-note"
          placeholder={t('qui décide, et pourquoi', 'who decides, and why')}
          className="mt-1 w-full rounded-controle border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <p className="mt-1 text-xs text-ink-500">{t('Obligatoire : elle dit pourquoi, et votre adresse est enregistrée avec.', 'Required: it says why, and your address is recorded with it.')}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Bouton type="button" onClick={enregistrer} disabled={statut === 'saving'} data-testid="ops-seuils-enregistrer">
          {statut === 'saving' ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </Bouton>
        <Bouton type="button" variante="secondaire" onClick={() => { setChamps(enChamps(lus.defauts)); setStatut('idle'); setChampFautif(null); }} data-testid="ops-seuils-defauts">
          {t('Valeurs par défaut', 'Default values')}
        </Bouton>
        {statut === 'saved' && <span className="text-xs text-succes-700" data-testid="ops-seuils-ok">{t('Enregistré', 'Saved')}</span>}
        {statut === 'error' && (
          <span className="text-xs text-danger-700" data-testid="ops-seuils-erreur">
            {champFautif ? t('Valeur refusée, corrigez le champ en rouge (l’orange doit rester sous le rouge).', 'Value rejected, fix the field in red (orange must stay below red).') : msg ?? t('Enregistrement impossible.', 'Could not save.')}
          </span>
        )}
      </div>
    </div>
  );
}

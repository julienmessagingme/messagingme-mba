'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import {
  chargerGrilleMetaOps, lireReglagesCreditWhatsappOps, reglerCommissionMessagesOps, type ResumeGrilleMeta,
} from '@/lib/api';

/**
 * LES RÉGLAGES DU CRÉDIT WHATSAPP DANS `/ops` (plan du Crédit WhatsApp, tâche 2) : la grille de Meta, chargée depuis le
 * fichier en euros que Meta publie, et la commission des messages.
 *
 * Un seul geste pour la grille : choisir le fichier, sa date d'entrée en vigueur, dire d'où il vient. C'est le serveur
 * qui le lit, et qui le refuse en nommant la ligne fautive. Comme la grille de prix, la carte se masque quand l'API n'a
 * pas encore la route, et rien ne s'affiche « enregistré » avant la réponse du serveur.
 */
const champ = `mt-1 ${inputCls}`;

function dateLisible(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
}

export function OpsCreditWhatsappCard({ token }: { token: string }) {
  const t = useT();
  const [absente, setAbsente] = useState(false);
  const [grille, setGrille] = useState<ResumeGrilleMeta | null | undefined>(undefined);
  const [commission, setCommission] = useState('');
  const [fichier, setFichier] = useState<File | null>(null);
  const [enVigueurLe, setEnVigueurLe] = useState('');
  const [noteGrille, setNoteGrille] = useState('');
  const [noteCommission, setNoteCommission] = useState('');
  const [etatGrille, setEtatGrille] = useState<{ statut: 'idle' | 'saving' | 'saved' | 'error'; msg?: string }>({ statut: 'idle' });
  const [etatCommission, setEtatCommission] = useState<{ statut: 'idle' | 'saving' | 'saved' | 'error'; msg?: string }>({ statut: 'idle' });

  useEffect(() => {
    let vivant = true;
    lireReglagesCreditWhatsappOps(token)
      .then((r) => { if (vivant) { setGrille(r.grille); setCommission(String(r.commissionPct)); } })
      .catch(() => { if (vivant) setAbsente(true); });
    return () => { vivant = false; };
  }, [token]);

  async function charger() {
    if (fichier === null) return;
    setEtatGrille({ statut: 'saving' });
    try {
      const r = await chargerGrilleMetaOps(token, await fichier.text(), enVigueurLe, noteGrille);
      setGrille(r.grille);
      setEtatGrille({ statut: 'saved' });
      setFichier(null);
      setNoteGrille('');
    } catch (err) {
      setEtatGrille({ statut: 'error', msg: err instanceof Error ? err.message : undefined });
    }
  }

  async function reglerCommission() {
    setEtatCommission({ statut: 'saving' });
    try {
      const r = await reglerCommissionMessagesOps(token, Number(commission), noteCommission);
      setCommission(String(r.commissionPct));
      setEtatCommission({ statut: 'saved' });
      setNoteCommission('');
    } catch (err) {
      setEtatCommission({ statut: 'error', msg: err instanceof Error ? err.message : undefined });
    }
  }

  if (absente) {
    return (
      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-ink-900">{t('Crédit WhatsApp', 'WhatsApp credit')}</h2>
        <p className="mt-1 text-xs text-ink-500">
          {t('Indisponible sur cette instance : l’API n’a pas encore la route.', 'Unavailable on this instance: the API does not have the route yet.')}
        </p>
      </div>
    );
  }
  if (grille === undefined) return null;

  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-credit-whatsapp">
      <h2 className="text-sm font-semibold text-ink-900">{t('Crédit WhatsApp : grille de Meta et commission', 'WhatsApp credit: Meta rate card and commission')}</h2>
      <p className="mt-1 text-xs text-ink-500">
        {t(
          'Le prix d’un message sur la ligne de crédit : le tarif de Meta du pays et de la catégorie, plus la commission. Aucun numéro ne peut passer sur la ligne sans grille.',
          'The price of a message on the credit line: Meta’s rate for the country and category, plus the commission. No number can go on the line without a rate card.',
        )}
      </p>

      <div className="mt-4 text-sm text-ink-900" data-testid="ops-grille-meta-etat">
        {grille === null
          ? t('Aucune grille chargée.', 'No rate card loaded.')
          : t(
            `En vigueur depuis le ${dateLisible(grille.enVigueurLe)} : ${grille.tarifs} tarifs, chargée le ${dateLisible(grille.chargeeLe)} par ${grille.chargeePar}.`,
            `In force since ${dateLisible(grille.enVigueurLe)}: ${grille.tarifs} rates, loaded on ${dateLisible(grille.chargeeLe)} by ${grille.chargeePar}.`,
          )}
        {grille?.perimee && (
          <p className="mt-1 text-xs text-alerte-700" data-testid="ops-grille-meta-perimee">
            {t(
              'Elle date d’avant ce trimestre : Meta change ses tarifs au 1er jour de chaque trimestre. Chargez la nouvelle.',
              'It predates this quarter: Meta changes its rates on the first day of each quarter. Load the new one.',
            )}
          </p>
        )}
        {grille?.prochaine && (
          <p className="mt-1 text-xs text-ink-500">
            {t(`Une grille suivante prendra effet le ${dateLisible(grille.prochaine.enVigueurLe)}.`, `A next rate card takes effect on ${dateLisible(grille.prochaine.enVigueurLe)}.`)}
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="grille-meta-fichier" className="block text-xs font-medium text-ink-900">
            {t('Fichier de Meta « EUR list rates » (CSV)', 'Meta file “EUR list rates” (CSV)')}
          </label>
          <input
            id="grille-meta-fichier" type="file" accept=".csv,text/csv" className={champ} data-testid="ops-grille-meta-fichier"
            onChange={(e) => { setFichier(e.target.files?.[0] ?? null); setEtatGrille({ statut: 'idle' }); }}
          />
        </div>
        <div>
          <label htmlFor="grille-meta-date" className="block text-xs font-medium text-ink-900">{t('En vigueur le', 'In force from')}</label>
          <input id="grille-meta-date" type="date" value={enVigueurLe} onChange={(e) => setEnVigueurLe(e.target.value)} className={champ} />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="grille-meta-note" className="block text-xs font-medium text-ink-900">{t('D’où vient ce fichier ?', 'Where does this file come from?')}</label>
        <input
          id="grille-meta-note" value={noteGrille} onChange={(e) => setNoteGrille(e.target.value)} className={champ}
          placeholder={t('par exemple : grille du T1 2027, téléchargée sur la page Pricing de Meta', 'for example: Q1 2027 rate card, from Meta’s Pricing page')}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Bouton type="button" onClick={() => { void charger(); }} disabled={etatGrille.statut === 'saving' || fichier === null || enVigueurLe === ''} data-testid="ops-grille-meta-charger">
          {etatGrille.statut === 'saving' ? t('Chargement…', 'Loading…') : t('Charger la grille', 'Load the rate card')}
        </Bouton>
        {etatGrille.statut === 'saved' && <span className="text-xs text-succes-700">{t('Grille chargée', 'Rate card loaded')}</span>}
        {etatGrille.statut === 'error' && (
          <span className="text-xs text-danger-700" data-testid="ops-grille-meta-erreur">{etatGrille.msg ?? t('Chargement impossible.', 'Could not load.')}</span>
        )}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="commission-messages" className="block text-xs font-medium text-ink-900">{t('Commission des messages (%)', 'Message commission (%)')}</label>
          <input
            id="commission-messages" type="number" min={0} max={100} step={1} value={commission} className={champ}
            onChange={(e) => { setCommission(e.target.value); setEtatCommission({ statut: 'idle' }); }}
          />
        </div>
        <div>
          <label htmlFor="commission-note" className="block text-xs font-medium text-ink-900">{t('Pourquoi ce changement ?', 'Why this change?')}</label>
          <input id="commission-note" value={noteCommission} onChange={(e) => setNoteCommission(e.target.value)} className={champ} />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Bouton type="button" onClick={() => { void reglerCommission(); }} disabled={etatCommission.statut === 'saving'}>
          {etatCommission.statut === 'saving' ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </Bouton>
        {etatCommission.statut === 'saved' && <span className="text-xs text-succes-700">{t('Enregistré', 'Saved')}</span>}
        {etatCommission.statut === 'error' && (
          <span className="text-xs text-danger-700">{etatCommission.msg ?? t('Enregistrement impossible.', 'Could not save.')}</span>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-500">
        {t(
          'La commission ne s’affiche jamais en taux chez le client : il voit des prix, commission comprise. L’Entreprise peut avoir la sienne, réglée avec son offre.',
          'The commission is never shown as a rate to the client: they see prices, commission included. An Enterprise can have its own, set with its plan.',
        )}
      </p>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { fmtCost, fmtNum } from '@/lib/format';
import { cardCls, inputClsAuto } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { Squelette } from '@/components/Squelette';
import { MbaNotice } from './MbaNotice';
import {
  getPlafondMba, putPlafondMba, PRIX_JETONS_USD_PAR_MILLION, PRIX_REPONSE_USD,
  type EtatPlafondMba, type FenetreBudget, type PlafondMba, type UniteBudget,
} from '@/lib/api-mba';

/**
 * LE PLAFOND DE DÉPENSE DE L'AGENT DE META (2026-10-02), dans l'onglet Activation.
 *
 * 🔴 IL VAUT POUR TOUT LE BUSINESS MANAGER, pas pour ce seul numéro : c'est là que Meta le pose (mesuré : le numéro rend
 * 404) et c'est là qu'il facture. Au plafond, l'agent finit sa réponse, passe la main à l'équipe, et reprend quand la
 * période glisse. L'écran le dit, sans quoi un client croirait son agent en panne.
 *
 * ⚠️ L'ESTIMATION EN DOLLARS EST UN ORDRE DE GRANDEUR : 2 $ le million de jetons, 20 000 à 25 000 jetons par réponse
 * selon Meta. Aucune API ne rend le coût réel ; la facture du Billing Hub fait foi.
 */
export function MbaPlafond({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<EtatPlafondMba | null | 'erreur'>(null);
  const [erreur, setErreur] = useState('');
  const [ok, setOk] = useState('');
  const [unite, setUnite] = useState<UniteBudget>('ai_turn');
  const [fenetre, setFenetre] = useState<FenetreBudget>('thirty_days');
  const [max, setMax] = useState('');
  const [busy, setBusy] = useState(false);

  function remplir(e: EtatPlafondMba): void {
    setEtat(e);
    if (e.plafond) {
      setUnite(e.plafond.unite);
      setFenetre(e.plafond.fenetre);
      setMax(String(e.plafond.max));
    }
  }

  useEffect(() => {
    let vivant = true;
    getPlafondMba(tenantId)
      .then((e) => {
        if (!vivant) return;
        // Une réponse sans `plafond` (API d'avant cette route, proxy qui rend `{}`) n'est pas « aucun plafond ».
        if (e && typeof e === 'object' && 'plafond' in e) remplir(e);
        else setEtat('erreur');
      })
      .catch((err: unknown) => {
        if (!vivant) return;
        setEtat('erreur');
        setErreur(err instanceof Error ? err.message : '');
      });
    return () => { vivant = false; };
  }, [tenantId]);

  const nombre = Number(max);
  const maxValide = max.trim() !== '' && Number.isSafeInteger(nombre) && nombre >= 1;

  async function enregistrer(plafond: PlafondMba | null): Promise<void> {
    setBusy(true);
    setErreur('');
    setOk('');
    try {
      remplir(await putPlafondMba(tenantId, plafond));
      setOk(plafond === null ? t('Plafond retiré : l’agent répond sans limite.', 'Cap removed: the agent replies without limit.') : t('Plafond enregistré chez Meta.', 'Cap saved at Meta.'));
    } catch (err) {
      // Le message du serveur, ou celui de Meta, porte la cause exacte : on ne le remplace pas.
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const fenetres: Array<[FenetreBudget, string]> = [
    ['one_day', t('1 jour', '1 day')],
    ['seven_days', t('7 jours', '7 days')],
    ['fourteen_days', t('14 jours', '14 days')],
    ['thirty_days', t('30 jours', '30 days')],
  ];
  const libelleFenetre = (f: FenetreBudget): string => fenetres.find(([cle]) => cle === f)?.[1] ?? f;
  const libelleUnite = (u: UniteBudget, n: number): string => (u === 'ai_turn'
    ? t(`${fmtNum(n, locale)} réponse(s) de l’agent`, `${fmtNum(n, locale)} agent reply(ies)`)
    : t(`${fmtNum(n, locale)} jetons`, `${fmtNum(n, locale)} tokens`));
  const dollars = (n: number): string => fmtCost(n, locale, 'USD');

  return (
    <section className={cardCls} data-testid="mba-plafond">
      <h3 className="text-sm font-semibold text-ink-900">{t('Plafond de dépense de l’agent', 'Agent spending cap')}</h3>
      <p className="mt-1 text-xs text-ink-500">
        {t(
          'Au plafond, l’agent termine sa réponse, passe la main à votre équipe, puis reprend quand la période glisse. Le plafond vaut pour tous les numéros de votre Business Manager : c’est lui que Meta facture.',
          'At the cap, the agent finishes its reply, hands over to your team, and resumes when the period rolls over. The cap applies to every number of your Business Manager: that is what Meta bills.',
        )}
      </p>

      {erreur !== '' && <div className="mt-3"><MbaNotice kind="error" testid="mba-plafond-erreur">{erreur}</MbaNotice></div>}
      {ok !== '' && erreur === '' && <div className="mt-3"><MbaNotice kind="success" testid="mba-plafond-ok">{ok}</MbaNotice></div>}

      {etat === null && <Squelette forme="carte" className="mt-3" />}
      {etat === 'erreur' && erreur === '' && (
        <p className="mt-3 text-xs text-ink-500">{t('Le plafond n’a pas pu être lu chez Meta.', 'The cap could not be read from Meta.')}</p>
      )}

      {etat !== null && etat !== 'erreur' && (
        <>
          <p className="mt-3 text-sm text-ink-900" data-testid="mba-plafond-actuel">
            {etat.plafond === null
              ? t('Aucun plafond : l’agent répond sans limite.', 'No cap: the agent replies without limit.')
              : t(
                `Plafond actuel : ${libelleUnite(etat.plafond.unite, etat.plafond.max)} sur ${libelleFenetre(etat.plafond.fenetre)} glissants.`,
                `Current cap: ${libelleUnite(etat.plafond.unite, etat.plafond.max)} over a rolling ${libelleFenetre(etat.plafond.fenetre)}.`,
              )}
          </p>
          {etat.autres > 0 && (
            <p className="mt-1 text-xs text-ink-500" data-testid="mba-plafond-autres">
              {t(
                `Meta porte ${etat.autres} autre(s) plafond(s), posé(s) ailleurs. Enregistrer ici les remplace tous.`,
                `Meta holds ${etat.autres} other cap(s), set elsewhere. Saving here replaces them all.`,
              )}
            </p>
          )}

          <div className="mt-3 space-y-2" role="radiogroup">
            {([
              ['ai_turn', t('En réponses de l’agent', 'In agent replies')],
              ['token', t('En jetons', 'In tokens')],
            ] as const).map(([cle, libelle]) => (
              <label key={cle} className="flex cursor-pointer items-center gap-2 text-sm text-ink-900">
                <input type="radio" name="mba-plafond-unite" data-testid={`mba-plafond-unite-${cle}`}
                  checked={unite === cle} disabled={busy} onChange={() => setUnite(cle)} />
                {libelle}
              </label>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="number" min={1} step={1} value={max} disabled={busy}
              onChange={(e) => setMax(e.target.value)}
              placeholder={unite === 'ai_turn' ? '500' : '10000000'}
              className={`${inputClsAuto} w-40`}
              data-testid="mba-plafond-max"
            />
            <span className="text-sm text-ink-500">{t('sur', 'over')}</span>
            <select
              value={fenetre} disabled={busy}
              onChange={(e) => setFenetre(e.target.value as FenetreBudget)}
              className={`${inputClsAuto} w-32`}
              data-testid="mba-plafond-fenetre"
            >
              {fenetres.map(([cle, libelle]) => <option key={cle} value={cle}>{libelle}</option>)}
            </select>
            <span className="text-sm text-ink-500">{t('glissants', 'rolling')}</span>
          </div>
          {maxValide && (
            <p className="mt-1.5 text-xs text-ink-500" data-testid="mba-plafond-estimation">
              {unite === 'token'
                ? t(
                  `Soit environ ${dollars((nombre / 1_000_000) * PRIX_JETONS_USD_PAR_MILLION)} au prix public de Meta (2 $ le million de jetons).`,
                  `About ${dollars((nombre / 1_000_000) * PRIX_JETONS_USD_PAR_MILLION)} at Meta’s public price ($2 per million tokens).`,
                )
                : t(
                  `Soit environ ${dollars(nombre * PRIX_REPONSE_USD.min)} à ${dollars(nombre * PRIX_REPONSE_USD.max)}, à 4 ou 5 cents la réponse selon Meta.`,
                  `About ${dollars(nombre * PRIX_REPONSE_USD.min)} to ${dollars(nombre * PRIX_REPONSE_USD.max)}, at 4 to 5 cents per reply according to Meta.`,
                )}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Bouton
              disabled={busy || !maxValide}
              data-testid="mba-plafond-enregistrer"
              onClick={() => void enregistrer({ unite, fenetre, max: nombre })}
            >
              {t('Enregistrer le plafond', 'Save the cap')}
            </Bouton>
            {etat.plafond !== null && (
              <Bouton variante="discret" disabled={busy} data-testid="mba-plafond-retirer" onClick={() => void enregistrer(null)}>
                {t('Retirer le plafond', 'Remove the cap')}
              </Bouton>
            )}
          </div>
        </>
      )}
    </section>
  );
}

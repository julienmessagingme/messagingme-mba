'use client';

import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { fmtCost, fmtNum } from '@/lib/format';
import { cardCls, inputClsAuto } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { Squelette } from '@/components/Squelette';
import { MbaNotice } from './MbaNotice';
import { ApiError } from '@/lib/api';
import {
  getPlafondMba, putPlafondMba,
  type EtatPlafondMba, type FenetreBudget, type PlafondMba, type UniteBudget,
} from '@/lib/api-mba';
import { UNITE_PAR_DEFAUT, estimationPlafond } from '@/lib/mba-plafond';

/**
 * LE PLAFOND DE L'AGENT DE META (2026-10-02), dans l'onglet Activation.
 *
 * 🔴 IL SE POSE CHEZ META SUR LE BUSINESS MANAGER (mesuré : le numéro rend 404), MAIS SES DEUX UNITÉS NE BORNENT PAS LA
 * MÊME CHOSE (relecture du 2026-10-02, `web/lib/mba-plafond.ts`) : en jetons, la dépense de tous les numéros du
 * Business Manager ; en réponses, CHAQUE conversation, donc pas la dépense totale. L'unité par défaut est le jeton, et
 * l'écran dit la portée de chacune. Au plafond, l'agent finit sa réponse, passe la main à l'équipe, et reprend quand la
 * période glisse.
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
  const [unite, setUnite] = useState<UniteBudget>(UNITE_PAR_DEFAUT);
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
        // Un 404 ne vient que d'une API d'avant cette route (la console part sur Vercel avant le déploiement de l'API) :
        // « Not Found » ne dirait rien à personne.
        setErreur(err instanceof ApiError && err.status === 404
          ? t('Le plafond n’est pas encore disponible sur ce serveur : réessayez dans quelques minutes.', 'The cap is not available on this server yet: try again in a few minutes.')
          : err instanceof Error ? err.message : '');
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
    ? t(`${fmtNum(n, locale)} réponse(s) de l’agent PAR CONVERSATION`, `${fmtNum(n, locale)} agent reply(ies) PER CONVERSATION`)
    : t(`${fmtNum(n, locale)} jetons sur tout le Business Manager`, `${fmtNum(n, locale)} tokens across the Business Manager`));
  const estimation = maxValide ? estimationPlafond(unite, nombre) : null;
  const dollars = (n: number): string => fmtCost(n, locale, 'USD');

  return (
    <section className={cardCls} data-testid="mba-plafond">
      <h3 className="text-sm font-semibold text-ink-900">{t('Plafond de l’agent', 'Agent cap')}</h3>
      <p className="mt-1 text-xs text-ink-500">
        {t(
          'Au plafond, l’agent termine sa réponse, passe la main à votre équipe, puis reprend quand la période glisse. En jetons, le plafond borne la dépense de tous les numéros de votre Business Manager, celui que Meta facture. En réponses, il borne chaque conversation, pas la dépense totale.',
          'At the cap, the agent finishes its reply, hands over to your team, and resumes when the period rolls over. In tokens, the cap bounds the spend of every number of your Business Manager, the one Meta bills. In replies, it bounds each conversation, not the total spend.',
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
          {etat.entreprise && (
            <p className="mt-1 text-xs text-ink-500" data-testid="mba-plafond-entreprise">
              {t(
                `Business Manager : ${etat.entreprise}. Tous ses numéros WhatsApp partagent ce plafond, y compris ceux d’autres espaces.`,
                `Business Manager: ${etat.entreprise}. All its WhatsApp numbers share this cap, including those of other workspaces.`,
              )}
            </p>
          )}
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
              ['token', t('En jetons : un plafond de dépense, sur tout le Business Manager', 'In tokens: a spending cap, across the Business Manager')],
              ['ai_turn', t('En réponses de l’agent : un plafond PAR CONVERSATION', 'In agent replies: a cap PER CONVERSATION')],
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
          {estimation !== null && (
            <p className="mt-1.5 text-xs text-ink-500" data-testid="mba-plafond-estimation">
              {estimation.portee === 'business_manager'
                ? t(
                  `Soit environ ${dollars(estimation.minUsd)} au prix public de Meta (2 $ le million de jetons), pour tous les numéros du Business Manager.`,
                  `About ${dollars(estimation.minUsd)} at Meta’s public price ($2 per million tokens), for every number of the Business Manager.`,
                )
                : t(
                  `Soit environ ${dollars(estimation.minUsd)} à ${dollars(estimation.maxUsd)} par conversation. Ce n’est pas un plafond de dépense : il ne limite pas le nombre de conversations.`,
                  `About ${dollars(estimation.minUsd)} to ${dollars(estimation.maxUsd)} per conversation. This is not a spending cap: it does not limit the number of conversations.`,
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

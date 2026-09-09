'use client';

import { useEffect, useState } from 'react';
import { getCoutParCampagne, type CoutParCampagne, type LigneCoutCampagne, type StatsRange } from '@/lib/api';
import { fmtNum, fmtCost } from '@/lib/format';
import { phrasesNonChiffrables } from '@/lib/cout-non-chiffrable';
import { useT, useLocale } from '@/lib/i18n';
import type { Locale } from '@/lib/locale';

/**
 * « Ce que coûte un engagement » : une ligne par campagne ayant envoyé sur la période (lot E du 2026-09-08).
 *
 * 🔴 LE COÛT EST UNE ESTIMATION, ET L'ÉCRAN LE DIT. Aucun coût par campagne n'est stocké nulle part : il se
 * recalcule (envois × tarif Meta de la catégorie), à partir des tarifs que Meta rend pour la période. Ce
 * n'est donc pas une facture, et le laisser croire serait le pire service à rendre à un client qui décide
 * de son budget dessus.
 *
 * 🔴 TROIS CASES RESTENT VIDES PLUTÔT QUE DE VALOIR ZÉRO, et chacune dit pourquoi au survol :
 *  - le coût, quand Meta ne rend aucun tarif ou que la catégorie de l'envoi est inconnue ;
 *  - les clics, quand la campagne n'a pas de template (elle envoie un scénario) ou que son template ne
 *    porte aucun lien tracé : il n'y a alors rien à mesurer, ce qui n'est pas « personne n'a cliqué » ;
 *  - le ratio, dès qu'un des deux termes manque ou que les clics valent zéro. Un « ∞ » ou un « 0 € »
 *    serait une réponse à une question qu'on n'a pas pu poser.
 *
 * 🔴 CETTE CASE DISAIT « NON ATTRIBUABLE », ET C'ÉTAIT LE MOT QUI TROMPAIT. Julien l'a lu le 2026-09-09
 * comme « on n'a pas su rattacher les clics », donc comme une panne d'attribution, et a demandé si ça ne
 * voulait pas plutôt dire « personne n'a cliqué ». Ce n'est ni l'un ni l'autre : il n'existe AUCUN lien
 * tracé à mesurer. Zéro clic, lui, s'affiche `0`. La case dit donc désormais ce qu'elle constate, « sans
 * lien tracé », et l'infobulle dit laquelle des deux situations on est.
 */

const CARD = 'rounded-2xl border border-ink-200 bg-white p-5 shadow-sm';
/**
 * ⚠️ DENSITÉ RESSERRÉE LE 2026-09-09, parce que la carte ne fait plus toute la largeur : elle partage la
 * ligne avec le nuage qualitatif. Aux anciennes mesures (`px-3 py-2`, `min-w-[36rem]`, « Coût estimé » en
 * en-tête), cinq colonnes de chiffres débordaient d'une demi-largeur et le tableau défilait de côté en
 * permanence, ce qui est le contraire d'un écran de synthèse. Le mot « estimé » n'est pas perdu : il est
 * dans le sous-titre de la carte, où il ne coûte aucune colonne.
 */
const TH = 'px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400';
const TD = 'px-2 py-1.5 text-[13px] text-ink-700';

export function CoutParCampagneCard({ tenantId, range }: { tenantId: string; range: StatsRange }) {
  const t = useT();
  const { locale } = useLocale();
  const [donnees, setDonnees] = useState<CoutParCampagne | null>(null);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let vivant = true;
    setDonnees(null);
    setErreur(false);
    getCoutParCampagne(tenantId, range)
      .then((d) => {
        if (!vivant) return;
        // 🔴 LE TYPE MENT SUR UNE DONNÉE DE RÉSEAU. `request()` rend ce que le serveur a envoyé, et le type
        // n'est qu'une promesse : une API plus ancienne que cette route, un proxy qui répond `{}`, et
        // `lignes.map` jette EN PLEIN RENDU. Ce n'est pas cette carte qui tombe alors, c'est la PAGE, donc
        // aussi le nuage d'à côté qui n'a rien demandé. Mesuré le 2026-09-08 : la suite E2E de la synthèse
        // est passée de verte à muette le jour où cette carte est arrivée sur la même page.
        if (!d || !Array.isArray(d.lignes)) { setErreur(true); return; }
        setDonnees(d);
      })
      .catch(() => { if (vivant) setErreur(true); });
    return () => { vivant = false; };
  }, [tenantId, range.from, range.to]);

  // ⚠️ Somme sur les lignes AFFICHÉES, pas sur la période : quand le tableau tronque, les campagnes
  // écartées ne sont comptées nulle part ici. La phrase le dit (« des campagnes affichées »), parce
  // qu'annoncer « de la période » serait faux exactement dans le cas où le chiffre compte le plus.
  //
  // 🔴 ET LES DEUX CAUSES SE SOMMENT SÉPARÉMENT. Une catégorie absente est un héritage clos (les envois de
  // scénario n'ont commencé à la porter que le 2026-09-07) ; un tarif manquant est une panne du jour. Le
  // total unique d'avant obligeait le lecteur à trancher entre les deux sans aucun moyen de le faire.
  //
  // ⚠️ LE TOTAL SE SOMME AUSSI, et il est le seul champ garanti : le détail manque tant que l'API du VPS
  // n'a pas rattrapé la console de Vercel. `phrasesNonChiffrables` retombe alors sur la phrase générique
  // plutôt que de se taire, et c'est pour ça que les trois compteurs voyagent ensemble.
  const causes = donnees
    ? donnees.lignes.reduce(
      (a, l) => ({
        nonChiffrables: a.nonChiffrables + (l.nonChiffrables ?? 0),
        sansCategorie: a.sansCategorie + (l.sansCategorie ?? 0),
        sansTarif: a.sansTarif + (l.sansTarif ?? 0),
        detail: a.detail && l.sansCategorie !== undefined && l.sansTarif !== undefined,
      }),
      { nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, detail: true },
    )
    : { nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, detail: true };

  return (
    <section className={CARD} data-testid="cout-engagement">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-ink-900">{t('Ce que coûte un engagement', 'What an engagement costs')}</h2>
        <p className="mt-0.5 text-xs text-ink-400">
          {t(
            'Coût ESTIMÉ (envois × tarif Meta de la catégorie), rapporté aux clics mesurés. Ce n’est pas une facture.',
            'ESTIMATED cost (sends × Meta category rate), against measured clicks. This is not an invoice.',
          )}
        </p>
      </header>

      {erreur && (
        <p className="rounded-lg bg-coral/10 px-3 py-2 text-xs text-coral" data-testid="cout-erreur">
          {t('Le coût par campagne n’a pas pu être chargé.', 'Cost per campaign could not be loaded.')}
        </p>
      )}
      {!erreur && donnees === null && <p className="text-xs text-ink-400">{t('Chargement…', 'Loading…')}</p>}

      {!erreur && donnees !== null && donnees.lignes.length === 0 && (
        <p className="text-xs text-ink-500" data-testid="cout-vide">
          {t('Aucune campagne n’a envoyé sur cette période.', 'No campaign sent anything over this period.')}
        </p>
      )}

      {!erreur && donnees !== null && donnees.lignes.length > 0 && (
        <>
          {/* Le tableau défile DANS son cadre : sur un écran étroit, cinq colonnes de chiffres ne tiennent
              pas, et faire défiler la page entière de côté abîmerait tout le reste de l'écran. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] border-collapse">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className={TH}>{t('Campagne', 'Campaign')}</th>
                  <th className={`${TH} text-right`}>{t('Envoyés', 'Sent')}</th>
                  <th className={`${TH} text-right`}>{t('Coût', 'Cost')}</th>
                  <th className={`${TH} text-right`}>{t('Clics', 'Clicks')}</th>
                  <th className={`${TH} text-right`}>{t('Coût/clic', 'Cost/click')}</th>
                </tr>
              </thead>
              <tbody>
                {donnees.lignes.map((l) => (
                  <Ligne key={l.campaignId} l={l} devise={donnees.currency} locale={locale} t={t} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 space-y-1 text-xs text-ink-400">
            {donnees.tronque && (
              <p data-testid="cout-tronque">
                {t(
                  `Seules les ${donnees.lignes.length} campagnes qui ont le plus envoyé sont affichées : la période en compte davantage.`,
                  `Only the ${donnees.lignes.length} campaigns that sent the most are shown: the period holds more.`,
                )}
              </p>
            )}
            {!donnees.hasRates && (
              <p data-testid="cout-sans-tarif">
                {t(
                  'Meta n’a rendu aucun tarif pour cette période : la colonne du coût reste vide plutôt que d’afficher un chiffre inventé.',
                  'Meta returned no rate for this period: the cost column stays empty rather than showing an invented figure.',
                )}
              </p>
            )}
            {phrasesNonChiffrables(
              causes.detail ? causes : { nonChiffrables: causes.nonChiffrables },
              'campagnes-affichees',
              (n) => fmtNum(n, locale),
            ).map((ph) => (
              <p key={ph.fr} data-testid="cout-non-chiffrables">{t(ph.fr, ph.en)}</p>
            ))}
            {/* ⚠️ LES DEUX RÉSERVES SONT AFFICHÉES, PAS CACHÉES DANS UNE INFOBULLE. Elles disent quand le
                chiffre des clics est structurellement bas, et quelqu'un qui compare deux campagnes sans
                les connaître conclurait de travers. */}
            <p data-testid="cout-reserves">
              {t(
                'Deux réserves sur les clics : un template approuvé avant le 2026-09-02 porte une adresse figée chez Meta sans jeton, aucun de ses clics ne remonte ; et deux campagnes qui envoient la même adresse au même contact partagent le compteur, l’attribution tranche alors par proximité de temps.',
                'Two caveats on clicks: a template approved before 2026-09-02 carries a frozen address at Meta with no token, so none of its clicks are reported; and two campaigns sending the same address to the same contact share the counter, attribution then goes by time proximity.',
              )}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function Ligne({ l, devise, locale, t }: { l: LigneCoutCampagne; devise: string | null; locale: Locale; t: (fr: string, en?: string) => string }) {
  /**
   * Pourquoi cette case est vide, en une phrase, au survol. Le tiret seul dirait « rien » là où la vérité
   * est « on ne peut pas répondre », et ces deux-là ne se déduisent pas d'un tableau.
   */
  const raisonClics = l.template === null
    ? t('Campagne à scénario : elle n’envoie pas de template, donc aucun lien tracé.', 'Scenario campaign: it sends no template, hence no tracked link.')
    : t('Ce template ne porte aucun lien tracé.', 'This template carries no tracked link.');

  return (
    <tr className="border-b border-ink-50" data-testid={`cout-ligne-${l.campaignId}`}>
      {/* Tronqué : dans une demi-largeur, un nom de campagne long poussait les quatre colonnes de chiffres
          hors du cadre à lui tout seul. Le nom complet reste au survol, il n'est pas perdu. */}
      <td className={`${TD} max-w-[11rem] truncate font-medium text-ink-900`} title={l.nom}>{l.nom}</td>
      <td className={`${TD} text-right tabular-nums`}>{fmtNum(l.envoyes, locale)}</td>
      <td className={`${TD} text-right tabular-nums`} data-testid={`cout-montant-${l.campaignId}`}>
        {l.cout === null
          ? <Vide titre={t('Aucun envoi chiffrable : tarif Meta indisponible, ou catégorie inconnue.', 'No priceable send: Meta rate unavailable, or unknown category.')} />
          : fmtCost(l.cout, locale, devise)}
      </td>
      <td className={`${TD} text-right tabular-nums`} data-testid={`cout-clics-${l.campaignId}`}>
        {l.clics === null
          ? <span className="text-ink-300" title={raisonClics}>{t('sans lien tracé', 'no tracked link')}</span>
          : fmtNum(l.clics, locale)}
      </td>
      <td className={`${TD} text-right tabular-nums`} data-testid={`cout-ratio-${l.campaignId}`}>
        {l.coutParClic === null
          ? <Vide titre={t('Il manque un des deux termes, ou aucun clic n’a été mesuré.', 'One of the two terms is missing, or no click was measured.')} />
          : fmtCost(l.coutParClic, locale, devise)}
      </td>
    </tr>
  );
}

/** Une case sans réponse. Le titre porte la raison : un tiret nu se lit « zéro » à la deuxième lecture. */
function Vide({ titre }: { titre: string }) {
  return <span className="text-ink-300" title={titre}>—</span>;
}

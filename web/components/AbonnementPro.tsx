'use client';

import { useEffect, useState } from 'react';
import { Bouton } from '@/components/Bouton';
import { useConfirmation } from '@/components/Confirmation';
import { useT, useLocale } from '@/lib/i18n';
import { erreurDeChargement } from '@/lib/http';
import { lireTarifPro, portailPro, resilierPro, type TarifPro } from '@/lib/api/offre';
import { relireOffre } from '@/lib/use-offre';
import type { StatutAbonnementPro, VueOffre } from '@/lib/offre';

/**
 * L'ABONNEMENT PRO DIT EN CLAIR (2026-10-26, demande de Julien : « super clair sur quand l'abonnement commence, quand il
 * s'arrête, son statut »). En tête de l'onglet Offre : le statut, la formule et son prix, la souscription, le prochain
 * renouvellement ou la fin, l'essai ; puis « Résilier », « Annuler la résiliation » et « Changer de carte bancaire ».
 *
 * 🔴 LE STATUT ET LES DATES VIENNENT DU SERVEUR (`VueOffre.abonnement`, `statutDuPro`), jamais recalculés ici.
 * ⚠️ LE MONTANT DU PROCHAIN PRÉLÈVEMENT N'EST PAS ANNONCÉ : un code promo le rendrait faux. La formule dit son prix HT,
 * les factures disent ce qui a été payé.
 * 🔴 RÉSILIER SE CONFIRME, avec la date exacte de fin et ce que devient le numéro fourni ; annuler la résiliation, non
 * (le geste ne retire rien). Après l'un ou l'autre, la vue est relue (`relireOffre`) : la suite du numéro en dépend aussi.
 */
export function AbonnementPro({ tenantId, vue }: { tenantId: string; vue: VueOffre & { abonnement: NonNullable<VueOffre['abonnement']> } }) {
  const t = useT();
  const { locale } = useLocale();
  const confirmer = useConfirmation();
  const a = vue.abonnement;
  const [geste, setGeste] = useState<'resilier' | 'reprendre' | 'carte' | null>(null);
  // Le tarif réel de l'abonné, lu chez Stripe (2026-10-26) : `undefined` tant qu'il n'est pas lu (aucun montant affiché,
  // pour ne pas montrer un instant celui de la grille), `null` s'il est illisible (la grille sert).
  const [tarif, setTarif] = useState<TarifPro | null | undefined>(undefined);
  const vivantPro = a.statut !== 'termine';
  useEffect(() => {
    if (!vivantPro) return;
    let actif = true;
    lireTarifPro(tenantId).then((r) => { if (actif) setTarif(r); }).catch(() => { if (actif) setTarif(null); });
    return () => { actif = false; };
  }, [tenantId, vivantPro]);
  const [erreur, setErreur] = useState<string | null>(null);

  const date = (iso: string): string => new Date(iso).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const euros = (centimes: number): string => `${(centimes / 100).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { maximumFractionDigits: 2 })} €`;

  const STATUTS: Record<StatutAbonnementPro, { libelle: string; classes: string }> = {
    actif: { libelle: t('Actif', 'Active'), classes: 'bg-succes-50 text-succes-700' },
    essai: { libelle: t('Essai gratuit', 'Free trial'), classes: 'bg-brand-50 text-brand-700' },
    en_retard: { libelle: t('Paiement en retard', 'Payment overdue'), classes: 'bg-danger-50 text-danger-700' },
    resiliation_programmee: { libelle: t('Résiliation programmée', 'Cancellation scheduled'), classes: 'bg-alerte-50 text-alerte-700' },
    termine: { libelle: t('Terminé', 'Ended'), classes: 'bg-ink-100 text-ink-700' },
  };
  const statut = STATUTS[a.statut];
  const vivant = a.statut !== 'termine';

  // La formule et son prix HT ; les utilisateurs payés en plus, s'il y en a, à leur prix de la même formule.
  // Le prix de l'abonné d'abord (Stripe), celui de la grille à défaut : ils diffèrent le jour où le tarif change.
  const prixGrille = vue.prixPro ? (a.periodicite === 'an' ? vue.prixPro.anCentimes : vue.prixPro.moisCentimes) : null;
  const prix = tarif === undefined && vivantPro ? null : (tarif?.proHtCentimes ?? prixGrille);
  const formule = a.periodicite === 'an'
    ? (prix === null ? t('Annuel', 'Yearly') : t(`Annuel, ${euros(prix)} HT par an`, `Yearly, ${euros(prix)} excl. VAT a year`))
    : (prix === null ? t('Mensuel', 'Monthly') : t(`Mensuel, ${euros(prix)} HT par mois`, `Monthly, ${euros(prix)} excl. VAT a month`));
  const achetes = vue.sieges?.achetes ?? 0;
  const prixSiegeGrille = vue.prixSiege ? (a.periodicite === 'an' ? vue.prixSiege.anCentimes : vue.prixSiege.moisCentimes) : null;
  const prixSiege = tarif === undefined && vivantPro ? null : (tarif?.siegeHtCentimes ?? prixSiegeGrille);
  const remise = tarif?.remise === true
    ? t(' (une remise s’applique : vos factures disent le montant payé)', ' (a discount applies: your invoices show the amount paid)')
    : '';
  const sieges = achetes > 0
    ? (prixSiege === null
      ? t(`, plus ${achetes} utilisateur${achetes > 1 ? 's' : ''} payé${achetes > 1 ? 's' : ''} en plus`, `, plus ${achetes} paid extra user${achetes > 1 ? 's' : ''}`)
      : t(`, plus ${achetes} utilisateur${achetes > 1 ? 's' : ''} à ${euros(prixSiege)} HT`, `, plus ${achetes} user${achetes > 1 ? 's' : ''} at ${euros(prixSiege)} excl. VAT`))
    : '';

  // La fin si l'on résiliait maintenant : celle de l'essai qui court, sinon celle de la période payée.
  const finSiResiliation = a.essaiFinLe ?? a.prochaineEcheanceLe;

  async function resilier(): Promise<void> {
    const quand = finSiResiliation
      ? t(`jusqu’au ${date(finSiResiliation)}`, `until ${date(finSiResiliation)}`)
      : t('jusqu’à la fin de la période en cours', 'until the end of the current period');
    const numero = vue.suiteDuNumero === null
      ? ''
      : vue.suiteDuNumero.rendreNumero
        ? t('\n\nVotre numéro WhatsApp fourni sera alors rendu : ses envois seront coupés, puis il sera libéré 7 jours après.',
          '\n\nYour provided WhatsApp number will then be given back: its sending stops, and it is released 7 days later.')
        : t('\n\nVotre numéro WhatsApp fourni passera alors à 3,50 € HT par mois, sur la même carte. Vous pouvez aussi choisir de le rendre, plus bas sur cette page.',
          '\n\nYour provided WhatsApp number will then cost €3.50 excl. VAT a month, on the same card. You can also choose to give it back, further down this page.');
    const essai = a.essaiFinLe ? t(' Vous ne serez pas prélevé.', ' You will not be charged.') : t(' Rien n’est remboursé.', ' Nothing is refunded.');
    const ok = await confirmer({
      titre: t('Résilier votre abonnement Pro', 'Cancel your Pro subscription'),
      message: t(
        `Votre Pro reste ouvert ${quand} : vous gardez tout jusque-là.${essai} Ensuite, votre espace repasse en Free.${numero}\n\nVous pourrez annuler cette résiliation jusqu’à cette date.`,
        `Your Pro plan stays open ${quand}: you keep everything until then.${essai} After that, your workspace goes back to Free.${numero}\n\nYou can cancel this cancellation until that date.`,
      ),
      confirmer: t('Résilier', 'Cancel subscription'),
    });
    if (!ok) return;
    await changer(true);
  }

  async function changer(resilier: boolean): Promise<void> {
    setGeste(resilier ? 'resilier' : 'reprendre');
    setErreur(null);
    try {
      await resilierPro(tenantId, resilier);
      await relireOffre(tenantId);
    } catch (err) {
      setErreur(erreurDeChargement(err, t));
    } finally {
      setGeste(null);
    }
  }

  async function carte(): Promise<void> {
    setGeste('carte');
    setErreur(null);
    try {
      window.location.assign((await portailPro(tenantId)).url);
    } catch (err) {
      setGeste(null);
      setErreur(erreurDeChargement(err, t));
    }
  }

  const lignes: Array<{ cle: string; libelle: string; valeur: string }> = [
    { cle: 'formule', libelle: t('Formule', 'Billing'), valeur: `${formule}${sieges}${remise}` },
    { cle: 'debut', libelle: t('Souscrit le', 'Started on'), valeur: date(a.debutLe) },
  ];
  if (a.essaiFinLe) lignes.push({ cle: 'essai', libelle: t('Essai gratuit', 'Free trial'), valeur: t(`jusqu’au ${date(a.essaiFinLe)}`, `until ${date(a.essaiFinLe)}`) });
  if (a.prochaineEcheanceLe) {
    lignes.push(a.essaiFinLe
      ? { cle: 'echeance', libelle: t('Premier paiement', 'First payment'), valeur: date(a.prochaineEcheanceLe) }
      : { cle: 'echeance', libelle: t('Prochain renouvellement', 'Next renewal'), valeur: date(a.prochaineEcheanceLe) });
  }
  if (a.finPrevueLe) lignes.push({ cle: 'fin', libelle: t('Fin de l’abonnement', 'Subscription ends'), valeur: date(a.finPrevueLe) });
  else if (vivant) {
    lignes.push({
      cle: 'fin', libelle: t('Fin de l’abonnement', 'Subscription ends'),
      valeur: a.periodicite === 'an'
        ? t('aucune : il se renouvelle chaque année tant que vous ne le résiliez pas', 'none: it renews every year until you cancel it')
        : t('aucune : il se renouvelle chaque mois tant que vous ne le résiliez pas', 'none: it renews every month until you cancel it'),
    });
  }
  if (a.finiLe) {
    lignes.push({
      cle: 'fini', libelle: t('Terminé le', 'Ended on'),
      valeur: a.finRaison === 'impaye' ? t(`${date(a.finiLe)}, faute de paiement`, `${date(a.finiLe)}, for non-payment`) : date(a.finiLe),
    });
  }

  return (
    <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-abonnement-pro" data-statut={a.statut}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-ink-900">
          {vivant ? t('Votre abonnement Pro', 'Your Pro subscription') : t('Votre ancien abonnement Pro', 'Your former Pro subscription')}
        </h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statut.classes}`} data-testid="offre-abonnement-statut">{statut.libelle}</span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {lignes.map((l) => (
          <div key={l.cle} className="contents" data-testid={`offre-abonnement-${l.cle}`}>
            <dt className="text-ink-500">{l.libelle}</dt>
            <dd className="text-ink-900">{l.valeur}</dd>
          </div>
        ))}
      </dl>

      {a.statut === 'en_retard' && (
        <p className="mt-3 text-sm text-danger" data-testid="offre-abonnement-retard">
          {t('Le dernier paiement n’est pas passé. Stripe va retenter le prélèvement : mettez à jour votre carte bancaire pour garder le Pro.',
            'The last payment did not go through. Stripe retries: update your card to keep Pro.')}
        </p>
      )}
      {a.statut === 'resiliation_programmee' && a.finPrevueLe && (
        <p className="mt-3 text-sm text-ink-700" data-testid="offre-abonnement-resilie">
          {t(`Votre Pro reste ouvert jusqu’au ${date(a.finPrevueLe)}, puis votre espace repasse en Free. Vous pouvez encore annuler la résiliation.`,
            `Your Pro plan stays open until ${date(a.finPrevueLe)}, then your workspace goes back to Free. You can still cancel the cancellation.`)}
        </p>
      )}
      {a.statut === 'essai' && a.essaiFinLe && (
        <p className="mt-3 text-sm text-ink-700" data-testid="offre-essai-fin">
          {t(`Votre essai du Pro se termine le ${date(a.essaiFinLe)} : sans résiliation, le premier paiement a lieu ce jour-là.`,
            `Your Pro trial ends on ${date(a.essaiFinLe)}: unless you cancel, the first payment happens that day.`)}
        </p>
      )}

      {vivant && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {a.finPrevueLe === null ? (
            <Bouton variante="secondaire" onClick={() => void resilier()} enCours={geste === 'resilier'} disabled={geste !== null} data-testid="offre-resilier">
              {t('Résilier mon abonnement', 'Cancel my subscription')}
            </Bouton>
          ) : (
            <Bouton onClick={() => void changer(false)} enCours={geste === 'reprendre'} disabled={geste !== null} data-testid="offre-reprendre">
              {t('Annuler la résiliation', 'Keep my subscription')}
            </Bouton>
          )}
          <Bouton variante={a.statut === 'en_retard' ? 'principal' : 'secondaire'} onClick={() => void carte()} enCours={geste === 'carte'} disabled={geste !== null} data-testid="offre-portail">
            {t('Changer de carte bancaire', 'Change card')}
          </Bouton>
        </div>
      )}
      {vivant && (
        <p className="mt-2 text-xs text-ink-500">
          {t('La carte se change sur la page sécurisée de Stripe. Vos factures sont plus bas sur cette page.',
            'The card is changed on Stripe’s secure page. Your invoices are further down this page.')}
        </p>
      )}
      {erreur && <p className="mt-2 text-sm text-danger" data-testid="offre-abonnement-erreur">{erreur}</p>}
    </section>
  );
}

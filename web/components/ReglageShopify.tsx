'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { useConfirmation } from '@/components/Confirmation';
import { routeInconnue } from '@/lib/canaux-services';
import { couperShopify, lireShopify, type EtatShopifyVue } from '@/lib/api-shopify';
import { EVENEMENTS_SHOPIFY, LIBELLES_EVENEMENTS, type EvenementShopify } from '@/lib/partage/shopify-messages';
import { delaiEnClair, etatDuMessage, type EtatMessage } from '@/lib/shopify-assistant';
import { fmtMontant } from '@/lib/ventes';
import { ShopifyBrancher } from '@/components/ShopifyBrancher';
import { ShopifyAssistant } from '@/components/ShopifyAssistant';
import { ShopifyImport } from '@/components/ShopifyImport';

/**
 * TOOLS > INTÉGRATIONS > SHOPIFY : brancher la boutique, régler ses trois messages, importer ses clients abonnés,
 * couper (conception 2026-10-22, maquette validée par Julien). Sans boutique, le mode opératoire chez Shopify puis les
 * clés (`ShopifyBrancher`) ; avec, chaque message et son assistant (`ShopifyAssistant`). Claude Code fait la même
 * chose par la skill `shopify` du plugin : les deux passent par la même gestion côté serveur.
 *
 * 🔴 UNE INTÉGRATION NEUVE NE S'AFFICHE PAS AVANT SON API, comme Salesforce : tant que la route n'existe pas (404 du
 * routeur), la carte n'est pas rendue.
 *
 * ⚠️ ADMIN SEULEMENT : la carte ne vit que dans la page des administrateurs, et ses routes sont sous `g.admin`.
 */

/** Le montant récupéré, par devise et jamais additionné, précédé de `avant` ; rien quand aucun panier n'a été récupéré. */
function montantsRecuperes(vue: EtatShopifyVue, locale: string, avant: string): string {
  const m = vue.paniers.montantsRecuperes;
  return m.length === 0 ? '' : avant + m.map((x) => fmtMontant(x.montant, x.devise, locale)).join(' · ');
}

const ETATS: Record<EtatMessage, readonly [string, string]> = {
  a_regler: ['pas encore réglé', 'not set up yet'],
  en_validation: ['en validation chez Meta', 'awaiting Meta’s approval'],
  actif: ['actif', 'active'],
  actif_nouvelle_version: ['actif, nouvelle version en validation chez Meta', 'active, new version awaiting Meta’s approval'],
  arrete: ['arrêté', 'stopped'],
  arrete_nouvelle_version: ['arrêté, nouvelle version en validation chez Meta', 'stopped, new version awaiting Meta’s approval'],
};
const GESTE: Record<EtatMessage, readonly [string, string]> = {
  a_regler: ['Mettre en place', 'Set up'],
  en_validation: ['Voir', 'View'],
  actif: ['Modifier', 'Edit'],
  actif_nouvelle_version: ['Voir', 'View'],
  arrete: ['Modifier', 'Edit'],
  arrete_nouvelle_version: ['Voir', 'View'],
};

const ISSUES: Record<string, [string, string]> = {
  envoye: ['envoyés', 'sent'],
  desabonne: ['écartés : le client a dit STOP', 'left out: the customer said STOP'],
  sans_consentement: ['écartés : sans consentement', 'left out: no consent'],
  limite_contacts: ['non partis : limite de contacts de l’offre', 'not sent: plan contact limit'],
  limite_modeles: ['non partis : modèles du mois épuisés', 'not sent: monthly templates used up'],
  sans_telephone: ['sans téléphone', 'without phone'],
  donnee_manquante: ['non partis : une donnée du modèle manque', 'not sent: a template value is missing'],
  modele_refuse: ['non partis : modèle refusé par Meta', 'not sent: template refused by Meta'],
  numero_indisponible: ['non partis : numéro indisponible', 'not sent: number unavailable'],
  bloque: ['écartés : contact bloqué', 'left out: blocked contact'],
  refuse: ['refusés', 'refused'],
};

export function ReglageShopify({ tenantId }: { tenantId: string }) {
  const t = useT();
  const confirmer = useConfirmation();
  const [vue, setVue] = useState<EtatShopifyVue | null>(null);
  const [lecture, setLecture] = useState<'en_cours' | 'ok' | 'absente' | 'echec'>('en_cours');
  const [enCours, setEnCours] = useState(false);
  const [message, setMessage] = useState<{ genre: 'ok' | 'erreur'; texte: string } | null>(null);
  const [assistant, setAssistant] = useState<EvenementShopify | null>(null);
  const [importOuvert, setImportOuvert] = useState(false);

  const recharger = useCallback(() => lireShopify(tenantId)
    .then((v) => { setVue(v); setLecture(v ? 'ok' : 'absente'); })
    .catch((e: unknown) => setLecture(routeInconnue(e) ? 'absente' : 'echec')), [tenantId]);

  useEffect(() => { void recharger(); }, [recharger]);
  // La page d'aide publique renvoie ici par `#integration-shopify` ; la carte n'existe qu'après sa propre lecture.
  useEffect(() => {
    if (lecture !== 'en_cours' && window.location.hash === '#integration-shopify') document.getElementById('integration-shopify')?.scrollIntoView();
  }, [lecture]);
  // Un message en validation chez Meta s'active seul : la carte se relit tant qu'il y en a un, pour le montrer.
  const enValidation = (vue?.attentes.length ?? 0) > 0;
  useEffect(() => {
    if (!enValidation) return;
    const minuterie = setInterval(() => { void recharger(); }, 30_000);
    return () => clearInterval(minuterie);
  }, [enValidation, recharger]);

  const couper = async (): Promise<void> => {
    if (!(await confirmer({
      titre: t('Couper la boutique Shopify', 'Cut the Shopify store'),
      message: t(
        'Plus aucun message de commande ne partira. L’app reste installée sur votre boutique : désinstallez-la depuis la page des apps de la boutique. Vous pourrez la rebrancher ici ou depuis Claude Code.',
        'No order message will go out anymore. The app stays installed on your store: uninstall it from the store apps page. You can reconnect it here or from Claude Code.',
      ),
      confirmer: t('Couper', 'Cut'),
    }))) return;
    setEnCours(true);
    setMessage(null);
    try {
      await couperShopify(tenantId);
      setMessage({ genre: 'ok', texte: t('Boutique coupée : plus aucun message ne part.', 'Store cut: no message goes out anymore.') });
      await recharger();
    } catch (e: unknown) {
      setMessage({ genre: 'erreur', texte: e instanceof Error ? e.message : t('Coupure impossible', 'Unable to cut') });
    } finally {
      setEnCours(false);
    }
  };

  /** Après l'assistant ou l'import : la fenêtre se ferme, la carte se relit et dit ce qui s'est passé. */
  const fini = async (bilan: string): Promise<void> => {
    setAssistant(null);
    setImportOuvert(false);
    setMessage({ genre: 'ok', texte: bilan });
    await recharger();
  };
  const branchee = async (texte: string): Promise<void> => {
    setMessage({ genre: 'ok', texte });
    await recharger();
  };

  if (lecture === 'en_cours' || lecture === 'absente') return null;
  const b = vue?.boutique ?? null;
  const compteurs = Object.entries(vue?.compteurs ?? {}).filter(([, n]) => n > 0);

  return (
    <section id="integration-shopify" className={cardCls} data-testid="integration-shopify">
      <h3 className="text-sm font-semibold text-ink-900">Shopify</h3>
      {lecture === 'echec' && <p className="mt-1 text-sm text-danger">{t('La lecture a échoué : rechargez la page.', 'The read failed: reload the page.')}</p>}
      {lecture === 'ok' && b === null && (
        <>
          <p className="mt-1 text-sm text-ink-500" data-testid="integration-shopify-vide">
            {t(
              'Vos clients reçoivent sur WhatsApp la confirmation de leur commande, son expédition, et une relance s’ils abandonnent leur panier.',
              'Your customers get on WhatsApp their order confirmation, its shipping, and a reminder if they abandon their checkout.',
            )}
          </p>
          <ShopifyBrancher tenantId={tenantId} onBranche={() => branchee(t('Boutique branchée : réglez maintenant ses messages.', 'Store connected: now set up its messages.'))} />
        </>
      )}
      {b !== null && (
        <div className="mt-1 space-y-3 text-sm">
          <p className="text-ink-500" data-testid="integration-shopify-etat">
            {b.etat === 'connectee'
              ? t(`Boutique ${b.nom ?? b.domaine} branchée (${b.domaine}).`, `Store ${b.nom ?? b.domaine} connected (${b.domaine}).`)
              : t(`Boutique ${b.domaine} coupée : plus aucun message ne part.`, `Store ${b.domaine} cut: no message goes out anymore.`)}
            {b.dernierEvenementLe && ` ${t('Dernier événement reçu', 'Last event received')} : ${new Date(b.dernierEvenementLe).toLocaleString()}.`}
          </p>
          {b.etat === 'coupee' && b.origine === 'claude_code' && (
            <p className="text-ink-500">
              {t(
                'Branchée par Claude Code : rebranchez-la depuis Claude Code, ou ici avec les clés de son app (elle reste alors branchée par Claude Code).',
                'Connected by Claude Code: reconnect it from Claude Code, or here with its app’s keys (it then stays connected by Claude Code).',
              )}
            </p>
          )}
          {/* Rebrancher : une boutique coupée, ou une boutique de la console dont l'abonnement des événements a échoué
              (le refus le dit au branchement ; relu plus tard, la carte la montre branchée : relecture du lot 3). */}
          {(b.etat === 'coupee' || b.origine === 'console') && (
            <ShopifyBrancher tenantId={tenantId} rebrancher onBranche={() => branchee(t('Boutique rebranchée.', 'Store reconnected.'))} />
          )}
          {b.etat === 'connectee' && (
            <ul className="divide-y divide-ink-100 rounded-controle border border-ink-200" data-testid="integration-shopify-messages">
              {EVENEMENTS_SHOPIFY.map((e) => {
                const etat = etatDuMessage(vue!, e);
                const actif = etat === 'actif' || etat === 'actif_nouvelle_version';
                return (
                  <li key={e} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid={`integration-shopify-message-${e}`}>
                    <span className="text-ink-900">
                      {t(...LIBELLES_EVENEMENTS[e])}
                      <span className={actif ? 'ml-2 font-medium text-succes-700' : 'ml-2 text-ink-500'}>{t(...ETATS[etat])}</span>
                      {e === 'checkout_abandoned' && actif && (
                        <span className="ml-2 text-ink-500">
                          {t(`(${delaiEnClair(b.delaiPanierMinutes ?? 60)} après le panier)`, `(${delaiEnClair(b.delaiPanierMinutes ?? 60)} after the checkout)`)}
                        </span>
                      )}
                    </span>
                    <Bouton
                      type="button" taille="petite" variante={etat === 'a_regler' ? 'principal' : 'secondaire'}
                      onClick={() => setAssistant(e)} data-testid={`integration-shopify-regler-${e}`}
                    >
                      {t(...GESTE[etat])}
                    </Bouton>
                  </li>
                );
              })}
            </ul>
          )}
          {['actif', 'actif_nouvelle_version'].includes(etatDuMessage(vue!, 'checkout_abandoned')) && (
            <p className="text-ink-500" data-testid="integration-shopify-paniers">
              {t(
                `Paniers abandonnés : relance ${b.delaiPanierMinutes ?? 60} min après la dernière modification. Sur 7 jours, ${Object.values(vue!.paniers.relances).reduce((s, n) => s + n, 0)} relancés (${vue!.paniers.relances.envoye ?? 0} partis), ${vue!.paniers.fermesATemps} devenus une commande à temps, ${vue!.paniers.enAttente} en attente.`,
                `Abandoned checkouts: reminder ${b.delaiPanierMinutes ?? 60} min after the last change. Over 7 days, ${Object.values(vue!.paniers.relances).reduce((s, n) => s + n, 0)} reminded (${vue!.paniers.relances.envoye ?? 0} sent), ${vue!.paniers.fermesATemps} turned into an order in time, ${vue!.paniers.enAttente} waiting.`,
              )}
              {/* Le chiffre d'affaires attribué (plan 2026-10-30) : relances parties et récupérés comptés sur la MÊME date,
                  celle de la relance, pour qu'ils se comparent ; les commandes de test ne comptent pas. */}
              {' '}
              {t(
                `Selon la date de la relance : ${vue!.paniers.relancesParties} relances parties, ${vue!.paniers.recuperes} récupérés${montantsRecuperes(vue!, 'fr', ' pour ')}${vue!.paniers.recuperesTest > 0 ? `, et ${vue!.paniers.recuperesTest} de test, non comptés` : ''}.`,
                `By reminder date: ${vue!.paniers.relancesParties} reminders sent, ${vue!.paniers.recuperes} recovered${montantsRecuperes(vue!, 'en', ' for ')}${vue!.paniers.recuperesTest > 0 ? `, plus ${vue!.paniers.recuperesTest} recovered in test, not counted` : ''}.`,
              )}
            </p>
          )}
          {b.etat === 'connectee' && (
            <p className="flex flex-wrap items-center gap-2 text-ink-900">
              {t('Vos clients abonnés à votre marketing dans Shopify peuvent entrer dans vos contacts.', 'Your customers subscribed to your marketing in Shopify can join your contacts.')}
              <Bouton type="button" taille="petite" variante="secondaire" onClick={() => setImportOuvert(true)} data-testid="integration-shopify-importer">{t('Importer', 'Import')}</Bouton>
            </p>
          )}
          {b.origine === 'console' && (
            <p className="text-ink-500" data-testid="integration-shopify-rgpd">
              {t(
                'Branchée depuis la console, la boutique ne nous transmet pas les demandes d’effacement de vos clients : quand Shopify vous en transmet une, supprimez vous-même la fiche du client dans Contacts.',
                'Connected from the console, the store does not forward your customers’ erasure requests to us: when Shopify forwards one to you, delete the customer’s record yourself in Contacts.',
              )}
            </p>
          )}
          {compteurs.length > 0 && (
            <ul className="space-y-0.5 text-ink-500" data-testid="integration-shopify-compteurs">
              <li className="font-medium text-ink-900">{t('Les 30 derniers jours', 'The last 30 days')}</li>
              {compteurs.map(([issue, n]) => <li key={issue}>{n} {t(...(ISSUES[issue] ?? [issue, issue]))}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {b.etat === 'connectee' && (
              <Bouton type="button" variante="secondaire" onClick={() => void couper()} disabled={enCours} enCours={enCours} data-testid="integration-shopify-couper">
                {t('Couper', 'Cut')}
              </Bouton>
            )}
            {vue!.pageApps && (
              <a href={vue!.pageApps} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">
                {t('La page des apps de la boutique', 'The store apps page')}
              </a>
            )}
          </div>
        </div>
      )}
      {message && <p className={`mt-3 text-sm ${message.genre === 'ok' ? 'text-ink-900' : 'text-danger'}`} data-testid="integration-shopify-message">{message.texte}</p>}
      {assistant !== null && vue !== null && (
        <ShopifyAssistant tenantId={tenantId} evenement={assistant} vue={vue} onClose={() => setAssistant(null)} onFini={fini} />
      )}
      {importOuvert && <ShopifyImport tenantId={tenantId} onClose={() => setImportOuvert(false)} onFini={fini} />}
    </section>
  );
}

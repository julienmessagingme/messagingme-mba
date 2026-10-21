'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { useConfirmation } from '@/components/Confirmation';
import { routeInconnue } from '@/lib/canaux-services';
import { couperShopify, lireShopify, type EtatShopifyVue } from '@/lib/api-shopify';

/**
 * PARAMÈTRES > INTÉGRATIONS > SHOPIFY (plan 2026-10-21, lot 1) : une carte en lecture et « Couper » (décision de Julien).
 * Brancher la boutique et ses messages se fait depuis Claude Code (la skill `shopify` du plugin Messaging Me).
 *
 * 🔴 UNE INTÉGRATION NEUVE NE S'AFFICHE PAS AVANT SON API, comme Salesforce : tant que la route n'existe pas (404 du
 * routeur), la carte n'est pas rendue.
 *
 * ⚠️ ADMIN SEULEMENT : la carte ne vit que dans la page des administrateurs, et ses routes sont sous `g.admin`.
 */

const EVENEMENTS: Record<string, [string, string]> = {
  order_paid: ['Commande payée', 'Order paid'],
  order_fulfilled: ['Commande expédiée', 'Order shipped'],
  checkout_abandoned: ['Panier abandonné', 'Abandoned checkout'],
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

  const recharger = useCallback(() => lireShopify(tenantId)
    .then((v) => { setVue(v); setLecture(v ? 'ok' : 'absente'); })
    .catch((e: unknown) => setLecture(routeInconnue(e) ? 'absente' : 'echec')), [tenantId]);

  useEffect(() => { void recharger(); }, [recharger]);

  const couper = async (): Promise<void> => {
    if (!(await confirmer({
      titre: t('Couper la boutique Shopify', 'Cut the Shopify store'),
      message: t(
        'Plus aucun message de commande ne partira. L’app reste installée sur votre boutique : désinstallez-la depuis la page des apps de la boutique. Vous pourrez la rebrancher depuis Claude Code.',
        'No order message will go out anymore. The app stays installed on your store: uninstall it from the store apps page. You can reconnect it from Claude Code.',
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

  if (lecture === 'en_cours' || lecture === 'absente') return null;
  const b = vue?.boutique ?? null;
  const compteurs = Object.entries(vue?.compteurs ?? {}).filter(([, n]) => n > 0);

  return (
    <section id="integration-shopify" className={cardCls} data-testid="integration-shopify">
      <h3 className="text-sm font-semibold text-ink-900">Shopify</h3>
      {lecture === 'echec' && <p className="mt-1 text-sm text-danger">{t('La lecture a échoué : rechargez la page.', 'The read failed: reload the page.')}</p>}
      {lecture === 'ok' && b === null && (
        <p className="mt-1 text-sm text-ink-500" data-testid="integration-shopify-vide">
          {t(
            'Aucune boutique branchée. Depuis Claude Code, avec le plugin Messaging Me, demandez « branche ma boutique Shopify » : vos clients recevront leurs confirmations de commande et d’expédition sur WhatsApp.',
            'No store connected. From Claude Code, with the Messaging Me plugin, ask “connect my Shopify store”: your customers will get their order and shipping confirmations on WhatsApp.',
          )}
        </p>
      )}
      {b !== null && (
        <div className="mt-1 space-y-3 text-sm">
          <p className="text-ink-500" data-testid="integration-shopify-etat">
            {b.etat === 'connectee'
              ? t(`Boutique ${b.nom ?? b.domaine} branchée (${b.domaine}).`, `Store ${b.nom ?? b.domaine} connected (${b.domaine}).`)
              : t(`Boutique ${b.domaine} coupée : plus aucun message ne part.`, `Store ${b.domaine} cut: no message goes out anymore.`)}
            {b.dernierEvenementLe && ` ${t('Dernier événement reçu', 'Last event received')} : ${new Date(b.dernierEvenementLe).toLocaleString()}.`}
          </p>
          {vue!.messages.length > 0 && (
            <ul className="space-y-1" data-testid="integration-shopify-messages">
              {vue!.messages.map((m) => (
                <li key={m.evenement} className="text-ink-900">
                  {t(...(EVENEMENTS[m.evenement] ?? [m.evenement, m.evenement]))} : {m.modele} ({m.langue})
                  {!m.actif && <span className="text-ink-500"> {t('(arrêté)', '(stopped)')}</span>}
                </li>
              ))}
            </ul>
          )}
          {b.consentementLe && (
            <p className="text-ink-500">
              {t(
                `Vous avez affirmé le ${new Date(b.consentementLe).toLocaleDateString()} que vos clients consentent à recevoir vos messages WhatsApp.`,
                `On ${new Date(b.consentementLe).toLocaleDateString()} you affirmed that your customers agree to receive your WhatsApp messages.`,
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
    </section>
  );
}

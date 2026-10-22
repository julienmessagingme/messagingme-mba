'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Modale } from '@/components/Modale';
import { Bouton } from '@/components/Bouton';
import { apercuClientsShopify, importerClientsShopify, type ApercuClientsShopify } from '@/lib/api-shopify';

/**
 * IMPORTER LES CLIENTS ABONNÉS DE LA BOUTIQUE (lot 3 du connecteur, dans la console depuis la conception du
 * 2026-10-22) : compter d'abord, puis le marchand choisit combien. Mêmes fonctions que `preview_shopify_customers` et
 * `import_shopify_customers` (`src/shopify/gestion.ts`) : les abonnés au marketing seulement, jamais un consentement
 * WhatsApp, une fiche déjà là n'est pas touchée.
 */
export function ShopifyImport({ tenantId, onClose, onFini }: {
  tenantId: string;
  onClose: () => void;
  onFini: (bilan: string) => Promise<void>;
}) {
  const t = useT();
  const [apercu, setApercu] = useState<ApercuClientsShopify | null>(null);
  const [nombre, setNombre] = useState(0);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    apercuClientsShopify(tenantId)
      .then((a) => { if (vivant) { setApercu(a); setNombre(a.importables); } })
      .catch((e: unknown) => { if (vivant) setErreur(e instanceof Error ? e.message : t('Lecture impossible', 'Unable to read')); });
    return () => { vivant = false; };
  }, [tenantId, t]);

  const importer = async (): Promise<void> => {
    setEnCours(true);
    setErreur(null);
    try {
      const r = await importerClientsShopify(tenantId, nombre);
      await onFini(t(
        `${r.importes + r.retablis} clients importés, avec l’étiquette « ${r.etiquette} ».${r.restent > 0 ? ` ${r.restent} restent dans la boutique.` : ''}`,
        `${r.importes + r.retablis} customers imported, tagged “${r.etiquette}”.${r.restent > 0 ? ` ${r.restent} remain in the store.` : ''}`,
      ));
    } catch (e: unknown) {
      setErreur(e instanceof Error ? e.message : t('Import impossible', 'Unable to import'));
    } finally {
      setEnCours(false);
    }
  };

  const valide = apercu !== null && Number.isInteger(nombre) && nombre >= 1 && nombre <= apercu.importables;
  return (
    <Modale
      titre={t('Importer les clients abonnés à votre marketing', 'Import the customers subscribed to your marketing')}
      taille="moyenne"
      testId="shopify-import"
      onClose={onClose}
      pied={apercu !== null && apercu.importables > 0 ? (
        <Bouton type="button" onClick={() => void importer()} enCours={enCours} disabled={enCours || !valide} data-testid="shopify-import-valider">
          {t(`Importer ${valide ? nombre : ''} clients`, `Import ${valide ? nombre : ''} customers`)}
        </Bouton>
      ) : undefined}
    >
      <div className="space-y-3 text-sm">
        {apercu === null && erreur === null && <p className="text-ink-500">{t('Lecture des clients de la boutique…', 'Reading the store customers…')}</p>}
        {apercu !== null && (
          <>
            <ul className="space-y-1 text-ink-900" data-testid="shopify-import-apercu">
              <li>{t(`${apercu.abonnes} clients abonnés à votre marketing (e-mail ou SMS), avec un téléphone`, `${apercu.abonnes} customers subscribed to your marketing (email or SMS), with a phone`)}</li>
              <li className="text-ink-500">{t(`dont ${apercu.dejaDansLEspace} déjà dans vos contacts, laissés tels quels`, `of whom ${apercu.dejaDansLEspace} already in your contacts, left as they are`)}</li>
              <li className="font-medium">{t(`${apercu.nouveaux} nouveaux`, `${apercu.nouveaux} new`)}</li>
              {apercu.sansTelephone > 0 && <li className="text-ink-500">{t(`${apercu.sansTelephone} abonnés sans téléphone, jamais importés`, `${apercu.sansTelephone} subscribers without a phone, never imported`)}</li>}
              {apercu.placesLibres !== null && <li className="text-ink-500">{t(`Votre offre laisse ${apercu.placesLibres} places de contacts.`, `Your plan leaves room for ${apercu.placesLibres} contacts.`)}</li>}
            </ul>
            {!apercu.complet && (
              <p className="text-ink-500">{t('La boutique a beaucoup de clients : seuls les plus récents ont été lus.', 'The store has many customers: only the most recent were read.')}</p>
            )}
            {apercu.importables > 0 ? (
              <label className="block text-ink-900">
                {t(`Combien en importer (jusqu’à ${apercu.importables}) ?`, `How many to import (up to ${apercu.importables})?`)}
                <input
                  type="number" min={1} max={apercu.importables} value={nombre} data-testid="shopify-import-nombre"
                  onChange={(e) => setNombre(Number(e.target.value))} className={`${inputCls} mt-1`}
                />
              </label>
            ) : (
              <p className="text-ink-900">
                {apercu.nouveaux === 0
                  ? t('Aucun nouveau client à importer.', 'No new customer to import.')
                  : t('Votre offre n’a plus de place pour de nouveaux contacts : passez à l’offre supérieure.', 'Your plan has no room left for new contacts: move to a higher plan.')}
              </p>
            )}
            <p className="text-ink-500">
              {t(
                'Ils entrent avec l’étiquette Shopify et sans consentement WhatsApp : un accord pour l’e-mail ou le SMS n’en est pas un, et un contact qui a dit STOP le reste. Un nouvel import prend les suivants, sans doublon.',
                'They come in tagged Shopify and without WhatsApp consent: an email or SMS agreement is not a WhatsApp one, and a contact who said STOP stays opted out. A new import takes the next ones, without duplicates.',
              )}
            </p>
          </>
        )}
        {erreur && <p className="text-danger" data-testid="shopify-import-erreur">{erreur}</p>}
      </div>
    </Modale>
  );
}

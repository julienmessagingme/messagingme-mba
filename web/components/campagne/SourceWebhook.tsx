'use client';

import { useEffect, useState } from 'react';
import { listWebhooks, type CampaignCategory, type WebhookEntrant } from '@/lib/api';
import { inputCls } from '@/lib/ui';

/**
 * LA CAMPAGNE AU FIL DE L'EAU : aucune liste, une ADRESSE.
 *
 * 🔴 CE N'EST PAS UNE QUATRIÈME SOURCE DE CONTACTS, C'EST UNE AUTRE NATURE DE CAMPAGNE. Les trois autres
 * désignent un ensemble figé au lancement ; celle-ci reste OUVERTE et prend chaque contact qui arrive par
 * l'adresse choisie, à partir de son lancement et jamais rétroactivement. Elle naît donc à zéro
 * destinataire, ce qui est son état NORMAL et non un échec : c'est pour ça que la garde « aucun contact
 * sélectionné » ne s'y applique pas (`problemeAvantLancement`).
 *
 * 🔴 IL EST PARTAGÉ PAR LES DEUX ÉCRANS DE CRÉATION, et il l'est parce que ses DEUX avertissements sont
 * la vraie valeur de ce panneau, pas le sélecteur. Une adresse qui n'affirme pas le consentement écarte
 * silencieusement tous ses arrivants d'une campagne marketing ; une adresse qui ne crée pas les contacts
 * inconnus ne touche que ceux qui existent déjà. Les deux se voient AVANT le lancement, et les recopier
 * dans le second écran aurait donné deux jeux de mises en garde à tenir d'accord à la main.
 *
 * ⚠️ LES ADRESSES SE CHARGENT AU MONTAGE, donc à la première ouverture du panneau : la majorité des
 * campagnes ne sont pas au fil de l'eau et n'ont pas à payer cet appel. Revenir sur ce panneau le
 * rejoue, et c'est acceptable : une adresse désactivée entre-temps doit se voir, et l'ancien écran
 * gardait au contraire une liste figée pour toute la vie de la page.
 */
export function SourceWebhook({
  tenantId,
  webhookId,
  onChange,
  category,
}: {
  tenantId: string;
  webhookId: string;
  onChange: (id: string) => void;
  /** La nature de la campagne : seule une campagne `marketing` exige le consentement des arrivants. */
  category: CampaignCategory;
}) {
  /** `null` = pas encore chargées, ce qui n'est PAS la même chose que « aucune adresse ». */
  const [webhooks, setWebhooks] = useState<WebhookEntrant[] | null>(null);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let vivant = true;
    void (async () => {
      try {
        const { webhooks: liste } = await listWebhooks(tenantId);
        if (!vivant) return;
        // `Array.isArray` : une réponse 200 sans le champ (backend plus ancien, proxy qui rend un objet
        // vide) poserait `undefined` dans un état typé tableau, et le rendu suivant casserait sur `.length`.
        const actives = Array.isArray(liste) ? liste.filter((w) => w.enabled) : [];
        setWebhooks(actives);
        // 🔴 UNE ADRESSE REPRISE D'UN BROUILLON PEUT AVOIR ÉTÉ SUPPRIMÉE OU DÉSACTIVÉE DEPUIS. Le
        // sélecteur l'afficherait alors VIDE pendant que l'état la porte encore, et la campagne partirait
        // sur une adresse morte (400 serveur, au moment du lancement).
        if (webhookId !== '' && !actives.some((w) => w.id === webhookId)) onChange('');
      } catch {
        // Un échec n'est PAS silencieux : sans adresse affichée ET sans message, l'écran laisserait croire
        // qu'il n'y en a aucune, donc qu'il faut aller en créer une.
        if (vivant) { setWebhooks([]); setErreur(true); }
      }
    })();
    return () => { vivant = false; };
    // Une seule lecture par montage : `webhookId` et `onChange` sont lus à l'instant du retour, ils ne
    // sont pas des raisons de relire la liste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const choisi = webhooks?.find((w) => w.id === webhookId) ?? null;

  return (
    <div className="w-full space-y-2" data-testid="source-webhook">
      <p className="text-xs text-ink-500">
        Aucune liste ici : la campagne reste ouverte, et chaque contact qui arrive par cette adresse
        reçoit le message dans la foulée. Elle envoie à partir de son lancement, pas aux contacts déjà
        arrivés avant.
      </p>
      {webhooks === null ? (
        <p className="text-xs text-ink-400">Chargement des adresses...</p>
      ) : erreur ? (
        <p className="rounded-lg bg-danger-50 px-3 py-2 text-xs text-danger-700">
          Impossible de charger les adresses. Réessaie dans un instant.
        </p>
      ) : webhooks.length === 0 ? (
        <p className="rounded-lg bg-alerte-50 px-3 py-2 text-xs text-alerte-800">
          Aucune adresse active. Crée-la dans Tools &gt; Webhooks, puis reviens ici.
        </p>
      ) : (
        <>
          <label className="block text-xs font-medium text-ink-500" htmlFor="campagne-webhook">
            Adresse (Tools &gt; Webhooks)
          </label>
          <select
            id="campagne-webhook"
            value={webhookId}
            onChange={(e) => onChange(e.target.value)}
            data-testid="campaign-webhook-select"
            className={inputCls}
          >
            <option value="">Choisir une adresse...</option>
            {webhooks.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          {/* 🔴 LE CONSENTEMENT EST LA SEULE CONDITION QUI PEUT TOUT ÉCARTER EN SILENCE : une campagne
              marketing n'envoie qu'aux contacts opt-in, et une adresse qui ne l'affirme pas produit des
              arrivants « consentement inconnu ». Ils seront inscrits et marqués écartés, jamais perdus,
              mais autant le dire avant de lancer. */}
          {choisi && category === 'marketing' && !choisi.optIn && (
            <p className="rounded-lg bg-alerte-50 px-3 py-2 text-xs text-alerte-800" data-testid="campaign-webhook-optin">
              Cette adresse n&apos;affirme pas le consentement des contacts qu&apos;elle crée. Sur une
              campagne marketing, ces contacts seront écartés. Coche le consentement dans Tools &gt;
              Webhooks, ou passe la campagne en « Service ».
            </p>
          )}
          {choisi && !choisi.createContact && (
            <p className="rounded-lg bg-alerte-50 px-3 py-2 text-xs text-alerte-800" data-testid="campaign-webhook-creation">
              Cette adresse ne crée pas les contacts inconnus : seuls ceux qui existent déjà dans le CRM
              seront touchés.
            </p>
          )}
        </>
      )}
    </div>
  );
}

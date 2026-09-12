'use client';

import { useEffect, useState } from 'react';
import { countContacts } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { filtresDeLAudience, type AudienceChoix } from '@/lib/campagne-repartition';
import type { EtatCampagne, ReferencesContenu } from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 4 : QUI reçoit.
 *
 * 🔴 ELLE ARRIVE APRÈS LE CONTENU, ET C'EST UN CHOIX ASSUMÉ (décision d'ordre du 2026-09-12). On
 * compose d'abord ce qu'on veut dire, on choisit ensuite à qui : c'est l'ordre naturel d'une campagne,
 * et c'est celui qui évite de figer une audience avant de savoir ce qu'on lui envoie. Le prix de cet
 * ordre est que l'opérateur a réglé son repli sans savoir combien de monde il concerne, et c'est le
 * RÉCAPITULATIF qui le rachète : il montre la répartition, pas un résumé.
 *
 * 🔴 LE COMPTE VIENT DU SERVEUR, PAS D'UNE LISTE RAPATRIÉE. `countContacts` rend un nombre ; charger les
 * contacts pour les compter dans le navigateur est exactement ce que l'audit du 2026-09-02 a fermé
 * (« tout sélectionner » rapatriait jusqu'à 100 000 identifiants, et la création échouait vers 25 000
 * sur le plafond de 1 Mo du corps de requête, BIEN avant la limite annoncée à l'écran).
 *
 * ⚠️ UNE SEULE COLONNE, BLOCS EMPILÉS. Même règle que les étapes 2 et 3 : sur un 13 pouces la console
 * laisse environ 990 px utiles, et une grille qui se réorganise sous un seuil produit précisément les
 * chevauchements que ce lot existe pour empêcher.
 */
export function EtapeAudience({
  tenantId,
  etat,
  references,
  onChange,
}: {
  tenantId: string;
  etat: EtatCampagne;
  references: ReferencesContenu;
  onChange: (patch: Partial<EtatCampagne>) => void;
}) {
  const audience = etat.audience;
  const modifier = (patch: Partial<AudienceChoix>): void => onChange({ audience: { ...audience, ...patch } });

  return (
    <section data-testid="etape-audience" className="w-full">
      <h2 className="text-lg font-semibold text-ink-800">Audience</h2>
      <p className="mt-1 text-sm text-ink-500">
        Les contacts sans consentement marketing et ceux qui sont bloqués sont écartés à la création, quel
        que soit ce choix.
      </p>

      <fieldset data-testid="choix-audience" className="mt-4 w-full rounded-xl border border-ink-200 p-4">
        <legend className="px-1 text-sm font-medium text-ink-700">Destinataires</legend>
        <div className="space-y-2">
          <Radio
            groupe="audience"
            libelle="Tous les contacts"
            coche={audience.mode === 'tous'}
            onCheck={() => modifier({ mode: 'tous' })}
          />
          <Radio
            groupe="audience"
            libelle="Ceux qui portent un de ces tags"
            coche={audience.mode === 'tags'}
            onCheck={() => modifier({ mode: 'tags' })}
          />
        </div>

        {audience.mode === 'tags' && (
          <div className="mt-3 w-full" data-testid="choix-tags">
            {references.tags.length === 0 ? (
              <p className="text-xs text-ink-500">Aucun tag sur cet espace. Posez-en depuis l&apos;onglet Contacts.</p>
            ) : (
              // ⚠️ `flex-wrap` ET `min-w-0` : une liste de tags est de longueur imprévisible, et c'est le seul
              // endroit de l'étape où du contenu du client décide de la largeur. Sans le retour à la ligne,
              // quarante tags poussent le cadre au-delà des 990 px utiles d'un 13 pouces.
              <div className="flex w-full flex-wrap gap-2">
                {references.tags.map((tg) => {
                  const choisi = audience.tags.includes(tg.tag);
                  return (
                    <label
                      key={tg.tag}
                      className={`flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${choisi ? 'border-brand-400 bg-brand-50 text-ink-800' : 'border-ink-200 text-ink-700'}`}
                    >
                      <input
                        type="checkbox"
                        checked={choisi}
                        onChange={() => modifier({
                          tags: choisi ? audience.tags.filter((x) => x !== tg.tag) : [...audience.tags, tg.tag],
                        })}
                        className="h-4 w-4 shrink-0 accent-brand-500"
                      />
                      <span className="truncate">{tg.tag}</span>
                      <span className="shrink-0 text-xs text-ink-400">{fmtNum(tg.count, 'fr')}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </fieldset>

      {/*
        🔴 ELLE CHANGE LE SENS DU RÉCAPITULATIF, d'où sa place ici plutôt qu'à l'étape du canal. Cochée,
        ceux qu'on sait injoignables sortent de l'audience : plus personne ne bascule sur le second étage
        pour ce motif, et le récapitulatif l'affichera à zéro, ce qui sera vrai. Décochée, ils restent et
        c'est le repli qui les rattrape. Les deux sont défendables ; ce qui ne l'est pas, c'est de ne pas
        savoir lequel on a choisi au moment de lire les chiffres.

        ⚠️ UN INCONNU N'EST PAS UN INJOIGNABLE. Le filtre ne retire que ceux qui ont été MESURÉS
        injoignables, et la mesure se périme à 90 jours (`verdictWhatsApp`) : un espace qui démarre n'a
        aucune mesure, donc cette case n'y retire personne.
      */}
      <label className="mt-4 flex w-full items-start gap-2 text-sm text-ink-800">
        <input
          type="checkbox"
          checked={audience.sansInjoignables}
          onChange={(e) => modifier({ sansInjoignables: e.target.checked })}
          data-testid="audience-sans-injoignables"
          className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
        />
        <span className="min-w-0">
          Écarter les contacts qu&apos;on sait injoignables en WhatsApp
          <span className="mt-0.5 block text-xs text-ink-500">
            Seulement ceux dont une tentative a échoué ; un contact jamais sollicité reste dans l&apos;audience.
          </span>
        </span>
      </label>

      <CompteAudience tenantId={tenantId} audience={audience} />
    </section>
  );
}

/**
 * LE NOMBRE DE CONTACTS RETENUS, relu à chaque changement de choix.
 *
 * ⚠️ `vivant` PLUTÔT QU'UN SIGNAL D'ABANDON : deux changements rapides lancent deux requêtes, et rien ne
 * garantit qu'elles reviennent dans l'ordre. Sans ce drapeau, la réponse de l'ancien choix peut arriver
 * après celle du nouveau et afficher un compte qui ne correspond plus à ce qui est coché.
 *
 * ⚠️ UNE LECTURE EN ÉCHEC N'AFFICHE PAS ZÉRO. Zéro est une réponse (« personne ne correspond »), et la
 * confondre avec une panne ferait croire à une audience vide alors que l'écran n'a simplement pas pu
 * compter.
 */
function CompteAudience({ tenantId, audience }: { tenantId: string; audience: AudienceChoix }) {
  const [compte, setCompte] = useState<number | null>(null);
  const [echec, setEchec] = useState(false);

  useEffect(() => {
    let vivant = true;
    setEchec(false);
    setCompte(null);
    void countContacts(tenantId, filtresDeLAudience(audience))
      .then((r) => { if (vivant) setCompte(typeof r?.total === 'number' ? r.total : 0); })
      .catch(() => { if (vivant) setEchec(true); });
    return () => { vivant = false; };
  }, [tenantId, audience]);

  return (
    <p className="mt-4 text-sm text-ink-700" data-testid="audience-compte">
      {echec
        ? <span className="text-gold">Le nombre de contacts n&apos;a pas pu être lu.</span>
        : compte === null
          ? 'Comptage...'
          : <><b>{fmtNum(compte, 'fr')}</b> contacts retenus</>}
    </p>
  );
}

/** Un radio dont le NOM ACCESSIBLE est exactement son libellé (même invariant que les étapes 2 et 3). */
function Radio({
  groupe, libelle, coche, onCheck,
}: { groupe: string; libelle: string; coche: boolean; onCheck: () => void }) {
  return (
    <label className="flex w-full items-center gap-2 text-sm text-ink-800">
      <input
        type="radio"
        name={groupe}
        checked={coche}
        onChange={onCheck}
        className="h-4 w-4 shrink-0 accent-brand-500"
      />
      <span className="min-w-0 break-words">{libelle}</span>
    </label>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { getMbaBusinessInfo, patchMbaBusinessInfo, type MbaBusinessInfo, type MbaBusinessInfoPatch } from '@/lib/api-mba';

/**
 * Informations générales sur l'entreprise : ce que l'agent répond quand on lui demande les horaires, la
 * politique de retour ou comment vous joindre.
 *
 * ⚠️ Côté Meta la ressource est en REMPLACEMENT COMPLET. Notre serveur relit et fusionne, mais seulement sur
 * ce qu'on lui envoie : cet écran n'envoie donc QUE les champs réellement modifiés. Poster le formulaire entier
 * réécrirait des champs que personne n'a touchés, avec la valeur qu'ils avaient au chargement de la page.
 */

const LIMITE_CHAMP = 5000;
const LIMITE_CONTACT = 1000;

type CleTexte = 'description' | 'purchaseInfo' | 'deliveryAndShipping' | 'returnPolicy' | 'paymentMethod';
type CleContact = 'email' | 'hours_of_operation' | 'address';

/** Formulaire à plat : la fusion avec la forme imbriquée de Meta se fait au moment de l'envoi. */
type Formulaire = Record<CleTexte | CleContact, string>;

const VIDE: Formulaire = {
  description: '', purchaseInfo: '', deliveryAndShipping: '', returnPolicy: '', paymentMethod: '',
  email: '', hours_of_operation: '', address: '',
};

function depuisApi(info: MbaBusinessInfo): Formulaire {
  return {
    description: info.business_description ?? '',
    purchaseInfo: info.purchase_info ?? '',
    deliveryAndShipping: info.delivery_and_shipping ?? '',
    returnPolicy: info.return_policy ?? '',
    paymentMethod: info.payment_method ?? '',
    email: info.contact_info?.email ?? '',
    hours_of_operation: info.contact_info?.hours_of_operation ?? '',
    address: info.contact_info?.address ?? '',
  };
}

const CLES_TEXTE: CleTexte[] = ['description', 'purchaseInfo', 'deliveryAndShipping', 'returnPolicy', 'paymentMethod'];
const CLES_CONTACT: CleContact[] = ['email', 'hours_of_operation', 'address'];

/** Ne garde que ce qui a bougé depuis le chargement. Retourne null si rien n'a changé. */
export function differenceBusinessInfo(initial: Formulaire, courant: Formulaire): MbaBusinessInfoPatch | null {
  const patch: MbaBusinessInfoPatch = {};
  for (const k of CLES_TEXTE) if (courant[k] !== initial[k]) patch[k] = courant[k];
  const contact: Record<string, string> = {};
  for (const k of CLES_CONTACT) if (courant[k] !== initial[k]) contact[k] = courant[k];
  if (Object.keys(contact).length > 0) patch.contact = contact;
  return Object.keys(patch).length === 0 ? null : patch;
}

export function MbaBusinessInfoPanel({ tenantId, phoneNumberId }: { tenantId: string; phoneNumberId: string }) {
  const t = useT();
  const [initial, setInitial] = useState<Formulaire>(VIDE);
  const [form, setForm] = useState<Formulaire>(VIDE);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let vivant = true;
    getMbaBusinessInfo(tenantId, phoneNumberId)
      .then((info) => {
        if (!vivant) return;
        const f = depuisApi(info);
        setInitial(f);
        setForm(f);
      })
      .catch((e: unknown) => { if (vivant) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [tenantId, phoneNumberId]);

  const patch = differenceBusinessInfo(initial, form);

  async function enregistrer(): Promise<void> {
    if (patch === null) return;
    setBusy(true);
    setErr('');
    setOk(false);
    try {
      const info = await patchMbaBusinessInfo(tenantId, phoneNumberId, patch);
      // ⚠️ On met à jour la RÉFÉRENCE, pas la saisie. Réécrire `form` depuis la réponse effacerait ce que
      // l'utilisateur a tapé PENDANT que la requête était en vol, en lui annonçant « enregistré » par-dessus.
      // Ce qu'il a continué d'écrire reste à l'écran, et repart au prochain enregistrement.
      setInitial(depuisApi(info));
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const champ = (cle: CleTexte | CleContact, label: string, aide: string, lignes: number, limite: number) => (
    <label className="block" key={cle}>
      <span className="text-sm font-medium text-ink-800">{label}</span>
      <span className="mt-0.5 block text-xs text-ink-500">{aide}</span>
      {lignes > 1 ? (
        <textarea
          className={`${inputCls} mt-1.5`}
          rows={lignes}
          maxLength={limite}
          data-testid={`mba-bi-${cle}`}
          value={form[cle]}
          onChange={(e) => setForm({ ...form, [cle]: e.target.value })}
        />
      ) : (
        <input
          className={`${inputCls} mt-1.5`}
          maxLength={limite}
          data-testid={`mba-bi-${cle}`}
          value={form[cle]}
          onChange={(e) => setForm({ ...form, [cle]: e.target.value })}
        />
      )}
    </label>
  );

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-bi-error">{err}</MbaNotice>}
      {ok && <MbaNotice kind="success" testid="mba-bi-saved">{t('Informations enregistrées.', 'Information saved.')}</MbaNotice>}

      <section className={`${cardCls} space-y-4`}>
        {champ('description', t('Votre activité', 'Your business'), t('En une phrase ou deux, ce que vous faites.', 'In a sentence or two, what you do.'), 3, LIMITE_CHAMP)}
        {champ('purchaseInfo', t('Comment acheter', 'How to buy'), t('Où et comment vos clients achètent.', 'Where and how your customers buy.'), 2, LIMITE_CHAMP)}
        {champ('deliveryAndShipping', t('Livraison', 'Delivery and shipping'), t('Délais, zones, conditions.', 'Times, areas, conditions.'), 2, LIMITE_CHAMP)}
        {champ('returnPolicy', t('Retours', 'Returns'), t('Votre politique de retour et de remboursement.', 'Your return and refund policy.'), 2, LIMITE_CHAMP)}
        {champ('paymentMethod', t('Moyens de paiement', 'Payment methods'), t('Ce que vous acceptez.', 'What you accept.'), 1, LIMITE_CHAMP)}
      </section>

      <section className={`${cardCls} space-y-4`}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Contact', 'Contact')}</h3>
        {champ('email', t('Email', 'Email'), t('L’adresse que l’agent peut donner.', 'The address the agent may give out.'), 1, LIMITE_CONTACT)}
        {champ('hours_of_operation', t('Horaires', 'Opening hours'), t('Tels que vos clients les liraient.', 'As your customers would read them.'), 2, LIMITE_CONTACT)}
        {champ('address', t('Adresse', 'Address'), t('Adresse postale ou lieu principal.', 'Postal address or main location.'), 2, LIMITE_CONTACT)}
      </section>

      <div className="flex items-center gap-3">
        <button
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          data-testid="mba-bi-save"
          disabled={busy || patch === null}
          onClick={() => void enregistrer()}
        >
          {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </button>
        {patch === null && !busy && <span className="text-xs text-ink-500">{t('Rien à enregistrer.', 'Nothing to save.')}</span>}
      </div>
    </div>
  );
}

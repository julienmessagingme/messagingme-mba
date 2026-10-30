'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { lireLignesCreditOps, poserLigneCreditOps, type LigneCreditOps, type VueCreditOps } from '@/lib/api';
import { eurosDepuisMicro } from '@/lib/agent-solde';

/**
 * LES NUMÉROS D'UN ESPACE SUR LA LIGNE DU CRÉDIT WHATSAPP (plan du Crédit WhatsApp, tâche 8), dans la fenêtre de l'offre
 * de `/ops` : poser un numéro d'essai avant l'option du lot 2, ou retirer un numéro. Le serveur lit le numéro dans l'espace
 * et refuse ce que la garde ne saurait pas compter (360dialog, coexistence, délié) ; l'écran affiche son refus tel quel.
 * La section se masque quand l'API n'a pas encore la route.
 */
export function OpsLignesCreditWhatsapp({ jeton, tenantId }: { jeton: string; tenantId: string }) {
  const t = useT();
  const [lignes, setLignes] = useState<LigneCreditOps[] | null>(null);
  const [vue, setVue] = useState<Pick<VueCreditOps, 'soldeMicroEur' | 'provisions'>>({});
  const [absente, setAbsente] = useState(false);
  const [numero, setNumero] = useState('');
  const [note, setNote] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let vivant = true;
    lireLignesCreditOps(jeton, tenantId)
      .then((r) => { if (vivant) lire(r); })
      .catch(() => { if (vivant) setAbsente(true); });
    return () => { vivant = false; };
  }, [jeton, tenantId]);

  const noteValide = note.trim().length >= 3;

  function lire(r: VueCreditOps) {
    setLignes(Array.isArray(r.lignes) ? r.lignes : []);
    setVue({ soldeMicroEur: r.soldeMicroEur, provisions: Array.isArray(r.provisions) ? r.provisions : undefined });
  }

  async function geste(phoneNumberId: string, poser: boolean) {
    setEnvoi(true);
    setMsg(null);
    try {
      const r = await poserLigneCreditOps(jeton, tenantId, phoneNumberId, poser, note.trim());
      lire(r);
      setNote('');
      if (poser) setNumero('');
      setMsg({ kind: 'ok', text: poser ? t('Numéro posé sur la ligne.', 'Number put on the line.') : t('Numéro retiré de la ligne.', 'Number removed from the line.') });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Geste impossible', 'Action failed') });
    } finally {
      setEnvoi(false);
    }
  }

  if (absente) return null;
  return (
    <div className="grid gap-2 border-t border-ink-100 pt-4" data-testid="ligne-credit">
      <p className="font-medium text-ink-900">{t('Crédit WhatsApp : numéros sur la ligne', 'WhatsApp credit: numbers on the line')}</p>
      {lignes === null ? null : lignes.length === 0 ? (
        <p className="text-xs text-ink-500">{t('Aucun numéro sur la ligne.', 'No number on the line.')}</p>
      ) : (
        <ul className="grid gap-1">
          {lignes.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 text-xs text-ink-700">
              <span>
                {l.phoneNumberId} · {l.origine === 'ops' ? t('posé à la main', 'set by hand') : t('option', 'option')}
                {l.arreteeLe !== null ? ` · ${t('envois arrêtés', 'sends stopped')}` : ''}
              </span>
              <Bouton variante="secondaire" taille="petite" disabled={!noteValide || envoi} onClick={() => { void geste(l.phoneNumberId, false); }} data-testid="ligne-credit-retirer">
                {t('Retirer', 'Remove')}
              </Bouton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1">
          <span className="text-xs font-medium text-ink-500">{t('Identifiant Meta du numéro', 'Meta number ID')}</span>
          <input className={`${inputCls} w-48`} inputMode="numeric" value={numero} onChange={(e) => setNumero(e.target.value)} data-testid="ligne-credit-numero" />
        </label>
        <Bouton taille="petite" enCours={envoi} disabled={!/^[0-9]{5,32}$/.test(numero.trim()) || !noteValide || envoi} onClick={() => { void geste(numero.trim(), true); }} data-testid="ligne-credit-poser">
          {t('Poser sur la ligne', 'Put on the line')}
        </Bouton>
      </div>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-ink-500">{t('Note (obligatoire) : pourquoi ce numéro', 'Note (required): why this number')}</span>
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="ligne-credit-note" />
      </label>
      {vue.soldeMicroEur !== undefined && (
        <p className="text-xs text-ink-700" data-testid="ligne-credit-solde">
          {t(`Solde : ${eurosDepuisMicro(vue.soldeMicroEur).toFixed(2)} € HT`, `Balance: €${eurosDepuisMicro(vue.soldeMicroEur).toFixed(2)} excl. VAT`)}
        </p>
      )}
      {vue.provisions && vue.provisions.length > 0 && (
        <table className="w-full text-xs text-ink-700" data-testid="ligne-credit-provisions">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="font-medium">{t('Envoi', 'Sent')}</th>
              <th className="font-medium">{t('Catégorie', 'Category')}</th>
              <th className="font-medium">{t('Pays', 'Country')}</th>
              <th className="text-right font-medium">{t('Montant', 'Amount')}</th>
              <th className="font-medium">{t('État', 'State')}</th>
            </tr>
          </thead>
          <tbody>
            {vue.provisions.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.creeLe).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</td>
                <td>{p.categorie}</td>
                <td>{p.pays ?? '?'}</td>
                <td className="text-right">{(p.montantMicroEur / 1_000_000).toFixed(4)} €</td>
                <td>{p.etat === 'rendu' ? t('rendu', 'refunded') : p.etat === 'ajuste' ? t('corrigé', 'adjusted') : p.livreLe ? t('livré', 'delivered') : t('provisionné', 'reserved')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && (
        <p data-testid="ligne-credit-message" className={`rounded-controle px-3 py-2 text-xs ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>
      )}
    </div>
  );
}

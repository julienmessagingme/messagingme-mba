'use client';

import { useEffect, useState } from 'react';
import { listRcsMessages, sendRcsToConversation, type RcsMessage } from '@/lib/api';
import { versBrouillonRcs } from '@/lib/rcs';
import { versBrouillonCarrousel } from '@/lib/rcs-carrousel';
import { RcsPreview } from '@/components/RcsPreview';
import { RcsCarouselPreview } from '@/components/RcsCarouselPreview';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { RCS_TEXTE_MAX } from '@/lib/rcs-limits';
import { Bouton } from '@/components/Bouton';
import { Modale } from '@/components/Modale';

/**
 * Envoyer un message RCS depuis une conversation.
 *
 * 🔴 Ce panneau existe surtout pour le moment où la fenêtre WhatsApp de 24 h est FERMÉE. Cette fenêtre est une
 * règle de WhatsApp, pas une règle du monde : le RCS n'en a pas, et il devient alors le seul moyen de
 * reprendre contact sans template à faire approuver. Il est donc proposé dans les deux états de la barre de
 * réponse, fenêtre ouverte comme fermée.
 *
 * Deux modes. Un message de la BIBLIOTHÈQUE, comme un template vient de Meta : on ne compose pas une carte,
 * un visuel et des boutons dans une barre de réponse. Ses variables sont résolues côté serveur sur la fiche
 * du contact, donc l'aperçu ci-dessous montre les `{{champ}}` tels quels, pas leur valeur.
 *
 * Ou une RÉPONSE LIBRE, ajoutée le 2026-08-25 : un contact joignable seulement en RCS n'était atteignable
 * qu'à travers la bibliothèque, alors que c'est le canal sur lequel il venait d'écrire. L'opérateur devait
 * créer une entrée de bibliothèque, ou faire approuver un template WhatsApp, pour répondre une phrase.
 * Le texte libre part TEL QUEL : on n'y cherche pas de `{{champ}}`, sinon une accolade tapée par erreur
 * deviendrait un trou dans le message.
 */
export function InboxRcsPanel({
  tenantId, conversationId, onClose, onSent,
}: {
  tenantId: string;
  conversationId: string;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const t = useT();
  const [messages, setMessages] = useState<RcsMessage[]>([]);
  const [selId, setSelId] = useState('');
  const [mode, setMode] = useState<'bibliotheque' | 'libre'>('bibliotheque');
  const [texte, setTexte] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRcsMessages(tenantId)
      .then((r) => setMessages(r.messages))
      .catch(() => setError(t('Chargement des messages RCS impossible', 'Unable to load RCS messages')));
  }, [tenantId, t]);

  const sel = messages.find((m) => m.id === selId);
  const brouillon = sel ? versBrouillonRcs(sel.content) : null;
  // Un carrousel se DESSINE aussi depuis le 2026-09-21 : la bibliothèque sait en composer, et l'opérateur doit
  // voir les cartes qui partiront plutôt qu'un avertissement.
  const carrousel = sel ? versBrouillonCarrousel(sel.content) : null;

  const libre = mode === 'libre';
  const pretAEnvoyer = libre ? texte.trim() !== '' && texte.trim().length <= RCS_TEXTE_MAX : selId !== '';

  async function envoyer() {
    if (!pretAEnvoyer) return;
    setBusy(true);
    setError(null);
    try {
      await sendRcsToConversation(tenantId, conversationId, libre ? { text: texte.trim() } : { rcsMessageId: selId });
      await onSent();
    } catch (e) {
      // Le message vient du serveur et NOMME la cause (canal éteint, contact désabonné) : ces deux-là
      // demandent deux gestes différents, les aplatir en « envoi impossible » ne servirait personne.
      setError(e instanceof Error ? e.message : t('Envoi impossible', 'Failed to send'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modale titre={t('Envoyer un message RCS', 'Send an RCS message')} testId="inbox-rcs-panel" onClose={onClose}>
      <p className="mt-1 text-xs text-ink-500">
        {t('Sous votre agent de marque, sans template à faire approuver et sans fenêtre de 24 h.', 'Under your brand agent, with no template to get approved and no 24h window.')}
      </p>

      <div className="mt-3 flex gap-1 rounded-controle bg-ink-50 p-1" role="group">
        {([['bibliotheque', t('Message enregistré', 'Saved message')], ['libre', t('Réponse libre', 'Free-form reply')]] as const).map(([v, libelle]) => (
          <button
            key={v}
            onClick={() => setMode(v)}
            data-testid={`inbox-rcs-mode-${v}`}
            className={`flex-1 rounded-controle px-2 py-1 text-xs font-medium transition-colors duration-150 ${mode === v ? 'bg-white text-ink-900' : 'text-ink-500 hover:text-ink-900'}`}
          >
            {libelle}
          </button>
        ))}
      </div>

      {libre ? (
        <div className="mt-3">
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Votre réponse', 'Your reply')}</label>
          <textarea
            value={texte}
            onChange={(e) => setTexte(e.target.value)}
            rows={4}
            data-testid="inbox-rcs-texte"
            placeholder={t('Écrivez votre réponse…', 'Write your reply…')}
            className={inputCls}
          />
          <p className="mt-1 text-xs text-ink-500">
            {t('Part tel quel sous votre agent de marque. ', 'Sent as-is under your brand agent. ')}
            {texte.trim().length}/{RCS_TEXTE_MAX}
          </p>
        </div>
      ) : (
      <div className="mt-3">
        <label className="mb-1 block text-sm font-medium text-ink-900">{t('Message enregistré', 'Saved message')}</label>
        {messages.length === 0 ? (
          <p className="text-xs text-alerte-700">
            {t('Aucun message RCS enregistré : créez-en un dans Contenu > Messages RCS.', 'No saved RCS message: create one in Content > RCS messages.')}
          </p>
        ) : (
          <select value={selId} onChange={(e) => setSelId(e.target.value)} data-testid="inbox-rcs-select" className={inputCls}>
            <option value="" disabled>{t('Choisir…', 'Choose…')}</option>
            {messages.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
      </div>

      )}

      {sel && !libre && (
        <div className="mt-3">
          {brouillon || carrousel ? (
            <>
              {brouillon ? <RcsPreview brouillon={brouillon} /> : carrousel && <RcsCarouselPreview brouillon={carrousel} />}
              <p className="mt-1 text-xs text-ink-500">
                {t('Les variables {{champ}} seront remplacées par la fiche de ce contact à l’envoi.', 'The {{field}} variables will be filled in from this contact at send time.')}
              </p>
            </>
          ) : sel.content === null ? (
            // ⚠️ LE SERVEUR REFUSE CET ENVOI (« son format n'est plus reconnu ») : annoncer qu'il partira serait
            // une promesse fausse, et c'est ce que ce panneau disait jusqu'au 2026-09-21.
            <p className="text-xs text-alerte-700" data-testid="inbox-rcs-illisible">
              {t('Ce message n’est plus lisible : son format n’est plus reconnu, il ne peut pas partir. Refaites-le dans Contenu > Messages RCS.', 'This message is no longer readable: its format is not recognised, it cannot be sent. Rebuild it in Content > RCS messages.')}
            </p>
          ) : (
            <p className="text-xs text-alerte-700">
              {t('Ce message a un format que l’aperçu ne sait pas dessiner (carte à titre). Il partira tel qu’il a été enregistré.', 'This message has a format the preview cannot draw (titled card). It will go out as saved.')}
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="inbox-rcs-error">{error}</p>}

      <div className="mt-4 flex gap-2">
        <Bouton variante="secondaire" onClick={onClose} className="flex-1">
          {t('Annuler', 'Cancel')}
        </Bouton>
        <Bouton enCours={busy}
          onClick={() => void envoyer()}
          disabled={busy || !pretAEnvoyer}
          data-testid="inbox-rcs-send"
          className="flex-1"
        >
          {busy ? t('Envoi...', 'Sending...') : t('Envoyer en RCS', 'Send over RCS')}
        </Bouton>
      </div>
    </Modale>
  );
}

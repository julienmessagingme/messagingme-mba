import { uploadRcsMedia, type RcsMedia } from '@/lib/api';

/**
 * DÉPOSER UN FICHIER DANS LA MÉDIATHÈQUE, et rendre son adresse. Deux appelants : le champ d'image partagé
 * (`ChampImageHebergee`) et le bouton « Ajouter un fichier » de la page Médiathèque (2026-10-30). Une seule lecture et un
 * seul envoi : recopiés, l'un aurait fini par envoyer autre chose que l'autre pour le même fichier.
 *
 * Le fichier part en data URL base64 : le serveur relit sa SIGNATURE (un `.png` renommé est refusé) et c'est le type réel
 * qui décide de l'extension de l'adresse rendue. Les refus d'avant l'envoi (type, poids) se lisent avant d'appeler ceci,
 * par `refusAvantEnvoi` (`lib/champ-fichier.ts`), selon ce que l'appelant accepte.
 */
export async function deposerDansLaMediatheque(tenantId: string, fichier: File): Promise<{ media: RcsMedia; url: string; existant?: boolean }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(String(lecteur.result ?? ''));
    lecteur.onerror = () => reject(new Error('lecture impossible'));
    lecteur.readAsDataURL(fichier);
  });
  return uploadRcsMedia(tenantId, dataUrl, fichier.name);
}

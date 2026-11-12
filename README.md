# NeoPaperless

Gestionnaire de documents moderne et auto-hébergé (factures, bulletins de paie, notices…), inspiré de paperless-ngx.
React + TailwindCSS + SQLite, responsive et installable en PWA. Aucune ressource chargée depuis un CDN tiers : polices, pdf.js et icônes sont embarqués.

## Fonctionnalités

- **Premier lancement** : création du compte administrateur depuis l'interface (aucun code à chercher dans les logs).
- **Ajout** par glisser-déposer ou bouton (plusieurs fichiers à la fois, progression, détection des doublons).
- **Recherche plein texte** dans le contenu des PDF (`pdftotext`) et des images (OCR `tesseract` si installé), avec mise en évidence des passages et insensible aux accents (SQLite FTS5).
- **Lecteur PDF** intégré (pdf.js, fonctionne aussi sur mobile), aperçus en miniature.
- **Classement** par dossiers en arborescence, tags colorés sur chaque document, date et notes.
- **Téléchargement et partage** par lien public révocable, avec expiration optionnelle.
- **Sauvegarde / restauration** complète (base SQLite + fichiers) en une archive `.tar.gz`.
- **Mises à jour** : migrations de schéma automatiques au démarrage.
  - **Debian** : automatiques. Un timer systemd (`neopaperless-update.timer`, chaque nuit vers 3 h 30) télécharge le `.deb` de la dernière release pour l'architecture de la machine, vérifie sa somme SHA-256 (`SHA256SUMS` de la release), copie la base dans `/var/lib/neopaperless/backups/avant-<version>.db` (3 conservées) puis lance `apt-get install`. Le bouton « Installer maintenant » des Paramètres passe par `neopaperless-update.path` (le service web n'a aucun droit root). Désactivation : case à cocher dans les Paramètres, ou `systemctl disable --now neopaperless-update.timer`. Journal : `journalctl -u neopaperless-update`. Prérequis : le `DATA_DIR` par défaut (`/var/lib/neopaperless`). La première installation de cette fonction se fait à la main (`apt install ./neopaperless_*.deb`), les suivantes sont automatiques.
  - **Docker** : `docker compose pull && docker compose up -d` (un conteneur ne peut pas se remplacer lui-même).

## Compatibilité Paperless-ngx

L'API sous `/api/` reprend celle de Paperless-ngx : des applications comme Swift Paperless peuvent s'y connecter avec l'URL du serveur, l'identifiant et le mot de passe (`POST /api/token/`, puis `Authorization: Token …`).

- Documents (liste, filtres, recherche, envoi, modification, téléchargement, miniatures) et tags : équivalents directs.
- **Dossiers** = « chemins de stockage » (`Maison/Factures`) ; un dossier parent inclut ses sous-dossiers. Renommer depuis l'app ne déplace pas le dossier.
- **Gérés** : correspondants, types de document, numéro d'archivage (ASN), notes, **champs personnalisés** (valeurs, filtres `custom_fields__id__*`, `custom_field_query`, tri `custom_field_<id>`, `bulk_edit modify_custom_fields`), **vues enregistrées**, **règles de correspondance automatique** (`match` / `matching_algorithm` 1 à 5, appliquées à l'envoi ; `suggestions/`), date `modified`, `documents/next_asn/`, `/api/status/`, `/api/`.
- **Non gérés** : corbeille (la suppression est définitive, `trash` est vide), historique des modifications, algorithme « auto » (6, classifieur), groupes et permissions par objet (champs `owner`/`set_permissions` ignorés), comptes et règles de mail, workflows, `bulk_download`, `reprocess`.
- **Jetons** : *Paramètres → Jetons d'API* crée des jetons nommés et révocables (affichés une seule fois). `POST /api/profile/generate_auth_token/` fonctionne aussi. Les en-têtes CORS sont ouverts sur `/api/` (authentification par `Authorization` uniquement).
- **Liens de partage** : `POST /api/share_links/` → lien public `/share/<slug>`.
- **Obsidian** : les plugins communautaires pour Paperless-ngx (*Paperless*, *Paperless Storage*, *Paperless Sync*) se configurent avec l'URL du serveur et un jeton. Non testés ici.
- L'API propre à l'interface web est sous `/api/np/`.

## Développement

Prérequis : Node.js ≥ 22.13 (pour `node:sqlite`), `poppler-utils`, et éventuellement `tesseract-ocr`.

```sh
npm install
npm run dev      # API sur :3001, interface Vite sur :5173
npm test         # tests de l'API
npm run build && npm start   # production sur http://localhost:3001
```

Variables d'environnement : `PORT` (3001), `HOST`, `DATA_DIR` (`./data`), `OCR_LANG` (`fra+eng`), `TRUST_PROXY` (`1` derrière un reverse proxy), `UPDATE_URL`, `PUBLIC_URL` (URL absolue des liens de pagination de l'API, si le proxy ne transmet pas l'hôte).

## Paquets Debian (amd64 / arm64)

```sh
npm run deb                          # les deux architectures
bash packaging/build-deb.sh arm64    # une seule
sudo apt install ./build/neopaperless_0.1.0_amd64.deb
```

Le paquet embarque Node.js (Debian ne fournit pas une version assez récente), crée l'utilisateur système `neopaperless`, stocke les données dans `/var/lib/neopaperless` et lance le service systemd `neopaperless`. Configuration : `/etc/default/neopaperless`.
Mise à jour : installer le nouveau `.deb` par-dessus, le service redémarre et la base est migrée. Les données sont conservées même en cas de purge.

## Docker

```sh
docker compose up -d --build
# image multi-arch
docker buildx build --platform linux/amd64,linux/arm64 -t neopaperless:latest .
```

Les données sont dans le volume `./data`. Mise à jour : `docker compose pull && docker compose up -d` (ou `--build`).

## HTTPS

Pour l'installation en PWA et la copie des liens de partage dans le presse-papiers, les navigateurs exigent HTTPS : placez le serveur derrière un reverse proxy (Caddy, nginx) et mettez `TRUST_PROXY=1`.

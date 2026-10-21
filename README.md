# NeoPaperless

Gestionnaire de documents moderne et auto-hébergé (factures, bulletins de paie, notices…), inspiré de paperless-ngx.
React + TailwindCSS + SQLite, responsive et installable en PWA. Aucune ressource chargée depuis un CDN tiers : polices, pdf.js et icônes sont embarqués.

## Fonctionnalités

- **Premier lancement** : création du compte administrateur depuis l'interface (aucun code à chercher dans les logs).
- **Ajout** par glisser-déposer ou bouton (plusieurs fichiers à la fois, progression, détection des doublons).
- **Recherche plein texte** dans le contenu des PDF (`pdftotext`) et des images (OCR `tesseract` si installé), avec mise en évidence des passages et insensible aux accents (SQLite FTS5).
- **Lecteur PDF** intégré (pdf.js, fonctionne aussi sur mobile), aperçus en miniature.
- **Classement** par tags colorés, date du document et notes.
- **Téléchargement et partage** par lien public révocable, avec expiration optionnelle.
- **Sauvegarde / restauration** complète (base SQLite + fichiers) en une archive `.tar.gz`.
- **Mises à jour** : vérification de nouvelle version depuis les paramètres ; migrations de schéma automatiques au démarrage.

## Développement

Prérequis : Node.js ≥ 22.13 (pour `node:sqlite`), `poppler-utils`, et éventuellement `tesseract-ocr`.

```sh
npm install
npm run dev      # API sur :3001, interface Vite sur :5173
npm test         # tests de l'API
npm run build && npm start   # production sur http://localhost:3001
```

Variables d'environnement : `PORT` (3001), `HOST`, `DATA_DIR` (`./data`), `OCR_LANG` (`fra+eng`), `TRUST_PROXY` (`1` derrière un reverse proxy), `UPDATE_URL`.

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

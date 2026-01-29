# Fonts pour l'extension RL4 Snapshot

Ce dossier contient les polices de caractères utilisées par l'extension.

## Fonts requises

L'extension utilise deux polices principales :

1. **Geist** (prioritaire) — https://vercel.com/font
2. **Inter** (fallback) — https://rsms.me/inter/

## Installation

### Option 1 : Télécharger depuis les sites officiels

1. **Geist** :
   - Aller sur https://vercel.com/font
   - Télécharger le package complet
   - Extraire les fichiers `.woff2` pour les poids : Regular (400), Medium (500), SemiBold (600)
   - Renommer en : `Geist-Regular.woff2`, `Geist-Medium.woff2`, `Geist-SemiBold.woff2`

2. **Inter** :
   - Aller sur https://rsms.me/inter/
   - Télécharger le package
   - Extraire les fichiers `.woff2` pour les mêmes poids
   - Renommer en : `Inter-Regular.woff2`, `Inter-Medium.woff2`, `Inter-SemiBold.woff2`

### Option 2 : Utiliser Google Fonts Helper

1. Aller sur https://gwfh.mranftl.com/fonts
2. Rechercher "Geist" et "Inter"
3. Sélectionner les poids : 400, 500, 600
4. Télécharger les fichiers `.woff2`
5. Placer les fichiers dans ce dossier avec les noms exacts ci-dessus

## Structure attendue

```
fonts/
├── Geist-Regular.woff2
├── Geist-Medium.woff2
├── Geist-SemiBold.woff2
├── Inter-Regular.woff2
├── Inter-Medium.woff2
├── Inter-SemiBold.woff2
└── README.md (ce fichier)
```

## Note

Si les fonts ne sont pas présentes, l'extension utilisera automatiquement les polices système (fallback) :
- `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Roboto`, `sans-serif`

Les fonts locales améliorent la cohérence visuelle mais ne sont pas obligatoires pour le fonctionnement de l'extension.

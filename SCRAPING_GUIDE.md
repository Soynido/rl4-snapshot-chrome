# 🔍 Guide de Scraping Complet - RL4 Extension

## Problème : L'extension ne capture qu'un seul message

Si tu vois `total_messages: 1` dans ton snapshot, utilise ce guide pour extraire **TOUTE** la conversation.

---

## 🚀 Méthode 1 : Script Forensic (RECOMMANDÉ)

### Étapes :

1. **Ouvre la page partagée Claude.ai**
   - Exemple : `https://claude.ai/share/c61ff0f2-6511-4d93-b03e-9d2bb222c1fe`

2. **Ouvre la Console DevTools**
   - Appuie sur `F12` ou `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows/Linux)
   - Va dans l'onglet **Console**

3. **Colle le script complet**
   - Ouvre le fichier `forensic-scraper.js`
   - Copie **TOUT** le contenu
   - Colle-le dans la console
   - Appuie sur **Entrée**

4. **Récupère le JSON**
   - Le script va automatiquement copier le JSON dans ton presse-papier
   - Si ça ne marche pas, le JSON sera affiché dans la console (copie-le manuellement)

5. **Utilise le JSON**
   - Colle-le dans un fichier `.json`
   - Ou envoie-le directement pour générer un snapshot RL4

---

## 🔧 Méthode 2 : Inspection Réseau (Manuel)

### Étapes :

1. **Ouvre DevTools** → Onglet **Network** (Réseau)

2. **Recharge la page** (`Cmd+R` / `Ctrl+R`)

3. **Cherche les requêtes API**
   - Filtre par `XHR` ou `Fetch`
   - Cherche des URLs contenant :
     - `/api/chat_snapshots/`
     - `/api/shares/`
     - `/backend-api/`

4. **Clique sur la requête** → Onglet **Response**
   - Copie le JSON complet

5. **Extrais les messages**
   - Le JSON contient généralement un array `messages` ou `chat_messages`
   - Chaque message a `role` (`user`/`assistant`) et `content`

---

## 🛠️ Méthode 3 : Application Tab (IndexedDB)

### Étapes :

1. **Ouvre DevTools** → Onglet **Application** (ou **Stockage**)

2. **IndexedDB** → Cherche des bases de données Claude.ai
   - Nom typique : `claude-*` ou `anthropic-*`

3. **Explore les stores**
   - Cherche des stores contenant `messages`, `conversations`, `chat`

4. **Exporte les données**
   - Clic droit → Export ou copie manuelle

---

## 📋 Format de Sortie Attendu

Le script forensic génère un JSON avec cette structure :

```json
{
  "share_id": "c61ff0f2-6511-4d93-b03e-9d2bb222c1fe",
  "url": "https://claude.ai/share/...",
  "extracted_at": "2026-01-06T21:46:29.078Z",
  "extraction_method": "api",
  "successful_endpoint": "/api/chat_snapshots/...",
  "total_messages": 42,
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "Premier message...",
      "timestamp": "2026-01-06T..."
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "content": "Réponse de Claude...",
      "timestamp": "2026-01-06T..."
    }
  ]
}
```

---

## ⚠️ Dépannage

### Le script ne trouve aucun message

1. **Vérifie que tu es sur une page `/share/`**
   - L'URL doit contenir `/share/` suivi d'un UUID

2. **Vérifie la console pour les erreurs**
   - Le script affiche des logs détaillés
   - Cherche les messages `[RL4]`

3. **Essaie de recharger la page**
   - Parfois le contenu n'est pas encore chargé

4. **Vérifie les permissions**
   - Le script doit pouvoir faire des `fetch()` vers `claude.ai/api/`

### Le script trouve des messages mais l'extension ne les capture pas

1. **Recharge l'extension**
   - Va dans `chrome://extensions/`
   - Clique sur "Recharger" sur l'extension RL4

2. **Recharge la page Claude.ai**
   - `Cmd+R` / `Ctrl+R`

3. **Vérifie les logs de l'extension**
   - Ouvre la Console DevTools
   - Cherche les messages `[RL4]`

4. **Utilise le script forensic directement**
   - C'est la méthode la plus fiable pour extraire toute la conversation

---

## 🎯 Prochaines Étapes

Une fois que tu as le JSON complet :

1. **Génère un snapshot RL4**
   - Utilise le JSON pour créer un snapshot structuré
   - Le snapshot inclura `topics`, `decisions`, `insights`, `checksum`

2. **Réinjecte dans Claude**
   - Colle le snapshot dans une nouvelle conversation
   - Claude pourra reconstruire toute la cognition/mémoire

3. **Partage le snapshot**
   - Le snapshot est portable et vérifiable (checksum SHA-256)
   - Tu peux le partager avec d'autres LLMs (OpenAI, Perplexity, etc.)

---

## 📞 Support

Si rien ne fonctionne :

1. Partage le JSON de sortie du script forensic
2. Partage les logs de la console (`[RL4]`)
3. Partage l'URL de la page partagée


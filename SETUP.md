# 🤖 CryptoBot AI — Guide de mise en route

## Étape 1 : Base de données (Neon Postgres — Gratuit)

1. Va sur [neon.tech](https://neon.tech) → créer un compte gratuit
2. Crée un nouveau projet → copie l'URL de connexion (format: `postgresql://user:pass@host/db`)
3. Mets cette URL dans `.env.local` → `DATABASE_URL=...`

## Étape 2 : OpenAI API

1. Va sur [platform.openai.com](https://platform.openai.com)
2. Crée une clé API → copie-la dans `OPENAI_API_KEY`
3. Prévoie ~5-10€/mois pour GPT-4o-mini + quelques appels GPT-4o

## Étape 3 : CoinGecko API (Gratuit)

1. Va sur [coingecko.com/en/api](https://www.coingecko.com/en/api) → "Get Demo API Key" (gratuit)
2. Copie la clé dans `COINGECKO_API_KEY`

## Étape 4 : Sources d'actualités

Le bot utilise des **flux RSS gratuits** par défaut (aucune clé requise) :
- CoinDesk, CoinTelegraph, Decrypt, Bitcoin Magazine, The Block, CryptoSlate

**NewsAPI (optionnel)** — plan gratuit = 100 requêtes/jour
1. Va sur [newsapi.org/register](https://newsapi.org/register)
2. Récupère ta clé → `NEWSAPI_KEY` dans `.env.local`
3. Si vide, le bot tourne uniquement sur RSS — c'est suffisant

## Étape 5 : Telegram Bot

1. Ouvre Telegram → cherche `@BotFather`
2. Tape `/newbot` → suis les instructions → copie le token dans `TELEGRAM_BOT_TOKEN`
3. Pour obtenir ton Chat ID :
   - Démarre une conversation avec ton bot
   - Va sur `https://api.telegram.org/bot<TON_TOKEN>/getUpdates`
   - Copie le `"id"` dans le champ `message.chat.id` → `TELEGRAM_CHAT_ID`

## Étape 6 : Initialiser la base de données

Une fois les variables d'environnement renseignées, appelle :
```
GET /api/init
```
(en local : http://localhost:3000/api/init)

## Étape 7 : Déployer sur Vercel

1. Installe Vercel CLI : `npm i -g vercel`
2. Depuis le dossier du projet : `vercel`
3. Suis les instructions
4. Dans le dashboard Vercel → Settings → Environment Variables → ajoute toutes les variables de `.env.local`
5. Les Cron Jobs se configurent automatiquement via `vercel.json` :
   - Analyse du marché : toutes les 4 heures
   - Rapport Telegram : tous les jours à 18h

## Étape 8 : Tester en local

```bash
npm run dev
```
Ouvre http://localhost:3000

Pour déclencher manuellement une analyse :
- Clique "Analyser" dans le dashboard, OU
- `GET /api/cron/analyze`

## Variables d'environnement complètes

```env
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://...
COINGECKO_API_KEY=CG-...
CRYPTOPANIC_API_KEY=...  (optionnel)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
CRON_SECRET=un_secret_aleatoire_ici
TRADING_MODE=paper
INITIAL_PORTFOLIO_EUR=5000
RISK_LEVEL=moderate
NEXT_PUBLIC_APP_URL=https://ton-app.vercel.app
```

## Architecture des Cron Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| `/api/cron/analyze` | Toutes les 4h | Analyse IA + trades |
| `/api/cron/daily-report` | 18h chaque jour | Rapport Telegram |

## Passer en mode réel (plus tard)

1. Change `TRADING_MODE=live` dans les env vars Vercel
2. Ajoute tes clés Coinbase et Kraken
3. Le bot utilisera les vraies APIs d'exchange

⚠️ **Teste TOUJOURS en mode paper en premier !**

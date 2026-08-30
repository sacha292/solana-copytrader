# solana-copytrader

Bot de copy trading Solana en **portefeuille virtuel** (aucun fonds réel engagé).
Il tourne tout seul toutes les 10 minutes sur GitHub Actions — rien à installer,
rien à lancer sur ton ordinateur.

## Ajouter un wallet à suivre

1. Ouvre [`watchlist.json`](watchlist.json) sur github.com et clique le **crayon** (✏️) en haut à droite.
2. Ajoute une entrée : `{ "address": "ADRESSE_DU_WALLET", "label": "Nom court", "lastSignature": null }`
3. Clique **Commit changes** — le prochain run du bot le prend en compte automatiquement.

`lastSignature: null` signifie « je viens d'ajouter ce wallet » : le premier run
enregistre juste sa transaction la plus récente comme point de départ et ne
rejoue **pas** son historique. Les trades sont copiés à partir du run suivant.

## Dashboard

Le tableau de bord (valeur totale, cash, P&L, positions, journal des trades) est
publié via GitHub Pages et se met à jour tout seul après chaque run.

## Comment le bot décide de copier un trade

Pour chaque nouvelle transaction d'un wallet suivi, il calcule ce que le wallet a
gagné ou perdu (SOL natif + tokens SPL), puis :

| Situation | Décision |
|---|---|
| Un actif de base dépensé, un token non-base reçu | **ACHAT** copié |
| Un token non-base dépensé, un actif de base reçu | **VENTE** copiée |
| Swap token↔token, ou simple transfert | ignoré |

Les actifs de base sont SOL, USDC et USDT. Une variation de SOL natif de moins de
0.005 est ignorée : c'est du bruit de frais de transaction.

## Réglages — [`settings.json`](settings.json)

| Clé | Défaut | Effet |
|---|---|---|
| `positionSizePct` | `10` | % du cash disponible dépensé à chaque achat |
| `sellAll` | `true` | Vendre 100 % de la position. Si `false`, ne vend que `positionSizePct` % |
| `signatureLimit` | `15` | Nb max de transactions examinées par wallet et par run |
| `rpcUrl` | RPC public Solana | À remplacer par un endpoint dédié si tu vois des erreurs 429 |

Modifiable de la même façon : crayon sur github.com → Commit.

## Fichiers

| Fichier | Rôle |
|---|---|
| `bot.py` | Le bot. Seule dépendance : `requests` |
| `watchlist.json` | Wallets suivis + curseur de dernière signature vue |
| `portfolio.json` | Cash, positions, journal des trades — réécrit par le bot |
| `settings.json` | Réglages |
| `index.html` | Dashboard lecture seule |
| `.github/workflows/copytrade.yml` | Planification toutes les 10 min + lancement manuel |

## Lancer un run à la main

Onglet **Actions** → workflow **copytrade** → **Run workflow**.

## Limites connues

- Le RPC public Solana est fortement limité en débit. Le bot temporise et réessaie,
  mais si un wallet est très actif, mets un endpoint dédié dans `rpcUrl`.
- GitHub planifie les runs `cron` au mieux : sous forte charge, un run peut être
  retardé de plusieurs minutes ou sauté. Le curseur `lastSignature` fait que rien
  n'est perdu, seulement décalé.
- Le journal est plafonné à 500 trades pour éviter que le dépôt ne gonfle sans fin.
- Prix d'exécution = prix spot Jupiter au moment du run, sans slippage ni frais.
  Les résultats sont donc plus optimistes que la réalité.
- Chaque trade est valorisé au prix spot **du moment du run**, pas au prix qu'avait
  le token quand le wallet a réellement tradé. Conséquence : si un wallet achète
  *et* revend le même token entre deux runs, les deux jambes sortent au même prix
  et le P&L est de 0. Le P&L n'est significatif que lorsque l'achat et la vente
  tombent dans des runs différents — ce qui est le cas courant.
- L'horodatage « màj » du dashboard n'avance que quand quelque chose a réellement
  bougé (trade copié ou valeur d'une position modifiée). Sinon le bot ne commit
  rien, pour éviter ~144 commits vides par jour. Pour vérifier qu'il tourne bien,
  regarde l'onglet **Actions**.

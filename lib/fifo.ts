// FIFO comptable partagé : P&L réalisé par trade et par symbole.
// Convention (identique partout) :
// - BUY : lot {qty, coût unitaire = total_eur / amount} (total = réellement débité, frais inclus)
// - SELL : net unitaire = total_eur / amount (total = net reçu, frais déduits).
//   On dépile les lots les plus anciens ; les ventes sans lot connu
//   (position pré-existante hors historique) donnent un réalisé de 0.

export interface FifoTrade {
  symbol: string;
  action: string;
  amount: number;
  total_eur: number;
}

interface Lot {
  qty: number;
  unitCost: number;
}

export interface FifoSymbolStats {
  buys: number;
  sells: number;
  volume_eur: number;
  fees_eur: number;
  realized_eur: number;
}

export function computeFifo(
  trades: Array<FifoTrade & { fee_eur?: number }>,
): { perTradeRealized: Array<number | null>; perSymbol: Record<string, FifoSymbolStats> } {
  const lots: Record<string, Lot[]> = {};
  const perSymbol: Record<string, FifoSymbolStats> = {};
  const perTradeRealized: Array<number | null> = [];

  const touch = (s: string): FifoSymbolStats =>
    (perSymbol[s] ??= { buys: 0, sells: 0, volume_eur: 0, fees_eur: 0, realized_eur: 0 });

  for (const t of trades) {
    const sym = String(t.symbol);
    const qty = Number(t.amount) || 0;
    const total = Number(t.total_eur) || 0;
    const fee = Number(t.fee_eur ?? 0) || 0;
    if (!(qty > 0)) {
      perTradeRealized.push(null);
      continue;
    }
    const st = touch(sym);
    st.fees_eur += fee;
    if (String(t.action) === 'BUY') {
      st.buys += 1;
      st.volume_eur += total;
      (lots[sym] ??= []).push({ qty, unitCost: total / qty });
      perTradeRealized.push(null);
    } else if (String(t.action) === 'SELL') {
      st.sells += 1;
      const netPerUnit = total / qty;
      let remaining = qty;
      let realized = 0;
      const queue = lots[sym] ?? [];
      while (remaining > 1e-12 && queue.length > 0) {
        const lot = queue[0];
        const matched = Math.min(lot.qty, remaining);
        realized += matched * (netPerUnit - lot.unitCost);
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty <= 1e-12) queue.shift();
      }
      st.realized_eur += realized;
      perTradeRealized.push(Number(realized.toFixed(2)));
    } else {
      perTradeRealized.push(null);
    }
  }

  for (const st of Object.values(perSymbol)) {
    st.volume_eur = Number(st.volume_eur.toFixed(2));
    st.fees_eur = Number(st.fees_eur.toFixed(2));
    st.realized_eur = Number(st.realized_eur.toFixed(2));
  }

  return { perTradeRealized, perSymbol };
}

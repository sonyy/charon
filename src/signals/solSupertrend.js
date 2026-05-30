import { ATR } from 'technicalindicators';

const BINANCE_URL = 'https://api.binance.com/api/v3/klines';
const SYMBOL = 'SOLUSDT';
const INTERVAL = '5m';
const LIMIT = 100;

export async function checkSolSupertrend() {
  const res = await fetch(`${BINANCE_URL}?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}`);
  if (!res.ok) throw new Error(`Binance API ${res.status}`);
  const data = await res.json();

  const highs = data.map(d => parseFloat(d[2]));
  const lows = data.map(d => parseFloat(d[3]));
  const closes = data.map(d => parseFloat(d[4]));

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 10 });
  const multiplier = 3;
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  const startIdx = closes.length - atrValues.length;

  let finalUpper = 0;
  let finalLower = 0;
  let direction = 1;

  for (let i = startIdx; i < closes.length; i++) {
    const atr = atrValues[i - startIdx];
    const basicUpper = hl2[i] + multiplier * atr;
    const basicLower = hl2[i] - multiplier * atr;

    if (i === startIdx) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = closes[i] > finalLower ? 1 : -1;
    } else {
      const prevFU = finalUpper;
      const prevFL = finalLower;
      finalUpper = (basicUpper < prevFU || closes[i - 1] > prevFU) ? basicUpper : prevFU;
      finalLower = (basicLower > prevFL || closes[i - 1] < prevFL) ? basicLower : prevFL;

      if (direction === 1) {
        direction = closes[i] > finalLower ? 1 : -1;
      } else {
        direction = closes[i] < finalUpper ? -1 : 1;
      }
    }
  }

  return {
    bullish: direction === 1,
    price: closes[closes.length - 1],
    supertrend: direction === 1 ? finalLower : finalUpper,
  };
}

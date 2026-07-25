// Deterministic token-page scalp facts: exitability, five-minute tape flow,
// and early-wallet behavior. The trader interprets the readout; no model runs.
'use strict';

BBD.scalp = (() => {
  const finiteNumber = (value) =>
    typeof value === 'number' && Number.isFinite(value);

  const read = (object, key, fallback = null) => {
    try {
      return object && typeof object === 'object' ? object[key] : fallback;
    } catch (err) {
      return fallback;
    }
  };

  const pressurePct = (value) => {
    try {
      if (value == null) return null;
      const rounded = Math.round(value * 100);
      return Number.isFinite(rounded) ? rounded : null;
    } catch (err) {
      return null;
    }
  };

  const flowDirection = (value) => {
    try {
      if (value == null) return null;
      if (value >= 1.15) return 'up';
      if (value <= 0.85) return 'down';
      return 'flat';
    } catch (err) {
      return null;
    }
  };

  const assess = (input) => {
    try {
      const source = input && typeof input === 'object' ? input : {};
      const flowValue = read(source, 'flow');
      const flow = flowValue && typeof flowValue === 'object' ? flowValue : {};
      const sellTaxValue = read(source, 'sellTaxPct');
      const sellTaxPct = finiteNumber(sellTaxValue) ? sellTaxValue : null;
      const liqValue = read(source, 'liqUsd');
      const liqUsd = finiteNumber(liqValue) ? liqValue : null;
      const maxTaxValue = read(source, 'maxSellTaxPct');
      const maxSellTaxPct = finiteNumber(maxTaxValue) ? maxTaxValue : 10;
      const auditDanger = read(source, 'auditDanger');
      const proTraderNetUsd = read(flow, 'proTraderNetUsd');
      const sniperNetUsd = read(flow, 'sniperNetUsd');
      const top3TraderShare = read(flow, 'top3TraderShare');
      const uniqueBuyers = read(flow, 'uniqueBuyers');
      const uniqueSellers = read(flow, 'uniqueSellers');

      let exit = 'unknown';
      let exitReason = null;
      if (auditDanger === true) {
        exit = 'blocked';
        exitReason = 'honeypot';
      } else if (sellTaxPct !== null && sellTaxPct > maxSellTaxPct) {
        exit = 'blocked';
        exitReason = 'tax';
      } else if (auditDanger === false
        || (sellTaxPct !== null && sellTaxPct <= maxSellTaxPct)) {
        exit = 'free';
      }

      const result = {
        buyPressurePct: pressurePct(read(flow, 'buyRatio')),
        flowDir: flowDirection(read(flow, 'volumeTrend')),
        smartMoney: finiteNumber(proTraderNetUsd) && proTraderNetUsd > 50 ? 'in'
          : finiteNumber(proTraderNetUsd) && proTraderNetUsd < -50 ? 'out' : 'flat',
        snipersDumping: finiteNumber(sniperNetUsd) && sniperNetUsd <= -500,
        devSold: Boolean(read(flow, 'devSold', false)),
        washRisk: finiteNumber(top3TraderShare) && top3TraderShare >= 0.5,
        uniqueBuyers: finiteNumber(uniqueBuyers) ? uniqueBuyers : 0,
        uniqueSellers: finiteNumber(uniqueSellers) ? uniqueSellers : 0,
        sellTaxPct,
        exit,
        liqUsd
      };
      if (exitReason) result.exitReason = exitReason;
      return result;
    } catch (err) {
      return {
        buyPressurePct: null,
        flowDir: null,
        smartMoney: 'flat',
        snipersDumping: false,
        devSold: false,
        washRisk: false,
        uniqueBuyers: 0,
        uniqueSellers: 0,
        sellTaxPct: null,
        exit: 'unknown',
        liqUsd: null
      };
    }
  };

  const hide = () => {
    try {
      if (typeof document === 'undefined') return;
      const el = document.getElementById('bbd-scalp');
      if (el) el.style.display = 'none';
    } catch (err) {
      // Extension reloads can orphan a content script between poll ticks.
    }
  };

  const alive = () => {
    try {
      return typeof BBD.alive !== 'function' || BBD.alive();
    } catch (err) {
      return false;
    }
  };

  const compactUsd = (value) => {
    if (!finiteNumber(value)) return '';
    const abs = Math.abs(value);
    const suffix = abs >= 1e6 ? 'M' : abs >= 1e3 ? 'K' : '';
    const scale = suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
    const scaled = value / scale;
    if (!suffix) return `$${Math.round(scaled)}`;
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    return `$${Number(scaled.toFixed(digits))}${suffix}`;
  };

  const signal = (text, className) => {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  };

  const render = async (addr, trades, settings) => {
    try {
      if (!alive()) {
        hide();
        return;
      }

      const flow = BBD.candles.flow(trades, {
        windowMs: 5 * 60 * 1000,
        now: Date.now(),
        creatorAddr: BBD.feed.creatorFor(addr)
      });
      const intelByAddr = await BBD.store.get(BBD.KEYS.intel, {});
      if (!alive()) {
        hide();
        return;
      }
      const intel = intelByAddr && typeof intelByAddr === 'object'
        ? intelByAddr[addr] : null;
      const sellTaxPct = intel && typeof intel.sellTax === 'number'
        ? intel.sellTax : null;
      const audit = BBD.feed.auditFor(addr);
      const auditDanger = audit ? audit.danger === true : null;
      const market = BBD.feed.marketFor(addr);
      const liqUsd = market && typeof market.liq === 'number' ? market.liq : null;
      const summary = assess({
        flow,
        sellTaxPct,
        auditDanger,
        liqUsd,
        maxSellTaxPct: settings && settings.scalpMaxSellTaxPct
      });

      let el = document.getElementById('bbd-scalp');
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        el.id = 'bbd-scalp';
        document.body.appendChild(el);
      }
      if (BBD.drag) BBD.drag.register(el);

      const exitLine = document.createElement('div');
      exitLine.className = `bbd-scalp-exit ${
        summary.exit === 'free' ? 'bbd-scalp-good'
          : summary.exit === 'blocked' ? 'bbd-scalp-bad' : 'bbd-scalp-mut'
      }`;
      exitLine.textContent = summary.exit === 'free' ? '✅ exit free'
        : summary.exitReason === 'tax' ? `⛔ exit: tax ${summary.sellTaxPct}%`
          : summary.exitReason === 'honeypot' ? '⛔ exit: honeypot'
            : 'exit: unknown';

      const signalLine = document.createElement('div');
      signalLine.className = 'bbd-scalp-signals';
      if (summary.buyPressurePct !== null) {
        const arrow = summary.flowDir === 'up' ? '↑'
          : summary.flowDir === 'down' ? '↓' : '·';
        signalLine.appendChild(signal(
          `Buy ${summary.buyPressurePct}% ${arrow}`,
          summary.buyPressurePct >= 50 ? 'bbd-scalp-good' : 'bbd-scalp-bad'
        ));
      }
      signalLine.appendChild(signal(
        summary.smartMoney === 'in' ? 'Pro in'
          : summary.smartMoney === 'out' ? 'Pro out' : 'Pro flat',
        summary.smartMoney === 'in' ? 'bbd-scalp-good'
          : summary.smartMoney === 'out' ? 'bbd-scalp-bad' : 'bbd-scalp-mut'
      ));
      if (summary.snipersDumping) {
        signalLine.appendChild(signal('Snipers dumping', 'bbd-scalp-bad'));
      }
      if (summary.devSold) signalLine.appendChild(signal('Dev sold', 'bbd-scalp-bad'));
      if (summary.washRisk) signalLine.appendChild(signal('Wash?', 'bbd-scalp-warn'));
      if (summary.liqUsd !== null) {
        signalLine.appendChild(signal(`Liq ${compactUsd(summary.liqUsd)}`, 'bbd-scalp-mut'));
      }

      // Wallet behaviour comes from the accumulated tape, so it stays blank
      // until enough of it exists. A share over a handful of wallets would be
      // noise, and a confident-looking percentage is worse than no line.
      const cohortLine = document.createElement('div');
      cohortLine.className = 'bbd-scalp-signals';
      const crowd = BBD.cohort && settings && settings.cohortReadoutEnabled !== false
        ? BBD.cohort.analyze(BBD.feed.tapeFor(addr), {
          minWallets: settings.cohortMinWallets,
          earlyWindowMs: settings.cohortEarlyWindowSec * 1000
        })
        : null;
      // The launch cohort comes from the token's own first minutes, so it is
      // the one number here that means what it says regardless of when the
      // page was opened. It leads for that reason.
      const born = BBD.cohort && settings && settings.cohortReadoutEnabled !== false
        ? BBD.cohort.launchAnalyze(BBD.feed.launchFor(addr), {
          buyWindowMs: settings.cohortEarlyWindowSec * 1000
        })
        : null;
      if (born && born.enough && born.exitedPct !== null) {
        const held = born.medianExitSec !== null ? ` ~${born.medianExitSec}s` : '';
        cohortLine.appendChild(signal(
          `Launch out ${born.exitedPct}%${held}`,
          born.exitedPct >= 60 ? 'bbd-scalp-bad' : 'bbd-scalp-good'
        ));
      }

      if (crowd && crowd.enough) {
        if (crowd.earlyExitedPct !== null) {
          cohortLine.appendChild(signal(
            `Recent out ${crowd.earlyExitedPct}%`,
            crowd.earlyExitedPct >= 60 ? 'bbd-scalp-bad' : 'bbd-scalp-good'
          ));
        }
        if (crowd.flipperPct !== null && crowd.medianHoldSec !== null) {
          cohortLine.appendChild(signal(
            `Flips ${crowd.flipperPct}% ~${crowd.medianHoldSec}s`,
            crowd.flipperPct >= 40 ? 'bbd-scalp-warn' : 'bbd-scalp-mut'
          ));
        }
        if (crowd.oneTimeWalletPct !== null) {
          cohortLine.appendChild(signal(
            `1-trade ${crowd.oneTimeWalletPct}%`,
            crowd.oneTimeWalletPct >= 70 ? 'bbd-scalp-warn' : 'bbd-scalp-mut'
          ));
        }
        // "Recent" is measured from the oldest row held, which is not the
        // token's start unless the launch page happens to reach it. Saying
        // "last Nm" keeps that distinction visible next to "Launch".
        cohortLine.appendChild(signal(
          `${crowd.walletCount}w/last ${crowd.observedMin}m`, 'bbd-scalp-mut'
        ));
      } else if (crowd) {
        cohortLine.appendChild(signal(
          `crowd: ${crowd.walletCount}w/last ${crowd.observedMin}m — too little tape`,
          'bbd-scalp-mut'
        ));
      }

      // Holder facts from the holder list rather than the tape: real
      // concentration (wallets fed from one source) and exit pressure (share
      // of holders sitting in profit). Both stay silent when the data is thin
      // or, in the funder case, simply absent for this token.
      const holdersLine = document.createElement('div');
      holdersLine.className = 'bbd-scalp-signals';
      const book = BBD.holders && settings && settings.holderReadoutEnabled !== false
        ? BBD.holders.analyze(BBD.feed.holdersFor(addr), {
          minHolders: settings.holderMinCount,
          minClusterWallets: settings.holderClusterMinWallets
        })
        : null;
      if (book && book.enough) {
        if (book.topClusterWallets >= 2 && book.topClusterPct !== null) {
          holdersLine.appendChild(signal(
            `Cluster ${book.topClusterWallets}w ${book.topClusterPct}%`,
            book.topClusterPct >= 10 ? 'bbd-scalp-bad' : 'bbd-scalp-warn'
          ));
        }
        if (book.inProfitPct !== null) {
          // A book mostly in profit is primed to take gains — exit pressure,
          // not reassurance — so a high share reads as a caution here.
          holdersLine.appendChild(signal(
            `In profit ${book.inProfitPct}%`,
            book.inProfitPct >= 70 ? 'bbd-scalp-warn' : 'bbd-scalp-mut'
          ));
        }

        // The real top holders matched against the rolling tape: a big holder
        // actively selling is the concrete exit event, not the volume-share
        // proxy. Shown only when one of them is actually moving.
        const track = BBD.holders.trackFlow(
          BBD.feed.holdersFor(addr), BBD.feed.tapeFor(addr), {
            topN: settings.holderTrackTopN,
            windowMs: (settings.holderTrackWindowSec || 300) * 1000,
            now: Date.now()
          }
        );
        if (track.enough && track.sellers > 0) {
          holdersLine.appendChild(signal(
            `Top${track.tracked}: ${track.sellers} sold ${compactUsd(track.soldUsd)}`,
            'bbd-scalp-bad'
          ));
        } else if (track.enough && track.buyers > 0) {
          holdersLine.appendChild(signal(
            `Top${track.tracked}: ${track.buyers} buying`, 'bbd-scalp-good'
          ));
        }
      }

      el.replaceChildren(exitLine, signalLine,
        ...(cohortLine.childNodes.length ? [cohortLine] : []),
        ...(holdersLine.childNodes.length ? [holdersLine] : []));
      el.style.display = 'block';
    } catch (err) {
      // A malformed tape row or disappearing extension API must not stop the
      // shared price poll from reaching its next healthy tick.
      hide();
    }
  };

  return { assess, render, hide };
})();

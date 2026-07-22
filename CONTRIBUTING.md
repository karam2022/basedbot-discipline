# Contributing

PRs welcome. Keep it in the spirit of the tool:

- **No auto-trading, ever.** The extension reads and reminds; it never clicks
  buy or sell. PRs that add order execution will be closed.
- **No trackers, no external calls** beyond basedbot.app and the Telegram API
  the user configures. Nothing about the user leaves their machine otherwise.
- Plain unminified JS, no build step, files small and focused.
- If you change scoring thresholds, say why in the PR — ideally with examples
  of real tokens the change would have caught or spared.
- Run `node --test test/*.test.js` and syntax-check changed scripts before a PR.
- Position identity is `chain|wallet|token`; journal entries are immutable trade
  cycles. Never return to address-keyed journal writes or treat stale unrealized
  PnL as an exact realized exit.

Good first contributions: new launchpad badge names as basedbot adds chains,
meme-keyword list improvements per language/meta, selector fixes when
basedbot changes their UI.

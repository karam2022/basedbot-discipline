# VPS deploy — basedbot 🔥 watcher

Runs headless Chromium against the PUBLIC Pulse page (no wallet/auth), scores
every card with the same hot logic as the extension, and Telegrams new passes.
Take-profit alerts still need the browser extension (positions require your
wallet session) — this covers discovery 24/7.

## One-time setup (as root on the VPS)

    scp -r vps-watcher your-server:/root/basedbot-watcher
    ssh your-server
    cd /root/basedbot-watcher
    npm install
    npx playwright install --with-deps chromium
    cp config.example.json config.json   # then paste tgToken + tgChatId
    cp basedbot-watcher.service /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now basedbot-watcher
    journalctl -u basedbot-watcher -f    # watch it work

## Notes
- seen.json dedupes by chain + token; a token re-alerts after realertHours (default 24h).
- Telegram creds: @BotFather -> token, @userinfobot -> chat id, message your bot once.
- config.json holds the bot token: keep it on the VPS only, never commit it.

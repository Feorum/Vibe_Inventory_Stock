# Telegram setup for the Google-backed app

Bot credentials stay in **private Apps Script Properties**, never in the PWA, Google Sheets cells, GitHub, or chat. The app can report configuration presence and send an explicitly requested owner-only test. Configuration presence is not proof of working delivery; a successful test is the confirmation.

## Update the working application

For Workspace v4.1, replace the contents of these existing **script files** with the matching repository source:

- `apps-script/PwaBridge.gs`
- `apps-script/Workspace.gs`
- `apps-script/WorkspaceNotifications.gs`

Keep the original five files and the current `doGet` hook. Keep `PwaBridge.html` as the separate **HTML** file: it must start with `<!doctype html>`. Do not paste `.gs` code into it. No new table, migration, installer, or stock import is needed if Workspace v4 is already installed.

Save, then **Deploy → Manage deployments → Edit → New version → Deploy**, using the same `/exec` URL. Publish the frontend using the existing manual **Deploy Google-mode PWA** GitHub Actions workflow. Reload online after the service worker updates. The footer identifies Workspace v4.1. Do not clear browser data; saved counts, pending requests, and recovery archives are retained.

## 1. Create or use your Telegram bot

In Telegram, open the official **@BotFather** account. Use `/newbot`, or select an existing bot you own. Copy the bot token privately.

In the Apps Script editor, open **Project Settings / Настройки проекта → Script Properties / Свойства скрипта**. Set:

| Property             | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| `TELEGRAM_TOKEN`     | The bot token supplied by BotFather                                  |
| `TELEGRAM_CHAT_ID`   | The destination chat ID from the next step                           |
| `PWA_WRITES_ENABLED` | `true` when you intend to allow online writes and notification sends |

These names reuse the existing integration. Do not replace your individual `WEB_ACCESS_…` codes with a bot token. Do not put a token in a browser address such as a Telegram API URL; URLs can be saved in history or logs.

## 2. Choose the destination chat

For a private destination, open the bot's conversation and press **Start**, or send `/start`. A bot cannot start a private conversation before the person has started it.

For a café group, add the bot and allow it to send messages. Send a fresh command directed at it, for example `/start@YourBotUsername`; normal group messages may be hidden by Telegram's bot privacy mode. For a channel, the bot needs channel posting rights. Do not grant unnecessary administrator permissions to a group bot.

After sending that message, select and run **`listWorkspaceTelegramChats`** from the Apps Script editor **as the project owner**. It returns/logs only recently observed chat IDs, types, and group/channel titles. Private chats get a generic title. It does not print the token, private message contents, or names, send messages, acknowledge updates with an offset, or change an existing webhook.

Copy the intended chat's `id` into the private `TELEGRAM_CHAT_ID` property. Keep the entire ID, including any minus sign or `-100` prefix. If multiple chats appear, select the intended café destination; the helper never selects a chat automatically.

- An empty `[]` means no destination was observed in the available recent updates. Send a fresh `/start` or group command and try again.
- `TELEGRAM_TOKEN_MISSING`: set the token privately first.
- `TELEGRAM_UPDATES_UNAVAILABLE`: an existing webhook or another polling integration may already own delivery of updates. **Do not delete its webhook or stop it just to discover an ID.** Use the chat ID from that integration's trusted configuration, or use a separate bot.
- `TELEGRAM_CHAT_DISCOVERY_FAILED`: check the private token and Apps Script execution permissions. Provider/network failures are sanitized so a token-bearing URL is never echoed.

Telegram only retains updates for a limited time; discovery is not a complete historical directory of every chat the bot has ever joined.

## 3. Verify delivery from Profile

Sign in to the PWA with the authorized **owner account**, refresh the database, and open **Profile → Telegram notifications**.

The panel shows missing/configured status without exposing credential values. Open its collapsed setup instructions if needed. Choose **Send test notification** and confirm the destination test. The message is localized using the app's current language. This action changes **no inventory quantities or count timestamps**.

- **Delivered:** Telegram returned a confirmed message ID.
- **Rejected:** the server records a definite Telegram rejection. Fix bot/chat permissions or credentials, refresh the database, and use **Retry test notification only**. The same saved operation ID is retained.
- **Unconfirmed:** the message may already have arrived. The app offers **Check delivery status**, not an automatic resend. Check the destination chat before considering any further action.
- **Missing configuration:** no request is sent to Telegram. Complete the private properties first.

If the browser loses the initial response, use the existing **Retry safely** action. It resumes the same persisted test request. A confirmed sent test is not duplicated. Test records are account/database scoped and separate from inventory notification outcomes. Staff can view configuration presence but cannot invoke the owner-only test, including through direct API calls.

Changing a token or chat later requires another explicit delivery check. A past successful test is not a permanent health guarantee. Repeated clicks after a confirmed success are new, intentional test messages; an ambiguous test is not automatically repeated.

## Stock notifications and reminders

The **Synchronize quantity** confirmation still saves every valid entered count, independently of the Telegram scope. Choose **Entire list**, **Only entered items**, or **Only items marked Low**. Notifications are based on the frozen full-catalog submission and accepted server results, not the visible filters. Old quantities are labeled as previously recorded. A notification failure never rolls back inventory; retry only the notification.

Fixed-interval scheduled recount reminders remain optional. Install them with **`installWorkspaceReminders`**, set private `WORKSPACE_REMINDER_LANGUAGE` to `ru` or `en`, and review the old `refreshAndAlert_` timer to avoid duplicate legacy reports. Do not remove unrelated form triggers. See [the scheduled reminder guide](google-workspace.md#scheduled-telegram-reminders).

## Verification limits

Repository tests use an isolated Apps Script workbook emulator, mocked Telegram responses, and browser iframe mocks. They verify access control, no credential exposure, same-ID retries, known rejection, uncertain delivery, and stock isolation. They do not prove that your live bot, chat permissions, Apps Script OAuth grants, or deployed version are configured correctly. Complete the explicit test in your own deployment; never send the token to an assistant to perform it.

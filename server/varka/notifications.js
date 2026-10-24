import { operation, bool, text, version, problem } from "./core.js";

export function settings(db) {
  const row = db
    .prepare("SELECT * FROM varka_notification_settings WHERE id=1")
    .get();
  return {
    enabled: Boolean(row.enabled),
    mode: row.mode,
    version: row.version,
  };
}
export function saveSettings(db, actor, id, body) {
  if (actor.role !== "owner") problem(403, "OWNER_ONLY");
  return operation(db, actor, id, "SETTINGS", body, () => {
    version(settings(db).version, body.version, "Notification settings");
    if (!["LOW", "ALL"].includes(body.mode))
      problem(400, "INVALID_NOTIFICATION_MODE");
    db.prepare(
      "UPDATE varka_notification_settings SET enabled=?,mode=?,version=version+1 WHERE id=1",
    ).run(+bool(body.enabled), body.mode);
    return { settings: settings(db) };
  });
}
export function retryNotification(db, actor, id, body) {
  if (actor.role !== "owner") problem(403, "OWNER_ONLY");
  return operation(db, actor, id, "NOTIFICATION_RETRY", body, () => {
    const row = db
      .prepare("SELECT * FROM varka_outbox WHERE id=?")
      .get(body.id);
    if (!row) problem(404, "REPORT_NOT_FOUND");
    if (!["FAILED", "UNKNOWN"].includes(row.status))
      problem(409, "DELIVERY_NOT_RETRYABLE");
    if (row.status === "UNKNOWN" && body.acknowledgeDuplicateRisk !== true)
      problem(
        409,
        "VERIFY_DELIVERY_FIRST",
        "Delivery is uncertain. Check Telegram before explicitly retrying.",
      );
    db.prepare(
      "UPDATE varka_outbox SET status='PENDING',error=NULL,updated_at=? WHERE id=?",
    ).run(new Date().toISOString(), row.id);
    return { id: row.id, status: "PENDING" };
  });
}

export function notificationWorker(
  db,
  { token, chatId, enabled = false, fetchImpl = fetch } = {},
) {
  let busy = false;
  // A previous process may have sent a claimed report without recording its reply.
  db.prepare(
    "UPDATE varka_outbox SET status='UNKNOWN',error='Process stopped during delivery' WHERE status='SENDING'",
  ).run();
  return async function tick() {
    if (busy || !enabled || !token || !chatId) return;
    busy = true;
    try {
      const row = db
        .prepare(
          "SELECT * FROM varka_outbox WHERE status='PENDING' ORDER BY created_at,rowid LIMIT 1",
        )
        .get();
      if (!row) return;
      const now = new Date().toISOString();
      const claim = db
        .prepare(
          "UPDATE varka_outbox SET status='SENDING',attempts=attempts+1,updated_at=? WHERE id=? AND status='PENDING'",
        )
        .run(now, row.id);
      if (!claim.changes) return;
      let status = "UNKNOWN",
        messageId = null,
        error = null;
      try {
        const response = await fetchImpl(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: row.text }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        const result = await response.json();
        if (response.ok && result.ok === true) {
          status = "SENT";
          messageId = String(result.result?.message_id || "");
        } else {
          status = "FAILED";
          error = `Telegram rejected the report (${response.status}).`;
        }
      } catch {
        error =
          "Delivery outcome is uncertain; verify Telegram before retrying.";
      }
      db.prepare(
        "UPDATE varka_outbox SET status=?,message_id=?,error=?,updated_at=? WHERE id=?",
      ).run(status, messageId, error, new Date().toISOString(), row.id);
    } finally {
      busy = false;
    }
  };
}

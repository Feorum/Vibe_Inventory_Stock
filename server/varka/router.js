import { Router } from "express";
import { authentication, provisionUser } from "./auth.js";
import { catalog, movements, history } from "./stock.js";
import { categories, saveProduct } from "./catalog.js";
import {
  session,
  recentSessions,
  startSession,
  refreshSession,
  submitSession,
  correctSession,
} from "./sessions.js";
import {
  information,
  saveCard,
  saveReminder,
  saveProfile,
} from "./information.js";
import { settings, saveSettings, retryNotification } from "./notifications.js";
import { problem, operation, ZONES, UNITS, hash } from "./core.js";

export function varkaRouter(db, { production = false } = {}) {
  const router = Router();
  const auth = authentication(db, { production });
  const operationId = (req) => req.get("Idempotency-Key");
  router.get("/session", (req, res) => res.json({ user: auth.current(req) }));
  router.post("/session", (req, res) => res.json(auth.login(req, res)));
  router.delete("/session", (req, res) => res.json(auth.logout(req, res)));
  router.use((req, _res, next) => {
    req.actor = auth.current(req);
    if (!req.actor)
      problem(401, "SIGN_IN_REQUIRED", "Sign in to open the inventory.");
    next();
  });
  router.get("/bootstrap", (req, res) =>
    res.json({
      user: req.actor,
      products: catalog(db),
      categories: categories(db),
      zones: ZONES,
      units: UNITS,
      sessions: recentSessions(db, req.actor),
      settings: { ...settings(db), canManage: req.actor.role === "owner" },
      syncedAt: new Date().toISOString(),
      migration: db
        .prepare(
          "SELECT report FROM varka_migration_runs ORDER BY imported_at DESC LIMIT 1",
        )
        .get()?.report
        ? JSON.parse(
            db
              .prepare(
                "SELECT report FROM varka_migration_runs ORDER BY imported_at DESC LIMIT 1",
              )
              .get().report,
          )
        : null,
    }),
  );
  router.post("/products", (req, res) =>
    res
      .status(201)
      .json(saveProduct(db, req.actor, operationId(req), req.body)),
  );
  router.get("/operations/:id", (req, res) => {
    const row = db
      .prepare("SELECT * FROM varka_operations WHERE id=? AND actor=?")
      .get(req.params.id, req.actor.email);
    if (!row) problem(404, "OPERATION_NOT_COMMITTED");
    res.json({ ...JSON.parse(row.response), replayed: true });
  });
  router.post("/movements", (req, res) =>
    res.status(201).json(movements(db, req.actor, operationId(req), req.body)),
  );
  router.get("/sessions", (req, res) =>
    res.json({ sessions: recentSessions(db, req.actor) }),
  );
  router.post("/sessions", (req, res) =>
    res
      .status(201)
      .json(startSession(db, req.actor, operationId(req), req.body)),
  );
  router.get("/sessions/:id", (req, res) =>
    res.json({ session: session(db, req.params.id) }),
  );
  router.post("/sessions/:id/refresh", (req, res) =>
    res.json(
      refreshSession(db, req.actor, operationId(req), req.params.id, req.body),
    ),
  );
  router.post("/sessions/:id/submit", (req, res) =>
    res.json(
      submitSession(db, req.actor, operationId(req), req.params.id, req.body),
    ),
  );
  router.post("/sessions/:id/corrections", (req, res) =>
    res.json(
      correctSession(db, req.actor, operationId(req), req.params.id, req.body),
    ),
  );
  router.get("/history", (req, res) => res.json(history(db, req.query)));
  router.get("/history/:id", (req, res) => {
    const row = db
      .prepare("SELECT * FROM varka_events WHERE id=?")
      .get(req.params.id);
    if (!row) problem(404, "EVENT_NOT_FOUND");
    res.json({ version: hash(JSON.stringify(row)) });
  });
  router.get("/information", (_req, res) => res.json(information(db)));
  router.post("/cards", (req, res) =>
    res.json(saveCard(db, req.actor, operationId(req), req.body)),
  );
  router.post("/reminders", (req, res) =>
    res.json(saveReminder(db, req.actor, operationId(req), req.body)),
  );
  router.post("/profile", (req, res) =>
    res.json(saveProfile(db, req.actor, operationId(req), req.body)),
  );
  router.post("/notification-settings", (req, res) =>
    res.json(saveSettings(db, req.actor, operationId(req), req.body)),
  );
  router.use("/admin", (req, _res, next) => {
    if (req.actor.role !== "owner") problem(403, "OWNER_ONLY");
    next();
  });
  router.get("/admin/users", (_req, res) =>
    res.json({
      users: db
        .prepare(
          "SELECT email,name,role,enabled,version,code_hash IS NOT NULL AS provisioned FROM varka_users ORDER BY email",
        )
        .all(),
    }),
  );
  router.post("/admin/users", (req, res) => {
    if (
      req.body.code !== undefined &&
      (typeof req.body.code !== "string" ||
        req.body.code.length < 12 ||
        req.body.code.length > 200)
    )
      problem(400, "INVALID_ACCESS_CODE");
    res.json(
      operation(
        db,
        req.actor,
        operationId(req),
        "ACCOUNT",
        {
          email: req.body.email,
          name: req.body.name ?? "",
          role: req.body.role ?? "staff",
          enabled: req.body.enabled ?? true,
          codeFingerprint:
            req.body.code === undefined ? null : hash(req.body.code),
        },
        () => ({ user: provisionUser(db, req.body) }),
      ),
    );
  });
  router.get("/admin/notifications", (_req, res) =>
    res.json({
      reports: db
        .prepare(
          "SELECT id,operation_id AS operationId,status,attempts,created_at AS createdAt,updated_at AS updatedAt,error FROM varka_outbox ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
    }),
  );
  router.post("/admin/notifications/retry", (req, res) =>
    res.json(retryNotification(db, req.actor, operationId(req), req.body)),
  );
  router.use((_req, _res) => problem(404, "ROUTE_NOT_FOUND"));
  return router;
}

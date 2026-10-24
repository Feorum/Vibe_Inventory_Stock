import express from "express";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApiError, inventory } from "./inventory.js";
import { varkaRouter } from "./varka/router.js";

export function createApp({
  db,
  password = "",
  production = false,
  trustProxy = false,
}) {
  if (production && password.length < 12)
    throw new Error(
      "Set APP_PASSWORD to at least 12 characters in production.",
    );
  const app = express();
  const store = inventory(db);
  const sessions = new Map();
  const attempts = new Map();
  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (production) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method)) {
      if (req.get("X-Inventory-Request") !== "1")
        return res
          .status(403)
          .json({ error: "Missing same-origin request header." });
      if (
        req.get("Origin") &&
        req.get("Origin") !== `${req.protocol}://${req.get("host")}`
      )
        return res
          .status(403)
          .json({ error: "Cross-origin requests are not allowed." });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "Send application/json." });
    }
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  app.use("/api/varka", varkaRouter(db, { production }));
  const cookieName = production
    ? "__Host-inventory_session"
    : "inventory_session";
  const tokenFor = (req) =>
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  const authenticated = (req) =>
    !password || (sessions.get(tokenFor(req)) ?? 0) > Date.now();
  app.get("/api/health", (_req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  app.get("/api/session", (req, res) =>
    res.json({
      authenticated: authenticated(req),
      passwordRequired: Boolean(password),
    }),
  );
  app.post("/api/session", (req, res) => {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until < now) attempts.delete(key);
    for (const [key, value] of sessions) if (value < now) sessions.delete(key);
    const key = req.ip;
    const attempt = attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 };
    if (attempt.count >= 10)
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again in 15 minutes." });
    const digest = (value) => createHash("sha256").update(value).digest();
    if (
      typeof req.body?.password !== "string" ||
      !timingSafeEqual(digest(req.body.password), digest(password))
    ) {
      attempt.count += 1;
      attempts.set(key, attempt);
      return res.status(401).json({ error: "Incorrect shop password." });
    }
    attempts.delete(key);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now + 12 * 60 * 60_000);
    res.cookie(cookieName, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: production,
      path: "/",
      maxAge: 12 * 60 * 60_000,
    });
    res.json({ authenticated: true });
  });
  app.delete("/api/session", (req, res) => {
    sessions.delete(tokenFor(req));
    res.clearCookie(cookieName, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: production,
    });
    res.json({ authenticated: false });
  });
  app.use("/api", (req, res, next) =>
    authenticated(req)
      ? next()
      : res.status(401).json({ error: "Enter the shop password to continue." }),
  );
  app.get("/api/items", (_req, res) =>
    res.json({ items: store.list(), syncedAt: new Date().toISOString() }),
  );
  app.post("/api/items", (req, res) =>
    res.status(201).json({ item: store.create(req.body ?? {}) }),
  );
  app.get("/api/movements", (_req, res) =>
    res.json({ movements: store.movements() }),
  );
  app.post("/api/items/:id/movements", (req, res) =>
    res
      .status(201)
      .json(
        store.move(
          Number(req.params.id),
          req.body ?? {},
          req.get("Idempotency-Key"),
        ),
      ),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
  app.use(
    express.static(publicPath, {
      etag: true,
      setHeaders(res, path) {
        if (path.endsWith("sw.js")) res.set("Cache-Control", "no-cache");
        if (path.endsWith(".html")) res.set("Cache-Control", "no-cache");
      },
    }),
  );
  app.use((_req, res) => res.status(404).type("text").send("Not found"));
  app.use((error, _req, res, _next) => {
    const status =
      error instanceof ApiError
        ? error.status
        : error.type === "entity.parse.failed"
          ? 400
          : error.type === "entity.too.large"
            ? 413
            : 500;
    if (status === 500) console.error(error);
    res.status(status).json({
      ...(error.code && error instanceof ApiError
        ? { code: error.code, ...error.details }
        : {}),
      error:
        status === 500
          ? "An unexpected server error occurred."
          : status === 413
            ? "Request is too large."
            : status === 400 && !(error instanceof ApiError)
              ? "Invalid JSON body."
              : error.message,
    });
  });
  return app;
}

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { hash, problem, text } from "./core.js";

export function provisionUser(
  db,
  { email, name, role = "staff", code, enabled = true },
) {
  if (typeof enabled !== "boolean") problem(400, "INVALID_FLAG");
  email = text(email, 200).toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !["staff", "owner"].includes(role)
  )
    problem(400, "INVALID_ACCOUNT");
  const current = db
    .prepare("SELECT * FROM varka_users WHERE email=?")
    .get(email);
  if (
    !enabled &&
    current?.role === "owner" &&
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM varka_users WHERE role='owner' AND enabled=1 AND code_hash IS NOT NULL",
      )
      .get().n <= 1
  )
    problem(409, "LAST_OWNER");
  if (
    current?.role === "owner" &&
    role !== "owner" &&
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM varka_users WHERE role='owner' AND enabled=1 AND code_hash IS NOT NULL",
      )
      .get().n <= 1
  )
    problem(409, "LAST_OWNER");
  let digest = current?.code_hash || null;
  if (code !== undefined) {
    if (typeof code !== "string" || code.length < 12 || code.length > 200)
      problem(
        400,
        "INVALID_ACCESS_CODE",
        "Access codes must be 12–200 characters.",
      );
    const salt = randomBytes(16).toString("hex");
    digest = `${salt}:${scryptSync(code, salt, 32).toString("hex")}`;
  }
  if (!current && !digest) problem(400, "ACCESS_CODE_REQUIRED");
  db.prepare(
    "INSERT INTO varka_users(email,name,role,code_hash,enabled) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role,code_hash=excluded.code_hash,enabled=excluded.enabled,version=version+1",
  ).run(
    email,
    name === undefined ? current?.name || "" : text(name, 80, false),
    role,
    digest,
    +enabled,
  );
  db.prepare("DELETE FROM varka_auth_sessions WHERE email=?").run(email);
  return { email, name: name ?? current?.name ?? "", role, enabled };
}

export function authentication(db, { production = false } = {}) {
  const cookieName = production ? "__Host-varka" : "varka-session";
  const token = (req) =>
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  const profile = (row) => ({
    email: row.email,
    name: row.name,
    role: row.role,
    version: row.version,
  });
  const development = () =>
    !production &&
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM varka_users WHERE code_hash IS NOT NULL AND enabled=1",
      )
      .get().n === 0;
  return {
    current(req) {
      if (development()) {
        db.prepare(
          "INSERT OR IGNORE INTO varka_users(email,name,role) VALUES('developer@local.invalid','Developer','owner')",
        ).run();
        return {
          ...profile(
            db
              .prepare(
                "SELECT * FROM varka_users WHERE email='developer@local.invalid'",
              )
              .get(),
          ),
          development: true,
        };
      }
      const cookie = token(req);
      if (!cookie) return null;
      const row = db
        .prepare(
          "SELECT u.* FROM varka_auth_sessions s JOIN varka_users u ON u.email=s.email WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1 AND u.code_hash IS NOT NULL",
        )
        .get(hash(cookie), Date.now());
      return row ? profile(row) : null;
    },
    login(req, res) {
      const email =
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";
      const code = req.body?.code;
      const now = Date.now();
      db.prepare("DELETE FROM varka_login_attempts WHERE until_at<?").run(now);
      db.prepare("DELETE FROM varka_auth_sessions WHERE expires_at<?").run(now);
      const keys = [hash(`ip:${req.ip}`), hash(`email:${email}`)];
      if (
        keys.some(
          (key) =>
            (db
              .prepare("SELECT count FROM varka_login_attempts WHERE key=?")
              .get(key)?.count || 0) >= 10,
        )
      )
        problem(
          429,
          "RATE_LIMIT",
          "Too many sign-in attempts. Try again in 15 minutes.",
        );
      const row = db
        .prepare("SELECT * FROM varka_users WHERE email=? AND enabled=1")
        .get(email);
      const [salt, expected] = (
        row?.code_hash || `${"0".repeat(32)}:${"0".repeat(64)}`
      ).split(":");
      const actual = scryptSync(
        typeof code === "string" && code.length <= 200 ? code : "",
        salt,
        32,
      );
      if (
        !row?.code_hash ||
        typeof code !== "string" ||
        code.length > 200 ||
        !timingSafeEqual(actual, Buffer.from(expected, "hex"))
      ) {
        for (const key of keys)
          db.prepare(
            "INSERT INTO varka_login_attempts(key,count,until_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
          ).run(key, now + 15 * 60_000);
        problem(401, "SIGN_IN_REQUIRED", "Incorrect email or access code.");
      }
      for (const key of keys)
        db.prepare("DELETE FROM varka_login_attempts WHERE key=?").run(key);
      const cookie = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO varka_auth_sessions(token_hash,email,expires_at) VALUES(?,?,?)",
      ).run(hash(cookie), email, now + 12 * 60 * 60_000);
      res.cookie(cookieName, cookie, {
        httpOnly: true,
        sameSite: "strict",
        secure: production,
        path: "/",
        maxAge: 12 * 60 * 60_000,
      });
      return { user: profile(row) };
    },
    logout(req, res) {
      if (token(req))
        db.prepare("DELETE FROM varka_auth_sessions WHERE token_hash=?").run(
          hash(token(req)),
        );
      res.clearCookie(cookieName, {
        httpOnly: true,
        sameSite: "strict",
        secure: production,
        path: "/",
      });
      return { user: null };
    },
  };
}

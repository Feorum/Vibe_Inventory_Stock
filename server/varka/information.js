import { operation, text, bool, version, problem } from "./core.js";

export function information(db) {
  return {
    cards: db
      .prepare("SELECT * FROM varka_cards WHERE active=1 ORDER BY category,id")
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        size: row.size,
        category: row.category,
        note: row.note,
        author: row.author,
        authorName: row.author_name,
        version: row.version,
        updatedAt: row.updated_at,
      })),
    reminders: db
      .prepare("SELECT * FROM varka_reminders ORDER BY done,created_at DESC")
      .all()
      .map((row) => ({
        id: row.id,
        text: row.text,
        done: Boolean(row.done),
        author: row.author,
        authorName: row.author_name,
        editor: row.editor,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
  };
}
export function saveCard(db, actor, id, body) {
  return operation(db, actor, id, "CARD", body, () => {
    const code = text(body.id, 20).toUpperCase();
    if (!/^[A-ZА-Я]{0,3}[1-9]\d{0,5}$/.test(code))
      problem(400, "INVALID_CARD_NUMBER");
    const current = db
      .prepare("SELECT * FROM varka_cards WHERE id=?")
      .get(code);
    const now = new Date().toISOString();
    if (body.action === "remove") {
      if (!current) problem(404, "CARD_NOT_FOUND");
      version(current.version, body.version, "Card");
      db.prepare(
        "UPDATE varka_cards SET active=0,version=version+1,updated_at=? WHERE id=?",
      ).run(now, code);
    } else if (body.action === "add") {
      if (current) problem(409, "CARD_EXISTS");
      db.prepare(
        "INSERT INTO varka_cards(id,name,size,category,note,author,author_name,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        code,
        text(body.name, 160),
        text(body.size ?? "", 100, false),
        text(body.category, 100),
        text(body.note ?? "", 500, false),
        actor.email,
        actor.name,
        now,
      );
    } else problem(400, "INVALID_ACTION");
    return { id: code };
  });
}
export function saveReminder(db, actor, id, body) {
  return operation(db, actor, id, "REMINDER", body, () => {
    const noteId = text(body.id, 100);
    const content = text(body.text, 1000);
    const done = bool(body.done);
    const current = db
      .prepare("SELECT * FROM varka_reminders WHERE id=?")
      .get(noteId);
    const now = new Date().toISOString();
    if (current) {
      version(current.version, body.version, "Reminder");
      db.prepare(
        "UPDATE varka_reminders SET text=?,done=?,editor=?,version=version+1,updated_at=? WHERE id=?",
      ).run(content, +done, actor.email, now, noteId);
    } else {
      if (body.version !== undefined && body.version !== null)
        problem(404, "REMINDER_NOT_FOUND");
      db.prepare(
        "INSERT INTO varka_reminders(id,text,done,author,author_name,editor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        noteId,
        content,
        +done,
        actor.email,
        actor.name,
        actor.email,
        now,
        now,
      );
    }
    return { id: noteId };
  });
}
export function saveProfile(db, actor, id, body) {
  return operation(db, actor, id, "PROFILE", body, () => {
    const current = db
      .prepare("SELECT * FROM varka_users WHERE email=?")
      .get(actor.email);
    version(current.version, body.version, "Profile");
    const name = text(body.name, 80, false).replace(/\s+/g, " ");
    db.prepare(
      "UPDATE varka_users SET name=?,version=version+1 WHERE email=?",
    ).run(name, actor.email);
    return { user: { ...actor, name, version: current.version + 1 } };
  });
}

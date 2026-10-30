/* Add to the EXISTING VARKA project. Do not replace the five original files.
 * See docs/google-mode.md. All inventory business rules stay in the original
 * webV* functions; this is an explicit transport allowlist, not generic RPC.
 */
function pwaOrigin_() {
  const origin =
    PropertiesService.getScriptProperties().getProperty("PWA_ORIGIN");
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin || ""))
    throw Error("PWA_ORIGIN_NOT_CONFIGURED");
  return origin;
}

// Call this from the existing doGet(e) ONLY for e.parameter.pwa === 'bridge'.
function pwaPage_(e) {
  const channel = String((e && e.parameter && e.parameter.channel) || "");
  if (!/^[a-f0-9]{32}$/.test(channel)) throw Error("INVALID_CHANNEL");
  const template = HtmlService.createTemplateFromFile("PwaBridge");
  template.configuration = JSON.stringify({
    origin: pwaOrigin_(),
    channel: channel,
  }).replace(/</g, "\\u003c");
  return template
    .evaluate()
    .setTitle("VARKA connection")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function pwaDispatch(request) {
  try {
    pwaOrigin_(); // Fail closed until the owner configures a trusted frontend.
    // Workspace submissions cover the full catalog, never the current filter.
    // Keep a bounded request without imposing the legacy single-cell batch size.
    const requestLimit =
      request && /^workspace/.test(request.method || "") ? 2000000 : 60000;
    if (!request || JSON.stringify(request).length > requestLimit)
      throw Error("INVALID_REQUEST");
    const writes =
      PropertiesService.getScriptProperties().getProperty(
        "PWA_WRITES_ENABLED",
      ) === "true";
    const body = request.body || {};
    let result;
    switch (request.method) {
      case "ping":
        result = {
          protocol: 1,
          features: 2,
          countRecovery: 1,
          workspace: typeof workspaceDispatch_ === "function" ? 1 : 0,
          writesEnabled: writes,
        };
        break;
      case "login":
        result = webLogin(body.email, body.code);
        break;
      case "workspaceLogin":
      case "workspaceLoad":
      case "workspaceStatus":
        if (typeof workspaceDispatch_ !== "function")
          throw Error("WORKSPACE_NOT_INSTALLED");
        result = workspaceDispatch_(request.method, request.token, body);
        break;
      case "workspaceCount":
      case "workspaceCatalog":
      case "workspaceTeam":
      case "workspaceNotify":
        if (!writes) throw Error("PWA_READ_ONLY");
        if (typeof workspaceDispatch_ !== "function")
          throw Error("WORKSPACE_NOT_INSTALLED");
        result = workspaceDispatch_(request.method, request.token, body);
        break;
      case "logout":
        result = webLogout(request.token);
        break;
      case "load":
        result = webV8Load(request.token, {
          sessionId: body.sessionId,
          suspendExpansion: true,
        });
        // Serialize Dates for google.script.run, which cannot return Date objects.
        break;
      case "start":
        if (!writes) throw Error("PWA_READ_ONLY");
        result = webV5Start(request.token, { id: body.id });
        break;
      case "submit":
        if (!writes) throw Error("PWA_READ_ONLY");
        result = webV5Submit(request.token, body);
        break;
      case "status":
        result = webV9SubmissionStatus(request.token, { id: body.id });
        break;
      case "recoverCount":
        if (!writes) throw Error("PWA_READ_ONLY");
        result = pwaRecoverCount_(request.token, body);
        break;
      case "information":
        result = webV6Information(request.token);
        break;
      case "history":
        result = webV4History(request.token, {
          productId: body.productId,
          offset: Math.max(0, Number(body.offset) || 0),
          limit: 100,
        });
        break;
      case "settings":
        result = webV10Settings(request.token);
        break;
      case "operationStatus":
        result = pwaOperationStatus_(request.token, body.id);
        break;
      case "mutate":
        if (!writes) throw Error("PWA_READ_ONLY");
        result = pwaMutate_(request.token, body);
        break;
      default:
        throw Error("METHOD_NOT_ALLOWED");
    }
    return { ok: true, data: JSON.parse(JSON.stringify(result)) };
  } catch (error) {
    return {
      ok: false,
      error: String(error.message || "GOOGLE_REQUEST_FAILED").slice(0, 1000),
    };
  }
}

// This is an explicit cancellation/replacement of an OWN open checklist, not
// a bypass of ZONES_CHANGED. The shared legacy lock prevents the old request
// from committing after the CLOSE record. No stock or notification is written.
function pwaRecoverCount_(token, request) {
  const email = webAuth_(token);
  const id = v3Id_(request.id),
    successorId = v3Id_(request.successorId);
  const pending = request.pending;
  if (!pending || !Array.isArray(pending.items))
    throw Error("INVALID_RECOVERY");
  v3Id_(pending.id);
  v3Id_(pending.sessionId);
  if (successorId === pending.sessionId) throw Error("INVALID_RECOVERY");
  const fingerprint = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(request),
    Utilities.Charset.UTF_8,
  )
    .map((n) => ("0" + ((n + 256) % 256).toString(16)).slice(-2))
    .join("");
  return v3Lock_(() => {
    const raw = v5RawEvents_(),
      row = raw.find((r) => r[0] === "V5BATCH:" + pending.id);
    if (row) {
      const batch = v5Decode_(row);
      if (!batch) return { status: "UNCONFIRMED" };
      if (
        batch.by !== email ||
        batch.sessionId !== pending.sessionId ||
        batch.requestHash !== webHash_(JSON.stringify(pending))
      )
        throw Error("REQUEST_ID_REUSED");
      return {
        status: "COMMITTED",
        result: {
          ok: true,
          sessionId: batch.sessionId,
          submittedAt: batch.submittedAt,
          saved: batch.events.length,
          status: batch.status,
          unchanged: (batch.missing || []).length,
        },
      };
    }
    const sheet = book_().getSheetByName("InventorySessions");
    const journal = sheet.getDataRange().getValues().slice(1);
    const closeId = "PWA-RECOVERY:" + id;
    const close = journal.find((r) => r[0] === closeId);
    const start = journal.find(
      (r) => r[0] === successorId || r[4] === successorId,
    );
    if (
      close &&
      (close[2] !== email ||
        close[3] !== "CLOSE" ||
        close[4] !== pending.sessionId ||
        close[5] !== fingerprint)
    )
      throw Error("REQUEST_ID_REUSED");
    if (
      start &&
      (!close ||
        start[0] !== successorId ||
        start[2] !== email ||
        start[3] !== "START" ||
        JSON.parse(start[6] || "{}").recoveryId !== id)
    )
      throw Error("REQUEST_ID_REUSED");
    const session = v4Session_(pending.sessionId);
    if (session.by !== email) throw Error("OWN_SESSION_ONLY");
    if (!close && session.status !== "OPEN")
      return { status: "SESSION_CHANGED" };
    if (close && session.status !== "REPLACED")
      return { status: "SESSION_CHANGED" };
    if (start)
      return {
        status: "RECOVERED",
        sessionId: successorId,
        recoveredFrom: pending.sessionId,
      };
    // Construct/validate before closing anything. Retry after an interrupted
    // CLOSE repairs only the missing START; it never duplicates either row.
    const events = rows_("Events"),
      products = rows_("Products"),
      state = totalState_(events, baselines_());
    const checklist = products
      .filter((p) => p[6] === "YES")
      .map((p) => ({
        id: p[0],
        ru: p[1],
        en: p[2],
        category: p[3],
        unit: p[4],
        sleeve: p[4] === "pcs" && Number(p[5]) === 25,
        previous: state[p[0]]?.q ?? null,
        revision: v5Revision_(p, events, state),
        zones: v8ProductZones_(p),
      }));
    if (!checklist.length) throw Error("NO_ACTIVE_PRODUCTS");
    const payload = JSON.stringify({
      products: checklist,
      recoveryId: id,
      recoveredFrom: pending.sessionId,
    });
    if (payload.length > 45000) throw Error("CHECKLIST_TOO_LARGE");
    if (!close) {
      sheet.appendRow([
        closeId,
        new Date().toISOString(),
        email,
        "CLOSE",
        pending.sessionId,
        fingerprint,
        JSON.stringify({
          status: "REPLACED",
          successorId: successorId,
          recoveryId: id,
          blockedRequestId: pending.id,
        }),
      ]);
      SpreadsheetApp.flush();
    }
    sheet.appendRow([
      successorId,
      new Date().toISOString(),
      email,
      "START",
      successorId,
      webHash_("START_V5"),
      payload,
    ]);
    SpreadsheetApp.flush();
    return {
      status: "RECOVERED",
      sessionId: successorId,
      recoveredFrom: pending.sessionId,
    };
  });
}

// Run once from the editor as owner. No stock, catalog, trigger, or Telegram changes.
function installPwaFeatures() {
  v4Owner_();
  return v3Lock_(() => {
    const book = book_(),
      properties = prop_();
    const header = [
      "ID",
      "Actor",
      "Request SHA256",
      "Kind",
      "Created",
      "State",
      "Result",
    ];
    const existing = book.getSheetByName("PwaOperations");
    if (
      existing &&
      JSON.stringify(existing.getRange(1, 1, 1, 7).getValues()[0]) !==
        JSON.stringify(header)
    )
      throw Error("PWA_OPERATIONS_LAYOUT_CONFLICT");
    if (!existing) {
      const backup = book.copy(
        "VARKA backup before PWA features " + new Date().toISOString(),
      );
      properties.setProperty("PWA_FEATURES_BACKUP_ID", backup.getId());
      v3Sheet_("PwaOperations", header);
    }
    return { ok: true, installed: true };
  });
}

function pwaJournal_() {
  const sheet = book_().getSheetByName("PwaOperations");
  if (!sheet)
    throw Error(
      "PWA_FEATURES_NOT_INSTALLED: run installPwaFeatures from the editor",
    );
  return sheet;
}
function pwaOperationStatus_(token, id) {
  const email = webAuth_(token);
  v3Id_(id);
  return v3Lock_(() => {
    const row = pwaJournal_()
      .getDataRange()
      .getValues()
      .slice(1)
      .find((r) => r[0] === id);
    if (!row) return { status: "ABSENT" };
    if (row[1] !== email) throw Error("OWN_ENTRIES_ONLY");
    return { status: row[5], result: row[6] ? JSON.parse(row[6]) : null };
  });
}
function pwaMutate_(token, request) {
  const email = webAuth_(token),
    id = v3Id_(request.id);
  const allowed = [
    "movement",
    "catalog",
    "reminder",
    "card",
    "profile",
    "settings",
    "correction",
    "expand",
  ];
  if (!allowed.includes(request.kind)) throw Error("METHOD_NOT_ALLOWED");
  const payload = request.payload || {};
  // Preserve request bytes/types and use UTF-8, not the legacy lossy hash.
  const fingerprint = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify([request.kind, payload]),
    Utilities.Charset.UTF_8,
  )
    .map((n) => ("0" + ((n + 256) % 256).toString(16)).slice(-2))
    .join("");
  const reservation = v3Lock_(() => {
    const sheet = pwaJournal_(),
      rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((r, i) => i > 0 && r[0] === id);
    if (index > 0) {
      const row = rows[index];
      if (row[1] !== email || row[2] !== fingerprint || row[3] !== request.kind)
        throw Error("REQUEST_ID_REUSED");
      return {
        replay: true,
        status: row[5],
        result: row[6] ? JSON.parse(row[6]) : null,
      };
    }
    sheet.appendRow([
      id,
      email,
      fingerprint,
      request.kind,
      new Date().toISOString(),
      "UNKNOWN",
      "",
    ]);
    SpreadsheetApp.flush();
    return { index: sheet.getLastRow() };
  });
  if (reservation.replay) return reservation;
  // Never hold the journal lock while entering a legacy function's own lock.
  // A concurrent retry or interrupted execution remains UNKNOWN, not re-executed.
  let result;
  try {
    switch (request.kind) {
      case "movement":
        if (
          !["RECEIVE", "WASTE"].includes(payload.action) ||
          !Array.isArray(payload.items) ||
          payload.items.length !== 1
        )
          result = { rejected: true, error: "INVALID_MOVEMENT" };
        else result = webSave(token, { ...payload, id: id });
        break;
      case "catalog": {
        const saved = webV8SyncProducts(token, { ...payload, id: id });
        result = { ok: true, ids: saved.ids || {} };
        break;
      }
      case "reminder":
        result = webV6Note(token, payload);
        break;
      case "card":
        result = webV6Card(token, { ...payload, operationId: id });
        break;
      case "profile":
        result = webV6SaveProfile(token, payload);
        break;
      case "settings":
        result = webV10SaveSettings(token, payload);
        break;
      case "correction":
        result = webV9CorrectSession(token, { ...payload, id: id });
        break;
      case "expand":
        webV6Expand(token, { sessionId: payload.sessionId });
        result = { ok: true };
        break;
    }
  } catch (error) {
    const reason = String(error.message || error).slice(0, 1000);
    // These particular legacy precondition failures occur before any mutation.
    // Recovery/flush/transport errors are deliberately NOT in this list.
    const precondition =
      /^(CONFLICT(?::|$)|PRODUCT_CONFLICT:|OWNER_ONLY$|OWN_ENTRIES_ONLY$|OWN_SESSION_ONLY$|INVALID_[A-Z_]+$|PRODUCT_NAME_EXISTS$|UNIT_HAS_HISTORY$|DEACTIVATE_BEFORE_DELETE$|CARD_EXISTS$|CARD_NOT_FOUND$|NOTE_NOT_FOUND$|EXISTING_CATEGORY_REQUIRED$|PRODUCT_NOT_FOUND$)/;
    let definitelyRejected =
      precondition.test(reason) ||
      reason === "SIGN_IN_REQUIRED" ||
      /^[A-Z0-9_]+_NOT_INSTALLED$/.test(reason);
    if (request.kind === "catalog" && definitelyRejected) {
      // A catalog call can throw while reading its response AFTER writing.
      // Any durable legacy plan means the owner may need to reconcile it.
      definitelyRejected = v3Lock_(() => {
        const sheet = book_().getSheetByName("ProductSync");
        return (
          !!sheet &&
          !sheet
            .getDataRange()
            .getValues()
            .slice(1)
            .some((row) => row[0] === id)
        );
      });
    }
    if (definitelyRejected) result = { rejected: true, error: reason };
    else {
      // Legacy calls can throw after a partial/complete external write. Never call
      // every exception a rollback and never automatically repeat it.
      return { status: "UNKNOWN", result: { error: reason } };
    }
  }
  const json = JSON.stringify(result);
  if (json.length > 45000)
    return { status: "UNKNOWN", result: { error: "RESULT_TOO_LARGE" } };
  const status = result && result.rejected ? "REJECTED" : "COMMITTED";
  v3Lock_(() => {
    pwaJournal_()
      .getRange(reservation.index, 6, 1, 2)
      .setValues([[status, json]]);
    SpreadsheetApp.flush();
  });
  return { status: status, result: result };
}

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
    if (!request || JSON.stringify(request).length > 60000)
      throw Error("INVALID_REQUEST");
    const writes =
      PropertiesService.getScriptProperties().getProperty(
        "PWA_WRITES_ENABLED",
      ) === "true";
    const body = request.body || {};
    let result;
    switch (request.method) {
      case "ping":
        result = { protocol: 1, writesEnabled: writes };
        break;
      case "login":
        result = webLogin(body.email, body.code);
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

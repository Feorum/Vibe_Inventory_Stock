const PROTOCOL = "varka-google-1";
export const googleOrigin = (value) =>
  /^https:\/\/(?:script|[a-z0-9-]+-script)\.googleusercontent\.com$/.test(
    value,
  );

export function deploymentUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== "https://script.google.com" ||
    !/^\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error(
      "Use the deployed Apps Script /exec URL, without query parameters.",
    );
  return url;
}

export class GoogleTransport {
  constructor(endpoint, { timeout = 45000 } = {}) {
    this.endpoint = deploymentUrl(endpoint);
    this.timeout = timeout;
    this.channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    this.pending = new Map();
    this.listener = (event) => this.receive(event);
    window.addEventListener("message", this.listener);
    this.frame = document.createElement("iframe");
    this.frame.title = "Google Sheets connection";
    this.frame.hidden = true;
    this.frame.referrerPolicy = "no-referrer";
    this.endpoint.searchParams.set("pwa", "bridge");
    this.endpoint.searchParams.set("channel", this.channel);
    this.frame.src = this.endpoint.href;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = setTimeout(() => {
        this.rejectReady(
          Error(
            "Google connection timed out. Check deployment access, PWA_ORIGIN, and browser privacy settings.",
          ),
        );
      }, timeout);
    });
    // Callers always await this.ready; avoid an unhandled rejection during setup.
    this.ready.catch(() => {});
    document.body.append(this.frame);
  }
  receive(event) {
    const message = event.data;
    if (
      !googleOrigin(event.origin) ||
      !message ||
      message.channel !== this.channel ||
      message.protocol !== PROTOCOL ||
      !event.source
    )
      return;
    if (message.type === "ready" && !this.peer) {
      this.peer = event.source;
      this.origin = event.origin;
      clearTimeout(this.readyTimer);
      this.resolveReady();
      return;
    }
    if (
      event.source !== this.peer ||
      event.origin !== this.origin ||
      message.type !== "response"
    )
      return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    const result = message.result;
    if (result?.ok) entry.resolve(result.data);
    else entry.reject(Error(result?.error || "GOOGLE_REQUEST_FAILED"));
  }
  async call(method, body = {}, token) {
    await this.ready;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Error(
            "Connection interrupted. A write may have committed; use Retry safely, not a new submission.",
          ),
        );
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.peer.postMessage(
        {
          protocol: PROTOCOL,
          type: "request",
          channel: this.channel,
          id,
          request: { method, body, token },
        },
        this.origin,
      );
    });
  }
  destroy() {
    clearTimeout(this.readyTimer);
    this.rejectReady(Error("Connection closed."));
    window.removeEventListener("message", this.listener);
    this.frame.remove();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error("Connection closed."));
    }
    this.pending.clear();
  }
}

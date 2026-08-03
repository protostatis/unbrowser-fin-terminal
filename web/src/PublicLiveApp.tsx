import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type AdmissionState = "queued" | "admitted" | "active" | "ended";

type Admission = {
  status: AdmissionState;
  queuePosition?: number;
  sessionExpiresAt?: number;
  idleExpiresAt?: number;
  reason?: string;
  ticketToken?: string;
};

type PublicConfig = {
  visitorToken: string;
  turnstileSiteKey: string;
  turnstileRequired: boolean;
  ticketTtlMs: number;
  maxSessionMs: number;
  maxResearchRuns: number;
};

type TurnstileApi = {
  render(container: HTMLElement, options: {
    sitekey: string;
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
    action: "public_terminal_admission";
    theme: "dark";
  }): string;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileLoad: Promise<TurnstileApi> | undefined;
const VISITOR_STORAGE_KEY = "fin-terminal-public-visitor";
const TICKET_STORAGE_KEY = "fin-terminal-public-ticket";

function apiPath(path: string): string {
  const base = import.meta.env.BASE_URL === "/"
    ? ""
    : import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${path}`;
}

function storedToken(key: string): string | undefined {
  try {
    return window.sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeToken(key: string, value: string | undefined): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be disabled; the current page can still complete admission.
  }
}

function publicHeaders(includeTicket = false): HeadersInit {
  const visitor = storedToken(VISITOR_STORAGE_KEY);
  const ticket = storedToken(TICKET_STORAGE_KEY);
  return {
    ...(visitor ? { "X-Public-Visitor-Token": visitor } : {}),
    ...(includeTicket && ticket ? { "X-Public-Ticket-Token": ticket } : {}),
  };
}

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoad) return turnstileLoad;
  turnstileLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not initialize"));
    script.onerror = () => reject(new Error("Turnstile could not load"));
    document.head.append(script);
  });
  return turnstileLoad;
}

async function readJson<T>(response: Response): Promise<T | undefined> {
  try {
    return await response.json() as T;
  } catch {
    return undefined;
  }
}

function endMessage(reason?: string): string {
  switch (reason) {
    case "daily-budget-exhausted":
      return "Today’s public research capacity is allocated. Please return after the daily reset.";
    case "idle-timeout":
      return "Your session ended after five minutes without terminal activity.";
    case "absolute-timeout":
      return "Your fifteen-minute public terminal session has ended.";
    case "worker-unavailable":
      return "The assigned terminal worker restarted. You can request a fresh session.";
    case "rate-limited":
      return "This session exceeded the public terminal activity limit. You can request a fresh session.";
    case "protocol-violation":
      return "This session sent an unsupported terminal message and was closed for safety.";
    default:
      return "This public terminal session is no longer available. Request a new seat to continue.";
  }
}

/**
 * Turnstile-gated public entrypoint. The real terminal is not mounted until
 * the gateway signs a ticket and assigns an isolated live Pi worker.
 */
export function PublicLiveApp({
  renderTerminal,
}: {
  renderTerminal: (onSessionEnd: () => void, sessionProtocol: string) => ReactNode;
}) {
  const [config, setConfig] = useState<PublicConfig>();
  const [admission, setAdmission] = useState<Admission>();
  const [challengeToken, setChallengeToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [joining, setJoining] = useState(false);
  const captchaRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string>();

  const checkExistingTicket = useCallback(async () => {
    const response = await fetch(apiPath("/api/public/admission/status"), {
      headers: publicHeaders(true),
      cache: "no-store",
    });
    if (!response.ok) return;
    const next = await readJson<Admission>(response);
    if (next) setAdmission(next);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void fetch(apiPath("/api/public/config"), {
      headers: publicHeaders(),
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Public terminal admission is unavailable");
      const next = await readJson<PublicConfig>(response);
      if (!next?.visitorToken || (next.turnstileRequired && !next.turnstileSiteKey)) {
        throw new Error("Public terminal admission is unavailable");
      }
      storeToken(VISITOR_STORAGE_KEY, next.visitorToken);
      if (active) setConfig(next);
    }).then(() => checkExistingTicket()).catch((reason: unknown) => {
      if (active && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Public terminal admission is unavailable");
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [checkExistingTicket]);

  useEffect(() => {
    if (!config || !config.turnstileRequired || admission || !captchaRef.current) return;
    let active = true;
    void loadTurnstile().then((turnstile) => {
      if (!active || !captchaRef.current) return;
      widgetIdRef.current = turnstile.render(captchaRef.current, {
        sitekey: config.turnstileSiteKey,
        action: "public_terminal_admission",
        theme: "dark",
        callback: (token) => {
          setChallengeToken(token);
          setError(undefined);
        },
        "error-callback": () => setError("Verification could not load. Please retry."),
        "expired-callback": () => setChallengeToken(undefined),
      });
    }).catch(() => setError("Verification could not load. Please retry."));
    return () => {
      active = false;
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = undefined;
    };
  }, [admission, config]);

  useEffect(() => {
    if (admission?.status !== "queued") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(apiPath("/api/public/admission/status"), {
          headers: publicHeaders(true),
          cache: "no-store",
        });
        const next = await readJson<Admission>(response);
        if (!active) return;
        if (!response.ok || !next) {
          setAdmission({ status: "ended", reason: "ticket-expired" });
          return;
        }
        setAdmission(next);
        if (next.status === "queued") timer = setTimeout(() => void poll(), 2_000);
      } catch {
        if (active) timer = setTimeout(() => void poll(), 3_000);
      }
    };
    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [admission?.status]);

  const join = async () => {
    if ((!challengeToken && config?.turnstileRequired) || joining) return;
    setJoining(true);
    setError(undefined);
    try {
      const response = await fetch(apiPath("/api/public/admission"), {
        method: "POST",
        headers: { "content-type": "application/json", ...publicHeaders() },
        body: JSON.stringify({ turnstileToken: challengeToken ?? "" }),
      });
      const next = await readJson<Admission & { error?: string }>(response);
      if (!response.ok || !next) {
        setError(next?.error === "queue-full"
          ? "The public waiting room is full. Please try again shortly."
          : "Verification failed. Please complete the challenge again.");
        widgetIdRef.current && window.turnstile?.reset(widgetIdRef.current);
        setChallengeToken(undefined);
        return;
      }
      if (!next.ticketToken) {
        setError("Public terminal admission is unavailable. Please retry.");
        return;
      }
      storeToken(TICKET_STORAGE_KEY, next.ticketToken);
      setAdmission(next);
    } catch {
      setError("Public terminal admission is unavailable. Please retry.");
    } finally {
      setJoining(false);
    }
  };

  const reset = () => {
    storeToken(TICKET_STORAGE_KEY, undefined);
    setAdmission(undefined);
    setChallengeToken(undefined);
    setError(undefined);
    widgetIdRef.current && window.turnstile?.reset(widgetIdRef.current);
  };

  const ticketToken = admission?.ticketToken ?? storedToken(TICKET_STORAGE_KEY);
  if ((admission?.status === "admitted" || admission?.status === "active") && ticketToken) {
    return (
      <>
        {renderTerminal(() => {
          storeToken(TICKET_STORAGE_KEY, undefined);
          setAdmission({ status: "ended", reason: "session-ended" });
        }, `fin-terminal-session.${ticketToken}`)}
        <div className="public-session-banner" role="status">
          PUBLIC LIVE SESSION · UP TO {config?.maxResearchRuns ?? 5} RESEARCH RUNS · 15 MIN MAX
        </div>
      </>
    );
  }

  return (
    <main className="public-admission" aria-live="polite">
      <section className="public-admission-card">
        <div className="public-admission-kicker">SIGNAL // PUBLIC LIVE TERMINAL</div>
        <h1>Request a live Pi session</h1>
        {admission?.status === "queued" ? (
          <>
            <p className="public-admission-state">WAITING ROOM · POSITION {admission.queuePosition ?? "—"}</p>
            <p>
              A clean terminal worker is being assigned. Keep this page open; your verified ticket expires after ten minutes.
            </p>
          </>
        ) : admission?.status === "ended" ? (
          <>
            <p className="public-admission-state public-admission-state-warning">SESSION ENDED</p>
            <p>{endMessage(admission.reason)}</p>
            <button type="button" className="public-admission-action" onClick={reset}>Request another session</button>
          </>
        ) : (
          <>
            <p>
              You will receive a fresh, isolated terminal for up to 15 minutes. Research is live, limited to five runs, and is not financial advice.
            </p>
            {config?.turnstileRequired ? (
              <div ref={captchaRef} className="public-turnstile" aria-label="Human verification" />
            ) : (
              <p className="public-admission-state">LOCAL DEVELOPMENT ADMISSION</p>
            )}
            <button
              type="button"
              className="public-admission-action"
              disabled={!config || (config.turnstileRequired && !challengeToken) || joining}
              onClick={() => void join()}
            >
              {joining ? "VERIFYING…" : "ENTER WAITING ROOM"}
            </button>
          </>
        )}
        {error && <p className="public-admission-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}

function browserBasePath(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base === "/" ? "" : base.replace(/\/$/, "");
}

export function BrowserDiscovery() {
  const base = browserBasePath();
  const terminalHref = `${base}/terminal/`;

  return (
    <div className="browser-discovery">
      <header className="discovery-nav">
        <a className="discovery-brand" href={base || "/"} aria-label="Unbrowser financial terminal home">
          <span className="discovery-brand-mark" aria-hidden="true">◒</span>
          <span>UNBROWSER <b>/</b> FIN TERMINAL</span>
        </a>
        <div className="discovery-nav-meta">
          <span className="discovery-live-dot" aria-hidden="true" />
          BROWSER-OWNED WORKSPACE
        </div>
      </header>

      <main className="discovery-main">
        <section className="discovery-hero" aria-labelledby="discovery-title">
          <div className="discovery-hero-copy">
            <p className="discovery-kicker">A focused market read, not a noisy dashboard</p>
            <h1 id="discovery-title">See what moved.<br /><em>Understand why.</em></h1>
            <p className="discovery-lede">
              A keyboard-first market workspace for live quotes, technical context,
              and evidence-led research — built to help you decide what deserves
              your attention next.
            </p>
            <div className="discovery-actions">
              <a className="discovery-primary" href="/">
                <span>Sign in to open workspace</span>
                <span aria-hidden="true">↗</span>
              </a>
              <a className="discovery-secondary" href="/fin-terminal-live-pilot/">
                Try the public demo <span aria-hidden="true">→</span>
              </a>
            </div>
            <p className="discovery-auth-note">
              New here? Explore the demo first. Already signed in? <a href={terminalHref}>Open your workspace</a>.
            </p>
          </div>

          <div className="discovery-terminal-preview" aria-label="Illustrated market terminal preview">
            <div className="discovery-preview-topline">
              <span>MARKET MAP</span>
               <span className="discovery-preview-live">SAMPLE // DELAYED DATA</span>
            </div>
            <div className="discovery-preview-index">
              <span className="discovery-preview-label">S&amp;P 500</span>
              <strong>5,648.40</strong>
              <span className="discovery-positive">+0.62%</span>
            </div>
            <div className="discovery-preview-chart" aria-hidden="true">
              <span className="chart-line chart-line-back" />
              <span className="chart-line chart-line-front" />
              <span className="chart-axis chart-axis-one" />
              <span className="chart-axis chart-axis-two" />
            </div>
            <div className="discovery-preview-grid">
              <div><span>NVDA</span><strong className="discovery-positive">+4.81%</strong></div>
              <div><span>BTC-USD</span><strong className="discovery-positive">+2.14%</strong></div>
              <div><span>TSLA</span><strong className="discovery-negative">-1.07%</strong></div>
              <div><span>EURUSD</span><strong>+0.18%</strong></div>
            </div>
            <div className="discovery-preview-footer">
              <span><b>J</b> brief</span>
              <span><b>K</b> why</span>
              <span><b>Tab</b> panes</span>
            </div>
          </div>
        </section>

        <section className="discovery-proof" aria-label="Workspace capabilities">
          <article>
            <span className="discovery-card-number">01</span>
            <h2>Start with the map</h2>
            <p>Scan global, crypto, movers, signals, events, and your watchlist in one compact view.</p>
          </article>
          <article>
            <span className="discovery-card-number">02</span>
            <h2>Open the context</h2>
            <p>Move from a ticker to technicals, news, scenarios, and source packets without losing your place.</p>
          </article>
          <article>
            <span className="discovery-card-number">03</span>
            <h2>Keep the read</h2>
            <p>Your signed-in workspace keeps watchlists and research history scoped to your account.</p>
          </article>
        </section>

        <section className="discovery-bottom">
          <p><span aria-hidden="true">⌁</span> Designed for keyboard, touch, and the five-minute glance between meetings.</p>
          <a href="/">Learn more about Unbrowser <span aria-hidden="true">↗</span></a>
        </section>
      </main>
    </div>
  );
}

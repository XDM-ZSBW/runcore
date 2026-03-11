/**
 * Search Flyout — Gemini-powered quick search modal.
 *
 * A small, mobile-search-sized popup for looking something up fast.
 * Opens with Ctrl+K (or Cmd+K on Mac), or via window.openSearchFlyout().
 * Self-contained: injects its own styles and DOM on first use.
 *
 * Usage: <script src="/search-flyout.js"></script>
 */
(function () {
  "use strict";

  let overlay = null;
  let input = null;
  let resultsEl = null;
  let statusEl = null;
  let abortController = null;

  function getSessionId() {
    return window.sessionId || localStorage.getItem("sessionId") || "";
  }

  function authHeaders() {
    var h = {};
    var t = localStorage.getItem("authToken");
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  function injectStyles() {
    if (document.getElementById("search-flyout-styles")) return;
    var style = document.createElement("style");
    style.id = "search-flyout-styles";
    style.textContent = `
      .search-flyout-overlay {
        position: fixed;
        inset: 0;
        z-index: 9500;
        display: none;
        align-items: flex-start;
        justify-content: center;
        padding-top: min(20vh, 120px);
        background: rgba(0,0,0,0.5);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      .search-flyout-overlay.open {
        display: flex;
      }
      .search-flyout {
        width: 420px;
        max-width: 92vw;
        max-height: 70vh;
        background: #1a1a1f;
        border: 1px solid #2a2a33;
        border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: search-flyout-in 0.15s ease-out;
      }
      @keyframes search-flyout-in {
        from { opacity: 0; transform: translateY(-12px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .search-flyout-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid #2a2a33;
      }
      .search-flyout-icon {
        width: 20px;
        height: 20px;
        opacity: 0.5;
        flex-shrink: 0;
      }
      .search-flyout-input {
        flex: 1;
        background: none;
        border: none;
        outline: none;
        color: #e0e0e0;
        font-size: 15px;
        font-family: inherit;
        line-height: 1.4;
      }
      .search-flyout-input::placeholder {
        color: #555;
      }
      .search-flyout-kbd {
        font-size: 11px;
        color: #555;
        background: #252530;
        padding: 2px 6px;
        border-radius: 4px;
        border: 1px solid #333;
        flex-shrink: 0;
      }
      .search-flyout-body {
        flex: 1;
        overflow-y: auto;
        padding: 0;
        scrollbar-width: thin;
        scrollbar-color: #333 transparent;
      }
      .search-flyout-status {
        padding: 24px 16px;
        text-align: center;
        color: #555;
        font-size: 13px;
      }
      .search-flyout-status.error {
        color: #e57373;
      }
      .search-flyout-answer {
        padding: 14px 16px;
        color: #ccc;
        font-size: 14px;
        line-height: 1.6;
      }
      .search-flyout-answer p {
        margin: 0 0 8px;
      }
      .search-flyout-answer p:last-child {
        margin-bottom: 0;
      }
      .search-flyout-answer strong, .search-flyout-answer b {
        color: #e0e0e0;
      }
      .search-flyout-answer code {
        background: #252530;
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 13px;
      }
      .search-flyout-sources {
        border-top: 1px solid #2a2a33;
        padding: 10px 16px 14px;
      }
      .search-flyout-sources-label {
        font-size: 11px;
        color: #555;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .search-flyout-source {
        display: block;
        color: #7c6fef;
        text-decoration: none;
        font-size: 13px;
        padding: 3px 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .search-flyout-source:hover {
        color: #9d93f7;
        text-decoration: underline;
      }
      .search-flyout-loading {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid #333;
        border-top-color: #7c6fef;
        border-radius: 50%;
        animation: search-spin 0.6s linear infinite;
        margin-right: 8px;
        vertical-align: middle;
      }
      @keyframes search-spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function injectDOM() {
    if (overlay) return;
    injectStyles();

    overlay = document.createElement("div");
    overlay.className = "search-flyout-overlay";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeFlyout();
    });

    overlay.innerHTML = `
      <div class="search-flyout">
        <div class="search-flyout-header">
          <svg class="search-flyout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="search-flyout-input" type="text" placeholder="Search with Gemini..." autocomplete="off" spellcheck="false" />
          <span class="search-flyout-kbd">esc</span>
        </div>
        <div class="search-flyout-body">
          <div class="search-flyout-status">Type a question and press Enter</div>
          <div class="search-flyout-results" style="display:none"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    input = overlay.querySelector(".search-flyout-input");
    resultsEl = overlay.querySelector(".search-flyout-results");
    statusEl = overlay.querySelector(".search-flyout-status");

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim()) {
        e.preventDefault();
        doSearch(input.value.trim());
      }
      if (e.key === "Escape") {
        closeFlyout();
      }
    });
  }

  function openFlyout() {
    injectDOM();
    overlay.classList.add("open");
    input.value = "";
    resultsEl.style.display = "none";
    resultsEl.innerHTML = "";
    statusEl.style.display = "";
    statusEl.className = "search-flyout-status";
    statusEl.textContent = "Type a question and press Enter";
    setTimeout(function () { input.focus(); }, 50);
  }

  function closeFlyout() {
    if (!overlay) return;
    overlay.classList.remove("open");
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  async function doSearch(query) {
    if (abortController) abortController.abort();
    abortController = new AbortController();

    statusEl.style.display = "";
    statusEl.className = "search-flyout-status";
    statusEl.innerHTML = '<span class="search-flyout-loading"></span>Searching...';
    resultsEl.style.display = "none";
    resultsEl.innerHTML = "";

    try {
      var res = await fetch("/api/search/gemini?sessionId=" + encodeURIComponent(getSessionId()), {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify({ query: query }),
        signal: abortController.signal,
      });

      var data = await res.json();

      if (!data.ok) {
        statusEl.className = "search-flyout-status error";
        statusEl.textContent = data.message || "Search failed";
        return;
      }

      statusEl.style.display = "none";
      resultsEl.style.display = "";

      // Render answer
      var answerHtml = '<div class="search-flyout-answer">';
      // Simple markdown-ish rendering: bold, code, paragraphs
      var text = data.answer || "No answer returned.";
      text = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/`(.*?)`/g, "<code>$1</code>")
        .replace(/\n\n+/g, "</p><p>")
        .replace(/\n/g, "<br>");
      answerHtml += "<p>" + text + "</p>";
      answerHtml += "</div>";

      // Render sources
      if (data.sources && data.sources.length > 0) {
        answerHtml += '<div class="search-flyout-sources">';
        answerHtml += '<div class="search-flyout-sources-label">Sources</div>';
        for (var i = 0; i < data.sources.length && i < 5; i++) {
          var s = data.sources[i];
          var title = (s.title || s.url).replace(/&/g, "&amp;").replace(/</g, "&lt;");
          var href = s.url.replace(/"/g, "&quot;");
          answerHtml += '<a class="search-flyout-source" href="' + href + '" target="_blank" rel="noopener">' + title + "</a>";
        }
        answerHtml += "</div>";
      }

      resultsEl.innerHTML = answerHtml;
    } catch (err) {
      if (err.name === "AbortError") return;
      statusEl.className = "search-flyout-status error";
      statusEl.textContent = err.message || "Search failed";
    }
  }

  // Keyboard shortcut: Ctrl+K / Cmd+K
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      if (overlay && overlay.classList.contains("open")) {
        closeFlyout();
      } else {
        openFlyout();
      }
    }
  });

  // Global API
  window.openSearchFlyout = openFlyout;
  window.closeSearchFlyout = closeFlyout;
})();

// Share Core modal — self-contained, loaded by all pages via <script src="/share-modal.js">
(function() {
  // Inject CSS (includes gear-btn styles for pages that don't define them)
  const style = document.createElement('style');
  style.textContent = `
    .gear-btn {
      background: none;
      border: none;
      color: #8b8b94;
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: all 0.15s;
      line-height: 1;
      text-decoration: none;
    }
    .gear-btn:hover { color: #e4e4e7; background: #2e2e33; }
    a.gear-btn { text-decoration: none; }
    .header-actions-right {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .share-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 9000;
      align-items: center;
      justify-content: center;
    }
    .share-overlay.open { display: flex; }
    .share-modal {
      background: #18181b;
      border: 1px solid #2e2e33;
      border-radius: 12px;
      padding: 24px;
      width: 420px;
      max-width: 90vw;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .share-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .share-modal-header h2 {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
    }
    .share-modal-close {
      background: none;
      border: none;
      color: #8b8b94;
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .share-modal-close:hover { color: #e4e4e7; background: #2e2e33; }
    .share-modal p {
      font-size: 13px;
      color: #8b8b94;
      margin: 0 0 16px 0;
      line-height: 1.5;
    }
    .share-modal label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: #8b8b94;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .share-modal input, .share-modal textarea {
      width: 100%;
      background: #0e0e10;
      border: 1px solid #2e2e33;
      border-radius: 6px;
      padding: 8px 12px;
      color: #e4e4e7;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      margin-bottom: 12px;
      box-sizing: border-box;
    }
    .share-modal input:focus, .share-modal textarea:focus { border-color: #6d5dfc; }
    .share-modal textarea { resize: vertical; min-height: 60px; }
    .share-send-btn {
      width: 100%;
      background: #6d5dfc;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .share-send-btn:hover { opacity: 0.9; }
    .share-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .share-msg {
      margin-top: 12px;
      font-size: 13px;
      padding: 8px 12px;
      border-radius: 6px;
      display: none;
    }
    .share-msg.success { display: block; background: rgba(34,197,94,0.12); color: #22c55e; }
    .share-msg.error { display: block; background: rgba(239,68,68,0.12); color: #ef4444; }
  `;
  document.head.appendChild(style);

  // Inject HTML
  const overlay = document.createElement('div');
  overlay.className = 'share-overlay';
  overlay.id = 'shareOverlay';
  overlay.innerHTML = `
    <div class="share-modal">
      <div class="share-modal-header">
        <h2>Share Core</h2>
        <button class="share-modal-close" id="shareCloseBtn">&times;</button>
      </div>
      <p>Share your Core install with someone. They'll get an email with setup instructions.</p>
      <label for="shareEmail">Email</label>
      <input type="email" id="shareEmail" placeholder="friend@example.com" />
      <label for="shareNote">Note (optional)</label>
      <textarea id="shareNote" placeholder="Hey, check this out..."></textarea>
      <button class="share-send-btn" id="shareSendBtn">Send Invite</button>
      <div class="share-msg" id="shareMsg"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Wire events
  const closeBtn = document.getElementById('shareCloseBtn');
  const sendBtn = document.getElementById('shareSendBtn');
  const emailInput = document.getElementById('shareEmail');
  const noteInput = document.getElementById('shareNote');
  const msgEl = document.getElementById('shareMsg');

  function closeShareModal() {
    overlay.classList.remove('open');
    msgEl.className = 'share-msg';
    msgEl.textContent = '';
    emailInput.value = '';
    noteInput.value = '';
    sendBtn.disabled = false;
  }

  closeBtn.addEventListener('click', closeShareModal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeShareModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeShareModal();
  });

  sendBtn.addEventListener('click', async function() {
    var email = emailInput.value.trim();
    if (!email) { emailInput.focus(); return; }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    msgEl.className = 'share-msg';
    msgEl.textContent = '';

    try {
      var res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, note: noteInput.value.trim() || undefined }),
      });
      var data = await res.json();
      if (data.ok) {
        msgEl.className = 'share-msg success';
        msgEl.textContent = 'Invite sent to ' + email;
        emailInput.value = '';
        noteInput.value = '';
      } else {
        msgEl.className = 'share-msg error';
        msgEl.textContent = data.error || 'Failed to send invite';
      }
    } catch (err) {
      msgEl.className = 'share-msg error';
      msgEl.textContent = 'Network error — is the server running?';
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Invite';
    }
  });

  // Enter key in email field triggers send
  emailInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendBtn.click();
  });

  // Global function for opening
  window.openShareModal = function() {
    overlay.classList.add('open');
    emailInput.focus();
  };
})();

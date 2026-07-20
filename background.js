// Passively observes the Statements page's own calls to generate-pro-report so we can
// learn `profile_id`/`email`/`proof_token` without asking the user to dig through DevTools.
// Non-blocking: we only read requestBody, never modify or cancel anything here.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.requestBody || !details.requestBody.raw) {
      return;
    }
    try {
      const decoder = new TextDecoder('utf-8');
      const raw = details.requestBody.raw[0].bytes;
      const json = JSON.parse(decoder.decode(raw));
      if (json.profile_id && json.email) {
        browser.storage.local.set({
          template: {
            email: json.email,
            profile_id: json.profile_id,
            proof_token: json.proof_token || '',
          },
        });
      }
    } catch (e) {
      // ignore malformed/unrelated bodies
    }
  },
  { urls: ['https://accounts.coinbase.com/v1/statements/generate-pro-report'] },
  ['requestBody']
);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'download') {
    return browser.downloads.download({
      url: message.url,
      filename: message.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    }).then((downloadId) => ({ ok: true, downloadId }))
      .catch((error) => ({ ok: false, error: String(error) }));
  }
  if (message.action === 'checkDownloaded') {
    // filename passed to downloads.download() is relative to the Downloads dir; downloads.search
    // only exposes the resolved absolute path, so match on the relative path as a suffix instead.
    const pattern = escapeRegExp(message.relPath) + '$';
    return browser.downloads.search({ filenameRegex: pattern, state: 'complete' })
      .then((results) => ({ exists: results.length > 0 }))
      .catch(() => ({ exists: false }));
  }
  return undefined;
});

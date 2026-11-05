(function initializeImportStatus(root) {
  'use strict';
  const FSD = root.FinancialStatementDownloader || {};
  const accountName = (settings) => settings.userName || (settings.userId ? `Account ${settings.userId}` : 'pfifi.com');
  const time = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function describe(snapshot, now = Date.now()) {
    const { settings, records } = snapshot;
    const queue = snapshot.queue || {};
    const pending = queue.pendingCount ?? records.filter((record) => record.status === 'local' && record.userId === settings.userId).length;
    const held = records.filter((record) => record.status !== 'received').length;
    const name = accountName(settings);
    const due = settings.retryAt > now ? settings.retryAt : null;
    const base = { name, pending, held, pause: false, resume: false, connect: false, open: false, review: false, allow: false,
      sync: false, waitingUntil: due ? time(due) : null };
    if (settings.stopReason) {
      const stopped = {
        sign_in: { text: `Sign in to pfifi.com to keep sending. ${held} receipts are safe here.`, resume: true, open: true },
        account_changed: { text: 'pfifi.com is signed in to a different account. Nothing was sent.', review: true },
        permission: { text: "This account can't accept receipts. Check you're using your own account, not one shared with you.", open: true },
        access_revoked: { text: 'Access to pfifi.com was turned off in Firefox.', allow: true },
      };
      return { ...base, phase: 'Stopped', ...stopped[settings.stopReason], text: stopped[settings.stopReason]?.text || settings.lastError || 'Imports stopped. Open settings to review.', detail: `Destination: ${name}` };
    }
    if (queue.phase === 'pausing') return { ...base, phase: 'Pausing', text: 'Finishing the batch already on its way. No new batches will start.' };
    if (!settings.userId) return { ...base, phase: 'Not connected', connect: true, text: 'Connect to pfifi.com to send saved receipts. They are safe here until you connect.' };
    if (!settings.enabled) return { ...base, phase: 'Paused', resume: true, text: 'Paused by you. New receipts save here and wait.', detail: `Destination: ${name}` };
    if (due) return { ...base, phase: settings.retryKind === 'transient' ? 'Retrying' : 'Waiting', pause: true,
      text: settings.retryKind === 'transient' ? `Can't reach pfifi.com right now. Trying again around ${time(due)}.`
        : `pfifi.com asked us to slow down. Trying again around ${time(due)}. Nothing's lost.` };
    if (queue.phase === 'sending') return { ...base, phase: 'Sending', pause: true,
      text: `Sending batch of ${queue.batchCount || 0}. ${queue.remainingCount ?? Math.max(0, pending - (queue.batchCount || 0))} more after this.` };
    if (pending) return { ...base, phase: 'Waiting to send', pause: true, sync: true, text: `${pending} receipts waiting to send.`, detail: `Destination: ${name}` };
    const refused = records.filter((record) => record.status === 'refused').length;
    if (refused) return { ...base, phase: 'Needs attention', pause: true,
      text: `${refused} refused ${refused === 1 ? 'receipt stays' : 'receipts stay'} here with the reason below. Other receipts keep sending.`, detail: `Destination: ${name}` };
    return { ...base, phase: 'All sent', pause: true, sync: true,
      text: `Everything is on pfifi.com.${settings.lastSentAt ? ` Last sent at ${time(settings.lastSentAt)}.` : ''}`, detail: `Destination: ${name}` };
  }
  FSD.importStatus = { describe, accountName };
  root.FinancialStatementDownloader = FSD;
})(globalThis);

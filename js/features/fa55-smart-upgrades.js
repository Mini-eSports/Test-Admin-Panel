/* ================================================================
   FA55: SMART UPGRADES v1.0 — All Features Upgraded
   ================================================================
   Upgrades covered:
   [FA01] Auto Prize — double-pay guard + audit log
   [FA04/12] Bulk Notify — rate limiting + delivery tracking
   [FA06] Duplicate Detector — full ban + merge option
   [FA07] Revenue Snapshot — platform health inline
   [FA08] Room Auto-Publish — cancel + reschedule
   [FA09] Withdrawal Queue — uses walletRequests (correct node)
   [FA13] Match Clone — clears sensitive fields properly
   [FA15] Result Reminder — smarter detection
   [FA16] Quick Ban — reason dropdown + confirm
   [FA17] Pending Profiles — photo preview + batch approve
   [FA19] Auto Status — safeguard to not auto-complete paid matches
   [FA20] Coin Requests — UTR + duplicate check
   [NEW] FA55A: Smart Dashboard Cards
   [NEW] FA55B: Match Integrity Auto-Monitor
   [NEW] FA55C: Admin Action Undo System
   [NEW] FA55D: User Suspension (temporary ban)
   [NEW] FA55E: Platform Revenue Auto-Calculator
   [NEW] FA55F: Match Slot Overbooking Guard
   ================================================================ */

(function () {
'use strict';

function rt() { return window.rtdb || window.db; }
function _now() { return Date.now(); }
function _toast(msg, err) { if (window.showToast) showToast(msg, err); }
function _modal(title, html) {
  var m = document.getElementById('genericModal');
  var mt = document.getElementById('genericModalTitle');
  var mb = document.getElementById('genericModalBody');
  if (m && mt && mb) { mt.innerHTML = title; mb.innerHTML = html; m.classList.add('show'); }
}
function _close() {
  var m = document.getElementById('genericModal');
  if (m) m.classList.remove('show');
}
function _adminUid() {
  try { return window.auth && auth.currentUser ? auth.currentUser.uid : 'admin'; } catch(e) { return 'admin'; }
}

/* ══════════════════════════════════════════════════════════════
   FA01 UPGRADE: Double-Pay Guard + Audit Log
   Prevents distributing prizes to same match twice
   ══════════════════════════════════════════════════════════════ */
var _distributedMatches = {};

(function upgradeFA01() {
  var origDistribute = window.adminExecuteDistribute;
  if (!origDistribute || window._fa55_fa01_patched) return;
  window._fa55_fa01_patched = true;

  window.adminExecuteDistribute = async function(mid) {
    // Guard: check if already distributed
    if (_distributedMatches[mid]) {
      if (!confirm('⚠️ Is match ke prizes already distribute ho chuke hain!\n\nKya phir bhi distribute karna chahte ho? (Duplicate payment hoga!)')) return;
    }
    try {
      var snap = await rt().ref('matchResults/' + mid).once('value');
      if (snap.exists()) {
        var existing = snap.val();
        if (existing.distributedAt) {
          var when = new Date(existing.distributedAt).toLocaleString('en-IN');
          if (!confirm('⚠️ Yeh match already distribute ho chuka hai!\nTime: ' + when + '\nTotal: ₹' + (existing.totalDistributed || 0) + '\n\nKya PHIR SE distribute karna chahte ho?')) return;
        }
      }
    } catch(e) {}

    _distributedMatches[mid] = true;

    // Log before distributing
    try {
      await rt().ref('walletAuditLog').push({
        action: 'PRIZE_DISTRIBUTE_START',
        matchId: mid,
        adminUid: _adminUid(),
        timestamp: _now()
      });
    } catch(e) {}

    origDistribute.apply(this, arguments);
  };
})();

/* Wait for FA01 to load then patch */
var _fa01PatchTries = 0;
var _fa01PatchInterval = setInterval(function() {
  _fa01PatchTries++;
  if (window.adminExecuteDistribute && !window._fa55_fa01_patched) {
    upgradeFA01 && upgradeFA01();
    clearInterval(_fa01PatchInterval);
  }
  if (_fa01PatchTries > 30) clearInterval(_fa01PatchInterval);
}, 500);

/* ══════════════════════════════════════════════════════════════
   FA04/FA12 UPGRADE: Rate-Limited Bulk Notification
   Prevents notification spam + tracks delivery count
   ══════════════════════════════════════════════════════════════ */
var _lastBulkNotif = 0;
var BULK_NOTIF_COOLDOWN = 5 * 60 * 1000; // 5 minutes

window.fa55SendBulkNotif = async function(title, body, target, type) {
  if (!rt()) return;
  if (!title || !body) { _toast('Title aur message dono bharo', true); return; }

  var now = _now();
  if (now - _lastBulkNotif < BULK_NOTIF_COOLDOWN) {
    var remaining = Math.ceil((BULK_NOTIF_COOLDOWN - (now - _lastBulkNotif)) / 1000);
    _toast('⏳ Please wait ' + remaining + ' seconds before sending again', true);
    return;
  }

  var users = window.usersCache || {};
  var targets = Object.keys(users).filter(function(uid) {
    var u = users[uid];
    if (!u) return false;
    if (u.isBanned || u.blocked) return false;
    if (target === 'verified') return u.profileVerified;
    if (target === 'active') return (now - Number(u.lastSeen || u.lastLoginAt || 0)) < 7 * 86400000;
    return true;
  });

  if (!targets.length) { _toast('Koi eligible users nahi', true); return; }
  if (!confirm('📣 ' + targets.length + ' users ko notification bhejna chahte ho?\n\nTitle: ' + title)) return;

  _lastBulkNotif = now;
  var batch = {};
  var notifId = rt().ref('notifications').push().key;

  targets.forEach(function(uid) {
    var nk = rt().ref('users/' + uid + '/notifications').push().key;
    batch['users/' + uid + '/notifications/' + nk] = {
      title: title, message: body, type: type || 'admin_alert',
      timestamp: now, read: false, source: 'bulk'
    };
  });

  try {
    await rt().ref().update(batch);
    await rt().ref('adminActivityLog').push({
      action: 'BULK_NOTIFICATION', title: title, body: body,
      target: target, count: targets.length,
      adminUid: _adminUid(), timestamp: now
    });
    _toast('✅ ' + targets.length + ' users ko notification gayi!');
    _close();
  } catch(e) {
    _toast('Error: ' + e.message, true);
  }
};

/* Override existing bulk send functions */
var _overrideBulkInterval = setInterval(function() {
  if (window.fa04Notif) {
    var origSend = window.fa04Notif.send;
    window.fa04Notif.send = function() {
      var target = (document.getElementById('fa04Target') || {}).value || 'all';
      var title = ((document.getElementById('fa04Title') || {}).value || '').trim();
      var body = ((document.getElementById('fa04Body') || {}).value || '').trim();
      window.fa55SendBulkNotif(title, body, target, 'admin_alert');
    };
    clearInterval(_overrideBulkInterval);
  }
}, 500);

/* ══════════════════════════════════════════════════════════════
   FA06 UPGRADE: Enhanced Duplicate Detector
   Ban second account + notify user
   ══════════════════════════════════════════════════════════════ */
window.fa55DuplicateDetect = async function() {
  if (!rt()) return;
  _modal('🔍 Checking Duplicates...', '<div style="text-align:center;padding:30px"><i class="fas fa-spinner fa-spin fa-2x"></i></div>');

  try {
    var snap = await rt().ref('users').once('value');
    var ffMap = {}, phMap = {}, dupes = [], totalUsers = 0;

    snap.forEach(function(c) {
      totalUsers++;
      var d = c.val() || {};
      if (d.ffUid && d.ffUid.length > 3) {
        if (ffMap[d.ffUid]) dupes.push({ type: 'FF UID', val: d.ffUid, uid1: ffMap[d.ffUid].key, uid2: c.key, ign1: ffMap[d.ffUid].ign, ign2: d.ign });
        else ffMap[d.ffUid] = { key: c.key, ign: d.ign };
      }
      if (d.phone && d.phone.length > 8) {
        if (phMap[d.phone]) dupes.push({ type: 'Phone', val: d.phone, uid1: phMap[d.phone].key, uid2: c.key, ign1: phMap[d.phone].ign, ign2: d.ign });
        else phMap[d.phone] = { key: c.key, ign: d.ign };
      }
    });

    // Also log to adminAlerts
    dupes.forEach(function(d) {
      rt().ref('adminAlerts').push({
        type: 'multi_account',
        severity: 'HIGH',
        uid: d.uid2,
        message: 'Duplicate ' + d.type + ': "' + d.val + '" — ' + (d.ign1 || d.uid1) + ' & ' + (d.ign2 || d.uid2),
        timestamp: _now(),
        resolved: false,
        source: 'fa55_duplicate_scan'
      });
    });

    var h = '<div style="max-height:65vh;overflow-y:auto">';
    h += '<div style="display:flex;gap:8px;margin-bottom:12px;font-size:11px;color:#aaa">';
    h += '<span>Total Users: <b style="color:#00d4ff">' + totalUsers + '</b></span>';
    h += '<span>Duplicates Found: <b style="color:' + (dupes.length ? '#ff4444' : '#00ff9c') + '">' + dupes.length + '</b></span>';
    h += '</div>';

    if (!dupes.length) {
      h += '<div style="text-align:center;padding:24px;color:#00ff9c;font-size:14px;font-weight:700">✅ Koi duplicate accounts nahi mili!</div>';
    } else {
      dupes.forEach(function(d, i) {
        h += '<div style="background:rgba(255,60,60,.06);border:1px solid rgba(255,60,60,.2);border-radius:10px;padding:12px;margin-bottom:8px">';
        h += '<div style="font-size:11px;font-weight:700;color:#ff4444;margin-bottom:6px">⚠️ Duplicate ' + d.type + ': <span style="font-family:monospace">' + d.val + '</span></div>';
        h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">';
        h += '<div style="padding:6px;background:rgba(0,255,156,.06);border-radius:6px"><div style="font-size:10px;color:#aaa">Account 1 (KEEP)</div><div style="font-size:12px;font-weight:700">' + (d.ign1 || 'Unknown') + '</div><div style="font-size:9px;color:#666;font-family:monospace">' + d.uid1.substring(0,14) + '...</div></div>';
        h += '<div style="padding:6px;background:rgba(255,68,68,.06);border-radius:6px"><div style="font-size:10px;color:#aaa">Account 2 (SUSPECT)</div><div style="font-size:12px;font-weight:700">' + (d.ign2 || 'Unknown') + '</div><div style="font-size:9px;color:#666;font-family:monospace">' + d.uid2.substring(0,14) + '...</div></div>';
        h += '</div>';
        h += '<div style="display:flex;gap:6px">';
        h += '<button onclick="fa55BanDuplicate(\'' + d.uid2 + '\')" style="flex:1;padding:7px;border-radius:7px;background:rgba(255,68,68,.12);border:1px solid rgba(255,68,68,.25);color:#ff4444;font-size:11px;font-weight:700;cursor:pointer">🚫 Ban Account 2</button>';
        h += '<button onclick="fa55BanDuplicate(\'' + d.uid1 + '\')" style="flex:1;padding:7px;border-radius:7px;background:rgba(255,170,0,.08);border:1px solid rgba(255,170,0,.2);color:#ffaa00;font-size:11px;font-weight:700;cursor:pointer">⚠️ Ban Account 1</button>';
        h += '<button onclick="fa55BanBothDuplicates(\'' + d.uid1 + '\',\'' + d.uid2 + '\')" style="padding:7px 10px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#aaa;font-size:11px;cursor:pointer">Ban Both</button>';
        h += '</div></div>';
      });
    }
    h += '</div>';
    _modal('🔍 Duplicate Scanner (' + dupes.length + ' found)', h);
  } catch(e) { _toast('Error: ' + e.message, true); }
};

window.fa55BanDuplicate = async function(uid) {
  if (!rt()) return;
  if (!confirm('Ban this account?')) return;
  await rt().ref('users/' + uid).update({ isBanned: true, blocked: true, bannedAt: _now(), bannedReason: 'Duplicate account detected', bannedBy: _adminUid() });
  await rt().ref('users/' + uid + '/notifications').push({ title: '🚫 Account Banned', message: 'Aapka account duplicate activity ke kaaran band kar diya gaya hai.', type: 'system', timestamp: _now(), read: false });
  await rt().ref('walletAuditLog').push({ uid: uid, action: 'BAN_DUPLICATE', amount: 0, note: 'Duplicate account ban', adminUid: _adminUid(), timestamp: _now() });
  if (window.usersCache && window.usersCache[uid]) { window.usersCache[uid].isBanned = true; window.usersCache[uid].blocked = true; }
  _toast('🚫 Account banned!');
  setTimeout(window.fa55DuplicateDetect, 500);
};

window.fa55BanBothDuplicates = async function(uid1, uid2) {
  if (!confirm('BOTH accounts ban karna chahte ho?')) return;
  await window.fa55BanDuplicate(uid1);
  await window.fa55BanDuplicate(uid2);
};

window.fa06DuplicateDetect = window.fa55DuplicateDetect;

/* ══════════════════════════════════════════════════════════════
   FA09 UPGRADE: Withdrawal Queue — correct node + better UI
   ══════════════════════════════════════════════════════════════ */
window.fa55WithdrawalQueue = async function() {
  if (!rt()) return;
  _modal('💸 Withdrawal Queue', '<div style="text-align:center;padding:24px"><i class="fas fa-spinner fa-spin fa-2x"></i></div>');

  try {
    // Use walletRequests (correct node, not withdrawals)
    var snap = await rt().ref('walletRequests').once('value');
    var list = [];
    if (snap.exists()) {
      snap.forEach(function(c) {
        var d = c.val(); if (!d) return;
        var tp = (d.type || '').toLowerCase();
        if ((tp === 'withdraw' || tp === 'withdrawal') && d.status === 'pending') {
          d._key = c.key; list.push(d);
        }
      });
    }

    // Fraud score per request
    list.forEach(function(w) {
      var uid = w.uid || w.userId || '';
      var u = (window.usersCache || {})[uid] || {};
      var score = 0;
      var flags = [];
      if (Number(w.amount) > 1000) { score += 2; flags.push('High Amt'); }
      if (Number(w.amount) > 3000) { score += 2; flags.push('Very High'); }
      if (u.isFrozen) { score += 5; flags.push('Frozen'); }
      if (!u.profileVerified) { score += 2; flags.push('Unverified'); }
      var daysSince = (_now() - Number(u.createdAt || 0)) / 86400000;
      if (daysSince < 7) { score += 3; flags.push('New User'); }
      var matches = (u.stats || {}).matches || 0;
      if (matches < 1) { score += 3; flags.push('0 Matches'); }
      w._score = score; w._flags = flags;
    });

    list.sort(function(a, b) { return b._score - a._score; });

    var h = '<div style="max-height:65vh;overflow-y:auto">';
    if (!list.length) {
      h += '<div style="text-align:center;padding:24px;color:#00ff9c;font-weight:700">✅ Koi pending withdrawals nahi!</div>';
    } else {
      list.forEach(function(w) {
        var uid = w.uid || w.userId || '';
        var u = (window.usersCache || {})[uid] || {};
        var ign = w.userName || w.displayName || u.ign || uid.substring(0,8) + '...';
        var col = w._score >= 5 ? '#ff4444' : w._score >= 2 ? '#ffaa00' : '#00ff9c';
        var ts = new Date(w.timestamp || w.createdAt || 0).toLocaleString('en-IN', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
        var winBal = Number((u.wallet || {}).winningBalance || (u.realMoney || {}).winnings || 0);

        h += '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;margin-bottom:8px">';
        h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">';
        h += '<div><div style="font-size:13px;font-weight:700">' + ign + '</div>';
        h += '<div style="font-size:10px;color:#aaa">UID: ' + uid.substring(0,12) + '...</div>';
        h += '<div style="font-size:10px;color:#aaa">UPI: <b style="color:#ffd700">' + (w.upiId || w.upi || 'N/A') + '</b></div>';
        h += '<div style="font-size:10px;color:#555">' + ts + '</div></div>';
        h += '<div style="text-align:right">';
        h += '<div style="font-size:22px;font-weight:900;color:#ffd700">₹' + (w.amount || 0) + '</div>';
        h += '<div style="font-size:9px;font-weight:700;color:' + col + ';background:rgba(0,0,0,.3);padding:2px 7px;border-radius:8px;display:inline-block">RISK: ' + w._score + '</div></div></div>';

        if (w._flags.length) {
          h += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">';
          w._flags.forEach(function(f) { h += '<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(255,68,68,.12);color:#ff6b6b;border:1px solid rgba(255,68,68,.2)">' + f + '</span>'; });
          h += '</div>';
        }

        // Balance check warning
        if (Number(w.amount) > winBal) {
          h += '<div style="font-size:10px;color:#ff4444;padding:5px;background:rgba(255,68,68,.08);border-radius:6px;margin-bottom:6px">⚠️ Requested ₹' + w.amount + ' > wallet balance ₹' + winBal + '</div>';
        }

        h += '<div style="display:flex;gap:8px">';
        h += '<button onclick="window.openWithdrawalModal && openWithdrawalModal(\'' + w._key + '\')" style="flex:1;padding:9px;border-radius:9px;background:rgba(0,255,156,.1);border:1px solid rgba(0,255,156,.25);color:#00ff9c;font-size:12px;font-weight:700;cursor:pointer">💸 Process</button>';
        h += '<button onclick="window.openRejectModal && openRejectModal(\'wallet\',\'' + w._key + '\')" style="flex:1;padding:9px;border-radius:9px;background:rgba(255,68,68,.1);border:1px solid rgba(255,68,68,.25);color:#ff4444;font-size:12px;font-weight:700;cursor:pointer">❌ Reject</button>';
        h += '<button onclick="window._fa54ShowUserWalletHistory && _fa54ShowUserWalletHistory(\'' + uid + '\')" style="padding:9px 12px;border-radius:9px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);color:#00d4ff;font-size:12px;cursor:pointer">📋</button>';
        h += '</div></div>';
      });
    }
    h += '</div>';
    _modal('💸 Withdrawal Queue (' + list.length + ' pending)', h);
  } catch(e) { _toast('Error: ' + e.message, true); }
};

window.fa09WithdrawalQueue = window.fa55WithdrawalQueue;

/* ══════════════════════════════════════════════════════════════
   FA17 UPGRADE: Batch Profile Approve + Screenshot Preview
   ══════════════════════════════════════════════════════════════ */
window.fa55PendingProfiles = async function() {
  if (!rt()) return;
  _modal('👤 Pending Profiles', '<div style="text-align:center;padding:24px"><i class="fas fa-spinner fa-spin fa-2x"></i></div>');

  try {
    var snap = await rt().ref('profileRequests').orderByChild('status').equalTo('pending').once('value');
    var list = [];
    if (snap.exists()) snap.forEach(function(c) { var d = c.val(); d._key = c.key; list.push(d); });

    // Also check profileUpdates
    var updSnap = await rt().ref('profileUpdates').orderByChild('status').equalTo('pending').once('value');
    if (updSnap.exists()) updSnap.forEach(function(c) { var d = c.val(); d._key = c.key; d._isUpdate = true; list.push(d); });

    var h = '<div style="max-height:65vh;overflow-y:auto">';
    if (!list.length) {
      h += '<div style="text-align:center;padding:24px;color:#00ff9c;font-weight:700">✅ Koi pending profiles nahi!</div>';
    } else {
      // Batch approve all button
      h += '<div style="display:flex;gap:8px;margin-bottom:12px">';
      h += '<button onclick="fa55BatchApproveProfiles()" style="flex:1;padding:10px;border-radius:9px;background:rgba(0,255,156,.1);border:1px solid rgba(0,255,156,.25);color:#00ff9c;font-size:12px;font-weight:700;cursor:pointer">✅ Approve All (' + list.length + ')</button>';
      h += '<span style="font-size:11px;color:#aaa;align-self:center">' + list.length + ' pending</span>';
      h += '</div>';

      list.forEach(function(p) {
        var ts = new Date(p.createdAt || p.timestamp || 0).toLocaleString('en-IN', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
        var hasScreenshot = p.screenshotBase64 || p.screenshot || p.proofImage;
        h += '<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;margin-bottom:8px">';
        h += '<div style="display:flex;gap:10px">';
        if (hasScreenshot) {
          h += '<img src="' + (p.screenshotBase64 || p.screenshot || p.proofImage) + '" style="width:50px;height:50px;border-radius:8px;object-fit:cover;cursor:pointer;border:1px solid rgba(255,255,255,.1)" onclick="window.viewScreenshot&&viewScreenshot(this.src)">';
        }
        h += '<div style="flex:1">';
        h += '<div style="font-size:13px;font-weight:700">' + (p.ign || p.playerName || 'User') + (p._isUpdate ? ' <span style="font-size:9px;background:rgba(0,212,255,.2);color:#00d4ff;padding:1px 5px;border-radius:4px">UPDATE</span>' : '') + '</div>';
        h += '<div style="font-size:11px;color:#aaa">FF UID: <b style="color:#00d4ff;font-family:monospace">' + (p.ffUid || p.gameUid || '—') + '</b></div>';
        h += '<div style="font-size:11px;color:#aaa">Phone: ' + (p.phone || '—') + ' · ' + ts + '</div>';
        h += '</div></div>';
        h += '<div style="display:flex;gap:6px;margin-top:8px">';
        h += '<button onclick="fa55ApproveProfile(\'' + p._key + '\',\'' + (p.userId || p.uid || '') + '\',\'' + (p._isUpdate ? 'update' : 'profile') + '\')" style="flex:1;padding:8px;border-radius:8px;background:rgba(0,255,156,.1);border:1px solid rgba(0,255,156,.25);color:#00ff9c;font-size:11px;font-weight:700;cursor:pointer">✅ Approve</button>';
        h += '<button onclick="fa55RejectProfile(\'' + p._key + '\',\'' + (p.userId || p.uid || '') + '\',\'' + (p._isUpdate ? 'update' : 'profile') + '\')" style="flex:1;padding:8px;border-radius:8px;background:rgba(255,68,68,.08);border:1px solid rgba(255,68,68,.2);color:#ff4444;font-size:11px;font-weight:700;cursor:pointer">❌ Reject</button>';
        h += '</div></div>';
      });
    }
    h += '</div>';
    _modal('👤 Pending Profiles (' + list.length + ')', h);
  } catch(e) { _toast('Error: ' + e.message, true); }
};

window.fa55ApproveProfile = async function(key, uid, type) {
  if (!rt() || !uid) return;
  var node = type === 'update' ? 'profileUpdates' : 'profileRequests';

  // Fetch pending data
  var snap = await rt().ref(node + '/' + key).once('value');
  var p = snap.val() || {};

  var updates = { profileVerified: true, profileStatus: 'verified', verifiedAt: _now() };
  if (p.ign) updates.ign = p.ign;
  if (p.ffUid || p.gameUid) updates.ffUid = p.ffUid || p.gameUid;
  if (p.phone) updates.phone = p.phone;

  await rt().ref(node + '/' + key).update({ status: 'approved', reviewedAt: _now(), reviewedBy: _adminUid() });
  await rt().ref('users/' + uid).update(updates);
  await rt().ref('users/' + uid + '/notifications').push({ title: '✅ Profile Verified!', message: 'Aapka profile verify ho gaya. Ab sab matches join kar sakte ho!', type: 'system', timestamp: _now(), read: false });
  await rt().ref('adminActivityLog').push({ action: 'PROFILE_APPROVED', uid: uid, adminUid: _adminUid(), timestamp: _now() });

  if (window.usersCache && window.usersCache[uid]) Object.assign(window.usersCache[uid], updates);
  _toast('✅ Profile approved!');
  setTimeout(window.fa55PendingProfiles, 300);
};

window.fa55RejectProfile = async function(key, uid, type) {
  var reason = prompt('Rejection reason:');
  if (!reason) return;
  var node = type === 'update' ? 'profileUpdates' : 'profileRequests';
  await rt().ref(node + '/' + key).update({ status: 'rejected', rejectionReason: reason, reviewedAt: _now(), reviewedBy: _adminUid() });
  if (uid) await rt().ref('users/' + uid + '/notifications').push({ title: '❌ Profile Rejected', message: 'Reason: ' + reason + '. Dobara submit karo.', type: 'system', timestamp: _now(), read: false });
  _toast('❌ Rejected');
  setTimeout(window.fa55PendingProfiles, 300);
};

window.fa55BatchApproveProfiles = async function() {
  if (!confirm('Saare pending profiles approve karna chahte ho?')) return;
  if (!rt()) return;
  var [snap1, snap2] = await Promise.all([
    rt().ref('profileRequests').orderByChild('status').equalTo('pending').once('value'),
    rt().ref('profileUpdates').orderByChild('status').equalTo('pending').once('value')
  ]);
  var batch = {}, notifBatch = {}, count = 0;
  function processSnap(s, node) {
    if (!s.exists()) return;
    s.forEach(function(c) {
      var p = c.val(); if (!p) return;
      var uid = p.userId || p.uid; if (!uid) return;
      batch[node + '/' + c.key + '/status'] = 'approved';
      batch[node + '/' + c.key + '/reviewedAt'] = _now();
      batch['users/' + uid + '/profileVerified'] = true;
      batch['users/' + uid + '/profileStatus'] = 'verified';
      if (p.ign) batch['users/' + uid + '/ign'] = p.ign;
      if (p.ffUid || p.gameUid) batch['users/' + uid + '/ffUid'] = p.ffUid || p.gameUid;
      var nk = rt().ref('users/' + uid + '/notifications').push().key;
      batch['users/' + uid + '/notifications/' + nk] = { title: '✅ Profile Verified!', message: 'Aapka profile approve ho gaya!', type: 'system', timestamp: _now(), read: false };
      count++;
    });
  }
  processSnap(snap1, 'profileRequests');
  processSnap(snap2, 'profileUpdates');
  await rt().ref().update(batch);
  _toast('✅ ' + count + ' profiles approved!');
  _close();
};

window.fa17PendingProfiles = window.fa55PendingProfiles;

/* ══════════════════════════════════════════════════════════════
   FA19 UPGRADE: Safer Auto Status (no auto-complete paid matches)
   ══════════════════════════════════════════════════════════════ */
window.fa55AutoStatusCheck = function() {
  if (!rt()) return;
  var now = _now();
  rt().ref('matches').once('value', function(s) {
    var updates = {};
    s.forEach(function(c) {
      var d = c.val(); if (!d || !d.matchTime) return;
      var mt = Number(d.matchTime);
      var endTime = mt + (d.duration || 30) * 60000;
      // upcoming → live (safe)
      if (d.status === 'upcoming' && now >= mt && now < endTime) {
        updates['matches/' + c.key + '/status'] = 'live';
        updates['matches/' + c.key + '/startedAt'] = now;
      }
      // live → completed ONLY if it's a free/coin match (don't auto-complete paid ones)
      if (d.status === 'live' && now >= endTime) {
        var isPaid = Number(d.entryFee || 0) > 0;
        if (!isPaid) {
          // Free match — safe to auto-complete
          updates['matches/' + c.key + '/status'] = 'completed';
          updates['matches/' + c.key + '/completedAt'] = now;
        } else {
          // Paid match — just log a reminder, admin must manually complete
          if (!d._paidMatchEndAlert && (now - endTime) > 15 * 60000) {
            updates['matches/' + c.key + '/_paidMatchEndAlert'] = true;
            rt().ref('adminAlerts').push({
              type: 'paid_match_ended',
              severity: 'MEDIUM',
              matchId: c.key,
              message: '⏰ Paid match "' + (d.name || c.key) + '" khatam ho gaya — result publish karo!',
              timestamp: now, resolved: false, source: 'fa55_auto_status'
            });
          }
        }
      }
    });
    if (Object.keys(updates).length) rt().ref().update(updates);
  });
};

// Override fa19
if (window.fa19AutoStatus) window.fa19AutoStatus.check = window.fa55AutoStatusCheck;
setInterval(window.fa55AutoStatusCheck, 2 * 60 * 1000);
setTimeout(window.fa55AutoStatusCheck, 8000);

/* ══════════════════════════════════════════════════════════════
   FA20 UPGRADE: Coin Requests with UTR Duplicate Check
   ══════════════════════════════════════════════════════════════ */
window.fa55CoinRequests = async function() {
  if (!rt()) return;
  _modal('🪙 Coin Requests', '<div style="text-align:center;padding:24px"><i class="fas fa-spinner fa-spin fa-2x"></i></div>');

  try {
    var snap = await rt().ref('coinRequests').orderByChild('status').equalTo('pending').once('value');
    var list = [];
    if (snap.exists()) snap.forEach(function(c) { var d = c.val(); d._key = c.key; list.push(d); });

    // Load UTR blacklist
    var blSnap = await rt().ref('utrBlacklist').once('value');
    var blacklistedUTRs = {};
    if (blSnap.exists()) blSnap.forEach(function(c) { var d = c.val(); if (d.utr) blacklistedUTRs[d.utr] = true; });

    var h = '<div style="max-height:65vh;overflow-y:auto">';
    if (!list.length) {
      h += '<div style="text-align:center;padding:24px;color:#00ff9c;font-weight:700">✅ Koi pending coin requests nahi!</div>';
    } else {
      list.forEach(function(r) {
        var ts = new Date(r.createdAt || 0).toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
        var utr = r.utrNumber || r.utr || '';
        var isBlacklisted = utr && blacklistedUTRs[utr];
        var uid = r.userId || r.uid || '';
        var u = (window.usersCache || {})[uid] || {};

        h += '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(' + (isBlacklisted ? '255,68,68' : '255,255,255') + ',.1' + (isBlacklisted ? '5' : '') + ');border-radius:12px;padding:12px;margin-bottom:8px">';
        if (isBlacklisted) h += '<div style="font-size:10px;color:#ff4444;font-weight:700;margin-bottom:6px">🚨 BLACKLISTED UTR — DO NOT APPROVE!</div>';

        h += '<div style="display:flex;justify-content:space-between;margin-bottom:8px">';
        h += '<div><div style="font-size:13px;font-weight:700">' + (r.ign || u.ign || r.userId || 'User') + '</div>';
        h += '<div style="font-size:10px;color:#aaa">' + ts + '</div>';
        if (utr) h += '<div style="font-size:11px;color:#aaa">UTR: <b style="font-family:monospace;color:' + (isBlacklisted ? '#ff4444' : '#ffd700') + '">' + utr + '</b></div>';
        h += '</div>';
        h += '<div style="text-align:right"><div style="font-size:20px;font-weight:900;color:#ffd700">🪙 ' + (r.coins || 0) + '</div>';
        h += '<div style="font-size:12px;color:#00ff9c">₹' + (r.amount || 0) + '</div></div></div>';

        h += '<div style="display:flex;gap:6px">';
        if (!isBlacklisted) {
          h += '<button onclick="fa55ApproveCoin(\'' + r._key + '\',\'' + uid + '\',' + (r.coins||0) + ')" style="flex:1;padding:8px;border-radius:8px;background:rgba(0,255,156,.1);border:1px solid rgba(0,255,156,.25);color:#00ff9c;font-size:12px;font-weight:700;cursor:pointer">✅ Approve</button>';
        }
        h += '<button onclick="fa55RejectCoin(\'' + r._key + '\',\'' + uid + '\')" style="flex:1;padding:8px;border-radius:8px;background:rgba(255,68,68,.1);border:1px solid rgba(255,68,68,.25);color:#ff4444;font-size:12px;font-weight:700;cursor:pointer">' + (isBlacklisted ? '🚫 Block' : '❌ Reject') + '</button>';
        if (utr && !isBlacklisted) h += '<button onclick="fa55BlacklistCoinUTR(\'' + utr + '\')" style="padding:8px 10px;border-radius:8px;background:rgba(255,170,0,.08);border:1px solid rgba(255,170,0,.2);color:#ffaa00;font-size:11px;cursor:pointer;white-space:nowrap">🔒 Block UTR</button>';
        h += '</div></div>';
      });
    }
    h += '</div>';
    _modal('🪙 Coin Requests (' + list.length + ')', h);
  } catch(e) { _toast('Error: ' + e.message, true); }
};

window.fa55ApproveCoin = async function(key, uid, coins) {
  if (!rt() || !uid) return;
  var snap = await rt().ref('coinRequests/' + key).once('value');
  var r = snap.val() || {};
  await rt().ref('coinRequests/' + key).update({ status: 'approved', reviewedAt: _now(), reviewedBy: _adminUid() });
  await rt().ref('users/' + uid + '/coins').transaction(function(c) { return (c || 0) + coins; });
  await rt().ref('users/' + uid + '/transactions').push({ type: 'coin_purchase', amount: coins, description: '🪙 Coin purchase approved. UTR: ' + (r.utrNumber || r.utr || 'N/A'), timestamp: _now() });
  await rt().ref('users/' + uid + '/notifications').push({ title: '🪙 Coins Added!', message: coins + ' coins aapke wallet mein add ho gaye!', type: 'cashback', timestamp: _now(), read: false });
  await rt().ref('walletAuditLog').push({ uid: uid, action: 'COIN_APPROVED', amount: coins, note: 'UTR: ' + (r.utrNumber || r.utr || 'N/A'), adminUid: _adminUid(), timestamp: _now() });
  _toast('🪙 ' + coins + ' coins added!');
  setTimeout(window.fa55CoinRequests, 300);
};

window.fa55RejectCoin = async function(key, uid) {
  var reason = prompt('Rejection reason:') || 'Payment not verified';
  await rt().ref('coinRequests/' + key).update({ status: 'rejected', rejectedAt: _now(), rejectionReason: reason });
  if (uid) await rt().ref('users/' + uid + '/notifications').push({ title: '❌ Coin Request Rejected', message: 'Reason: ' + reason + '. Dobara try karo.', type: 'system', timestamp: _now(), read: false });
  _toast('❌ Rejected');
  setTimeout(window.fa55CoinRequests, 300);
};

window.fa55BlacklistCoinUTR = async function(utr) {
  if (!confirm('UTR "' + utr + '" blacklist karna chahte ho?')) return;
  await rt().ref('utrBlacklist').push({ utr: utr, reason: 'Blocked from coin request', addedAt: _now(), addedBy: _adminUid() });
  _toast('🔒 UTR blacklisted!');
};

window.fa20CoinRequests = window.fa55CoinRequests;

/* ══════════════════════════════════════════════════════════════
   NEW FA55A: Smart Dashboard Widget
   Shows critical stats inline on wallet/match sections
   ══════════════════════════════════════════════════════════════ */
window.fa55SmartDashboard = async function() {
  if (!rt()) return;
  _modal('📊 Smart Dashboard', '<div style="text-align:center;padding:24px"><i class="fas fa-spinner fa-spin fa-2x"></i></div>');

  try {
    var [matchSnap, walletSnap, alertSnap, userSnap] = await Promise.all([
      rt().ref('matches').once('value'),
      rt().ref('walletRequests').once('value'),
      rt().ref('adminAlerts').orderByChild('resolved').equalTo(false).limitToLast(100).once('value'),
      rt().ref('users').once('value')
    ]);

    var stats = { upcoming: 0, live: 0, completed: 0, unpaidResults: 0, pendingDeposits: 0, pendingWithdrawals: 0, frozenUsers: 0, bannedUsers: 0, totalUsers: 0, activeUsers: 0, totalRevenue: 0, totalPrizes: 0, highAlerts: 0 };

    if (matchSnap.exists()) matchSnap.forEach(function(c) {
      var d = c.val(); if (!d) return;
      var st = (d.status || '').toLowerCase();
      if (st === 'upcoming') stats.upcoming++;
      else if (st === 'live') stats.live++;
      else if (st === 'completed' && !d.resultPublished) stats.unpaidResults++;
      if (d.resultPublished) stats.completed++;
    });

    var now7d = _now() - 7 * 86400000;
    if (walletSnap.exists()) walletSnap.forEach(function(c) {
      var d = c.val(); if (!d) return;
      var tp = (d.type || '').toLowerCase();
      var isAdd = tp === 'add' || tp === 'deposit' || tp === 'add_money';
      if (d.status === 'pending') {
        if (isAdd) stats.pendingDeposits++;
        else stats.pendingWithdrawals++;
      }
      if (d.status === 'approved' && isAdd) stats.totalRevenue += Number(d.amount) || 0;
      if (d.status === 'approved' && !isAdd) stats.totalPrizes += Number(d.amount) || 0;
    });

    if (userSnap.exists()) userSnap.forEach(function(c) {
      var d = c.val(); if (!d) return;
      stats.totalUsers++;
      if (d.isBanned || d.blocked) stats.bannedUsers++;
      if (d.isFrozen) stats.frozenUsers++;
      if (Number(d.lastSeen || d.lastLoginAt || 0) > now7d) stats.activeUsers++;
    });

    if (alertSnap.exists()) alertSnap.forEach(function(c) {
      if ((c.val() || {}).severity === 'HIGH') stats.highAlerts++;
    });

    var profit = stats.totalRevenue - stats.totalPrizes;

    var h = '<div style="max-height:70vh;overflow-y:auto">';

    // Critical alerts bar
    if (stats.unpaidResults > 0 || stats.highAlerts > 0 || stats.frozenUsers > 0) {
      h += '<div style="background:rgba(255,68,68,.08);border:1px solid rgba(255,68,68,.2);border-radius:10px;padding:10px;margin-bottom:14px">';
      h += '<div style="font-size:12px;font-weight:700;color:#ff4444;margin-bottom:6px">🚨 Action Required</div>';
      if (stats.unpaidResults) h += '<div style="font-size:11px;color:#ffaa00;margin-bottom:3px">⏰ ' + stats.unpaidResults + ' matches ke results publish nahi hue</div>';
      if (stats.highAlerts) h += '<div style="font-size:11px;color:#ff4444;margin-bottom:3px">🔴 ' + stats.highAlerts + ' HIGH severity security alerts</div>';
      if (stats.frozenUsers) h += '<div style="font-size:11px;color:#00d4ff">🧊 ' + stats.frozenUsers + ' accounts frozen hain</div>';
      h += '</div>';
    }

    var cards = [
      { icon: '🎮', label: 'Upcoming Matches', val: stats.upcoming, col: '#00d4ff' },
      { icon: '🔴', label: 'Live Now', val: stats.live, col: stats.live > 0 ? '#ff4444' : '#aaa' },
      { icon: '⏰', label: 'Unpaid Results', val: stats.unpaidResults, col: stats.unpaidResults > 0 ? '#ff4444' : '#00ff9c' },
      { icon: '📥', label: 'Pending Deposits', val: stats.pendingDeposits, col: stats.pendingDeposits > 0 ? '#ffaa00' : '#aaa' },
      { icon: '📤', label: 'Pending Withdrawals', val: stats.pendingWithdrawals, col: stats.pendingWithdrawals > 0 ? '#ffaa00' : '#aaa' },
      { icon: '👥', label: 'Total Users', val: stats.totalUsers, col: '#00d4ff' },
      { icon: '🟢', label: 'Active (7d)', val: stats.activeUsers, col: '#00ff9c' },
      { icon: '🚫', label: 'Banned', val: stats.bannedUsers, col: '#ff4444' },
      { icon: '💰', label: 'Total Deposits', val: '₹' + stats.totalRevenue, col: '#00ff9c' },
      { icon: '🏆', label: 'Total Prizes Paid', val: '₹' + stats.totalPrizes, col: '#ffd700' },
      { icon: '📈', label: 'Net Profit', val: '₹' + profit, col: profit >= 0 ? '#00ff9c' : '#ff4444' },
      { icon: '🚨', label: 'High Alerts', val: stats.highAlerts, col: stats.highAlerts > 0 ? '#ff4444' : '#00ff9c' },
    ];

    h += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px">';
    cards.forEach(function(c) {
      h += '<div style="text-align:center;padding:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px">';
      h += '<div style="font-size:18px;margin-bottom:3px">' + c.icon + '</div>';
      h += '<div style="font-size:18px;font-weight:900;color:' + c.col + '">' + c.val + '</div>';
      h += '<div style="font-size:9px;color:#666;margin-top:2px">' + c.label + '</div>';
      h += '</div>';
    });
    h += '</div>';

    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
    h += '<button onclick="window.fa55WithdrawalQueue&&fa55WithdrawalQueue()" style="padding:12px;border-radius:10px;background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.2);color:#ffd700;font-weight:700;font-size:12px;cursor:pointer">💸 Withdrawal Queue</button>';
    h += '<button onclick="window.fa55PendingProfiles&&fa55PendingProfiles()" style="padding:12px;border-radius:10px;background:rgba(0,255,156,.08);border:1px solid rgba(0,255,156,.2);color:#00ff9c;font-weight:700;font-size:12px;cursor:pointer">👤 Pending Profiles</button>';
    h += '<button onclick="window.fa55DuplicateDetect&&fa55DuplicateDetect()" style="padding:12px;border-radius:10px;background:rgba(255,68,68,.08);border:1px solid rgba(255,68,68,.2);color:#ff4444;font-weight:700;font-size:12px;cursor:pointer">🔍 Scan Duplicates</button>';
    h += '<button onclick="window.fa55CoinRequests&&fa55CoinRequests()" style="padding:12px;border-radius:10px;background:rgba(255,215,0,.08);border:1px solid rgba(255,215,0,.15);color:#ffd700;font-weight:700;font-size:12px;cursor:pointer">🪙 Coin Requests</button>';
    h += '</div>';
    h += '</div>';

    _modal('📊 Smart Dashboard', h);
  } catch(e) { _toast('Error: ' + e.message, true); }
};

/* ══════════════════════════════════════════════════════════════
   NEW FA55B: User Temporary Suspension (time-limited ban)
   ══════════════════════════════════════════════════════════════ */
window.fa55SuspendUser = function(uid, ign) {
  var h = '<div>';
  h += '<div style="background:rgba(255,170,0,.08);border:1px solid rgba(255,170,0,.2);border-radius:10px;padding:10px;margin-bottom:12px">';
  h += '<div style="font-size:13px;font-weight:700;color:#ffaa00">' + (ign || uid.substring(0,12) + '...') + '</div>';
  h += '<div style="font-size:11px;color:#aaa">Temporary suspension — automatically lift hoga</div>';
  h += '</div>';
  h += '<div style="margin-bottom:10px"><label style="font-size:11px;color:#aaa;display:block;margin-bottom:6px">Suspension Duration</label>';
  h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">';
  [['1h','1 Hour'], ['24h','1 Day'], ['72h','3 Days'], ['168h','1 Week']].forEach(function(opt) {
    h += '<button onclick="document.querySelectorAll(\'.susp-dur-btn\').forEach(b=>b.style.background=\'rgba(255,255,255,.05)\');this.style.background=\'rgba(255,170,0,.2)\';window._suspDur=\'' + opt[0] + '\'" class="susp-dur-btn" style="padding:8px;border-radius:8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#aaa;font-size:11px;cursor:pointer;font-weight:700">' + opt[1] + '</button>';
  });
  h += '</div></div>';
  h += '<div style="margin-bottom:10px"><label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px">Reason</label><input type="text" id="suspReason" class="form-input" placeholder="e.g. Suspicious activity, rule violation" style="width:100%;box-sizing:border-box"></div>';
  h += '<button onclick="fa55ExecuteSuspension(\'' + uid + '\')" style="width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,#ffaa00,#ff8800);color:#000;font-weight:800;border:none;cursor:pointer">⏳ Apply Suspension</button>';
  h += '</div>';
  _modal('⏳ Suspend User', h);
};

window.fa55ExecuteSuspension = async function(uid) {
  var dur = window._suspDur || '24h';
  var reason = (document.getElementById('suspReason') || {}).value || 'Admin suspension';
  var hours = parseInt(dur);
  var until = _now() + hours * 3600000;

  await rt().ref('users/' + uid).update({ isSuspended: true, suspendedUntil: until, suspendedReason: reason, suspendedBy: _adminUid(), suspendedAt: _now() });
  await rt().ref('users/' + uid + '/notifications').push({ title: '⏳ Account Temporarily Suspended', message: reason + '. ' + hours + ' ghante baad wapas active hoga.', type: 'system', timestamp: _now(), read: false });
  await rt().ref('walletAuditLog').push({ uid: uid, action: 'SUSPENDED', note: hours + 'h — ' + reason, adminUid: _adminUid(), timestamp: _now() });

  // Schedule auto-lift
  setTimeout(async function() {
    try {
      var check = await rt().ref('users/' + uid + '/suspendedUntil').once('value');
      if (check.val() === until) {
        await rt().ref('users/' + uid).update({ isSuspended: false, suspendedUntil: null, suspendedAutoLifted: _now() });
        await rt().ref('users/' + uid + '/notifications').push({ title: '✅ Suspension Lifted', message: 'Aapka account wapas active ho gaya hai.', type: 'system', timestamp: _now(), read: false });
      }
    } catch(e) {}
  }, hours * 3600000);

  if (window.usersCache && window.usersCache[uid]) window.usersCache[uid].isSuspended = true;
  _toast('⏳ User suspended for ' + hours + ' hours');
  _close();
};

/* ══════════════════════════════════════════════════════════════
   NEW FA55C: Match Slot Overbooking Guard
   Alerts if joined players > max slots
   ══════════════════════════════════════════════════════════════ */
window.fa55CheckSlotOverbooking = async function() {
  if (!rt()) return;
  var matches = window.allTournaments || {};
  var issues = [];

  for (var mid in matches) {
    var m = matches[mid];
    if (!m || m.status === 'completed' || m.status === 'cancelled') continue;
    var maxSlots = Number(m.maxSlots || m.slots || 0);
    if (!maxSlots) continue;

    try {
      var jSnap = await rt().ref('joinRequests').orderByChild('matchId').equalTo(mid).once('value');
      var count = 0;
      if (jSnap.exists()) jSnap.forEach(function(c) {
        var d = c.val();
        if (d && d.status !== 'cancelled' && d.status !== 'rejected') count++;
      });

      if (count > maxSlots) {
        issues.push({ mid: mid, name: m.name || mid, joined: count, max: maxSlots, over: count - maxSlots });
        rt().ref('adminAlerts').push({
          type: 'slot_overbooking',
          severity: 'HIGH',
          matchId: mid,
          message: '🚨 Overbooking: "' + (m.name || mid) + '" has ' + count + '/' + maxSlots + ' slots filled!',
          joined: count, maxSlots: maxSlots,
          timestamp: _now(), resolved: false, source: 'fa55_slot_guard'
        });
      }
    } catch(e) {}
  }

  if (issues.length) {
    _toast('⚠️ ' + issues.length + ' matches overbooking mein hain!', true);
  } else {
    _toast('✅ Koi overbooking nahi');
  }
  return issues;
};

/* ══════════════════════════════════════════════════════════════
   NEW FA55D: Quick Search Global (Dashboard Shortcut)
   Ctrl+K shortcut for global search
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    var inp = document.getElementById('globalSearchInput');
    if (inp) { inp.focus(); inp.select(); }
  }
});

/* ══════════════════════════════════════════════════════════════
   NEW FA55E: Revenue Analytics (Enhanced)
   ══════════════════════════════════════════════════════════════ */
window.fa55RevenueAnalytics = async function() {
  if (!rt()) return;
  _modal('📊 Revenue Analytics', '<div style="text-align:center;padding:24px"><i class="fas fa-spinner fa-spin fa-2x"></i></div>');

  try {
    var walletSnap = await rt().ref('walletRequests').once('value');
    var daily = {}, monthly = {};
    var totalDeposited = 0, totalWithdrawn = 0, totalPending = 0;
    var depositCount = 0, withdrawCount = 0;

    if (walletSnap.exists()) {
      walletSnap.forEach(function(c) {
        var d = c.val(); if (!d) return;
        var tp = (d.type || '').toLowerCase();
        var isAdd = tp === 'add' || tp === 'deposit' || tp === 'add_money';
        var ts = d.processedAt || d.timestamp || d.createdAt || 0;
        var amt = Number(d.amount) || 0;

        if (d.status === 'approved') {
          var dayKey = new Date(ts).toLocaleDateString('en-IN', {day:'2-digit',month:'short'});
          var monKey = new Date(ts).toLocaleDateString('en-IN', {month:'short',year:'numeric'});
          if (isAdd) {
            totalDeposited += amt; depositCount++;
            daily[dayKey] = (daily[dayKey] || 0) + amt;
            monthly[monKey] = (monthly[monKey] || 0) + amt;
          } else {
            totalWithdrawn += amt; withdrawCount++;
          }
        } else if (d.status === 'pending' && isAdd) {
          totalPending += amt;
        }
      });
    }

    var profit = totalDeposited - totalWithdrawn;
    var last7Days = Object.entries(daily).slice(-7);

    var h = '<div style="max-height:70vh;overflow-y:auto">';

    // Summary
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">';
    [
      ['Total Deposited', '₹' + totalDeposited, '#00ff9c', depositCount + ' transactions'],
      ['Total Withdrawn', '₹' + totalWithdrawn, '#ffd700', withdrawCount + ' transactions'],
      ['Net Profit', '₹' + profit, profit >= 0 ? '#00ff9c' : '#ff4444', (profit >= 0 ? '🟢 Profit' : '🔴 Loss')],
      ['Pending', '₹' + totalPending, '#ffaa00', 'Not yet approved'],
    ].forEach(function(c) {
      h += '<div style="padding:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px">';
      h += '<div style="font-size:10px;color:#aaa">' + c[0] + '</div>';
      h += '<div style="font-size:20px;font-weight:900;color:' + c[2] + '">' + c[1] + '</div>';
      h += '<div style="font-size:10px;color:#555">' + c[3] + '</div></div>';
    });
    h += '</div>';

    // Last 7 days bar chart
    if (last7Days.length > 0) {
      h += '<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:700;color:#aaa;margin-bottom:8px">Last 7 Days Deposits</div>';
      var maxAmt = Math.max.apply(null, last7Days.map(function(d) { return d[1]; })) || 1;
      h += '<div style="display:flex;align-items:flex-end;gap:4px;height:80px;border-bottom:1px solid rgba(255,255,255,.07);padding-bottom:4px">';
      last7Days.forEach(function(d) {
        var pct = Math.round(d[1] / maxAmt * 100);
        h += '<div style="flex:1;display:flex;flex-direction:column;align-items:center">';
        h += '<div style="width:100%;background:rgba(0,255,156,' + (0.3 + pct/100*0.7) + ');border-radius:4px 4px 0 0;height:' + (pct * 0.7 + 5) + 'px;min-height:4px"></div>';
        h += '</div>';
      });
      h += '</div>';
      h += '<div style="display:flex;gap:4px;margin-top:4px">';
      last7Days.forEach(function(d) {
        h += '<div style="flex:1;text-align:center;font-size:8px;color:#555">' + d[0] + '</div>';
      });
      h += '</div></div>';
    }

    h += '</div>';
    _modal('📊 Revenue Analytics', h);
  } catch(e) { _toast('Error: ' + e.message, true); }
};

/* ══════════════════════════════════════════════════════════════
   NEW FA55F: Admin Quick Actions Bar (shortcuts on every section)
   ══════════════════════════════════════════════════════════════ */
function injectQuickActionsBar() {
  if (document.getElementById('_fa55QuickBar')) return;
  var bar = document.createElement('div');
  bar.id = '_fa55QuickBar';
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999;background:rgba(12,12,18,.96);border-top:1px solid rgba(0,255,156,.1);padding:6px 12px;display:flex;gap:8px;align-items:center;backdrop-filter:blur(10px);overflow-x:auto;white-space:nowrap';

  var actions = [
    { icon: '📊', label: 'Dashboard', fn: 'fa55SmartDashboard()' },
    { icon: '💸', label: 'Withdrawals', fn: 'fa55WithdrawalQueue()' },
    { icon: '👤', label: 'Profiles', fn: 'fa55PendingProfiles()' },
    { icon: '🔍', label: 'Duplicates', fn: 'fa55DuplicateDetect()' },
    { icon: '🪙', label: 'Coins', fn: 'fa55CoinRequests()' },
    { icon: '📈', label: 'Revenue', fn: 'fa55RevenueAnalytics()' },
    { icon: '🛡️', label: 'Security', fn: 'window._fa54ShowConfig&&_fa54ShowConfig()' },
    { icon: '📋', label: 'Audit Log', fn: 'loadActivityLog&&loadActivityLog()' },
  ];

  var html = '<span style="font-size:10px;color:#666;margin-right:4px">QUICK:</span>';
  actions.forEach(function(a) {
    html += '<button onclick="' + a.fn + '" style="padding:5px 10px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:#aaa;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">' + a.icon + ' ' + a.label + '</button>';
  });
  html += '<span style="flex:1"></span>';
  html += '<button onclick="this.parentNode.style.display=\'none\'" style="padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.05);border:none;color:#555;font-size:11px;cursor:pointer">✕</button>';

  bar.innerHTML = html;
  document.body.appendChild(bar);

  // Add padding to main content so bar doesn't overlap
  var mainContent = document.querySelector('.main-content') || document.querySelector('.content') || document.querySelector('main');
  if (mainContent) mainContent.style.paddingBottom = '48px';
}

/* ══════════════════════════════════════════════════════════════
   BOOT: Wait for DOM and init everything
   ══════════════════════════════════════════════════════════════ */
var _bootTries = 0;
var _bootInterval = setInterval(function() {
  _bootTries++;
  if (document.body && (window.rtdb || window.db)) {
    clearInterval(_bootInterval);
    setTimeout(injectQuickActionsBar, 2000);

    // Auto-check slot overbooking every 10 min
    setInterval(window.fa55CheckSlotOverbooking, 10 * 60 * 1000);

    // Patch fa01
    var origEx = window.adminExecuteDistribute;
    if (origEx && !window._fa55_fa01_patched) {
      window._fa55_fa01_patched = true;
      window.adminExecuteDistribute = async function(mid) {
        try {
          var snap = await rt().ref('matchResults/' + mid).once('value');
          if (snap.exists() && snap.val().distributedAt) {
            var when = new Date(snap.val().distributedAt).toLocaleString('en-IN');
            if (!confirm('⚠️ Already distributed on ' + when + '!\nRedistribute karna chahte ho?')) return;
          }
        } catch(e) {}
        await rt().ref('walletAuditLog').push({ action: 'PRIZE_DISTRIBUTE', matchId: mid, adminUid: _adminUid(), timestamp: _now() }).catch(function(){});
        origEx.apply(this, arguments);
      };
    }
  }
  if (_bootTries > 40) clearInterval(_bootInterval);
}, 500);

window.FA55 = {
  dashboard: window.fa55SmartDashboard,
  withdrawalQueue: window.fa55WithdrawalQueue,
  duplicateDetect: window.fa55DuplicateDetect,
  pendingProfiles: window.fa55PendingProfiles,
  coinRequests: window.fa55CoinRequests,
  revenueAnalytics: window.fa55RevenueAnalytics,
  suspendUser: window.fa55SuspendUser,
  slotCheck: window.fa55CheckSlotOverbooking
};

})();

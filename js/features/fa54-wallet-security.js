/* ================================================================
   FA54: WALLET SECURITY & ANTI-HACK ENGINE v1.0
   ================================================================
   FEATURES:
   [1] REAL-TIME ANOMALY DETECTOR — balance change monitor
   [2] UTR DUPLICATE / FAKE PAYMENT DETECTOR
   [3] VELOCITY CHECKER — too many deposits in short time
   [4] BALANCE INTEGRITY MONITOR — unexpected balance jumps
   [5] AUTO-FREEZE — suspicious accounts auto-locked
   [6] DEPOSIT APPROVAL AUTO-CHECKS — before admin approves
   [7] WALLET AUDIT TRAIL — every change logged with source
   [8] HACK ATTEMPT LOGGER — tracks unauthorized write attempts
   [9] SMART AUTO-APPROVE — safe small deposits auto-pass
   [10] DAILY ANOMALY REPORT — summary dashboard card
   ================================================================ */

(function () {
'use strict';

/* ─── CONFIG (editable by admin via UI) ─── */
var CFG = {
  maxDepositPerDay:      5000,   // ₹ per user per day
  maxDepositPerRequest:  2000,   // single request max
  maxDepositsPerHour:    3,      // frequency limit
  suspiciousJumpAmount:  500,    // balance jump without request = alert
  utrMinLength:         12,      // UTR must be this long
  autoFreezeOnJump:     true,    // auto-freeze if balance jumps without request
  autoApproveBelow:     200,     // ₹ — safe amount to auto-approve (0 = disabled)
  requireUTRAlways:     true,    // UTR mandatory for all deposits
  maxPendingPerUser:    2,       // max pending requests at once
  alertCooldownMs:      60000,   // don't spam same alert within 1 min
};

/* ─── STATE ─── */
var _utrCache       = {};   // utr → requestId (duplicate check)
var _balanceSnap    = {};   // uid → {deposit, winnings} (last known good)
var _alertCooldown  = {};   // alert key → last timestamp
var _watcherActive  = false;
var _listeners      = [];

/* ─── HELPERS ─── */
function rt() { return window.rtdb || window.db; }
function _now() { return Date.now(); }
function _log(msg) { /* silent in production */ }

function _adminUid() {
  try { return (window.auth && auth.currentUser) ? auth.currentUser.uid : 'system'; } catch(e) { return 'system'; }
}

function _cooldown(key) {
  var now = _now();
  if (_alertCooldown[key] && (now - _alertCooldown[key]) < CFG.alertCooldownMs) return true;
  _alertCooldown[key] = now;
  return false;
}

function _pushAlert(data) {
  if (!rt()) return;
  var key = data.type + '_' + (data.uid || 'global');
  if (_cooldown(key)) return;
  rt().ref('adminAlerts').push(Object.assign({
    timestamp: _now(),
    resolved: false,
    source: 'fa54_wallet_security'
  }, data)).catch(function(){});
}

function _freezeUser(uid, reason) {
  if (!rt() || !uid) return;
  rt().ref('users/' + uid).update({
    isFrozen: true,
    frozenAt: _now(),
    frozenReason: reason,
    frozenBy: 'system_auto'
  }).then(function() {
    _pushAlert({
      type: 'auto_freeze',
      severity: 'HIGH',
      uid: uid,
      message: '🧊 Account auto-frozen: ' + reason,
      reason: reason
    });
    _logWalletAudit(uid, 'AUTO_FREEZE', 0, reason);
  }).catch(function(){});
}

function _logWalletAudit(uid, action, amount, note) {
  if (!rt()) return;
  rt().ref('walletAuditLog').push({
    uid: uid,
    action: action,
    amount: amount || 0,
    note: note || '',
    timestamp: _now(),
    adminUid: _adminUid()
  }).catch(function(){});
}

/* ═══════════════════════════════════════════════════════════
   1. REAL-TIME BALANCE WATCHER
   Monitors users/ node for unexpected balance changes
   that happen WITHOUT a corresponding walletRequest approval
   ═══════════════════════════════════════════════════════════ */
function startBalanceWatcher() {
  if (_watcherActive || !rt()) return;
  _watcherActive = true;

  // Take initial snapshot of all user balances
  rt().ref('users').once('value', function(snap) {
    if (!snap.exists()) return;
    snap.forEach(function(child) {
      var u = child.val() || {};
      _balanceSnap[child.key] = {
        deposit: _getDeposit(u),
        winnings: _getWinnings(u)
      };
    });
  });

  // Listen for individual balance changes
  rt().ref('users').on('child_changed', function(snap) {
    var uid = snap.key;
    var u = snap.val() || {};
    var newDep = _getDeposit(u);
    var newWin = _getWinnings(u);
    var old = _balanceSnap[uid] || { deposit: 0, winnings: 0 };

    var depJump = newDep - old.deposit;
    var winJump = newWin - old.winnings;

    // Check for suspicious jump
    if (depJump >= CFG.suspiciousJumpAmount) {
      _checkUnauthorizedJump(uid, 'deposit', depJump, newDep);
    }
    if (winJump >= CFG.suspiciousJumpAmount * 2) {
      // Winnings can jump from prize distribution — check timing
      _checkUnauthorizedJump(uid, 'winnings', winJump, newWin);
    }

    // Update snapshot
    _balanceSnap[uid] = { deposit: newDep, winnings: newWin };
  });
}

function _getDeposit(u) {
  return Number((u.realMoney || {}).deposited || (u.wallet || {}).depositBalance || 0);
}
function _getWinnings(u) {
  return Number((u.realMoney || {}).winnings || (u.wallet || {}).winningBalance || 0);
}

/* Check if a balance jump has a corresponding recent approved wallet request */
function _checkUnauthorizedJump(uid, type, amount, newBalance) {
  if (!rt()) return;
  var now = _now();
  var windowMs = 30 * 1000; // 30 seconds window

  rt().ref('walletRequests')
    .orderByChild('uid').equalTo(uid)
    .once('value', function(snap) {
      var hasRecentApproval = false;
      if (snap.exists()) {
        snap.forEach(function(c) {
          var w = c.val();
          var wUid = w.uid || w.userId || w.oderId;
          if (wUid !== uid) return;
          if (w.status !== 'approved') return;
          var approvedAt = w.processedAt || 0;
          if ((now - approvedAt) < windowMs && Math.abs(Number(w.amount) - amount) < 50) {
            hasRecentApproval = true;
          }
        });
      }

      if (!hasRecentApproval) {
        // Also check admin manual credit (activityLogs)
        rt().ref('activityLogs').orderByChild('uid').equalTo(uid).limitToLast(5).once('value', function(als) {
          var hasAdminAction = false;
          if (als.exists()) {
            als.forEach(function(c) {
              var l = c.val();
              if ((now - (l.timestamp || 0)) < windowMs && l.type && l.type.includes('wallet')) {
                hasAdminAction = true;
              }
            });
          }

          if (!hasAdminAction) {
            // UNAUTHORIZED BALANCE JUMP DETECTED
            _pushAlert({
              type: 'unauthorized_balance_jump',
              severity: 'HIGH',
              uid: uid,
              message: '🚨 UNAUTHORIZED balance jump! ' + type + ' +₹' + amount + ' (now ₹' + newBalance + ') — No matching approval found!',
              amount: amount,
              balanceType: type,
              newBalance: newBalance
            });
            _logWalletAudit(uid, 'UNAUTHORIZED_JUMP', amount, type + ' jumped +₹' + amount + ' without approval');

            if (CFG.autoFreezeOnJump) {
              _freezeUser(uid, 'Unauthorized balance jump: ' + type + ' +₹' + amount);
            }

            // Show live toast to admin if panel is open
            if (window.showToast) {
              showToast('🚨 HACK ALERT! User ' + uid.substring(0,8) + '... balance jumped ₹' + amount + ' without approval!', true);
            }

            // Flash alert badge
            _flashAlertBadge();
          }
        });
      }
    }).catch(function(){});
}

/* ═══════════════════════════════════════════════════════════
   2. UTR DUPLICATE DETECTOR
   Scans all wallet requests — same UTR = fake payment attempt
   ═══════════════════════════════════════════════════════════ */
function buildUTRCache() {
  if (!rt()) return;
  rt().ref('walletRequests').on('value', function(snap) {
    _utrCache = {};
    if (!snap.exists()) return;
    snap.forEach(function(c) {
      var w = c.val();
      var utr = (w.utrNumber || w.utr || w.transactionId || '').trim();
      if (utr.length >= CFG.utrMinLength) {
        if (!_utrCache[utr]) _utrCache[utr] = [];
        _utrCache[utr].push({
          key: c.key,
          uid: w.uid || w.userId || '',
          amount: w.amount,
          status: w.status,
          timestamp: w.timestamp || w.createdAt || 0
        });
      }
    });

    // Check for duplicates
    Object.keys(_utrCache).forEach(function(utr) {
      var entries = _utrCache[utr];
      if (entries.length > 1) {
        // Sort: most recent first
        entries.sort(function(a, b) { return b.timestamp - a.timestamp; });
        var uids = entries.map(function(e) { return e.uid; });
        var unique = uids.filter(function(v, i) { return uids.indexOf(v) === i; });

        _pushAlert({
          type: 'duplicate_utr',
          severity: 'HIGH',
          utr: utr,
          uid: entries[0].uid,
          message: '🔁 DUPLICATE UTR detected! "' + utr + '" used ' + entries.length + ' times by ' + unique.length + ' user(s). Possible fake payment!',
          affectedUids: unique,
          count: entries.length
        });
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   3. VELOCITY CHECKER
   Called before approveAddMoney — checks rate limits
   Returns { ok: true/false, reason: '' }
   ═══════════════════════════════════════════════════════════ */
window._walletVelocityCheck = async function(uid, amount) {
  if (!rt()) return { ok: true };
  var now = _now();
  var dayStart = new Date(); dayStart.setHours(0,0,0,0);
  var hourAgo = now - 3600000;

  try {
    var snap = await rt().ref('walletRequests')
      .orderByChild('uid').equalTo(uid)
      .once('value');

    var todayTotal = 0, hourCount = 0, pendingCount = 0;

    if (snap.exists()) {
      snap.forEach(function(c) {
        var w = c.val();
        var wUid = w.uid || w.userId || w.oderId;
        if (wUid !== uid) return;
        var wType = (w.type || '').toLowerCase();
        var isAdd = wType === 'add' || wType === 'deposit' || wType === 'add_money';
        if (!isAdd) return;

        if (w.status === 'pending') pendingCount++;
        if (w.status === 'approved') {
          var ts = w.processedAt || w.timestamp || 0;
          if (ts >= dayStart.getTime()) todayTotal += Number(w.amount) || 0;
          if (ts >= hourAgo) hourCount++;
        }
      });
    }

    if (pendingCount >= CFG.maxPendingPerUser) {
      return { ok: false, reason: 'User ke paas already ' + pendingCount + ' pending requests hain (max ' + CFG.maxPendingPerUser + ')' };
    }
    if (todayTotal + amount > CFG.maxDepositPerDay) {
      return { ok: false, reason: 'Daily limit exceed: aaj ₹' + todayTotal + ' already approved, ₹' + amount + ' aur approve karne se ₹' + CFG.maxDepositPerDay + ' limit cross hogi' };
    }
    if (hourCount >= CFG.maxDepositsPerHour) {
      return { ok: false, reason: 'Hourly frequency limit: is user ko pichle 1 ghante mein ' + hourCount + ' baar already approve kiya gaya hai' };
    }
    if (amount > CFG.maxDepositPerRequest) {
      return { ok: false, reason: 'Single request limit: ₹' + amount + ' > max ₹' + CFG.maxDepositPerRequest + ' per request' };
    }

    return { ok: true, todayTotal: todayTotal, hourCount: hourCount };
  } catch(e) {
    return { ok: true }; // fail open (don't block on error)
  }
};

/* ═══════════════════════════════════════════════════════════
   4. UTR VALIDATION
   Check UTR format + duplicate before approval
   ═══════════════════════════════════════════════════════════ */
window._walletUTRCheck = function(utr, currentRequestKey) {
  if (!utr || utr.length < CFG.utrMinLength) {
    return { ok: false, reason: 'UTR too short (minimum ' + CFG.utrMinLength + ' characters)' };
  }
  if (!/^[0-9A-Za-z]+$/.test(utr)) {
    return { ok: false, reason: 'UTR mein invalid characters hain' };
  }

  // Check duplicate in cache
  var entries = _utrCache[utr] || [];
  var others = entries.filter(function(e) { return e.key !== currentRequestKey && e.status === 'approved'; });
  if (others.length > 0) {
    return {
      ok: false,
      reason: 'DUPLICATE UTR! Yeh UTR pehle se approved hai (User: ' + (others[0].uid || 'unknown').substring(0, 8) + '...)',
      isDuplicate: true
    };
  }

  return { ok: true };
};

/* ═══════════════════════════════════════════════════════════
   5. ENHANCED approveAddMoney WRAPPER
   Wraps original function with all security checks
   ═══════════════════════════════════════════════════════════ */
function wrapApproveAddMoney() {
  if (!window.approveAddMoney || window._fa54Wrapped) return;
  window._fa54Wrapped = true;
  var origApprove = window.approveAddMoney;

  window.approveAddMoney = async function(rid) {
    var w = (window.allWalletRequests || {})[rid];
    if (!w) return origApprove.apply(this, arguments);

    var uid = window.getUid ? getUid(w) : (w.uid || w.userId);
    var amount = Number(w.amount) || 0;
    var utr = w.utrNumber || w.utr || w.transactionId || '';
    var userName = w.userName || w.displayName || uid || 'User';

    // Show security checking overlay
    if (window.showToast) showToast('🔍 Security checks chal rahe hain...');

    try {
      // CHECK 1: UTR validation
      if (CFG.requireUTRAlways) {
        var utrCheck = window._walletUTRCheck(utr, rid);
        if (!utrCheck.ok) {
          showToast('❌ UTR Check Failed: ' + utrCheck.reason, true);
          if (utrCheck.isDuplicate) {
            _pushAlert({
              type: 'duplicate_utr_approval_attempt',
              severity: 'HIGH',
              uid: uid,
              utr: utr,
              message: 'Admin ne duplicate UTR wala request approve karne ki koshish ki: ' + utr
            });
          }
          _logWalletAudit(uid, 'APPROVE_BLOCKED_UTR', amount, utrCheck.reason);
          return;
        }
      }

      // CHECK 2: Velocity / rate limiting
      var velCheck = await window._walletVelocityCheck(uid, amount);
      if (!velCheck.ok) {
        showToast('❌ Rate Limit: ' + velCheck.reason, true);
        _logWalletAudit(uid, 'APPROVE_BLOCKED_RATE', amount, velCheck.reason);

        // Show confirmation override for admin
        var override = confirm('⚠️ Security Warning:\n\n' + velCheck.reason + '\n\nKya phir bhi approve karna chahte ho? (Only if you are sure)');
        if (!override) return;
        _logWalletAudit(uid, 'RATE_LIMIT_OVERRIDDEN', amount, 'Admin override: ' + velCheck.reason);
      }

      // CHECK 3: User frozen?
      var userSnap = await rt().ref('users/' + uid).once('value');
      var userData = userSnap.val() || {};
      if (userData.isFrozen) {
        showToast('❌ User account frozen hai! Pehle unfreeze karo.', true);
        _logWalletAudit(uid, 'APPROVE_BLOCKED_FROZEN', amount, 'Account is frozen');
        return;
      }

      // All checks passed — proceed
      _logWalletAudit(uid, 'APPROVE_SECURITY_PASSED', amount, 'UTR: ' + utr);
      origApprove.apply(this, arguments);

    } catch(e) {
      origApprove.apply(this, arguments); // fail open
    }
  };
}

/* ═══════════════════════════════════════════════════════════
   6. SMART AUTO-APPROVE ENGINE
   Safe small deposits auto-approved if all conditions met
   ═══════════════════════════════════════════════════════════ */
async function tryAutoApprove(rid, w) {
  if (!CFG.autoApproveBelow || CFG.autoApproveBelow <= 0) return false;
  var amount = Number(w.amount) || 0;
  if (amount > CFG.autoApproveBelow) return false;

  var uid = window.getUid ? getUid(w) : (w.uid || w.userId);
  if (!uid) return false;

  var utr = w.utrNumber || w.utr || w.transactionId || '';

  // All conditions for auto-approve:
  var utrOk = window._walletUTRCheck(utr, rid);
  if (!utrOk.ok) return false;

  var velOk = await window._walletVelocityCheck(uid, amount);
  if (!velOk.ok) return false;

  // User must have played at least 1 match
  var userSnap = await rt().ref('users/' + uid).once('value');
  var userData = userSnap.val() || {};
  var matchesPlayed = (userData.stats || {}).matches || 0;
  if (matchesPlayed < 1) return false;
  if (userData.isFrozen || userData.isBanned || userData.blocked) return false;

  // All good — auto approve
  _logWalletAudit(uid, 'AUTO_APPROVED', amount, 'Smart auto-approve: all checks passed, UTR: ' + utr);

  await rt().ref('users/' + uid + '/realMoney/deposited').transaction(function(v) { return (v||0) + amount; });
  await rt().ref('users/' + uid + '/wallet/depositBalance').transaction(function(v) { return (v||0) + amount; });
  await rt().ref('walletRequests/' + rid).update({
    status: 'approved',
    processedAt: _now(),
    processedBy: 'system_auto',
    autoApproved: true,
    autoApproveReason: 'Amount ≤ ₹' + CFG.autoApproveBelow + ', UTR verified, no velocity issues'
  });
  await rt().ref('users/' + uid + '/transactions').push({
    type: 'deposit',
    amount: amount,
    description: 'Deposit auto-approved (₹' + amount + ')',
    timestamp: _now()
  });
  await rt().ref('users/' + uid + '/notifications').push({
    title: '✅ Deposit Approved!',
    message: 'Aapka ₹' + amount + ' deposit automatically approved ho gaya!',
    type: 'wallet_approved',
    amount: amount,
    timestamp: _now(),
    read: false
  });

  if (window.showToast) showToast('⚡ Auto-approved: ₹' + amount + ' for ' + (userData.ign || uid.substring(0,8)));
  return true;
}

/* ═══════════════════════════════════════════════════════════
   7. WALLET MONITOR DASHBOARD CARD
   Shows live security stats in the wallets section
   ═══════════════════════════════════════════════════════════ */
function injectSecurityDashboard() {
  var section = document.getElementById('section-wallets');
  if (!section || document.getElementById('_fa54SecurityCard')) return;

  var card = document.createElement('div');
  card.id = '_fa54SecurityCard';
  card.style.cssText = 'margin-bottom:12px';
  card.innerHTML = [
    '<div class="card" style="border:1px solid rgba(255,68,68,.25);background:rgba(255,68,68,.04)">',
    '<div class="card-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="window._fa54ToggleCard()">',
    '<span><i class="fas fa-shield-alt" style="color:#ff6b6b;margin-right:8px"></i><b style="color:#ff6b6b">Wallet Security Monitor</b></span>',
    '<div style="display:flex;gap:8px;align-items:center">',
    '<span id="_fa54AlertCount" style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:12px;background:rgba(255,68,68,.15);color:#ff6b6b">0 alerts</span>',
    '<button onclick="event.stopPropagation();window._fa54ShowConfig()" style="padding:4px 10px;border-radius:6px;background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.2);color:#ffd700;font-size:11px;cursor:pointer"><i class="fas fa-cog"></i> Config</button>',
    '<button onclick="event.stopPropagation();window._fa54FullReport()" style="padding:4px 10px;border-radius:6px;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.2);color:#00d4ff;font-size:11px;cursor:pointer"><i class="fas fa-chart-bar"></i> Report</button>',
    '</div></div>',
    '<div id="_fa54CardBody" style="padding:12px;display:grid;grid-template-columns:repeat(4,1fr);gap:10px">',
    '<div style="text-align:center;padding:10px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.07)">',
    '<div id="_fa54StatAlerts" style="font-size:24px;font-weight:900;color:#ff4444">0</div>',
    '<div style="font-size:10px;color:#aaa;margin-top:2px">🚨 Active Alerts</div></div>',
    '<div style="text-align:center;padding:10px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.07)">',
    '<div id="_fa54StatFrozen" style="font-size:24px;font-weight:900;color:#00d4ff">0</div>',
    '<div style="font-size:10px;color:#aaa;margin-top:2px">🧊 Frozen Accounts</div></div>',
    '<div style="text-align:center;padding:10px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.07)">',
    '<div id="_fa54StatDupUTR" style="font-size:24px;font-weight:900;color:#ffd700">0</div>',
    '<div style="font-size:10px;color:#aaa;margin-top:2px">🔁 Duplicate UTRs</div></div>',
    '<div style="text-align:center;padding:10px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.07)">',
    '<div id="_fa54StatAutoApp" style="font-size:24px;font-weight:900;color:#00ff9c">0</div>',
    '<div style="font-size:10px;color:#aaa;margin-top:2px">⚡ Auto-Approved</div></div>',
    '</div>',
    '<div id="_fa54AlertList" style="padding:0 12px 12px;max-height:280px;overflow-y:auto"></div>',
    '</div>'
  ].join('');

  // Insert before first card in section
  var firstCard = section.querySelector('.card');
  if (firstCard) section.insertBefore(card, firstCard);
  else section.appendChild(card);

  _updateSecurityStats();
  _startAlertListener();
}

var _cardCollapsed = false;
window._fa54ToggleCard = function() {
  _cardCollapsed = !_cardCollapsed;
  var body = document.getElementById('_fa54CardBody');
  var list = document.getElementById('_fa54AlertList');
  if (body) body.style.display = _cardCollapsed ? 'none' : 'grid';
  if (list) list.style.display = _cardCollapsed ? 'none' : 'block';
};

function _startAlertListener() {
  if (!rt()) return;
  rt().ref('adminAlerts').orderByChild('resolved').equalTo(false).on('value', function(snap) {
    var alerts = [];
    if (snap.exists()) snap.forEach(function(c) {
      var d = c.val(); d._key = c.key;
      if (d.source === 'fa54_wallet_security' || d.type === 'unauthorized_balance_jump' || d.type === 'duplicate_utr' || d.type === 'auto_freeze')
        alerts.push(d);
    });
    alerts.sort(function(a,b) { return b.timestamp - a.timestamp; });
    _renderAlertList(alerts);
    _updateSecurityStats();
  });
}

function _renderAlertList(alerts) {
  var el = document.getElementById('_fa54AlertList');
  var countEl = document.getElementById('_fa54AlertCount');
  var statEl = document.getElementById('_fa54StatAlerts');
  if (!el) return;
  if (countEl) { countEl.textContent = alerts.length + ' alerts'; countEl.style.background = alerts.length ? 'rgba(255,68,68,.2)' : 'rgba(0,255,156,.1)'; countEl.style.color = alerts.length ? '#ff4444' : '#00ff9c'; }
  if (statEl) statEl.textContent = alerts.length;

  if (!alerts.length) {
    el.innerHTML = '<div style="text-align:center;padding:16px;color:#00ff9c;font-weight:700;font-size:12px">✅ Koi active security alert nahi — Wallet safe hai!</div>';
    return;
  }

  var typeIcon = { unauthorized_balance_jump:'🚨', duplicate_utr:'🔁', auto_freeze:'🧊', duplicate_utr_approval_attempt:'⛔', velocity_breach:'⚡' };
  var sCol = { HIGH:'#ff4444', MEDIUM:'#ffaa00', LOW:'#00ff9c' };

  el.innerHTML = alerts.slice(0, 20).map(function(a) {
    var icon = typeIcon[a.type] || '⚠️';
    var col = sCol[a.severity] || '#aaa';
    var t = new Date(a.timestamp).toLocaleString('en-IN', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    return [
      '<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;border:1px solid rgba(',
      (a.severity==='HIGH'?'255,68,68':'255,170,0'),',.2);background:rgba(',(a.severity==='HIGH'?'255,68,68':'255,170,0'),',.05);margin-bottom:6px">',
      '<span style="font-size:18px">',icon,'</span>',
      '<div style="flex:1;min-width:0">',
      '<div style="font-size:11px;font-weight:700;color:',col,'">',a.type.replace(/_/g,' ').toUpperCase(),'</div>',
      '<div style="font-size:11px;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">',a.message||'','</div>',
      '<div style="font-size:10px;color:#666;margin-top:2px">',t,'</div>',
      '</div>',
      '<div style="display:flex;flex-direction:column;gap:4px">',
      a.uid ? '<button onclick="_fa54QuickAction(\''+a.uid+'\',\''+a._key+'\')" style="padding:4px 8px;border-radius:6px;background:rgba(255,68,68,.15);border:1px solid rgba(255,68,68,.3);color:#ff4444;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap">⚡ Action</button>' : '',
      '<button onclick="_fa54ResolveAlert(\''+a._key+'\')" style="padding:4px 8px;border-radius:6px;background:rgba(0,255,156,.08);border:1px solid rgba(0,255,156,.2);color:#00ff9c;font-size:10px;font-weight:700;cursor:pointer">✅ Resolve</button>',
      '</div></div>'
    ].join('');
  }).join('');
}

window._fa54ResolveAlert = function(key) {
  if (!rt()) return;
  rt().ref('adminAlerts/' + key).update({ resolved: true, resolvedAt: _now(), resolvedBy: _adminUid() });
};

window._fa54QuickAction = function(uid, alertKey) {
  var u = (window.usersCache || {})[uid] || {};
  var ign = u.ign || uid.substring(0,8) + '...';
  var isFrozen = u.isFrozen;

  var h = '<div style="display:grid;gap:10px">';
  h += '<div style="background:rgba(255,68,68,.08);border:1px solid rgba(255,68,68,.2);border-radius:10px;padding:12px">';
  h += '<div style="font-size:13px;font-weight:700;color:#ff4444;margin-bottom:4px">⚠️ ' + ign + '</div>';
  h += '<div style="font-size:11px;color:#aaa">UID: ' + uid + '</div>';
  h += '<div style="font-size:11px;color:' + (isFrozen?'#00d4ff':'#ffaa00') + ';margin-top:4px">' + (isFrozen ? '🧊 Currently FROZEN' : '🟡 Active Account') + '</div>';
  h += '</div>';

  var btns = [
    { label: (isFrozen ? '🔓 Unfreeze Account' : '🧊 Freeze Account'), action: 'freeze', color: isFrozen ? '#00ff9c' : '#ff4444', bg: isFrozen ? 'rgba(0,255,156,.1)' : 'rgba(255,68,68,.12)' },
    { label: '🚫 Ban User', action: 'ban', color: '#ff4444', bg: 'rgba(255,68,68,.12)' },
    { label: '💰 View Wallet History', action: 'wallet', color: '#ffd700', bg: 'rgba(255,215,0,.1)' },
    { label: '👁️ Open User Profile', action: 'profile', color: '#00d4ff', bg: 'rgba(0,212,255,.1)' },
    { label: '✅ Mark Alert Resolved', action: 'resolve', color: '#00ff9c', bg: 'rgba(0,255,156,.1)' },
  ];

  btns.forEach(function(b) {
    h += '<button onclick="_fa54DoAction(\''+b.action+'\',\''+uid+'\',\''+alertKey+'\')" style="width:100%;padding:12px;border-radius:10px;background:'+b.bg+';border:1px solid '+b.color+';color:'+b.color+';font-weight:700;font-size:13px;cursor:pointer;text-align:left">'+b.label+'</button>';
  });
  h += '</div>';
  if (window.showModal) showModal('🛡️ Quick Security Action', h);
};

window._fa54DoAction = async function(action, uid, alertKey) {
  if (!rt()) return;
  if (window.closeGenericModal) closeGenericModal();

  if (action === 'freeze') {
    var u = (window.usersCache || {})[uid] || {};
    if (u.isFrozen) {
      await rt().ref('users/' + uid).update({ isFrozen: false, unfrozenAt: _now(), unfrozenBy: _adminUid() });
      _logWalletAudit(uid, 'MANUAL_UNFREEZE', 0, 'Admin unfreeze');
      if (window.showToast) showToast('✅ Account unfrozen!');
    } else {
      _freezeUser(uid, 'Manual freeze by admin');
      if (window.showToast) showToast('🧊 Account frozen!');
    }
  } else if (action === 'ban') {
    if (!confirm('User ' + uid + ' ko permanently ban karna chahte ho?')) return;
    await rt().ref('users/' + uid).update({ isBanned: true, banned: true, bannedAt: _now(), bannedBy: _adminUid(), bannedReason: 'Wallet security violation' });
    _logWalletAudit(uid, 'MANUAL_BAN', 0, 'Banned for security violation');
    if (alertKey) rt().ref('adminAlerts/' + alertKey).update({ resolved: true, action: 'banned', resolvedAt: _now() });
    if (window.showToast) showToast('🚫 User banned!');
  } else if (action === 'wallet') {
    _fa54ShowUserWalletHistory(uid);
    return;
  } else if (action === 'profile') {
    if (window.openUserModal) openUserModal(uid);
    return;
  } else if (action === 'resolve') {
    if (alertKey) rt().ref('adminAlerts/' + alertKey).update({ resolved: true, resolvedAt: _now(), resolvedBy: _adminUid() });
    if (window.showToast) showToast('✅ Alert resolved!');
  }
};

/* ═══════════════════════════════════════════════════════════
   8. USER WALLET HISTORY VIEWER
   Complete transaction audit trail per user
   ═══════════════════════════════════════════════════════════ */
window._fa54ShowUserWalletHistory = async function(uid) {
  if (!rt()) return;
  var m = document.getElementById('genericModal');
  var mt = document.getElementById('genericModalTitle');
  var mb = document.getElementById('genericModalBody');
  if (!m || !mt || !mb) return;

  var u = (window.usersCache || {})[uid] || {};
  mt.innerHTML = '💰 Wallet History — ' + (u.ign || uid.substring(0,10));
  mb.innerHTML = '<div style="text-align:center;padding:20px"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
  m.classList.add('show');

  try {
    var [txSnap, reqSnap, auditSnap] = await Promise.all([
      rt().ref('users/' + uid + '/transactions').limitToLast(50).once('value'),
      rt().ref('walletRequests').orderByChild('uid').equalTo(uid).once('value'),
      rt().ref('walletAuditLog').orderByChild('uid').equalTo(uid).limitToLast(30).once('value')
    ]);

    var txns = [];
    if (txSnap.exists()) txSnap.forEach(function(c) { var d = c.val(); d._key = c.key; txns.push(d); });
    txns.sort(function(a,b) { return b.timestamp - a.timestamp; });

    var requests = [];
    if (reqSnap.exists()) reqSnap.forEach(function(c) {
      var w = c.val(); var wUid = w.uid || w.userId || w.oderId;
      if (wUid === uid) { w._key = c.key; requests.push(w); }
    });
    requests.sort(function(a,b) { return b.timestamp - a.timestamp; });

    var audits = [];
    if (auditSnap.exists()) auditSnap.forEach(function(c) { var d = c.val(); d._key = c.key; audits.push(d); });
    audits.sort(function(a,b) { return b.timestamp - a.timestamp; });

    var totalDep = _getDeposit(u);
    var totalWin = _getWinnings(u);

    var html = '<div style="max-height:70vh;overflow-y:auto">';

    // Balance summary
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">';
    html += '<div style="text-align:center;padding:12px;background:rgba(0,255,156,.06);border:1px solid rgba(0,255,156,.15);border-radius:10px"><div style="font-size:22px;font-weight:900;color:#00ff9c">₹' + totalDep + '</div><div style="font-size:10px;color:#aaa">Deposit Balance</div></div>';
    html += '<div style="text-align:center;padding:12px;background:rgba(255,215,0,.06);border:1px solid rgba(255,215,0,.15);border-radius:10px"><div style="font-size:22px;font-weight:900;color:#ffd700">₹' + totalWin + '</div><div style="font-size:10px;color:#aaa">Winnings Balance</div></div>';
    html += '</div>';

    // Freeze/ban status
    if (u.isFrozen || u.isBanned) {
      html += '<div style="padding:10px;border-radius:8px;background:rgba(255,68,68,.1);border:1px solid rgba(255,68,68,.3);color:#ff4444;font-size:12px;font-weight:700;margin-bottom:12px">';
      html += u.isFrozen ? '🧊 FROZEN — ' + (u.frozenReason || '') : '';
      html += u.isBanned ? '🚫 BANNED — ' + (u.bannedReason || '') : '';
      html += '</div>';
    }

    // Tab: Wallet Requests
    html += '<div style="font-size:12px;font-weight:700;color:#00d4ff;margin-bottom:8px">📋 Wallet Requests (' + requests.length + ')</div>';
    if (requests.length) {
      html += '<div style="margin-bottom:14px">';
      requests.slice(0, 15).forEach(function(r) {
        var tp = (r.type || 'add').toLowerCase();
        var isAdd = tp === 'add' || tp === 'deposit' || tp === 'add_money';
        var stCol = r.status === 'approved' ? '#00ff9c' : r.status === 'rejected' ? '#ff4444' : '#ffaa00';
        var t = new Date(r.timestamp || r.processedAt || 0).toLocaleString('en-IN', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
        var utr = r.utrNumber || r.utr || r.transactionId || '—';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(255,255,255,.03);border-radius:8px;border:1px solid rgba(255,255,255,.06);margin-bottom:5px">';
        html += '<span style="font-size:16px">' + (isAdd ? '📥' : '📤') + '</span>';
        html += '<div style="flex:1"><div style="font-size:12px;font-weight:700;color:' + (isAdd?'#00ff9c':'#ffd700') + '">' + (isAdd?'+ ':'- ') + '₹' + (r.amount||0) + '</div>';
        html += '<div style="font-size:10px;color:#aaa">UTR: ' + utr + ' · ' + t + '</div></div>';
        html += '<span style="font-size:10px;font-weight:700;color:' + stCol + ';padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.3)">' + (r.status||'pending') + (r.autoApproved?' ⚡':'') + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Security audit log
    if (audits.length) {
      html += '<div style="font-size:12px;font-weight:700;color:#ff6b6b;margin-bottom:8px">🛡️ Security Events (' + audits.length + ')</div>';
      html += '<div style="margin-bottom:14px">';
      audits.slice(0, 10).forEach(function(a) {
        var isRed = a.action && (a.action.includes('BLOCKED') || a.action.includes('FREEZE') || a.action.includes('BAN') || a.action.includes('JUMP'));
        var t = new Date(a.timestamp || 0).toLocaleString('en-IN', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
        html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,68,68,.04);border-radius:6px;border:1px solid rgba(255,68,68,.1);margin-bottom:4px">';
        html += '<span style="font-size:11px;font-weight:700;color:' + (isRed?'#ff4444':'#00ff9c') + ';min-width:160px">' + (a.action||'') + '</span>';
        html += '<span style="font-size:10px;color:#aaa;flex:1">' + (a.note||'') + '</span>';
        html += '<span style="font-size:10px;color:#666">' + t + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Transaction history
    html += '<div style="font-size:12px;font-weight:700;color:#ffd700;margin-bottom:8px">📊 Transaction History (' + txns.length + ')</div>';
    txns.slice(0, 15).forEach(function(tx) {
      var isPos = tx.amount > 0;
      var t = new Date(tx.timestamp || 0).toLocaleString('en-IN', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
      html += '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(255,255,255,.02);border-radius:7px;border:1px solid rgba(255,255,255,.05);margin-bottom:4px">';
      html += '<span style="font-size:13px;font-weight:800;color:' + (isPos?'#00ff9c':'#ff4444') + ';min-width:80px">' + (isPos?'+':'') + '₹' + (tx.amount||0) + '</span>';
      html += '<div style="flex:1"><div style="font-size:11px;font-weight:600">' + (tx.type||'tx') + '</div><div style="font-size:10px;color:#666">' + (tx.description||'') + '</div></div>';
      html += '<span style="font-size:10px;color:#555">' + t + '</span>';
      html += '</div>';
    });

    html += '</div>';
    mb.innerHTML = html;

  } catch(e) {
    mb.innerHTML = '<div style="color:#ff4444;padding:16px">Error: ' + e.message + '</div>';
  }
};

/* ═══════════════════════════════════════════════════════════
   9. SECURITY CONFIG PANEL
   ═══════════════════════════════════════════════════════════ */
window._fa54ShowConfig = function() {
  var h = '<div style="display:grid;gap:12px">';

  function row(label, id, val, type, extra) {
    return '<div><label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px">' + label + '</label>' +
      (type === 'checkbox' ?
        '<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer"><input type="checkbox" id="' + id + '" ' + (val ? 'checked' : '') + ' style="width:16px;height:16px"> Enable</label>' :
        '<input type="number" id="' + id + '" value="' + val + '" style="width:100%;padding:8px;border-radius:8px;background:#111;border:1px solid #333;color:#00d4ff;font-size:14px;font-weight:700;text-align:center;box-sizing:border-box">'
      ) +
      (extra ? '<div style="font-size:10px;color:#555;margin-top:3px">' + extra + '</div>' : '') + '</div>';
  }

  h += '<div style="background:rgba(255,68,68,.06);border:1px solid rgba(255,68,68,.15);border-radius:10px;padding:12px">';
  h += '<div style="font-size:12px;font-weight:700;color:#ff6b6b;margin-bottom:10px">💰 Deposit Limits</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  h += row('Max Per Day (₹)', 'cfg_maxDay', CFG.maxDepositPerDay, 'number');
  h += row('Max Per Request (₹)', 'cfg_maxReq', CFG.maxDepositPerRequest, 'number');
  h += row('Max Per Hour (count)', 'cfg_maxHr', CFG.maxDepositsPerHour, 'number');
  h += row('Max Pending per User', 'cfg_maxPend', CFG.maxPendingPerUser, 'number');
  h += '</div></div>';

  h += '<div style="background:rgba(255,215,0,.06);border:1px solid rgba(255,215,0,.15);border-radius:10px;padding:12px">';
  h += '<div style="font-size:12px;font-weight:700;color:#ffd700;margin-bottom:10px">🛡️ Security Rules</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  h += row('Suspicious Jump Alert (₹)', 'cfg_jump', CFG.suspiciousJumpAmount, 'number', 'Balance suddenly jumps by this amount → alert');
  h += row('Min UTR Length', 'cfg_utrLen', CFG.utrMinLength, 'number');
  h += row('Auto-Freeze on Jump', 'cfg_freeze', CFG.autoFreezeOnJump, 'checkbox');
  h += row('UTR Always Required', 'cfg_utrReq', CFG.requireUTRAlways, 'checkbox');
  h += '</div></div>';

  h += '<div style="background:rgba(0,255,156,.04);border:1px solid rgba(0,255,156,.1);border-radius:10px;padding:12px">';
  h += '<div style="font-size:12px;font-weight:700;color:#00ff9c;margin-bottom:10px">⚡ Auto-Approve</div>';
  h += row('Auto-Approve Below (₹)', 'cfg_autoApp', CFG.autoApproveBelow, 'number', '0 = disabled. Deposits ≤ this amount auto-approved if all checks pass');
  h += '</div>';

  h += '<button onclick="_fa54SaveConfig()" style="width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,#00ff9c,#00d4aa);color:#000;font-weight:800;border:none;cursor:pointer;font-size:14px"><i class="fas fa-save"></i> Save Config</button>';
  h += '</div>';

  if (window.showModal) showModal('⚙️ Wallet Security Config', h);
};

window._fa54SaveConfig = function() {
  function val(id) { var el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : Number(el.value)) : null; }
  CFG.maxDepositPerDay    = val('cfg_maxDay')    || 5000;
  CFG.maxDepositPerRequest= val('cfg_maxReq')    || 2000;
  CFG.maxDepositsPerHour  = val('cfg_maxHr')     || 3;
  CFG.maxPendingPerUser   = val('cfg_maxPend')   || 2;
  CFG.suspiciousJumpAmount= val('cfg_jump')      || 500;
  CFG.utrMinLength        = val('cfg_utrLen')    || 12;
  CFG.autoFreezeOnJump    = val('cfg_freeze');
  CFG.requireUTRAlways    = val('cfg_utrReq');
  CFG.autoApproveBelow    = val('cfg_autoApp')   || 0;

  // Persist to Firebase
  if (rt()) rt().ref('appSettings/walletSecurity').set(Object.assign({}, CFG, {updatedAt: _now(), updatedBy: _adminUid()}));

  if (window.closeGenericModal) closeGenericModal();
  if (window.showToast) showToast('✅ Wallet security config saved!');
};

/* ═══════════════════════════════════════════════════════════
   10. FULL SECURITY REPORT
   ═══════════════════════════════════════════════════════════ */
window._fa54FullReport = async function() {
  if (!rt()) return;
  var m = document.getElementById('genericModal'), mt = document.getElementById('genericModalTitle'), mb = document.getElementById('genericModalBody');
  if (!m) return;
  mt.innerHTML = '📊 Wallet Security Report';
  mb.innerHTML = '<div style="text-align:center;padding:30px"><i class="fas fa-spinner fa-spin fa-2x"></i></div>';
  m.classList.add('show');

  try {
    var [alertSnap, reqSnap, auditSnap] = await Promise.all([
      rt().ref('adminAlerts').limitToLast(200).once('value'),
      rt().ref('walletRequests').once('value'),
      rt().ref('walletAuditLog').limitToLast(500).once('value')
    ]);

    var alerts = [], reqs = [], audits = [];
    if (alertSnap.exists()) alertSnap.forEach(function(c) { var d = c.val(); d._key = c.key; if (d.source === 'fa54_wallet_security' || d.type === 'unauthorized_balance_jump' || d.type === 'duplicate_utr' || d.type === 'auto_freeze') alerts.push(d); });
    if (reqSnap.exists()) reqSnap.forEach(function(c) { var d = c.val(); d._key = c.key; reqs.push(d); });
    if (auditSnap.exists()) auditSnap.forEach(function(c) { var d = c.val(); d._key = c.key; audits.push(d); });

    var approved = reqs.filter(function(r) { return r.status === 'approved'; });
    var autoApp  = approved.filter(function(r) { return r.autoApproved; });
    var pending  = reqs.filter(function(r) { return r.status === 'pending'; });
    var rejected = reqs.filter(function(r) { return r.status === 'rejected'; });

    var dupUTRs  = Object.keys(_utrCache).filter(function(u) { return (_utrCache[u]||[]).length > 1; });
    var frozen   = Object.keys(window.usersCache || {}).filter(function(uid) { return (window.usersCache[uid]||{}).isFrozen; });
    var blocked  = audits.filter(function(a) { return a.action && a.action.includes('BLOCKED'); });
    var totalDeposited = approved.filter(function(r) { var t = (r.type||'').toLowerCase(); return t==='add'||t==='deposit'||t==='add_money'; }).reduce(function(s,r) { return s + (Number(r.amount)||0); }, 0);

    var html = '<div style="max-height:75vh;overflow-y:auto">';

    // Summary grid
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">';
    var stats = [
      { v: approved.length, l: 'Approved', c: '#00ff9c' },
      { v: pending.length, l: 'Pending', c: '#ffaa00' },
      { v: rejected.length, l: 'Rejected', c: '#ff4444' },
      { v: autoApp.length, l: 'Auto-Approved', c: '#00d4ff' },
      { v: blocked.length, l: 'Blocked Attempts', c: '#ff6b6b' },
      { v: dupUTRs.length, l: 'Duplicate UTRs', c: '#ffd700' },
      { v: frozen.length, l: 'Frozen Accounts', c: '#00d4ff' },
      { v: alerts.filter(function(a){return !a.resolved;}).length, l: 'Active Alerts', c: '#ff4444' },
      { v: '₹' + totalDeposited, l: 'Total Deposited', c: '#00ff9c' },
    ];
    stats.forEach(function(s) {
      html += '<div style="text-align:center;padding:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px"><div style="font-size:22px;font-weight:900;color:' + s.c + '">' + s.v + '</div><div style="font-size:10px;color:#aaa;margin-top:2px">' + s.l + '</div></div>';
    });
    html += '</div>';

    // Top suspicious users (most alerts)
    var alertByUser = {};
    alerts.forEach(function(a) { if (a.uid) { alertByUser[a.uid] = (alertByUser[a.uid]||0) + 1; } });
    var topSuspect = Object.keys(alertByUser).sort(function(a,b){ return alertByUser[b]-alertByUser[a]; }).slice(0,5);

    if (topSuspect.length) {
      html += '<div style="font-size:12px;font-weight:700;color:#ff6b6b;margin-bottom:8px">🎯 Most Flagged Users</div>';
      html += '<div style="margin-bottom:14px">';
      topSuspect.forEach(function(uid) {
        var u = (window.usersCache || {})[uid] || {};
        var status = u.isBanned ? '🚫 Banned' : u.isFrozen ? '🧊 Frozen' : '⚠️ Active';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:rgba(255,68,68,.05);border:1px solid rgba(255,68,68,.15);border-radius:8px;margin-bottom:6px">';
        html += '<div style="flex:1"><div style="font-size:12px;font-weight:700;color:#ff4444">' + (u.ign||uid.substring(0,10)+'...') + '</div><div style="font-size:10px;color:#aaa">' + status + '</div></div>';
        html += '<span style="font-size:18px;font-weight:900;color:#ff4444">' + alertByUser[uid] + ' alerts</span>';
        html += '<button onclick="window._fa54QuickAction(\'' + uid + '\',\'\')" style="padding:5px 10px;border-radius:6px;background:rgba(255,68,68,.15);border:1px solid rgba(255,68,68,.3);color:#ff4444;font-size:11px;cursor:pointer">Action</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Duplicate UTRs detail
    if (dupUTRs.length) {
      html += '<div style="font-size:12px;font-weight:700;color:#ffd700;margin-bottom:8px">🔁 Duplicate UTR Numbers</div>';
      html += '<div style="margin-bottom:14px">';
      dupUTRs.slice(0, 10).forEach(function(utr) {
        var entries = _utrCache[utr] || [];
        html += '<div style="padding:8px 12px;background:rgba(255,215,0,.05);border:1px solid rgba(255,215,0,.2);border-radius:8px;margin-bottom:5px">';
        html += '<div style="font-size:12px;font-weight:700;color:#ffd700;font-family:monospace">' + utr + '</div>';
        html += '<div style="font-size:11px;color:#aaa">Used ' + entries.length + ' times — UIDs: ' + entries.map(function(e){return (e.uid||'?').substring(0,8);}).join(', ') + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '</div>';
    mb.innerHTML = html;
  } catch(e) {
    mb.innerHTML = '<div style="color:#ff4444;padding:16px">Error: ' + e.message + '</div>';
  }
};

/* ─── Update security stats counters ─── */
function _updateSecurityStats() {
  if (!rt()) return;

  // Frozen count
  var frozenCount = Object.keys(window.usersCache || {}).filter(function(uid) {
    return (window.usersCache[uid] || {}).isFrozen;
  }).length;
  var el = document.getElementById('_fa54StatFrozen');
  if (el) el.textContent = frozenCount;

  // Duplicate UTR count
  var dupCount = Object.keys(_utrCache).filter(function(u) { return (_utrCache[u]||[]).length > 1; }).length;
  var el2 = document.getElementById('_fa54StatDupUTR');
  if (el2) el2.textContent = dupCount;

  // Auto-approved count (from wallet requests)
  rt().ref('walletRequests').orderByChild('autoApproved').equalTo(true).once('value', function(snap) {
    var el3 = document.getElementById('_fa54StatAutoApp');
    if (el3) el3.textContent = snap.numChildren ? snap.numChildren() : 0;
  });
}

/* ─── Flash alert badge in header ─── */
function _flashAlertBadge() {
  var badge = document.getElementById('fraudAlertBadge');
  if (!badge) return;
  badge.style.animation = 'none';
  badge.offsetHeight; // force reflow
  badge.style.animation = 'pulse 0.5s ease-in-out 3';
}

/* ═══════════════════════════════════════════════════════════
   WALLET REQUEST TABLE — Add security badges to each row
   Hooks into renderWalletRequests
   ═══════════════════════════════════════════════════════════ */
function hookRenderWalletRequests() {
  if (!window.renderWalletRequests || window._fa54RWHooked) return;
  window._fa54RWHooked = true;
  var orig = window.renderWalletRequests;

  window.renderWalletRequests = function() {
    orig.apply(this, arguments);

    // After rendering, add security badge to each row
    setTimeout(function() {
      var tb = document.getElementById('walletRequestsTable');
      if (!tb) return;
      var reqs = window.allWalletRequests || {};

      tb.querySelectorAll('tr').forEach(function(row, i) {
        if (row.dataset.secChecked) return;
        row.dataset.secChecked = '1';
        var cells = row.querySelectorAll('td');
        if (cells.length < 7) return;

        // Find the matching request
        var reqKeys = Object.keys(reqs);
        var rid = reqKeys[i];
        if (!rid) return;
        var w = reqs[rid];
        if (!w || w.status !== 'pending') return;

        var utr = w.utrNumber || w.utr || w.transactionId || '';
        var uid = window.getUid ? getUid(w) : (w.uid || w.userId);
        var amount = Number(w.amount) || 0;
        var warnings = [];

        // UTR checks
        if (!utr) warnings.push({ label: 'No UTR', col: '#ff4444' });
        else if (utr.length < CFG.utrMinLength) warnings.push({ label: 'Short UTR', col: '#ffaa00' });
        else {
          var dupEntries = (_utrCache[utr] || []).filter(function(e) { return e.key !== rid && e.status === 'approved'; });
          if (dupEntries.length) warnings.push({ label: 'DUP UTR!', col: '#ff4444' });
        }

        // Amount check
        if (amount > CFG.maxDepositPerRequest) warnings.push({ label: '₹' + amount + ' > limit', col: '#ffaa00' });

        // User frozen?
        var u = (window.usersCache || {})[uid] || {};
        if (u.isFrozen) warnings.push({ label: '🧊 Frozen', col: '#00d4ff' });
        if (u.isBanned || u.blocked) warnings.push({ label: '🚫 Banned', col: '#ff4444' });

        // Auto-approve eligible?
        if (amount <= CFG.autoApproveBelow && !warnings.length) warnings.push({ label: '⚡ Auto-OK', col: '#00ff9c' });

        if (warnings.length) {
          var badgeHtml = warnings.map(function(w) {
            return '<span style="display:inline-block;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.4);border:1px solid ' + w.col + ';color:' + w.col + ';margin:1px">' + w.label + '</span>';
          }).join('');
          var firstCell = cells[0];
          if (firstCell) firstCell.insertAdjacentHTML('beforeend', '<div style="margin-top:3px">' + badgeHtml + '</div>');
        }
      });
    }, 200);
  };
}

/* ═══════════════════════════════════════════════════════════
   AUTOMATION: Auto-scan pending requests on wallet section open
   ═══════════════════════════════════════════════════════════ */
async function autoScanPendingRequests() {
  if (!rt()) return;
  var reqs = window.allWalletRequests || {};
  var pending = Object.keys(reqs).filter(function(k) { return reqs[k].status === 'pending'; });
  if (!pending.length) return;

  for (var i = 0; i < pending.length; i++) {
    var rid = pending[i];
    var w = reqs[rid];
    if (!w) continue;
    var tp = (w.type || '').toLowerCase();
    var isAdd = tp === 'add' || tp === 'deposit' || tp === 'add_money';
    if (!isAdd) continue;

    // Try auto-approve small safe ones
    try {
      await tryAutoApprove(rid, w);
    } catch(e) {}
  }
}

/* ═══════════════════════════════════════════════════════════
   LOAD CONFIG FROM FIREBASE
   ═══════════════════════════════════════════════════════════ */
function loadConfig() {
  if (!rt()) return;
  rt().ref('appSettings/walletSecurity').once('value', function(snap) {
    if (snap.exists()) {
      var saved = snap.val();
      Object.keys(CFG).forEach(function(k) { if (saved[k] !== undefined) CFG[k] = saved[k]; });
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════ */
var _tries = 0;
var _poll = setInterval(function() {
  _tries++;

  // Wait for rtdb to be ready
  if (!rt()) { if (_tries > 60) clearInterval(_poll); return; }

  clearInterval(_poll);
  loadConfig();
  buildUTRCache();
  startBalanceWatcher();

  // Wait for DOM + existing functions
  var _domTries = 0;
  var _domPoll = setInterval(function() {
    _domTries++;
    injectSecurityDashboard();
    wrapApproveAddMoney();
    hookRenderWalletRequests();
    if (_domTries > 60) clearInterval(_domPoll);
  }, 500);

  // Hook into section navigation to auto-scan when wallet section opens
  if (window.showSection) {
    var origShow = window.showSection;
    window.showSection = function(sec) {
      var r = origShow.apply(this, arguments);
      if (sec === 'wallets') {
        setTimeout(function() {
          injectSecurityDashboard();
          _updateSecurityStats();
          autoScanPendingRequests();
        }, 300);
      }
      return r;
    };
  }

}, 300);

// Add pulse keyframe for badge animation
var style = document.createElement('style');
style.textContent = '@keyframes pulse{0%{transform:scale(1);opacity:1}50%{transform:scale(1.3);opacity:0.7}100%{transform:scale(1);opacity:1}}';
document.head.appendChild(style);

window._FA54 = { cfg: CFG, utrCache: _utrCache, balanceSnap: _balanceSnap };

})();

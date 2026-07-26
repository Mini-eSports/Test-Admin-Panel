/* =============================================
   FEATURE A01: Auto Prize Distribution (Admin)
   - Admin result me position + kills enter kare
   - System automatically prize calculate kare
   - "Distribute All" click se sab users ko prize milta hai
   - Firebase: users/{uid}/realMoney/winnings me add hota hai
   - Log: matchResults/{matchId} me save hota hai
   ============================================= */
(function() {
  'use strict';

  var _distributionData = {}; // matchId -> {uid, name, prize}[]

  function calcPrize(rank, kills, matchData) {
    if (!matchData) return 0;
    var rankPrize = 0;
    if (rank === 1) rankPrize = Number(matchData.firstPrize || matchData.prize1 || 0);
    else if (rank === 2) rankPrize = Number(matchData.secondPrize || matchData.prize2 || 0);
    else if (rank === 3) rankPrize = Number(matchData.thirdPrize || matchData.prize3 || 0);

    // Additional position prizes if defined
    var extra = 0;
    if (matchData.prizes) {
      var prizeArr = matchData.prizes;
      if (Array.isArray(prizeArr) && prizeArr[rank-1]) extra = Number(prizeArr[rank-1]) || 0;
    }

    var killPrize = Number(kills) * Number(matchData.perKillPrize || matchData.perKill || 0);
    return Math.max(rankPrize || extra, 0) + killPrize;
  }

  // calcPrize is defined and managed by inline script in index.html
  // fa01 uses window.calcPrize which is set there
  window.adminCalcPrize = function(inp) { if(window.calcPrize) window.calcPrize(inp); };

  function collectResults() {
    var rows = document.querySelectorAll('#participantsList tr[data-uid]');
    var results = [];
    rows.forEach(function(row) {
      var uid = row.dataset.uid;
      var name = row.querySelector('.user-name') ? row.querySelector('.user-name').textContent : (row.dataset.name || uid);
      var _ri = row.querySelector('.rank-input'); var rank = Number(_ri ? _ri.value : (row.dataset.rank || 0)) || 0;
      var _ki = row.querySelector('.kills-input'); var kills = Number(_ki ? _ki.value : (row.dataset.kills || 0)) || 0;
      var prize = calcPrize(rank, kills, window.currentTournamentData);
      results.push({ uid: uid, name: name, rank: rank, kills: kills, prize: prize });
    });
    return results;
  }

  window.adminDistributePrizes = function() {
    var mid = document.getElementById('resultTournamentSelect') ? document.getElementById('resultTournamentSelect').value : '';
    if (!mid) { showAdminToast('Pehle match select karo', true); return; }

    var results = collectResults();
    var winners = results.filter(function(r) { return r.prize > 0; });

    if (winners.length === 0) {
      showAdminToast('Koi winner nahi mila — position/kills enter karo', true);
      return;
    }

    // Confirm modal
    var h = '<div>';
    h += '<div style="font-size:14px;font-weight:700;margin-bottom:12px">Prize distribute karna hai?</div>';
    var total = 0;
    winners.forEach(function(w) {
      total += w.prize;
      h += '<div style="display:flex;justify-content:space-between;padding:8px;border-radius:8px;background:var(--bg-dark);margin-bottom:4px;font-size:13px">';
      h += '<span>' + w.name + ' (#' + w.rank + ')</span>';
      h += '<span style="color:var(--primary);font-weight:700">₹' + w.prize + '</span>';
      h += '</div>';
    });
    h += '<div style="display:flex;justify-content:space-between;padding:10px;background:rgba(0,255,156,.08);border-radius:10px;margin-top:8px;font-weight:700">';
    h += '<span>Total Distribution</span><span style="color:var(--primary)">₹' + total + '</span></div>';
    h += '<div style="display:flex;gap:8px;margin-top:16px">';
    h += '<button onclick="this.closest(\'.modal-body\')&&(window._confirmDistribute=true)" class="btn btn-primary" style="flex:1" onclick="window.adminExecuteDistribute(\'' + mid + '\')">✅ Confirm & Distribute</button>';
    h += '<button onclick="document.getElementById(\'adminModal\').style.display=\'none\'" class="btn btn-ghost" style="flex:1">Cancel</button>';
    h += '</div></div>';

    // Store results for execution
    _distributionData[mid] = winners;

    showAdminModal('💰 Prizes Distribute', h);
  };

  window.adminExecuteDistribute = function(mid) {
    var winners = _distributionData[mid];
    if (!winners) return;

    var rtdb = window.rtdb || window.db;
    if (!rtdb) { showAdminToast('Database not connected', true); return; }

    var matchData = window.currentTournamentData || {};
    var processed = 0;

    winners.forEach(function(w) {
      // Add prize to winnings
      rtdb.ref('users/' + w.uid + '/realMoney/winnings').transaction(function(v) {
        return (v || 0) + w.prize;
      });
      // TDS TRACKING: Prize credited — winnings cumulative track karo (Section 194BA)
      rtdb.ref('users/' + w.uid + '/tds/winningsCredited').transaction(function(v) { return (v||0) + w.prize; });
      // TDS record save karo for admin Form 26Q filing
      var tdsRef = rtdb.ref('tdsRecords').push().key;
      rtdb.ref('tdsRecords/' + tdsRef).set({
        uid: w.uid, ign: w.name || '',
        type: 'prize_credited', amount: w.prize,
        matchId: mid, matchName: (window.currentTournamentData || {}).name || '',
        rank: w.rank, kills: w.kills,
        timestamp: Date.now(),
        financialYear: (function(){ var d=new Date(); return d.getMonth()<3?(d.getFullYear()-1)+'-'+d.getFullYear():d.getFullYear()+'-'+(d.getFullYear()+1); })()
      });
      // Update stats
      rtdb.ref('users/' + w.uid + '/stats/earnings').transaction(function(v) { return (v||0) + w.prize; });
      if (w.rank === 1) rtdb.ref('users/' + w.uid + '/stats/wins').transaction(function(v) { return (v||0) + 1; });
      rtdb.ref('users/' + w.uid + '/stats/kills').transaction(function(v) { return (v||0) + (w.kills||0); });
      rtdb.ref('users/' + w.uid + '/stats/matches').transaction(function(v) { return (v||0) + 1; });

      // Send notification to user
      rtdb.ref('users/' + w.uid + '/notifications').push({
        type: 'result',
        title: '🏆 Match Result!',
        body: 'Rank #' + w.rank + ' | ' + w.kills + ' kills | +₹' + w.prize + ' prize!',
        matchId: mid,
        timestamp: Date.now()
      });

      processed++;
    });

    // Save match result log
    rtdb.ref('matchResults/' + mid).set({
      matchId: mid,
      matchName: matchData.name || '',
      distributedAt: Date.now(),
      winners: winners,
      totalDistributed: winners.reduce(function(s, w) { return s + w.prize; }, 0),
      distributedBy: window.ADMIN_UID || 'admin'
    });

    // Mark match as completed
    rtdb.ref(window.DB_MATCHES || 'matches').child(mid).update({ status: 'completed', resultPublished: true });
    if (window.DB_TOURN) rtdb.ref(window.DB_TOURN).child(mid).update({ status: 'completed', resultPublished: true });

    showAdminToast('✅ ' + processed + ' users ko prizes distribute ho gaye!');

    // Close modal if open
    var modal = document.getElementById('adminModal');
    if (modal) modal.style.display = 'none';
  };

  function showAdminToast(msg, isErr) {
    if (window.showToast) window.showToast(msg, isErr);
    else console.log(msg);
  }

  function showAdminModal(title, body) {
    var m = document.getElementById('adminModal');
    var mt = document.getElementById('adminModalTitle');
    var mb = document.getElementById('adminModalBody');
    if (m && mt && mb) { mt.textContent = title; mb.innerHTML = body; m.style.display = 'flex'; }
  }

  // Add "Distribute All" button to results section
  function addDistributeButton() {
    var resultsContainer = document.getElementById('resultsContainer');
    if (!resultsContainer || resultsContainer.querySelector('.f-a01-dist-btn')) return;

    var btn = document.createElement('button');
    btn.className = 'btn btn-primary f-a01-dist-btn';
    btn.style.cssText = 'width:100%;padding:12px;border-radius:12px;font-size:14px;font-weight:800;margin-top:12px;background:linear-gradient(135deg,#00ff9c,#00cc7a);color:#000;border:none;cursor:pointer';
    btn.innerHTML = '💰 Distribute All Prizes';
    btn.onclick = window.adminDistributePrizes;
    resultsContainer.appendChild(btn);
  }

  // Observe results container
  var _obs = new MutationObserver(function() { addDistributeButton(); });
  var _rc = document.getElementById('resultsContainer');
  if (_rc) _obs.observe(_rc, { childList: true, subtree: false });

  // Also hook loadParticipants
  var orig = window.loadParticipants;
  if (orig) {
    window.loadParticipants = function() {
      return orig.apply(this, arguments).then ? orig.apply(this, arguments).then(function() { setTimeout(addDistributeButton, 500); }) : (orig.apply(this, arguments), setTimeout(addDistributeButton, 500));
    };
  }

  // Note: calcPrize is set by inline script in index.html (after all JS loads)
  // so we do NOT override it here anymore

  window.fA01AutoDistribute = { collect: collectResults, distribute: window.adminDistributePrizes };
})();

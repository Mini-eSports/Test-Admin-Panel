/* =============================================
   ADMIN WITHDRAWAL QUEUE - Smart Processing
   js/admin-withdrawal-queue.js
   ============================================= */

var withdrawalQueue = [];
var todayPayout = 0;

function initWithdrawalQueue() {
    console.log('Initializing Withdrawal Queue...');
    
    // Listen to wallet requests for queue updates
    rtdb.ref(DB_WALLET).on('value', function(s) {
        withdrawalQueue = [];
        todayPayout = 0;
        
        var todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        s.forEach(function(c) {
            var w = c.val();
            var type = normalizeWalletType(w.type);
            
            // Count today's approved payouts
            if (type === 'withdraw' && w.status === 'approved') {
                var processedAt = w.processedAt || w.createdAt || 0;
                if (processedAt >= todayStart.getTime()) {
                    todayPayout += Number(w.amount) || 0;
                }
            }
            
            // Add pending withdrawals to queue
            if (type === 'withdraw' && w.status === 'pending') {
                withdrawalQueue.push({
                    id: c.key,
                    ...w
                });
            }
        });
        
        // Sort by oldest first
        withdrawalQueue.sort(function(a, b) {
            return (a.createdAt || 0) - (b.createdAt || 0);
        });
        
        renderWithdrawalQueue();
    });
    
    console.log('✅ Withdrawal Queue initialized');
}

function renderWithdrawalQueue() {
    var queueEl = document.getElementById('withdrawalQueueList');
    var summaryEl = document.getElementById('withdrawalQueueSummary');
    
    if (!queueEl) return;
    
    // Summary
    var totalPending = withdrawalQueue.reduce(function(sum, w) {
        return sum + (Number(w.amount) || 0);
    }, 0);
    
    if (summaryEl) {
        summaryEl.innerHTML = 
            '<div class="flex items-center justify-between">' +
                '<span>' + withdrawalQueue.length + ' pending</span>' +
                '<span class="text-warning font-bold">₹' + totalPending + ' total</span>' +
            '</div>' +
            '<div class="text-xs text-muted mt-1">Today\'s payout: ₹' + todayPayout + '</div>';
    }
    
    // Queue list
    if (withdrawalQueue.length === 0) {
        queueEl.innerHTML = '<div class="text-center text-muted" style="padding:20px">' +
            '<i class="fas fa-check-circle" style="font-size:24px;opacity:0.3"></i>' +
            '<p class="text-xs mt-2">No pending withdrawals 🎉</p>' +
        '</div>';
        return;
    }
    
    var html = '';
    withdrawalQueue.forEach(function(w, i) {
        var uid = w.uid || w.userId || w.oderId;
        var userName = w.userName || w.displayName || getUserName(uid);
        var upiId = w.upiId || w.upi || 'No UPI';
        var amount = Number(w.amount) || 0;
        var createdAt = w.createdAt ? new Date(w.createdAt).toLocaleString() : 'Unknown';
        
        // UPI pay link
        var upiLink = 'upi://pay?pa=' + encodeURIComponent(upiId) + 
                      '&am=' + amount + 
                      '&pn=' + encodeURIComponent(userName) + 
                      '&cu=INR';
        
        html += '<div class="queue-item">' +
            '<div class="queue-header">' +
                '<span class="queue-num">#' + (i + 1) + '</span>' +
                '<span class="queue-time text-xxs text-muted">' + createdAt + '</span>' +
            '</div>' +
            '<div class="queue-body">' +
                '<div class="queue-user">' +
                    '<strong>' + userName + '</strong>' +
                    '<div class="text-xxs font-mono text-muted">' + (uid ? uid.substring(0, 20) + '...' : 'N/A') + '</div>' +
                '</div>' +
                '<div class="queue-upi">' +
                    '<span class="text-xs text-dim">UPI:</span>' +
                    '<span class="text-xs text-warning font-bold">' + upiId + '</span>' +
                '</div>' +
                '<div class="queue-amount">' +
                    '<span class="text-primary font-bold" style="font-size:16px">₹' + amount + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="queue-actions">' +
                '<a href="' + upiLink + '" class="btn btn-info btn-xs" target="_blank" title="Open UPI App">' +
                    '<i class="fas fa-external-link-alt"></i> Pay' +
                '</a> ' +
                '<button class="btn btn-primary btn-xs" onclick="openWithdrawalModal(\'' + w.id + '\')" title="Process">' +
                    '<i class="fas fa-check"></i>' +
                '</button> ' +
                '<button class="btn btn-danger btn-xs" onclick="quickRejectWithdrawal(\'' + w.id + '\')" title="Quick Reject">' +
                    '<i class="fas fa-times"></i>' +
                '</button>' +
            '</div>' +
        '</div>';
    });
    
    queueEl.innerHTML = html;
}

function quickRejectWithdrawal(requestId) {
    var reasons = [
        'Invalid UPI ID',
        'Insufficient balance', 
        'Duplicate request',
        'Account under review',
        'Verification pending',
        'Custom reason...'
    ];
    
    var promptText = 'Quick Reject — Select reason:\n\n';
    reasons.forEach(function(r, i) {
        promptText += (i + 1) + '. ' + r + '\n';
    });
    promptText += '\nEnter number (1-' + reasons.length + ') or custom text:';
    
    var input = prompt(promptText);
    if (!input) return;
    
    var reasonIndex = parseInt(input) - 1;
    var finalReason;
    
    if (reasonIndex >= 0 && reasonIndex < reasons.length - 1) {
        finalReason = reasons[reasonIndex];
    } else if (reasonIndex === reasons.length - 1) {
        finalReason = prompt('Enter custom reason:');
        if (!finalReason) return;
    } else {
        finalReason = input;
    }
    
    // Use existing reject flow
    pendingRejectData = { type: 'wallet', requestId: requestId };
    document.getElementById('rejectReason').value = finalReason;
    submitReject();
}

function copyAllUPIs() {
    if (withdrawalQueue.length === 0) {
        showToast('No pending withdrawals', true);
        return;
    }
    
    var list = '💳 UPI IDs for Payment:\n\n';
    withdrawalQueue.forEach(function(w, i) {
        var upi = w.upiId || w.upi || 'N/A';
        var amount = Number(w.amount) || 0;
        var name = w.userName || 'User';
        list += (i + 1) + '. ' + name + '\n   UPI: ' + upi + '\n   Amount: ₹' + amount + '\n\n';
    });
    
    if (navigator.clipboard) {
        navigator.clipboard.writeText(list).then(function() {
            showToast('✅ UPI list copied!');
        });
    }
}

function refreshQueue() {
    showToast('Queue refreshed!');
    // The listener will auto-update
}

console.log('✅ admin-withdrawal-queue.js loaded');

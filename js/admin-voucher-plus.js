/* =============================================
   ADMIN VOUCHER PLUS - Enhanced Voucher System
   js/admin-voucher-plus.js
   ============================================= */

var voucherAnalytics = {
    total: 0,
    used: 0,
    expired: 0,
    valueDistributed: 0
};

function generateBulkVouchers() {
    var count = parseInt(prompt('How many vouchers to generate? (max 20)'));
    if (!count || count < 1 || count > 20) {
        showToast('Enter a number between 1-20', true);
        return;
    }
    
    var value = parseInt(prompt('Value per voucher (₹)?'));
    if (!value || value < 1) {
        showToast('Enter a valid amount', true);
        return;
    }
    
    var maxUses = parseInt(prompt('Max uses per voucher? (default: 1)')) || 1;
    var expiryDays = parseInt(prompt('Expiry in days? (default: 30)')) || 30;
    
    var codes = [];
    var promises = [];
    
    for (var i = 0; i < count; i++) {
        // Generate unique code
        var code = 'MINI' + Math.random().toString(36).substr(2, 6).toUpperCase();
        codes.push(code);
        
        var voucherData = {
            code: code,
            value: value,
            maxUses: maxUses,
            usedCount: 0,
            usedBy: {},
            createdAt: Date.now(),
            expiresAt: Date.now() + (expiryDays * 24 * 60 * 60 * 1000),
            createdBy: auth.currentUser ? auth.currentUser.uid : 'admin',
            active: true
        };
        
        promises.push(rtdb.ref(DB_VOUCHERS + '/' + code).set(voucherData));
    }
    
    Promise.all(promises).then(function() {
        // Copy codes to clipboard
        var codeList = codes.join('\n');
        if (navigator.clipboard) {
            navigator.clipboard.writeText(codeList);
        }
        
        showToast('✅ ' + count + ' vouchers created! Codes copied to clipboard.');
        loadVouchers();
        loadVoucherAnalytics();
        
        // Log activity
        rtdb.ref('activityLogs').push({
            type: 'bulk_vouchers_created',
            count: count,
            value: value,
            admin: auth.currentUser ? auth.currentUser.uid : 'admin',
            timestamp: Date.now()
        });
        
    }).catch(function(e) {
        showToast('Error creating vouchers: ' + e.message, true);
    });
}

function loadVoucherAnalytics() {
    rtdb.ref(DB_VOUCHERS).once('value', function(s) {
        voucherAnalytics = {
            total: 0,
            used: 0,
            expired: 0,
            valueDistributed: 0,
            activeValue: 0
        };
        
        var now = Date.now();
        
        s.forEach(function(c) {
            var v = c.val();
            voucherAnalytics.total++;
            
            var usedCount = v.usedCount || 0;
            voucherAnalytics.used += usedCount;
            voucherAnalytics.valueDistributed += usedCount * (v.value || 0);
            
            // Check if expired
            if (v.expiresAt && v.expiresAt < now) {
                voucherAnalytics.expired++;
            } else if (v.active !== false && usedCount < (v.maxUses || 1)) {
                voucherAnalytics.activeValue += (v.value || 0) * ((v.maxUses || 1) - usedCount);
            }
        });
        
        renderVoucherAnalytics();
    });
}

function renderVoucherAnalytics() {
    var el = document.getElementById('voucherAnalyticsDisplay');
    if (!el) return;
    
    el.innerHTML = 
        '<div class="stats-grid" style="grid-template-columns:repeat(4,1fr);gap:8px">' +
            '<div class="stat-card" style="padding:10px">' +
                '<h3 style="font-size:8px">Total</h3>' +
                '<div class="value" style="font-size:16px">' + voucherAnalytics.total + '</div>' +
            '</div>' +
            '<div class="stat-card" style="padding:10px">' +
                '<h3 style="font-size:8px">Times Used</h3>' +
                '<div class="value" style="font-size:16px">' + voucherAnalytics.used + '</div>' +
            '</div>' +
            '<div class="stat-card" style="padding:10px">' +
                '<h3 style="font-size:8px">Distributed</h3>' +
                '<div class="value text-primary" style="font-size:16px">₹' + voucherAnalytics.valueDistributed + '</div>' +
            '</div>' +
            '<div class="stat-card" style="padding:10px">' +
                '<h3 style="font-size:8px">Expired</h3>' +
                '<div class="value text-danger" style="font-size:16px">' + voucherAnalytics.expired + '</div>' +
            '</div>' +
        '</div>';
}

function createTargetedVoucher() {
    var targetUid = prompt('Enter target user UID (or leave empty for public):');
    var code = prompt('Enter voucher code:');
    if (!code) {
        showToast('Code required', true);
        return;
    }
    
    var value = parseInt(prompt('Value (₹)?'));
    if (!value || value < 1) {
        showToast('Valid amount required', true);
        return;
    }
    
    var voucherData = {
        code: code.toUpperCase(),
        value: value,
        maxUses: 1,
        usedCount: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000),
        createdBy: auth.currentUser ? auth.currentUser.uid : 'admin',
        active: true
    };
    
    if (targetUid) {
        voucherData.targetUid = targetUid;
        voucherData.isTargeted = true;
    }
    
    rtdb.ref(DB_VOUCHERS + '/' + code.toUpperCase()).set(voucherData)
        .then(function() {
            showToast('✅ Voucher ' + code.toUpperCase() + ' created!' + 
                (targetUid ? ' (For: ' + targetUid.substring(0, 10) + '...)' : ''));
            loadVouchers();
            loadVoucherAnalytics();
        })
        .catch(function(e) {
            showToast('Error: ' + e.message, true);
        });
}

function viewVoucherUsage(code) {
    rtdb.ref(DB_VOUCHERS + '/' + code).once('value', function(s) {
        var v = s.val();
        if (!v) {
            showToast('Voucher not found', true);
            return;
        }
        
        var info = '📋 Voucher: ' + code + '\n\n';
        info += 'Value: ₹' + v.value + '\n';
        info += 'Used: ' + (v.usedCount || 0) + '/' + (v.maxUses || 1) + '\n';
        info += 'Created: ' + new Date(v.createdAt).toLocaleString() + '\n';
        info += 'Expires: ' + (v.expiresAt ? new Date(v.expiresAt).toLocaleString() : 'Never') + '\n';
        
        if (v.usedBy && Object.keys(v.usedBy).length > 0) {
            info += '\n👥 Used By:\n';
            Object.keys(v.usedBy).forEach(function(uid) {
                var useData = v.usedBy[uid];
                info += '• ' + uid.substring(0, 15) + '... at ' + 
                    (useData.usedAt ? new Date(useData.usedAt).toLocaleString() : 'Unknown') + '\n';
            });
        }
        
        if (v.targetUid) {
            info += '\n🎯 Targeted: ' + v.targetUid;
        }
        
        alert(info);
    });
}

function deactivateVoucher(code) {
    if (!confirm('Deactivate voucher ' + code + '?')) return;
    
    rtdb.ref(DB_VOUCHERS + '/' + code).update({ active: false })
        .then(function() {
            showToast('Voucher deactivated');
            loadVouchers();
        });
}

function exportVoucherCodes() {
    rtdb.ref(DB_VOUCHERS).once('value', function(s) {
        var csv = 'Code,Value,MaxUses,UsedCount,Created,Expires,Active\n';
        
        s.forEach(function(c) {
            var v = c.val();
            csv += [
                c.key,
                v.value,
                v.maxUses || 1,
                v.usedCount || 0,
                new Date(v.createdAt).toLocaleDateString(),
                v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : 'Never',
                v.active !== false ? 'Yes' : 'No'
            ].join(',') + '\n';
        });
        
        var blob = new Blob([csv], { type: 'text/csv' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'vouchers-' + new Date().toISOString().split('T')[0] + '.csv';
        a.click();
        
        showToast('✅ Vouchers exported!');
    });
}

console.log('✅ admin-voucher-plus.js loaded');

/* ADMIN FEATURE A09: Smart Withdrawal Queue with Fraud Score
   Pending withdrawals ko sorted dikh − fraud score high wale top pe. One-tap approve/reject. */
(function(){
'use strict';
window.fa09WithdrawalQueue=async function(){
  try{
    var s=await rtdb.ref('withdrawals').orderByChild('status').equalTo('pending').once('value');
    var list=[];
    s.forEach(function(c){ var d=c.val(); d._k=c.key; list.push(d); });

    // Compute fraud score per request
    list.forEach(function(w){
      var score=0;
      if(Number(w.amount)>500) score+=2;
      if(w.newAccount) score+=3;
      if((Date.now()-Number(w.createdAt||0))<24*3600000) score+=1; // requested < 24h after join
      w._score=score;
    });
    list.sort(function(a,b){ return b._score-a._score; });

    var h='<div>';
    if(!list.length){ h+='<div style="text-align:center;padding:20px;color:#00ff9c">✅ No pending withdrawals!</div>'; }
    list.forEach(function(w){
      var col=w._score>=4?'#ff4444':w._score>=2?'#ffaa00':'#00ff9c';
      h+='<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;margin-bottom:8px">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
        +'<strong>'+( w.userName||w.userId||'User')+'</strong>'
        +'<span style="background:rgba(0,0,0,.3);padding:2px 8px;border-radius:10px;font-size:11px;color:'+col+'">⚠️ Score: '+w._score+'</span></div>'
        +'<div style="font-size:12px;color:#aaa;margin-bottom:8px">₹'+w.amount+' → '+( w.upiId||'UPI')+'</div>'
        +'<div style="display:flex;gap:8px">'
        +'<button onclick="fa09Act(\''+w._k+'\',\''+w.userId+'\','+w.amount+',\'approve\')" style="flex:1;padding:8px;border-radius:8px;background:#00ff9c;color:#000;font-weight:700;border:none;cursor:pointer;font-size:12px">✅ Approve</button>'
        +'<button onclick="fa09Act(\''+w._k+'\',\''+w.userId+'\','+w.amount+',\'reject\')" style="flex:1;padding:8px;border-radius:8px;background:#ff4444;color:#fff;font-weight:700;border:none;cursor:pointer;font-size:12px">❌ Reject</button>'
        +'</div></div>';
    });
    h+='</div>';
    showAdminModal('💸 Withdrawal Queue ('+list.length+')',h);
  }catch(e){showToast('Error: '+e.message,true);}
};

window.fa09Act=async function(key,uid,amount,action){
  try{
    if(action==='approve'){
      await rtdb.ref('withdrawals/'+key).update({status:'approved',approvedAt:Date.now()});
      var nk=rtdb.ref('users/'+uid+'/notifications').push().key;
      await rtdb.ref('users/'+uid+'/notifications/'+nk).set({title:'✅ Withdrawal Approved!',message:'₹'+amount+' approved. UPI transfer started.',type:'system',timestamp:Date.now(),read:false});
    } else {
      await rtdb.ref('withdrawals/'+key).update({status:'rejected',rejectedAt:Date.now()});
      await rtdb.ref('users/'+uid+'/realMoney/balance').transaction(function(v){return (v||0)+Number(amount);});
      var nk2=rtdb.ref('users/'+uid+'/notifications').push().key;
      await rtdb.ref('users/'+uid+'/notifications/'+nk2).set({title:'❌ Withdrawal Rejected',message:'₹'+amount+' wapas wallet mein.',type:'system',timestamp:Date.now(),read:false});
    }
    showToast('Done!'); fa09WithdrawalQueue();
  }catch(e){showToast('Error: '+e.message,true);}
};
})();
